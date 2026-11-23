"""Deriving a benchmark case set's publication, as the CLI (examples/uploaded_benchmark's step 1) and RUSH Lab's Publish
benchmark screen both do it. Every field of the body for RUSH's `POST /api/benchmark/benchmarks` comes from the plugin
package and the plugin benchmark's case file (YAML, uploaded whole); the member supplies only those and a name. Each case's private reference is
pinned once, by running the task's reference tool on the plugin's installed package. Anything the verifier could not judge
deterministically fails preparation with a message that says what to change. Nothing here reaches the network."""

import asyncio
import base64
import gzip
import hashlib
import io
import json
import re
import tarfile
import tempfile
from dataclasses import dataclass, field
from collections.abc import Iterator
from pathlib import Path, PurePosixPath
from typing import Any

import yaml
from slimconfig import Config, Output, build_output

from nanoagent.plugin.runtime import _names_workspace, call_tool_async
from nanoagent.uploaded.answer import ANSWER
from nanoagent.uploaded.contract import SESSION_STATE, ContractError
from nanoagent.uploaded.outcome import answer_skeleton

NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}")
# The most one case's fixtures archive may weigh gzipped (RUSH answers 400 `fixtures_too_large` above it).
FIXTURES_MAX_BYTES = 8 << 20


class PreparationError(Exception):
    """The case file and the plugin cannot make a case set, and why."""


@dataclass
class Case(Output):
    """A case to answer: the prompt a coding agent is given, the task's input it states, and the folder of fixtures it works
    on (relative to the case file's folder)."""

    prompt: str
    arguments: dict[str, Any]
    fixtures: str | None = None


@dataclass
class Refusal(Output):
    """A case to refuse: as a :class:`Case`, and text the pinning tool's error holds when it rejects it."""

    prompt: str
    arguments: dict[str, Any]
    reference_error: str
    fixtures: str | None = None


@dataclass
class CaseSet(Output):
    """One task of one plugin, and its cases: to answer, and to refuse."""

    plugin: str
    task: str
    cases: list[Case] = field(default_factory=list)
    refuse: list[Refusal] = field(default_factory=list)

    def case(self, id: str) -> Case | Refusal:
        """Case ``id`` (<plugin>-<n>, the cases to answer first)."""
        every = [*self.cases, *self.refuse]
        ids = case_ids(self)
        if id not in ids:
            raise ValueError(f"{self.plugin}'s cases are {ids[0]} to {ids[-1]}, not {id}")
        return every[ids.index(id)]


def with_fixtures_default(cases: Any) -> Any:
    """A case file's content with the optional `fixtures` of each case made explicit (null), as :func:`build_output` takes every
    field; anything else of the file is left for it to refuse."""
    if not isinstance(cases, dict):
        return cases
    return {
        key: [{"fixtures": None, **case} if isinstance(case, dict) else case for case in value] if isinstance(value, list) and key in ("cases", "refuse") else value
        for key, value in cases.items()
    }


def parse_case_file(text: str) -> CaseSet:
    """The case set a YAML case file holds. A syntax error says its line; a file of another shape (a key it does not take, a
    missing one) says what is wrong."""
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        where = f"line {mark.line + 1}, column {mark.column + 1}: " if mark is not None else ""
        problem = getattr(error, "problem", None) or str(error)
        raise PreparationError(f"the case file is not valid YAML at {where}{problem}") from error
    if not isinstance(document, dict):
        raise PreparationError("the case file must be a YAML mapping with plugin, task, cases and refuse")
    try:
        return build_output(with_fixtures_default(document), CaseSet)
    except (TypeError, ValueError, KeyError) as error:
        raise PreparationError(f"the case file does not fit the case file shape: {error}") from error


@dataclass
class CaseSetSpec(Output):
    """What RUSH Lab's Publish benchmark screen sends to the member's own NanoAgent: the case set's name, the YAML case file's
    text and every other file of the uploaded case folder by its path in the folder (base64); the package is the one installed
    there."""

    name: str
    case_file: str
    files: dict[str, str] = field(default_factory=dict)


def reference_tool(task) -> str | None:
    """The tool that pins the task's right answer, as its manifest says: its reference tool; for a
    tool task without one, its one tool, whose output RUSH gives; None for an agent or decide task without one,
    whose verifier judges with reference None."""
    if task.reference is not None:
        return task.reference
    match task.runner:
        case "tool":
            [tool] = task.tools
            return tool
        case "agent" | "decide":
            return None
    raise ValueError(f"task {task.id!r}: the benchmark cannot pin a {task.runner} task without a reference tool")


