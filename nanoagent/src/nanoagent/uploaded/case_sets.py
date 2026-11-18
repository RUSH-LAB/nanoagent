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

from slimconfig import Output, build_output

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
        "context": cases.context,
        "cases": published,
        "private": references,
    }


# The case set of one session in a plugin page's Harness tab: one case, the member's request.
SESSION = "harness-session"


async def session_case_set(model: DecisionModel, manifest, sha256: str, task_id: str, text: str, timeout: float) -> dict[str, Any]:
    """The case set of a Harness tab session: one case to answer, whose input ``model`` fills from ``text``, the member's
    request, as the plugin's Session agent fills a task's input from theirs; ``text`` is its context, so a coding harness
    reads the request as the member wrote it. Pinned like any case set (:func:`derive_case_set`)."""
    try:
        task = manifest.task(task_id)
    except KeyError as error:
        raise PreparationError(f"{manifest.id} has an unknown task: {error.args[0]}") from error
    system = f"You turn a request to the {manifest.name} plugin into the input of its task: {task.description}.\n{task.instructions}"
    answer = await model.answer([{"role": "system", "content": system}, {"role": "user", "content": text}], name=task.id, schema=task.input)
    cases = CaseSet(plugin=manifest.id, task=task.id, context=text, answer=[answer.value], refuse=[])
    return await asyncio.to_thread(derive_case_set, SESSION, cases, manifest, sha256, timeout)
