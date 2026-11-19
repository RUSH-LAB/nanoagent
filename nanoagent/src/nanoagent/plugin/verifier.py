"""Running a plugin's deterministic verifier, under the rules of the spec the plugin follows.

What a verifier is, the functions ``verifier/__init__.py`` defines and what its modules may
import and use, is the spec's (for v0001, :mod:`nanoagent.plugin.v0001.verifier`). Each call
re-reads the package under those rules, then runs in a fresh process (the ``verifier`` helper,
:mod:`nanoagent.helpers.verifier`) with networking and process launching disabled and only the
spec's ``VERIFIER_IMPORTS`` importable, and the function is called twice: two different verdicts
fail the run. Each argument with a contract class is built into that class first.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from slimconfig import build_output

from nanoagent import helpers
from nanoagent.plugin import sandbox
from nanoagent.plugin.manifest import spec_module

if TYPE_CHECKING:
    from nanoagent.plugin.manifest import PluginManifest

TIMEOUT = 60.0
# The explanation codes of a failed case, with the text shown for each.
TASK_VERIFIER_EXPLANATIONS = {
    "execution_failed": "The harness did not produce a result.",
    "refused_answer_case": "The harness refused a case that has an answer.",
    "answered_refusal_case": "The harness answered a case it should have refused.",
    "invalid_answer": "The answer does not have the shape the task requires.",
}
EXECUTION_FAILURES = frozenset({"nonzero_exit", "signaled", "timed_out", "invalid_result", "missing_result"})


class VerifierError(RuntimeError):
    """A verifier that did not give a valid result: the case score stays unavailable."""


@dataclass(frozen=True)
class Verification:
    valid: bool
    score: float
    message: str
    details: dict[str, Any]

    def __post_init__(self) -> None:
        if not isinstance(self.valid, bool):
            raise TypeError("verification valid must be a boolean")
        if not isinstance(self.score, (int, float)) or isinstance(self.score, bool):
            raise TypeError("verification score must be a number")
        if not 0 <= self.score <= 1:
            raise ValueError("verification score must be between 0 and 1")
        if not isinstance(self.message, str):
            raise TypeError("verification message must be a string")
        if not isinstance(self.details, dict):
            raise TypeError("verification details must be a mapping")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def verify_input(manifest: PluginManifest, tool: str, value: dict[str, Any]) -> Verification:
    return _call(manifest, "verify_input", [tool, value], [None, manifest.tool(tool).input_class], None)


def verify_output(
    manifest: PluginManifest,
    tool: str,
    input_value: dict[str, Any],
    output_value: dict[str, Any],
    workspace: Path,
) -> Verification:
    definition = manifest.tool(tool)
    return _call(
        manifest,
        "verify_output",
        [tool, input_value, output_value, str(workspace.resolve())],
        [None, definition.input_class, definition.output_class, None],
        workspace,
    )


def verify_task(
    manifest: PluginManifest,
    task: str,
    arguments: dict[str, Any],
    output: dict[str, Any],
    reference: dict[str, Any] | None,
    workspace: Path,
) -> Verification:
    definition = manifest.task(task)
    pinned = None if definition.reference is None else manifest.tool(definition.reference).output_class
    return _call(
        manifest,
        "verify_task",
        [task, arguments, output, reference, str(workspace.resolve())],
        [None, definition.input_class, definition.output_class, pinned, None],
        workspace,
    )


def _call(
    manifest: PluginManifest, name: str, arguments: list[Any], classes: list[Any], workspace: Path | None
) -> Verification:
    result = _run(manifest, name, arguments, classes, workspace)
    try:
        return Verification(
            valid=result["valid"],
            score=result["score"],
            message=result["message"],
            details=result["details"],
        )
    except KeyError as error:
        raise ValueError(f"{name}() result is missing {error.args[0]!r}") from error


def _run(
    manifest: PluginManifest, name: str, arguments: list[Any], classes: list[Any], workspace: Path | None
) -> dict[str, Any]:
    """Run ``name`` in the sandbox; each argument with a class is built into that contract class
    (a mapping argument may name a class per key). The verifier may read ``workspace``, the run's folder,
    and write nothing. Returns the function's mapping."""
    root = manifest.root.resolve()
    folder = root / "verifier"
    rules = spec_module(manifest.spec)
    problems = rules.verifier_problems(folder)
    if problems:
        raise ValueError(f"{folder} is not a deterministic verifier: " + "; ".join(problems))
    request = {
        "verifier": str(folder),
        "contract": str(root / "contract.py"),
        "function": name,
        "arguments": arguments,
        "classes": classes,
        "modules": sorted(rules.VERIFIER_IMPORTS),
    }
    readable = [] if workspace is None else [workspace]
    with sandbox.launch(helpers.command("verifier"), root=root, env={}, readable=readable) as (argv, env):
        completed = subprocess.run(
            argv,
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            cwd=folder.parent,
            env=env,
            check=False,
        )
    if completed.returncode:
        reason = completed.stderr.strip().splitlines()[-1:] or [f"exit {completed.returncode}"]
        raise RuntimeError(f"verifier {name}() failed: {reason[0]}")
    result = json.loads(completed.stdout)
    if not isinstance(result, dict):
        raise TypeError(f"{name}() must return a mapping")
    return result