def case_ids(cases: CaseSet) -> list[str]:
    return [f"{cases.plugin}-{number:02d}" for number in range(1, len(cases.cases) + len(cases.refuse) + 1)]


def stage(files: dict[str, bytes], workspace: Path) -> None:
    """Copy fixture ``files`` into ``workspace``, the reference tool's scratch."""
    for path, data in files.items():
        target = workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


async def pin(
    manifest, tool: str | None, case: Case | Refusal, files: dict[str, bytes], timeout: float
) -> tuple[dict[str, Any] | None, str | None]:
    """``tool``'s answer to a case to answer, or its rejection of a case to refuse, which must hold the text the cases file
    names, with the case's fixture ``files`` staged in the tool's workspace; (None, None) for a task with no tool to pin it."""
    if tool is None:
        return None, None
    refusal = case if isinstance(case, Refusal) else None
    arguments = case.arguments
    with tempfile.TemporaryDirectory() as scratch:
        stage(files, Path(scratch))
        try:
            output = await call_tool_async(manifest, tool, arguments, workspace=Path(scratch), timeout=timeout)
        # A tool's own failure, or the plugin's input verification refusing the input.
        except (RuntimeError, ValueError) as error:
            if refusal is None:
                raise RuntimeError(f"{tool} could not answer {json.dumps(arguments)}, a case to answer: {error}") from error
            if refusal.reference_error not in str(error):
                raise RuntimeError(f"{tool} rejected {json.dumps(arguments)} without {refusal.reference_error!r}: {error}") from error
            # The scratch folder differs every run, so an error naming it would pin a different reference each time (and leak the local path).
            if _names_workspace(str(error), Path(scratch)):
                raise RuntimeError(f"{tool}'s rejection of {json.dumps(arguments)} names its scratch folder; name what is in it by a path relative to it") from error
            return None, str(error)
    if refusal is not None:
        raise RuntimeError(f"{tool} answered {json.dumps(arguments)}, a case to refuse")
    return output, None


def leaves(value: Any, path: str = "") -> Iterator[tuple[str, Any]]:
    """Every scalar of ``value`` with its dotted path (a list index is a path part)."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, f"{path}.{index}" if path else str(index))
    else:
        yield path, value


def squeezed(text: str) -> str:
    return " ".join(text.split())


def stated(text: str, prompt: str) -> bool:
    """Whether ``text`` stands in ``prompt`` as a token of its own: no letter, digit or `_` beside it, nor a `.` or `/` before it or
    one after it that goes on with a letter, digit or `_` (so `5` is not in "15" or "1.5", nor `a.csv` in "data.csv"), while a
    sentence's closing `.` may follow it."""
    return re.search(rf"(?<![\w./]){re.escape(text)}(?!\w|[./]\w)", prompt) is not None


def lint(case_id: str, case: Case | Refusal) -> None:
    """Every non-empty string and number among the case's arguments (not a bool, not null) must be stated in its prompt as a token
    of its own (see :func:`stated`), whitespace runs read as one space; a number by its JSON text, an integral float also by its
    integer text. An argument of any other type cannot be checked, so it fails the lint."""
    prompt = squeezed(case.prompt)
    for path, value in leaves(case.arguments):
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, str):
            texts = [squeezed(value)]
        elif isinstance(value, (int, float)):
            texts = [json.dumps(value)] + ([str(int(value))] if isinstance(value, float) and value.is_integer() else [])
        else:
            raise PreparationError(
                f"case {case_id}: argument {path} is a {type(value).__name__} ({value!r}), which the prompt lint cannot check; write it as a string or number"
            )
        if texts[0] != "" and not any(stated(text, prompt) for text in texts):
            raise PreparationError(f"case {case_id}: the prompt does not state argument {path} ({texts[0]})")


