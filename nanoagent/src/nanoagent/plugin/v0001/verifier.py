"""What a v0001 plugin's ``verifier/`` package is: a deterministic verifier (rule 6).

A verifier is plain code, never a model: the same input (and the same workspace files) must
always give the same verdict. ``verifier/__init__.py`` defines three functions, each returning
``valid``/``score``/``message``/``details``; other modules in ``verifier/`` are imported
relatively (``from .ids import ARXIV_ID``), and the plugin's contract as ``contract``:

    def verify_input(tool, value): ...                                  # tool: its name
    def verify_output(tool, input_value, output_value, workspace): ...  # workspace: the folder path
    def verify_task(task, arguments, output, reference, workspace): ...  # once the task is done

Every value is an instance of its contract class (see :mod:`nanoagent.plugin.v0001.contract`),
already checked against its type: a verifier checks what a value means, never its shape.
``verify_input`` / ``verify_output`` check each tool call; ``verify_task`` checks a task's
``output``, against ``reference``: the pinned output of the task's reference tool, or None. A result's
``details`` may hold contract instances and Enum members; they are recorded as their JSON.

Determinism is enforced twice. :func:`verifier_problems` reads every module before anything runs:
each may import only :data:`ALLOWED_IMPORTS`, ``contract`` and its own package, and may not reach builtins that
load or run code, private attributes, or file-writing methods. NanoAgent then runs each call
(:mod:`nanoagent.plugin.verifier`) in a fresh process with networking and process launching
disabled and only :data:`ALLOWED_IMPORTS` importable, twice: two different verdicts fail the run.
"""

from __future__ import annotations

import ast
from pathlib import Path

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
SIGNATURES = {"verify_input": 2, "verify_output": 4, "verify_task": 5}


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
