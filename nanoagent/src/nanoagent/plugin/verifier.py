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

from nanoagent import helpers
from nanoagent.plugin import sandbox
from nanoagent.plugin.manifest import spec_module

if TYPE_CHECKING:
    from nanoagent.plugin.manifest import PluginManifest

TIMEOUT = 60.0


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
    manifest: PluginManifest, name: str, arguments: list[Any], classes: list[str | None], workspace: Path | None
) -> Verification:
    """Run ``name`` in the sandbox; each argument with a class is built into that contract class.
    The verifier may read ``workspace``, the run's folder, and write nothing."""
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
    try:
        return Verification(
            valid=result["valid"],
            score=result["score"],
            message=result["message"],
            details=result["details"],
        )
    except KeyError as error:
        raise ValueError(f"{name}() result is missing {error.args[0]!r}") from error