def directory_files(folder: Path, base: Path, case_id: str) -> dict[str, bytes]:
    """The regular files under ``folder`` (relative to ``base``, the case file's folder) by their path in it."""
    root = base.resolve()
    start = base / folder
    if start.is_symlink() or not start.resolve().is_relative_to(root):
        raise PreparationError(f"case {case_id}: the fixtures {folder} are not inside {base}")
    if not start.is_dir():
        raise PreparationError(f"case {case_id}: the fixtures {folder} are not a folder in {base}")
    if start.resolve() == root:
        raise PreparationError(f"case {case_id}: the fixtures {folder} hold the case file itself; name a folder beside it")
    files: dict[str, bytes] = {}
    for path in sorted(start.rglob("*")):
        relative = path.relative_to(start).as_posix()
        if path.is_symlink():
            raise PreparationError(f"case {case_id}: the fixture {relative} is a symlink")
        if path.is_dir():
            continue
        if not path.is_file():
            raise PreparationError(f"case {case_id}: the fixture {relative} is not a regular file or folder")
        files[relative] = path.read_bytes()
    return files


def decode_files(encoded: dict[str, str]) -> dict[str, bytes]:
    """The uploaded case folder's files, ``{path in the folder: base64}``."""
    files: dict[str, bytes] = {}
    for path, text in encoded.items():
        parts = PurePosixPath(path).parts
        if not parts or PurePosixPath(path).is_absolute() or ".." in parts or "." in parts or "\\" in path:
            raise PreparationError(f"the uploaded file path {path!r} must be relative and stay inside the case folder")
        try:
            files[path] = base64.b64decode(text, validate=True)
        except (TypeError, ValueError) as error:
            raise PreparationError(f"the uploaded file {path} is not base64: {error}") from error
    return files


def uploaded_folder_files(folder: str, uploaded: dict[str, bytes], case_id: str) -> dict[str, bytes]:
    """The files of the uploaded case folder under ``folder`` (relative to the case file), by their path in it."""
    parts = PurePosixPath(folder).parts
    if not parts or PurePosixPath(folder).is_absolute() or ".." in parts or "\\" in folder:
        raise PreparationError(f"case {case_id}: the fixtures {folder} are not inside the case folder")
    prefix = PurePosixPath(*[part for part in parts if part != "."])
    files = {PurePosixPath(path).relative_to(prefix).as_posix(): data for path, data in uploaded.items() if PurePosixPath(path).is_relative_to(prefix)}
    if not files:
        raise PreparationError(f"case {case_id}: the fixtures {folder} are not a folder of the uploaded case folder")
    return files


def fixture_files(case: Case | Refusal, case_id: str, base: Path | dict[str, bytes] | None) -> dict[str, bytes] | None:
    """The case's fixture files read from ``base``: the case file's folder, or the uploaded files by path in it."""
    if case.fixtures is None:
        return None
    if not isinstance(case.fixtures, str):
        raise PreparationError(f"case {case_id}: fixtures are a folder relative to the case file, or null")
    if base is None:
        raise PreparationError(f"case {case_id}: the fixtures {case.fixtures} are a folder, and there is no case file folder to read it from")
    files = directory_files(Path(case.fixtures), base, case_id) if isinstance(base, Path) else uploaded_folder_files(case.fixtures, base, case_id)
    for path in files:  # the platform seeds answer.json before the session and keeps `.rush/` as its own, so a fixture there would be overwritten or dropped
        if path == ANSWER or path == SESSION_STATE or path.startswith(f"{SESSION_STATE}/"):
            raise PreparationError(f"case {case_id}: the fixtures hold {path} at their root, which the platform reserves ({ANSWER} is seeded, {SESSION_STATE}/ is the session's)")
    return files


def archive(files: dict[str, bytes], case_id: str) -> dict[str, Any]:
    """The deterministic fixtures archive of ``files``: ``{sha256, files, archive}`` (see verified-benchmark-interfaces.md)."""
    folders = sorted({parent.as_posix() for path in files for parent in PurePosixPath(path).parents if parent != PurePosixPath(".")})
    entries = sorted([(name, None) for name in folders] + list(files.items()))
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
            if data is None:
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                tar.addfile(info)
            else:
                info.size, info.mode = len(data), 0o644
                tar.addfile(info, io.BytesIO(data))
    zipped = io.BytesIO()
    with gzip.GzipFile(fileobj=zipped, mode="wb", compresslevel=9, mtime=0, filename="") as gz:
        gz.write(raw.getvalue())
    data = zipped.getvalue()
    if len(data) > FIXTURES_MAX_BYTES:
        raise PreparationError(f"case {case_id}: the fixtures weigh {len(data)} bytes gzipped, over the {FIXTURES_MAX_BYTES} a case may have")
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "files": {path: hashlib.sha256(content).hexdigest() for path, content in sorted(files.items())},
        "archive": base64.b64encode(data).decode(),
    }


