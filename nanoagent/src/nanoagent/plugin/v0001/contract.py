"""A plugin's ``contract.py``: its tools' and tasks' typed input and output, as slimconfig classes.

The contract is the one place a plugin's data shapes are declared. The host, the plugin's MCP
server and the verifier all check every value against it with :func:`slimconfig.build_output`,
and every JSON Schema (for MCP, the agent and the web) is :func:`slimconfig.output_schema` of
its classes. It declares:

    class Tool(Enum):            # every tool, by name: the keys of nanoagent.yaml's `tools`
        SOLVE_MEAL = "solve_meal"

    class Task(Enum):            # every task, by id: the keys of nanoagent.yaml's `tasks`
        SUGGEST_MEAL = "suggest-meal"

    @dataclass
    class SolveInput(Output):    # slimconfig Output classes; Annotated[T, "text"] describes a field
        meal: Annotated[Meal, "The meal to suggest"]

    TOOLS = {Tool.SOLVE_MEAL: (SolveInput, SolveOutput)}      # each tool's input and output class
    TASKS = {Task.SUGGEST_MEAL: (SolveInput, SolveOutput)}    # each task's input and output class

It is run inside the host, so it may hold only declarations (see :func:`contract_problems`):
imports of the names in :data:`CONTRACT_IMPORTS`, classes of annotated fields and constant
members, and assignments of names, constants and containers of them. No ``from __future__ import
annotations``: the classes' annotations are evaluated once, when the contract loads, because
the module is registered as ``contract`` only while it loads.
"""

from __future__ import annotations

import ast
import dataclasses
import enum
import importlib.util
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any

from slimconfig import Output, output_schema

from nanoagent.plugin.v0001.verifier import FORBIDDEN_ATTRIBUTES, FORBIDDEN_NAMES

CONTRACT = "contract.py"
MODULE = "contract"  # the name nanoagent.yaml, the server and the verifier import it by
# The names a contract may import, per module: an allowlist of names, never what a module re-exports.
CONTRACT_IMPORTS = {
    "dataclasses": frozenset({"dataclass"}),
    "enum": frozenset({"Enum", "IntEnum", "StrEnum"}),
    "slimconfig": frozenset({"Output"}),
    "typing": frozenset({"Annotated", "Any", "Literal", "Optional", "Union"}),
}
_SUBSCRIPTABLE = frozenset({"typing.Annotated", "typing.Literal", "typing.Optional", "typing.Union"})
_BUILTIN_GENERICS = frozenset({"dict", "frozenset", "list", "set", "tuple"})
_BUILTIN_TYPES = _BUILTIN_GENERICS | {"bool", "bytes", "float", "int", "str"}
_MODULE, _IMPORTED, _CLASS, _VALUE = "module", "import", "class", "value"
# Every contract is the one module `contract` while it loads, so two plugins never load at once.
_LOADING = threading.Lock()


@dataclasses.dataclass(frozen=True)
class Contract:
    tools: dict[str, tuple[type, type]]  # tool name -> (input class, output class)
    tasks: dict[str, tuple[type, type]]  # task id -> (input class, output class)


