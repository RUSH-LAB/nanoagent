"""Deriving a benchmark case set's publication, as the CLI (examples/uploaded_benchmark's step 1) and RUSH Lab's Publish
benchmark screen both do it. Every field of the body for RUSH's `POST /api/benchmark/case-sets` comes from the plugin
package and the plugin benchmark's case file; the member supplies only those and a name. Each case's private reference is
pinned once, by running the task's reference tool on the plugin's installed package. Anything the verifier could not judge
deterministically fails preparation with a message that says what to change. Nothing here reaches the network."""

import asyncio
import json
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from slimconfig import Config, Output, build_output

from nanoagent.core.agent import DecisionModel
from nanoagent.plugin.runtime import call_tool_async

NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}")


class PreparationError(Exception):
    """The case file and the plugin cannot make a case set, and why."""


@dataclass
class Refusal:
    """A case to refuse: its input, and text the pinning tool's error holds when it rejects it."""

    arguments: dict[str, Any]
    reference_error: str


@dataclass
class CaseSet:
    """One task of one plugin, and its inputs: to answer, and to refuse."""

    plugin: str
    task: str
    # What a coding agent is told that the task's input does not say: its universe and data source.
    context: str
    answer: list[dict[str, Any]]
    refuse: list[Refusal]

    def case(self, id: str) -> tuple[dict[str, Any], Refusal | None]:
        """The input of case ``id`` (<plugin>-<n>, the inputs to answer first), and its refusal when it
        is a case to refuse."""
        inputs = [(arguments, None) for arguments in self.answer] + [(refusal.arguments, refusal) for refusal in self.refuse]
        ids = [f"{self.plugin}-{index:02d}" for index in range(1, len(inputs) + 1)]
        if id not in ids:
            raise ValueError(f"{self.plugin}'s cases are {ids[0]} to {ids[-1]}, not {id}")
        return inputs[ids.index(id)]


@dataclass
class CaseSetSpec(Output):
    """What RUSH Lab's Publish benchmark screen sends to the member's own NanoAgent: the case file and the case set's name;
    the package is the one installed there."""

    cases: CaseSet
    name: str


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


async def pin(
    manifest, tool: str | None, arguments: dict[str, Any], refusal: Refusal | None, timeout: float
) -> tuple[dict[str, Any] | None, str | None]:
    """``tool``'s answer to a case to answer, or its rejection of a case to refuse, which must hold
    the text the cases file names; (None, None) for a task with no tool to pin it."""
    if tool is None:
        return None, None
    with tempfile.TemporaryDirectory() as scratch:
        try:
            output = await call_tool_async(manifest, tool, arguments, workspace=Path(scratch), timeout=timeout)
        # A tool's own failure, or the plugin's input verification refusing the input.
        except (RuntimeError, ValueError) as error:
            if refusal is None:
                raise RuntimeError(f"{tool} could not answer {json.dumps(arguments)}, a case to answer: {error}") from error
            if refusal.reference_error not in str(error):
                raise RuntimeError(f"{tool} rejected {json.dumps(arguments)} without {refusal.reference_error!r}: {error}") from error
            return None, str(error)
    if refusal is not None:
        raise RuntimeError(f"{tool} answered {json.dumps(arguments)}, a case to refuse")
    return output, None


def case_ids(cases: CaseSet) -> list[str]:
    return [f"{cases.plugin}-{number:02d}" for number in range(1, len(cases.answer) + len(cases.refuse) + 1)]


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
        raise PreparationError(f"the cases file for {cases.plugin} {cases.task} has no cases: both `answer` and `refuse` are empty")
    for case in case_ids(cases):
        arguments, refusal = cases.case(case)
        try:
            build_output(arguments, task.input_type)
        except (TypeError, ValueError) as error:
            raise PreparationError(f"case {case}: its arguments do not fit the input of task {task.id}: {error}") from error
        if refusal is not None and not refusal.reference_error:
            raise PreparationError(f"case {case}: a case to refuse names no reference_error, so a refusal for the wrong reason would pass")
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