def check_cases(manifest, cases: CaseSet, name: str) -> Any:
    """The task of ``cases`` in ``manifest``, once the case file and name are known to fit it."""
    if not NAME.fullmatch(name):
        raise PreparationError(f"the case set name {name!r} must be lowercase letters, digits, '.', '_' or '-', and start with a letter or digit")
    if cases.plugin != manifest.id:
        raise PreparationError(f"the cases are for {cases.plugin}, not {manifest.id}")
    try:
        task = manifest.task(cases.task)
    except KeyError as error:
        raise PreparationError(f"{manifest.id} has an unknown task: {error.args[0]}") from error
    if not case_ids(cases):
        raise PreparationError(f"the cases file for {cases.plugin} {cases.task} has no cases: both `cases` and `refuse` are empty")
    for case_id in case_ids(cases):
        case = cases.case(case_id)
        if not case.prompt.strip():
            raise PreparationError(f"case {case_id}: the prompt is empty")
        if case.prompt != case.prompt.strip():  # an agent (hermes) strips its input, and prompt_bound pins the first request byte for byte
            raise PreparationError(f"case {case_id}: the prompt starts or ends with whitespace")
        try:
            build_output(case.arguments, task.input_type)
        except (TypeError, ValueError) as error:
            raise PreparationError(f"case {case_id}: its arguments do not fit the input of task {task.id}: {error}") from error
        if isinstance(case, Refusal) and not case.reference_error:
            raise PreparationError(f"case {case_id}: a case to refuse names no reference_error, so a refusal for the wrong reason would pass")
        lint(case_id, case)
    return task


def task_tools(manifest, task) -> list[dict[str, Any]]:
    """The tools ``run_task`` gives the agent for ``task``: the task's tools, never its reference tool. ``writes``
    is the manifest's: a plugin allowed to write the filesystem may write with any of its tools."""
    writes = bool(manifest.permissions.filesystem_write)
    return [
        {
            "name": tool.name,
            "description": tool.description,
            "input_schema": tool.input,
            "output_schema": tool.output,
            "writes": writes,
        }
        for tool in map(manifest.tool, task.tools)
        if tool.name != task.reference
    ]


def check_skeleton(task) -> None:
    """Refuse a task whose output schema has no answer skeleton: the worker seeds every case's answer.json from it, so such a
    schema would fail every attempt of every case at run time."""
    try:
        answer_skeleton(task.output)
    except ContractError as error:
        raise PreparationError(f"task {task.id}: {error}") from error


def derive_case_set(name: str, cases: CaseSet, manifest, sha256: str, timeout: float, base: Path | dict[str, bytes] | None = None) -> dict[str, Any]:
    """The body of `POST /api/benchmark/benchmarks` for the plugin ``manifest`` (the package with ``sha256``) but the run
    configuration (model, endpoint profile, limits), with every case pinned by the task's reference tool, the private
    references in ``private``. A case's fixtures folder is read relative to ``base``: the case file's folder, or the uploaded files by path in it.

    Raises :class:`PreparationError` for a case file that does not fit the plugin: no cases, arguments that break the task's
    input schema or that the prompt does not state, fixtures that are not plain files, a case the reference tool cannot
    answer or answers though it is to be refused, a refusal whose error differs from the one expected, and a case to refuse
    in a task without a reference tool to confirm the refusal."""
    task = check_cases(manifest, cases, name)
    check_skeleton(task)
    tool = reference_tool(task)
    if tool is None and cases.refuse:
        first = case_ids(cases)[len(cases.cases)]
        raise PreparationError(
            f"case {first}: task {task.id} has no reference tool, so nothing can confirm that its input is to be refused "
            f"or that the error {cases.refuse[0].reference_error!r} is the right one; declare a reference tool in the manifest or remove the cases to refuse"
        )
    references: dict[str, Any] = {}
    published: list[dict[str, Any]] = []
    for case_id in case_ids(cases):
        case = cases.case(case_id)
        files = fixture_files(case, case_id, base)
        try:
            reference, rejection = asyncio.run(pin(manifest, tool, case, files or {}, timeout))
        except RuntimeError as error:
            raise PreparationError(f"case {case_id}: {error}") from error
        refusal = isinstance(case, Refusal)
        references[case_id] = rejection if refusal else reference
        published.append(
            {
                "case_id": case_id,
                "kind": "refuse" if refusal else "answer",
                "prompt": case.prompt,
                "arguments": case.arguments,
                "fixtures": None if files is None else archive(files, case_id),
                "expected_error": case.reference_error if isinstance(case, Refusal) else None,
            }
        )
        print(f"pinned {case_id}")
    return {**case_set_frame(name, manifest, sha256, task), "cases": published, "private": references}