@dataclass(frozen=True)
class CaseVerdict:
    """``score`` is 1.0 for a pass and 0.0 for a fail; ``explanation`` is a :data:`TASK_VERIFIER_EXPLANATIONS` code or None."""

    verdict: str
    score: float
    explanation: str | None


def verify_task_verifier_case(
    manifest: PluginManifest,
    task: str,
    arguments: dict[str, Any],
    outcome: dict[str, Any],
    reference: dict[str, Any] | str | None,
    workspace: Path,
) -> CaseVerdict:
    """One case's verdict from the plugin's ordinary :func:`verify_task`. A refusal case pins its reference error (a string),
    an answer case its reference output (a mapping) or None for a task the verifier judges without one; anything else
    raises :class:`VerifierError`. An answer to an answer case passes when ``verify_task`` calls it valid; a refusal passes
    only on a refusal case (its reason is not judged); everything else fails with an explanation code."""
    _check_outcome(outcome)
    if reference is not None and not isinstance(reference, (str, dict)):
        raise VerifierError(f"a case pins a reference output, a reference error or no reference, not {reference!r}")
    refusal_case = isinstance(reference, str)
    status = outcome["status"]
    if status == "execution_failed":
        return _fail("execution_failed")
    if status == "refused":
        return _pass() if refusal_case else _fail("refused_answer_case")
    if refusal_case:
        return _fail("answered_refusal_case")
    try:
        build_output(outcome["answer"], manifest.task(task).output_type)
    except (TypeError, ValueError):
        return _fail("invalid_answer")
    try:
        verdict = verify_task(manifest, task, arguments, outcome["answer"], reference, workspace)
    except (RuntimeError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
        raise VerifierError(f"verify_task() gave no valid result: {error}") from error
    return _pass() if verdict.valid else _fail(None)


def _pass() -> CaseVerdict:
    return CaseVerdict("pass", 1.0, None)


def _fail(explanation: str | None) -> CaseVerdict:
    return CaseVerdict("fail", 0.0, explanation)


def _check_outcome(outcome: dict[str, Any]) -> None:
    status = outcome.get("status")
    expected = {"answered": {"answer"}, "refused": {"reason"}, "execution_failed": {"reason"}}.get(status)
    if expected is None or set(outcome) != {"status"} | expected:
        raise ValueError(f"benchmark outcome {outcome!r} is not answered, refused or execution_failed")
    if status == "execution_failed" and outcome["reason"] not in EXECUTION_FAILURES:
        raise ValueError(f"execution failure reason {outcome['reason']!r} is not one of {sorted(EXECUTION_FAILURES)}")