def contract_problems(path: Path) -> list[str]:
    """Every way ``contract.py`` holds more than declarations.

    The grammar is an allowlist, because the contract runs in the host: a docstring; imports of
    the names in :data:`CONTRACT_IMPORTS`; classes (bare ``@dataclass`` or none, bases that are
    imported or earlier classes) whose bodies are a docstring, annotated fields without defaults
    and ``NAME = <constant>`` members; and ``NAME = <names, constants, containers, Class.MEMBER>``.
    Only an annotation is subscripted, and only by ``Annotated``, ``Literal``, ``Optional``,
    ``Union`` or a builtin container. No name or attribute starts with ``_``, none is rebound,
    and none is in the verifier's denylists.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as error:
        return [f"{CONTRACT}:{error.lineno}: not valid Python"]
    problems: list[str] = []
    bound: dict[str, tuple[str, str]] = {}  # name -> (kind, what it is)
    for node in tree.body:
        problems += [f"{CONTRACT}:{getattr(node, 'lineno', 0)}: {problem}" for problem in _statement(node, bound, top=True)]
    return problems


def _statement(node: ast.stmt, bound: dict[str, tuple[str, str]], *, top: bool) -> list[str]:
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
        return []  # a docstring
    if isinstance(node, ast.Pass):
        return []
    if top and isinstance(node, ast.Import | ast.ImportFrom):
        return _import(node, bound)
    if top and isinstance(node, ast.ClassDef):
        return _class(node, bound)
    if isinstance(node, ast.AnnAssign) and not top and isinstance(node.target, ast.Name) and node.simple:
        if node.value is not None:
            return [f"{node.target.id} has a default: every field is required"]
        return _target(node.target.id) + _annotation(node.annotation, bound)
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        name = node.targets[0].id
        if not top:
            return _target(name) + _member(node.value)
        return _target(name) + (_value(node.value, bound) or _bind(bound, name, (_VALUE, name)))
    return [f"holds a {type(node).__name__}: a contract holds only declarations"]


def _target(name: str) -> list[str]:
    return [f"assigns {name}: no name starts with _"] if name.startswith("_") else []


def _bind(bound: dict[str, tuple[str, str]], name: str, what: tuple[str, str]) -> list[str]:
    if name in bound:
        return [f"redefines {name}"]
    bound[name] = what
    return []


def _import(node: ast.Import | ast.ImportFrom, bound: dict[str, tuple[str, str]]) -> list[str]:
    modules = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""]
    problems = [
        f"imports {module!r}: a contract imports only {', '.join(sorted(CONTRACT_IMPORTS))}"
        for module in modules
        if isinstance(node, ast.ImportFrom) and node.level or module not in CONTRACT_IMPORTS
    ]
    if problems:
        return problems
    for alias in node.names:
        if alias.asname is not None:
            problems.append(f"imports {alias.name!r} as {alias.asname!r}: an import is not renamed")
        elif isinstance(node, ast.Import):
            problems += _bind(bound, alias.name, (_MODULE, alias.name))
        elif alias.name in CONTRACT_IMPORTS[node.module or ""] and alias.name not in FORBIDDEN_NAMES | FORBIDDEN_ATTRIBUTES:
            problems += _bind(bound, alias.name, (_IMPORTED, f"{node.module}.{alias.name}"))
        else:
            problems.append(
                f"imports {alias.name!r}: a contract imports only {', '.join(sorted(CONTRACT_IMPORTS[node.module or '']))} from {node.module}"
            )
    return problems


def _class(node: ast.ClassDef, bound: dict[str, tuple[str, str]]) -> list[str]:
    problems = _target(node.name)
    problems += [] if not node.keywords else ["a class takes no keywords"]
    problems += ["a class takes no type parameters"] if node.type_params else []
    for decorator in node.decorator_list:
        problems += (
            [] if _reference(decorator, bound) == "dataclasses.dataclass" else ["a class is decorated only with @dataclass, without arguments"]
        )
    for base in node.bases:
        problems += (
            _name_or_member(base, bound) if isinstance(base, ast.Name | ast.Attribute) else [f"uses a {type(base).__name__}: a base is a name"]
        )
    problems += [problem for item in node.body for problem in _statement(item, bound, top=False)]
    return problems + (_bind(bound, node.name, (_CLASS, node.name)) if not problems else [])


def _reference(node: ast.expr, bound: dict[str, tuple[str, str]]) -> str | None:
    """What ``node`` names among what a contract may reach (``typing.Annotated``, ``builtins.list``, a class), else None."""
    if isinstance(node, ast.Name) and not node.id.startswith("_") and node.id not in FORBIDDEN_NAMES:
        kind, what = bound.get(node.id, (None, node.id if node.id in _BUILTIN_TYPES else ""))
        if kind == _IMPORTED:
            return what
        if kind in (_CLASS, _VALUE):
            return f"{kind}:{what}"
        return f"builtins.{what}" if what and kind is None else None
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        if node.attr.startswith("_") or node.attr in FORBIDDEN_ATTRIBUTES:
            return None
        kind, what = bound.get(node.value.id, (None, ""))
        if kind == _MODULE and node.attr in CONTRACT_IMPORTS[what]:
            return f"{what}.{node.attr}"
    return None


def _name_or_member(node: ast.expr, bound: dict[str, tuple[str, str]]) -> list[str]:
    if _reference(node, bound) is not None:
        return []
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and bound.get(node.value.id, ("",))[0] == _CLASS:
        if not (node.attr.startswith("_") or node.attr in FORBIDDEN_ATTRIBUTES):
            return []  # Class.MEMBER
    return [f"uses {ast.unparse(node)}: a contract reaches only the names it defines or imports from {', '.join(sorted(CONTRACT_IMPORTS))}"]


def _plain(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and (node.value is None or type(node.value) in (str, int, float, bool))


def _member(node: ast.expr) -> list[str]:
    """A class body's ``NAME = value``: a constant or a tuple of them."""
    if _plain(node) or isinstance(node, ast.Tuple) and all(_plain(item) for item in node.elts):
        return []
    return [f"uses a {type(node).__name__}: a member is a constant"]