def case_set_frame(name: str, manifest, sha256: str, task) -> dict[str, Any]:
    """What a case set of ``task`` says but its cases: the plugin and the task, all from ``manifest``."""
    return {
        "name": name,
        "plugin_id": manifest.id,
        "plugin_name": manifest.name,
        "version": manifest.version,
        "package_sha256": sha256,
        "task_id": task.id,
        "task": {
            "kind": task.runner,
            "description": task.description,
            "input_schema": task.input,
            "output_schema": task.output,
            "tools": task_tools(manifest, task),
            # The HTTPS hosts the plugin's processes may reach (CONNECT host:443 through the egress proxy); none means no egress.
            "egress_hosts": sorted(set(manifest.permissions.network_hosts)),
        },
    }


# COMPAT(case-set-cases): the case-set request production RUSH still sends, `{name, cases: {plugin, task, context, answer, refuse}}`,
# answered as it always was (the old publication: no prompt or fixtures per case, `instructions` and `context` in the frame). Delete
# with the `cases` form of the route in web/app.py once no deployed RUSH sends it.
@dataclass
class CompatRefusal:  # COMPAT(case-set-cases)
    """A case to refuse: its input, and text the pinning tool's error holds when it rejects it."""

    arguments: dict[str, Any]
    reference_error: str


@dataclass
class CompatCaseSet:  # COMPAT(case-set-cases)
    """One task of one plugin, and its inputs: to answer, and to refuse."""

    plugin: str
    task: str
    # What a coding agent is told that the task's input does not say: its universe and data source.
    context: str
    answer: list[dict[str, Any]]
    refuse: list[CompatRefusal]

    def case(self, id: str) -> tuple[dict[str, Any], CompatRefusal | None]:
        """The input of case ``id`` (<plugin>-<n>, the inputs to answer first), and its refusal when it is a case to refuse."""
        inputs = [(arguments, None) for arguments in self.answer] + [(refusal.arguments, refusal) for refusal in self.refuse]
        ids = [f"{self.plugin}-{index:02d}" for index in range(1, len(inputs) + 1)]
        if id not in ids:
            raise ValueError(f"{self.plugin}'s cases are {ids[0]} to {ids[-1]}, not {id}")
        return inputs[ids.index(id)]


@dataclass
class CompatCaseSetSpec(Output):  # COMPAT(case-set-cases)
    """The old body of the case-set request: the case file's content and the case set's name."""

    cases: CompatCaseSet
    name: str


def compat_case_ids(cases: CompatCaseSet) -> list[str]:  # COMPAT(case-set-cases)
    return [f"{cases.plugin}-{number:02d}" for number in range(1, len(cases.answer) + len(cases.refuse) + 1)]