def derive_case_set(name: str, cases: CaseSet, manifest, sha256: str, timeout: float) -> dict[str, Any]:
    """The body of `POST /api/benchmark/case-sets` for the plugin ``manifest`` (the package with ``sha256``), with every
    case pinned by the task's reference tool, the private references in ``private``.

    Raises :class:`PreparationError` for a case file that does not fit the plugin: no cases, arguments that break the task's
    input schema, a case the reference tool cannot answer or answers though it is to be refused, a refusal whose error
    differs from the one expected, and a case to refuse in a task without a reference tool to confirm the refusal."""
    task = check_cases(manifest, cases, name)
    tool = reference_tool(task)
    if tool is None and cases.refuse:
        first = case_ids(cases)[len(cases.answer)]
        raise PreparationError(
            f"case {first}: task {task.id} has no reference tool, so nothing can confirm that its input is to be refused "
            f"or that the error {cases.refuse[0].reference_error!r} is the right one; declare a reference tool in the manifest or remove the cases to refuse"
        )
    references: dict[str, Any] = {}
    published: list[dict[str, Any]] = []
    for case in case_ids(cases):
        arguments, refusal = cases.case(case)
        try:
            reference, rejection = asyncio.run(pin(manifest, tool, arguments, refusal, timeout))
        except RuntimeError as error:
            raise PreparationError(f"case {case}: {error}") from error
        references[case] = rejection if refusal is not None else reference
        published.append(
            {
                "case_id": case,
                "kind": "answer" if refusal is None else "refuse",
                "arguments": arguments,
                "expected_error": None if refusal is None else refusal.reference_error,
            }
        )
        print(f"pinned {case}")
    return {**case_set_frame(name, manifest, sha256, task, cases.context), "cases": published, "private": references}


def case_set_frame(name: str, manifest, sha256: str, task, context: str) -> dict[str, Any]:
    """What a case set of ``task`` says but its cases: the plugin, the task and the context, all from ``manifest``."""
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
            "instructions": task.instructions,
            "input_schema": task.input,
            "output_schema": task.output,
            "tools": task_tools(manifest, task),
            # The HTTPS hosts the plugin's processes may reach (CONNECT host:443 through the egress proxy); none means no egress.
            "egress_hosts": sorted(set(manifest.permissions.network_hosts)),
        },
        "context": context,
    }


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
    # The output tokens the plugin's model may spend filling a session's case from the request, its reasoning included.
    fill_max_tokens: int = 16_384

    def __post_init__(self) -> None:
        for name in (
            "max_model_calls",
            "wall_time_ms",
            "build_output_bytes",
            "build_wall_ms",
            "tmp_bytes",
            "workspace_bytes",
            "memory_mb",
            "fill_max_tokens",
        ):
            if getattr(self, name) < 1:
                raise ValueError(f"sessions.{name} must be >= 1, got {getattr(self, name)}")


def session_task(manifest, task_id: str) -> Any:
    try:
        return manifest.task(task_id)
    except KeyError as error:
        raise PreparationError(f"{manifest.id} has an unknown task: {error.args[0]}") from error


def session_frame(manifest, sha256: str, task_id: str, text: str, sessions: SessionsConfig) -> dict[str, Any]:
    """A Harness tab session's case set but its case (and that case's id, ``case_id``), read from ``manifest`` at once: RUSH queues
    the session's run on it while :func:`session_case_set` fills and pins the case, whose case set has this same frame."""
    task = session_task(manifest, task_id)
    limits = {
        "max_model_calls": sessions.max_model_calls, "wall_time_ms": sessions.wall_time_ms, "build_output_bytes": sessions.build_output_bytes,
        "build_wall_ms": sessions.build_wall_ms, "tmp_bytes": sessions.tmp_bytes, "workspace_bytes": sessions.workspace_bytes,
        "memory_mb": sessions.memory_mb,
    }  # fmt: skip
    frame = {**case_set_frame(SESSION, manifest, sha256, task, text), "limits": limits}
    [case_id] = case_ids(CaseSet(plugin=manifest.id, task=task.id, context=text, answer=[{}], refuse=[]))
    return {**frame, "case_id": case_id}


async def session_case_set(
    model: DecisionModel, manifest, sha256: str, task_id: str, text: str, timeout: float, sessions: SessionsConfig
) -> dict[str, Any]:
    """The case set of a Harness tab session: one case to answer, whose input ``model`` fills from ``text``, the member's
    request, as the plugin's Session agent fills a task's input from theirs; ``text`` is its context, so a coding harness
    reads the request as the member wrote it. Pinned like any case set (:func:`derive_case_set`), on the frame
    :func:`session_frame` gives."""
    task = session_task(manifest, task_id)
    system = f"You turn a request to the {manifest.name} plugin into the input of its task: {task.description}.\n{task.instructions}"
    try:
        answer = await model.answer([{"role": "system", "content": system}, {"role": "user", "content": text}], name=task.id, schema=task.input)
    except ValueError as error:  # the backend's refusal of an answer cut off, not JSON or not an object
        raise PreparationError(f"the model could not make task {task.id}'s input from the request: {error}") from error
    cases = CaseSet(plugin=manifest.id, task=task.id, context=text, answer=[answer.value], refuse=[])
    publication = await asyncio.to_thread(derive_case_set, SESSION, cases, manifest, sha256, timeout)
    return {**publication, **session_frame(manifest, sha256, task_id, text, sessions)}