def _value(node: ast.expr, bound: dict[str, tuple[str, str]]) -> list[str]:
    """A top-level assignment's value: constants, defined names, ``Class.MEMBER`` and containers of them."""
    if _plain(node):
        return []
    if isinstance(node, ast.Name | ast.Attribute):
        return _name_or_member(node, bound)
    if isinstance(node, ast.Tuple | ast.List):
        return [problem for item in node.elts for problem in _value(item, bound)]
    if isinstance(node, ast.Dict) and all(key is not None for key in node.keys):
        return [problem for item in [*node.keys, *node.values] if item is not None for problem in _value(item, bound)]
    return [f"uses a {type(node).__name__}: a contract holds only declarations"]


def _annotation(node: ast.expr, bound: dict[str, tuple[str, str]]) -> list[str]:
    """A field's annotation: names, ``X | Y`` and subscripts by ``Annotated``, ``Literal``, ``Optional``, ``Union`` or a builtin container."""
    if isinstance(node, ast.Constant) and node.value is None:
        return []
    if isinstance(node, ast.Name | ast.Attribute):
        return _name_or_member(node, bound)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        return _annotation(node.left, bound) + _annotation(node.right, bound)
    if isinstance(node, ast.Subscript):
        reference = _reference(node.value, bound)
        args = node.slice.elts if isinstance(node.slice, ast.Tuple) else [node.slice]
        if reference == "typing.Annotated" and len(args) >= 2:
            return _annotation(args[0], bound) + [
                p for arg in args[1:] for p in ([] if _plain(arg) else [f"uses a {type(arg).__name__}: Annotated text is a constant"])
            ]
        if reference == "typing.Literal":
            return [p for arg in args for p in ([] if _plain(arg) else [f"uses a {type(arg).__name__}: Literal holds constants"])]
        if reference in _SUBSCRIPTABLE - {"typing.Annotated", "typing.Literal"} or reference in {f"builtins.{name}" for name in _BUILTIN_GENERICS}:
            return [problem for arg in args for problem in _annotation(arg, bound)]
        return [f"subscripts {ast.unparse(node.value)}: only Annotated, Literal, Optional, Union and builtin containers are subscripted"]
    return [f"uses a {type(node).__name__}: a contract holds only declarations"]


@contextmanager
def contract_module(root: Path) -> Iterator[ModuleType]:
    """Run ``root/contract.py`` as the module ``contract`` for the duration of the block, one plugin at a time."""
    spec = importlib.util.spec_from_file_location(MODULE, root / CONTRACT)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {root / CONTRACT}")
    module = importlib.util.module_from_spec(spec)
    with _LOADING:
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
    tools = _table(names, "TOOLS", enums.get("Tool"), violations)
    tasks = _table(names, "TASKS", enums.get("Task"), violations)
    if violations:
        return None, violations
    return Contract(tools, tasks), []


def _table(names: dict[str, Any], table: str, keys: type[enum.Enum] | None, violations: list[str]) -> Any:
    found = names.get(table)
    shape = "(input class, output class)"
    if keys is None:
        return {}
    if not isinstance(found, dict) or set(found) != set(keys):
        violations.append(f"{CONTRACT} {table} must map every {keys.__name__} member to {shape}")
        return {}
    out: dict[str, Any] = {}
    for member, value in found.items():
        if not (isinstance(value, tuple) and len(value) == 2):
            violations.append(f"{CONTRACT} {table}[{member.value!r}] must be {shape}")
            continue
        for cls in value:
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