def compat_derive_case_set(name: str, cases: CompatCaseSet, manifest, sha256: str, timeout: float) -> dict[str, Any]:  # COMPAT(case-set-cases)
    """The old publication of ``cases``: as :func:`derive_case_set`, but each case is its arguments alone (no prompt, no fixtures)."""
    if not NAME.fullmatch(name):
        raise PreparationError(f"the case set name {name!r} must be lowercase letters, digits, '.', '_' or '-', and start with a letter or digit")
    if cases.plugin != manifest.id:
        raise PreparationError(f"the cases are for {cases.plugin}, not {manifest.id}")
    try:
        task = manifest.task(cases.task)
    except KeyError as error:
        raise PreparationError(f"{manifest.id} has an unknown task: {error.args[0]}") from error
    ids = compat_case_ids(cases)
    if not ids:
        raise PreparationError(f"the cases file for {cases.plugin} {cases.task} has no cases: both `answer` and `refuse` are empty")
    for case_id in ids:
        arguments, refusal = cases.case(case_id)
        try:
            build_output(arguments, task.input_type)
        except (TypeError, ValueError) as error:
            raise PreparationError(f"case {case_id}: its arguments do not fit the input of task {task.id}: {error}") from error
        if refusal is not None and not refusal.reference_error:
            raise PreparationError(f"case {case_id}: a case to refuse names no reference_error, so a refusal for the wrong reason would pass")
    check_skeleton(task)
    tool = reference_tool(task)
    if tool is None and cases.refuse:
        raise PreparationError(
            f"case {ids[len(cases.answer)]}: task {task.id} has no reference tool, so nothing can confirm that its input is to be refused "
            f"or that the error {cases.refuse[0].reference_error!r} is the right one; declare a reference tool in the manifest or remove the cases to refuse"
        )
    references: dict[str, Any] = {}
    published: list[dict[str, Any]] = []
    for case_id in ids:
        arguments, refusal = cases.case(case_id)
        # The prompt only feeds the new case's lint and the tool pin never reads it.
        pinned = Case(prompt="", arguments=arguments) if refusal is None else Refusal(prompt="", arguments=arguments, reference_error=refusal.reference_error)
        try:
            reference, rejection = asyncio.run(pin(manifest, tool, pinned, {}, timeout))
        except RuntimeError as error:
            raise PreparationError(f"case {case_id}: {error}") from error
        references[case_id] = rejection if refusal is not None else reference
        published.append(
            {
                "case_id": case_id,
                "kind": "answer" if refusal is None else "refuse",
                "arguments": arguments,
                "expected_error": None if refusal is None else refusal.reference_error,
            }
        )
        print(f"pinned {case_id}")
    frame = case_set_frame(name, manifest, sha256, task)
    frame["task"] = {**frame["task"], "instructions": task.instructions}
    return {**frame, "context": cases.context, "cases": published, "private": references}


# The case set of one session in a plugin page's Harness tab: one case, the member's request.
SESSION = "harness-session"


@dataclass
class SessionsConfig(Config):
    """How every session runs: a Harness tab session, and ``nanoagent harness``."""

    # The model calls one session admits: a person works with the harness, so more than a benchmark case's.
    max_model_calls: int = 200
    # How long one session may run: a person installs and tries agents in it, so far longer than a benchmark case's 10 minutes.
    wall_time_ms: int = 3_600_000
    # The Terminal's build (`shell`: Claude Code's and Codex's binaries, dsh, Hermes) outgrows a benchmark's build bounds; a worker
    # keeps each build for every later session of it, so only the first pays.
    build_output_bytes: int = 3 << 30
    build_wall_ms: int = 1_800_000
    # The case VM's /tmp (HOME, and so Claude Code's home and the npm and pip caches) and its workspace (where pip and npm -g
    # install): a person installs and runs agents there, which a benchmark case's 64 MiB and 256 MiB do not hold.
    tmp_bytes: int = 4 << 30
    workspace_bytes: int = 10 << 30
    # The case VM's memory, which its tmpfs /tmp is charged to: room for that and an agent's process (Claude Code's node) beside it.
    memory_mb: int = 4096

    def __post_init__(self) -> None:
        for name in ("max_model_calls", "wall_time_ms", "build_output_bytes", "build_wall_ms", "tmp_bytes", "workspace_bytes", "memory_mb"):
            if getattr(self, name) < 1:
                raise ValueError(f"sessions.{name} must be >= 1, got {getattr(self, name)}")


def session_frame(manifest, sha256: str, task_id: str, sessions: SessionsConfig) -> dict[str, Any]:
    """A Harness tab session's case set but its case (and that case's id, ``case_id``), read from ``manifest`` at once."""
    try:
        task = manifest.task(task_id)
    except KeyError as error:
        raise PreparationError(f"{manifest.id} has an unknown task: {error.args[0]}") from error
    limits = {
        "max_model_calls": sessions.max_model_calls, "wall_time_ms": sessions.wall_time_ms, "build_output_bytes": sessions.build_output_bytes,
        "build_wall_ms": sessions.build_wall_ms, "tmp_bytes": sessions.tmp_bytes, "workspace_bytes": sessions.workspace_bytes,
        "memory_mb": sessions.memory_mb,
    }  # fmt: skip
    [case_id] = case_ids(CaseSet(plugin=manifest.id, task=task.id, cases=[Case(prompt="", arguments={})]))
    return {**case_set_frame(SESSION, manifest, sha256, task), "limits": limits, "case_id": case_id}
