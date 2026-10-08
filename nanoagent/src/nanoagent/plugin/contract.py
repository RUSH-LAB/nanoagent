"""A plugin's ``contract.py``: its tools' and tasks' typed input and output, as slimconfig classes.

The contract is the one place a plugin's data shapes are declared. The host, the plugin's MCP
server and the verifier all check every value against it with :func:`slimconfig.build_output`,
and every JSON Schema (for MCP, the agent and the web) is :func:`slimconfig.output_schema` of
its classes. It declares:

    class Tool(Enum):            # every tool, by name: the keys of nanoagent.yaml's `tools`
        SOLVE = "solve"

    class Task(Enum):            # every task, by id: the keys of nanoagent.yaml's `tasks`
        SUGGEST_MEAL = "suggest-meal"

    @dataclass
    class SolveInput(Output):    # slimconfig Output classes; Annotated[T, "text"] describes a field
        meal: Annotated[Meal, "The meal to suggest"]

    TOOLS = {Tool.SOLVE: (SolveInput, SolveOutput)}   # each tool's input and output class
    TASKS = {Task.SUGGEST_MEAL: SolveInput}           # each task's input class

It is run inside the host, so it may hold only declarations (see :func:`contract_problems`):
imports from :data:`CONTRACT_IMPORTS`, classes of annotated fields and constant members, and
assignments of names, constants and containers of them. No ``from __future__ import
annotations``: the classes' annotations are evaluated once, when the contract loads, because
the module is registered as ``contract`` only while it loads.
"""

from __future__ import annotations

import ast
import dataclasses
import enum
import importlib.util
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any

from slimconfig import Output, output_schema

from nanoagent.plugin.verifier import FORBIDDEN_NAMES

CONTRACT = "contract.py"
MODULE = "contract"  # the name nanoagent.yaml, the server and the verifier import it by
CONTRACT_IMPORTS = frozenset({"dataclasses", "enum", "typing", "slimconfig"})
# The expressions a declaration is made of: names, constants, subscripts, `X | Y`, containers.
_EXPRESSIONS = (
    ast.Name,
    ast.Attribute,
    ast.Constant,
    ast.Subscript,
    ast.Tuple,
    ast.List,
    ast.Dict,
    ast.BinOp,
    ast.BitOr,
    ast.expr_context,
)


@dataclasses.dataclass(frozen=True)
class Contract:
    tools: dict[str, tuple[type, type]]  # tool name -> (input class, output class)
    tasks: dict[str, type]  # task id -> input class


def contract_problems(path: Path) -> list[str]:
    """Every way ``contract.py`` holds more than declarations."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as error:
        return [f"{CONTRACT}:{error.lineno}: not valid Python"]
    problems: list[str] = []
    for node in tree.body:
        problems += [f"{CONTRACT}:{getattr(node, 'lineno', 0)}: {problem}" for problem in _statement(node, top=True)]
    return problems


def _statement(node: ast.stmt, *, top: bool) -> list[str]:
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
        return []  # a docstring
    if isinstance(node, ast.Pass):
        return []
    if top and isinstance(node, ast.Import | ast.ImportFrom):
        modules = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""]
        problems = [
            f"imports {module!r}: a contract imports only {', '.join(sorted(CONTRACT_IMPORTS))}"
            for module in modules
            if isinstance(node, ast.ImportFrom) and node.level or module.split(".")[0] not in CONTRACT_IMPORTS
        ]
        return problems + [f"imports {alias.name!r}" for alias in node.names if alias.name.startswith("_")]
    if top and isinstance(node, ast.ClassDef):
        problems = [] if not node.keywords else ["a class takes no keywords"]
        problems += [problem for decorator in node.decorator_list for problem in _decorator(decorator)]
        problems += [problem for base in node.bases for problem in _expression(base)]
        return problems + [problem for item in node.body for problem in _statement(item, top=False)]
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        if node.value is not None:
            return [f"{node.target.id} has a default: every field is required"]
        return _expression(node.annotation)
    if isinstance(node, ast.Assign) and all(isinstance(target, ast.Name) for target in node.targets):
        return _expression(node.value)
    return [f"holds a {type(node).__name__}: a contract holds only declarations"]


def _decorator(node: ast.expr) -> list[str]:
    if isinstance(node, ast.Name) and node.id == "dataclass":
        return []
    if isinstance(node, ast.Attribute) and node.attr == "dataclass":
        return []
    return ["a class is decorated only with @dataclass, without arguments"]


def _expression(node: ast.expr) -> list[str]:
    problems: list[str] = []
    for part in ast.walk(node):
        if not isinstance(part, _EXPRESSIONS) or isinstance(part, ast.BinOp) and not isinstance(part.op, ast.BitOr):
            problems.append(f"uses a {type(part).__name__}: a contract holds only declarations")
        elif isinstance(part, ast.Name) and (part.id in FORBIDDEN_NAMES or part.id.startswith("_")):
            problems.append(f"uses {part.id}")
        elif isinstance(part, ast.Attribute) and part.attr.startswith("_"):
            problems.append(f"uses .{part.attr}")
    return problems


@contextmanager
def contract_module(root: Path) -> Iterator[ModuleType]:
    """Run ``root/contract.py`` as the module ``contract`` for the duration of the block."""
    spec = importlib.util.spec_from_file_location(MODULE, root / CONTRACT)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {root / CONTRACT}")
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get(MODULE)
    sys.modules[MODULE] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        if previous is None:
            sys.modules.pop(MODULE, None)
        else:
            sys.modules[MODULE] = previous


def read_contract(module: ModuleType) -> tuple[Contract | None, list[str]]:
    """The contract ``module`` declares, and every way it falls short of one."""
    names = vars(module)
    violations: list[str] = []
    enums: dict[str, type[enum.Enum]] = {}
    for name in ("Tool", "Task"):
        found = names.get(name)
        if not (isinstance(found, type) and issubclass(found, enum.Enum)):
            violations.append(f"{CONTRACT} declares no {name} Enum")
        elif not all(isinstance(member.value, str) for member in found):
            violations.append(f"{CONTRACT} {name} members must have str values")
        else:
            enums[name] = found
    tools = _table(names, "TOOLS", enums.get("Tool"), violations, pair=True)
    tasks = _table(names, "TASKS", enums.get("Task"), violations, pair=False)
    if violations:
        return None, violations
    return Contract(tools, tasks), []


def _table(names: dict[str, Any], table: str, keys: type[enum.Enum] | None, violations: list[str], *, pair: bool) -> Any:
    found = names.get(table)
    shape = "(input class, output class)" if pair else "an input class"
    if keys is None:
        return {}
    if not isinstance(found, dict) or set(found) != set(keys):
        violations.append(f"{CONTRACT} {table} must map every {keys.__name__} member to {shape}")
        return {}
    out: dict[str, Any] = {}
    for member, value in found.items():
        classes = value if pair else (value,)
        if pair and not (isinstance(value, tuple) and len(value) == 2):
            violations.append(f"{CONTRACT} {table}[{member.value!r}] must be {shape}")
            continue
        for cls in classes:
            problem = _output_problem(cls)
            if problem:
                violations.append(f"{CONTRACT} {table}[{member.value!r}]: {problem}")
        out[member.value] = value
    return out


def _output_problem(cls: Any) -> str | None:
    if not (isinstance(cls, type) and dataclasses.is_dataclass(cls) and issubclass(cls, Output)):
        return f"{cls!r} is not a slimconfig Output class"
    try:
        output_schema(cls)
    except TypeError as error:
        return str(error)
    return None
