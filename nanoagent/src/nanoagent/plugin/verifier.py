"""The deterministic verifier every plugin ships as the ``verifier/`` package.

A verifier is plain code, never a model: the same input (and the same workspace files) must
always give the same verdict. ``verifier/__init__.py`` defines three functions, each returning
``valid``/``score``/``message``/``details``; other modules in ``verifier/`` are imported
relatively (``from .ids import ARXIV_ID``), and the plugin's contract as ``contract``:

    def verify_input(tool, value): ...                                  # tool: its name
    def verify_output(tool, input_value, output_value, workspace): ...  # workspace: the folder path
    def verify_task(task, arguments, reference, workspace): ...  # once the whole task is done

Every value is an instance of its contract class (see :mod:`nanoagent.plugin.contract`), already
checked against its type: a verifier checks what a value means, never its shape.
``verify_input`` / ``verify_output`` check each tool call; ``verify_task`` checks the outcome of a
task, against ``reference``: the pinned output of the task's reference tool, or None. A result's
``details`` may hold contract instances and Enum members; they are recorded as their JSON.

Determinism is enforced twice. :func:`check_verifier` reads every module before anything runs:
each may import only :data:`ALLOWED_IMPORTS`, ``contract`` and its own package, and may not reach builtins that
load or run code, private attributes, or file-writing methods. Each call then runs in a fresh interpreter (see
``_verifier_sandbox.py``) with networking and process launching disabled and new imports
blocked, and the function is called twice: two different verdicts fail the run.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from nanoagent.plugin import sandbox

if TYPE_CHECKING:
    from nanoagent.plugin.manifest import PluginManifest

# Pure, deterministic standard-library modules: no clock, randomness, environment, network or
# processes.
ALLOWED_IMPORTS = frozenset(
    {
        "__future__",
        "collections",
        "dataclasses",
        "decimal",
        "difflib",
        "enum",
        "fractions",
        "functools",
        "hashlib",
        "itertools",
        "json",
        "math",
        "operator",
        "pathlib",
        "re",
        "statistics",
        "string",
        "textwrap",
        "typing",
        "unicodedata",
    }
)
# Builtins that load or run code, reach hidden state, or read the terminal.
FORBIDDEN_NAMES = frozenset(
    {
        "__import__",
        "breakpoint",
        "compile",
        "delattr",
        "eval",
        "exec",
        "getattr",
        "globals",
        "input",
        "locals",
        "open",
        "setattr",
        "vars",
    }
)
# Attributes that write files, or reach a module an allowed one imported (`pathlib.os`).
FORBIDDEN_ATTRIBUTES = frozenset(
    {
        "builtins",
        "chmod",
        "hardlink_to",
        "mkdir",
        "os",
        "rename",
        "rmdir",
        "shutil",
        "socket",
        "subprocess",
        "symlink_to",
        "sys",
        "touch",
        "unlink",
        "write_bytes",
        "write_text",
    }
)
# The two functions and their positional parameters.
SIGNATURES = {"verify_input": 2, "verify_output": 4, "verify_task": 4}
TIMEOUT = 60.0
_SANDBOX = Path(__file__).with_name("_verifier_sandbox.py")


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


def check_verifier(folder: Path) -> None:
    """Fail unless the package ``folder`` reads as a deterministic verifier (see the module docstring)."""
    problems = verifier_problems(folder)
    if problems:
        raise ValueError(f"{folder} is not a deterministic verifier: " + "; ".join(problems))


def verifier_problems(folder: Path) -> list[str]:
    """Every way the package ``folder`` falls short of a deterministic verifier."""
    init = folder / "__init__.py"
    if not init.is_file():
        return ["verifier/ has no __init__.py"]
    problems: list[str] = []
    for module in sorted(folder.rglob("*.py")):
        name = f"verifier/{module.relative_to(folder).as_posix()}"
        try:
            tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
        except SyntaxError as error:
            problems.append(f"{name}:{error.lineno}: not valid Python")
            continue
        problems += [f"{name}:{problem}" for problem in _problems(tree)]
        if module == init:
            problems += [f"{name}: {problem}" for problem in _missing_functions(tree)]
    return problems


def _problems(tree: ast.Module) -> list[str]:
    problems: list[str] = []
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        modules: list[str] = []
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0:
                modules = [node.module or ""]
            problems += [
                f"{line}: imports {alias.name!r}"
                for alias in node.names
                if alias.name.startswith("_") or alias.name in FORBIDDEN_ATTRIBUTES
            ]
        problems += [
            f"{line}: imports {module!r}"
            for module in modules
            if module.split(".")[0] not in ALLOWED_IMPORTS | {"contract"}
        ]
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            problems.append(f"{line}: uses {node.id}()")
        if isinstance(node, ast.Attribute) and (
            node.attr.startswith("_") or node.attr in FORBIDDEN_ATTRIBUTES
        ):
            problems.append(f"{line}: uses .{node.attr}")
    return problems


def _missing_functions(tree: ast.Module) -> list[str]:
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    problems: list[str] = []
    for name, count in SIGNATURES.items():
        function = functions.get(name)
        if function is None:
            problems.append(f"defines no {name}()")
        elif len(function.args.posonlyargs + function.args.args) != count:
            problems.append(f"{name}() must take {count} positional argument(s)")
    return problems

def verify_input(manifest: PluginManifest, tool: str, value: dict[str, Any]) -> Verification:
    return _call(manifest.root, "verify_input", [tool, value], [None, manifest.tool(tool).input_class], None)


def verify_output(
    manifest: PluginManifest,
    tool: str,
    input_value: dict[str, Any],
    output_value: dict[str, Any],
    workspace: Path,
) -> Verification:
    definition = manifest.tool(tool)
    return _call(
        manifest.root,
        "verify_output",
        [tool, input_value, output_value, str(workspace.resolve())],
        [None, definition.input_class, definition.output_class, None],
        workspace,
    )


def verify_task(
    manifest: PluginManifest,
    task: str,
    arguments: dict[str, Any],
    reference: dict[str, Any] | None,
    workspace: Path,
) -> Verification:
    definition = manifest.task(task)
    pinned = None if definition.reference is None else manifest.tool(definition.reference).output_class
    return _call(
        manifest.root,
        "verify_task",
        [task, arguments, reference, str(workspace.resolve())],
        [None, definition.input_class, pinned, None],
        workspace,
    )


def _call(
    root: Path, name: str, arguments: list[Any], classes: list[str | None], workspace: Path | None
) -> Verification:
    """Run ``name`` in the sandbox; each argument with a class is built into that contract class.
    The verifier may read ``workspace``, the run's folder, and write nothing."""
    folder = root.resolve() / "verifier"
    check_verifier(folder)
    request = {
        "verifier": str(folder),
        "contract": str(root.resolve() / "contract.py"),
        "function": name,
        "arguments": arguments,
        "classes": classes,
        "modules": sorted(ALLOWED_IMPORTS),
    }
    # -B: no __pycache__ written into the plugin.
    readable = [] if workspace is None else [workspace]
    with sandbox.launch([sys.executable, "-I", "-B", str(_SANDBOX)], root=root, env={}, readable=readable) as (argv, env):
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
