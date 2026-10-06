"""The `nanoagent.plugin/v1` rules, and the loader that refuses a plugin breaking any of them.

A plugin is a folder. :func:`load_manifest` loads it only when every rule holds, and otherwise
raises :class:`PluginError` listing every broken rule at once:

1. Layout: the folder has every file in :data:`REQUIRED_FILES` and every folder in
   :data:`REQUIRED_FOLDERS`; ``src/`` holds at least one file and ``tests/`` at least one
   ``test_*.py``.
2. ``.env`` lists the environment variables the plugin needs: one ``NAME`` per line, no values.
3. ``nanoagent.yaml`` matches :data:`MANIFEST_SCHEMA` exactly: no missing or unknown keys.
4. Every tool's input and output is a valid JSON Schema file under ``schemas/``.
5. Tool names and task ids are unique, and every task uses only declared tools. A task's
   ``runner`` is ``tool`` (exactly one tool, called directly with the task's input, so the task's
   ``input`` is that tool's input schema) or ``agent`` (an agent works the task with its tools).
   A ``reference`` tool, when set, takes the task's input and is not one of the task's tools:
   NanoAgent runs it before the task and pins its output for :func:`verify_task`.
6. ``verifier/`` is a deterministic verifier package (see :mod:`nanoagent.plugin.verifier`).
7. Nothing else: the top level holds only the standard layout (and :data:`TOOL_ARTIFACTS`),
   ``schemas/`` only the JSON files the manifest references, and ``verifier/`` only ``.py``
   files. ``src/`` and ``tests/`` are the plugin's own to organize.

Every tool call re-checks the rules (see :mod:`nanoagent.plugin.runtime`), so a plugin edited
after it was loaded is refused as well.
"""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, SchemaError

from nanoagent.plugin.verifier import verifier_problems

SPEC = "nanoagent.plugin/v1"
PLUGIN_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
MANIFEST = "nanoagent.yaml"
# The standard plugin layout: every plugin has these at its root.
REQUIRED_FILES = (
    MANIFEST,
    "README.md",
    "LICENSE",
    "pyproject.toml",
    "uv.lock",
    ".gitignore",
    ".env",  # the environment variables the plugin needs, one name per line, no values
    "run.sh",  # exits 0 when this environment can run the plugin; run before every launch
)
REQUIRED_FOLDERS = (
    "schemas",  # every tool's input and output JSON Schema
    "src",
    "tests",
    "verifier",  # the deterministic verifier package (see nanoagent.plugin.verifier)
)
# What git, uv, Python and the test tools create in a checkout: allowed anywhere, never checked.
TOOL_ARTIFACTS = frozenset(
    {".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".DS_Store"}
)

_TEXT = {"type": "string", "pattern": r"\S"}
_TEXTS = {"type": "array", "minItems": 1, "items": _TEXT}
_SCHEMA_FILE = {"type": "string", "pattern": r"^schemas/[^\s]+\.json$"}


STATUSES = ("ready", "in-development")


def _record(required: dict[str, Any]) -> dict[str, Any]:
    """An object with exactly the keys ``required``, each matching its schema."""
    return {
        "type": "object",
        "required": list(required),
        "properties": required,
        "additionalProperties": False,
    }


# The whole of `nanoagent.yaml`: every key required, no other key allowed.
MANIFEST_SCHEMA = _record(
    {
        "spec": {"const": SPEC},
        "id": {"type": "string", "pattern": PLUGIN_ID.pattern},
        "name": _TEXT,
        "version": _TEXT,
        # The shelf a catalog files the plugin under, such as "Research".
        "group": _TEXT,
        # Whether hosts may run it: "ready", or "in-development" (listed, never run).
        "status": {"enum": list(STATUSES)},
        "runtime": _record(
            {"type": {"const": "mcp_stdio"}, "command": {"oneOf": [_TEXT, _TEXTS]}}
        ),
        "permissions": _record(
            {
                # Hostnames only: no scheme, port, or path.
                "network": _record(
                    {"hosts": {"type": "array", "items": {"type": "string", "pattern": r"^[^/:\s]+$"}}}
                ),
                "filesystem": _record(
                    {"write": {"type": "array", "items": {"const": "workspace"}}}
                ),
            }
        ),
        "tools": {
            "type": "array",
            "minItems": 1,
            "items": _record(
                {"name": _TEXT, "description": _TEXT, "input": _SCHEMA_FILE, "output": _SCHEMA_FILE}
            ),
        },
        "tasks": {
            "type": "array",
            "minItems": 1,
            "items": _record(
                {
                    "id": _TEXT,
                    "description": _TEXT,
                    "runner": {"enum": ["tool", "agent"]},
                    "tools": _TEXTS,
                    "input": _SCHEMA_FILE,
                    "reference": {"oneOf": [_TEXT, {"type": "null"}]},
                    "instructions": _TEXT,
                }
            ),
        },
    }
)


# What a catalog needs to list a plugin: the identifying head of `nanoagent.yaml`. The rest may
# be unfinished while the plugin is in development, since a host never runs it then.
LISTING_KEYS = ("spec", "id", "name", "version", "group", "status")
LISTING_SCHEMA = {
    "type": "object",
    "required": list(LISTING_KEYS),
    "properties": {key: MANIFEST_SCHEMA["properties"][key] for key in LISTING_KEYS},
}


class PluginError(ValueError):
    """A plugin breaks one or more rules; ``violations`` lists every one."""

    def __init__(self, root: Path, violations: list[str]) -> None:
        self.violations = violations
        lines = "\n".join(f"  - {violation}" for violation in violations)
        super().__init__(f"plugin {root} breaks the {SPEC} rules:\n{lines}")


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_path: str
    output_path: str
    input: dict[str, Any]
    output: dict[str, Any]


@dataclass(frozen=True)
class TaskDefinition:
    id: str
    description: str
    runner: str  # "tool" or "agent"
    tools: tuple[str, ...]
    input_path: str
    input: dict[str, Any]
    reference: str | None  # the tool whose output is pinned as the task's ground truth
    instructions: str


@dataclass(frozen=True)
class Permissions:
    network_hosts: tuple[str, ...]
    filesystem_write: tuple[str, ...]


@dataclass(frozen=True)
class PluginManifest:
    root: Path
    id: str
    name: str
    version: str
    group: str
    status: str
    runtime: str
    command: tuple[str, ...]
    permissions: Permissions
    env: tuple[str, ...]
    tools: tuple[ToolDefinition, ...]
    tasks: tuple[TaskDefinition, ...]

    def task(self, task_id: str) -> TaskDefinition:
        try:
            return next(task for task in self.tasks if task.id == task_id)
        except StopIteration:
            known = ", ".join(task.id for task in self.tasks) or "none"
            raise KeyError(f"unknown task {task_id!r} (available: {known})") from None

    def tool(self, name: str) -> ToolDefinition:
        try:
            return next(tool for tool in self.tools if tool.name == name)
        except StopIteration:
            raise KeyError(f"unknown tool {name!r}") from None

    def public(self) -> dict[str, Any]:
        return {
            "spec": "nanoagent.plugin/v1",
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "group": self.group,
            "status": self.status,
            "runtime": {"type": self.runtime, "command": list(self.command)},
            "env": list(self.env),
            "permissions": {
                "network": {"hosts": list(self.permissions.network_hosts)},
                "filesystem": {"write": list(self.permissions.filesystem_write)},
            },
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input": tool.input_path,
                    "output": tool.output_path,
                }
                for tool in self.tools
            ],
            "tasks": [
                {
                    "id": task.id,
                    "description": task.description,
                    "runner": task.runner,
                    "tools": list(task.tools),
                    "input": task.input_path,
                    "reference": task.reference,
                    "instructions": task.instructions,
                }
                for task in self.tasks
            ],
        }


def _layout_violations(root: Path) -> list[str]:
    violations = [f"missing {name}" for name in REQUIRED_FILES if not (root / name).is_file()]
    violations += [f"missing {name}/" for name in REQUIRED_FOLDERS if not (root / name).is_dir()]
    if (root / "src").is_dir() and not any(path.is_file() for path in (root / "src").rglob("*")):
        violations.append("src/ holds no files")
    if (root / "tests").is_dir() and not any((root / "tests").rglob("test_*.py")):
        violations.append("tests/ holds no test_*.py")
    standard = {*REQUIRED_FILES, *REQUIRED_FOLDERS, *TOOL_ARTIFACTS}
    violations += [f"unexpected {path.name}" for path in sorted(root.iterdir()) if path.name not in standard]
    if (root / "verifier").is_dir():
        violations += [
            f"unexpected verifier/{path.relative_to(root / 'verifier').as_posix()}: only .py files belong there"
            for path in sorted((root / "verifier").rglob("*"))
            if path.is_file() and path.suffix != ".py" and not TOOL_ARTIFACTS & set(path.relative_to(root).parts)
        ]
    return violations


def _unreferenced_schemas(root: Path, referenced: set[str]) -> list[str]:
    return [
        f"unexpected {path.relative_to(root).as_posix()}: schemas/ holds only the schemas tools and tasks reference"
        for path in sorted((root / "schemas").rglob("*"))
        if path.is_file()
        and path.relative_to(root).as_posix() not in referenced
        and not TOOL_ARTIFACTS & set(path.relative_to(root).parts)
    ]


def _env_names(path: Path) -> tuple[tuple[str, ...], list[str]]:
    """The variable names `.env` declares (`NAME` or `NAME=` lines, never a value), and its violations."""
    names: list[str] = []
    violations: list[str] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, value = line.partition("=")
        if not ENV_NAME.fullmatch(name) or value:
            violations.append(f".env line {number} must be a variable NAME with no value")
        elif name in names:
            violations.append(f".env line {number} declares {name} twice")
        else:
            names.append(name)
    return tuple(names), violations


def _schema_file(root: Path, relative: str) -> tuple[dict[str, Any] | None, list[str]]:
    path = (root / relative).resolve()
    if not path.is_relative_to(root / "schemas") or not path.is_file():
        return None, [f"{relative} not found under schemas/"]
    try:
        schema = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return None, [f"{relative} is not JSON: {error}"]
    if not isinstance(schema, dict):
        return None, [f"{relative} must hold a JSON object"]
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as error:
        return None, [f"{relative} is not a valid JSON Schema: {error.message}"]
    return schema, []


def _read_manifest(root: Path) -> tuple[dict[str, Any] | None, list[str]]:
    """``nanoagent.yaml`` when it matches :data:`MANIFEST_SCHEMA`, and its violations."""
    try:
        raw = yaml.safe_load((root / MANIFEST).read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        return None, [f"{MANIFEST} is not YAML: {error}"]
    errors = sorted(
        Draft202012Validator(MANIFEST_SCHEMA).iter_errors(raw),
        key=lambda error: [str(part) for part in error.absolute_path],
    )
    violations = [
        f"{MANIFEST} {'.'.join(str(part) for part in error.absolute_path) or '(top level)'}: {error.message}"
        for error in errors
    ]
    return (None if violations else raw), violations


def load_manifest(source: str | Path) -> PluginManifest:
    """Load the plugin folder ``source``, or raise :class:`PluginError` naming every broken rule."""
    root = Path(source).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"plugin folder not found: {root}")
    violations = _layout_violations(root)
    env: tuple[str, ...] = ()
    if (root / ".env").is_file():
        env, env_violations = _env_names(root / ".env")
        violations += env_violations
    if (root / "verifier").is_dir():
        violations += verifier_problems(root / "verifier")
    raw = None
    if (root / MANIFEST).is_file():
        raw, manifest_violations = _read_manifest(root)
        violations += manifest_violations

    tools: list[ToolDefinition] = []
    tasks: list[TaskDefinition] = []
    if raw is not None:
        for item in raw["tools"]:
            input_schema, input_violations = _schema_file(root, item["input"])
            output_schema, output_violations = _schema_file(root, item["output"])
            violations += input_violations + output_violations
            if input_schema is not None and output_schema is not None:
                tools.append(
                    ToolDefinition(
                        name=item["name"].strip(),
                        description=item["description"].strip(),
                        input_path=item["input"],
                        output_path=item["output"],
                        input=input_schema,
                        output=output_schema,
                    )
                )
        if (root / "schemas").is_dir():
            violations += _unreferenced_schemas(
                root,
                {item[key] for item in raw["tools"] for key in ("input", "output")}
                | {item["input"] for item in raw["tasks"]},
            )
        names = [item["name"].strip() for item in raw["tools"]]
        violations += [f"tool {name!r} is declared twice" for name in sorted({n for n in names if names.count(n) > 1})]
        inputs = {item["name"].strip(): item["input"] for item in raw["tools"]}
        for item in raw["tasks"]:
            task_id, runner, task_tools, reference = item["id"].strip(), item["runner"], item["tools"], item["reference"]
            unknown = sorted(set(task_tools) - set(names))
            if unknown:
                violations.append(f"task {task_id!r} uses undeclared tools: {', '.join(unknown)}")
            if runner == "tool" and (len(task_tools) != 1 or inputs.get(task_tools[0]) != item["input"]):
                violations.append(f"task {task_id!r}: a tool runner has exactly one tool, and takes that tool's input")
            if reference is not None and (reference in task_tools or inputs.get(reference) != item["input"]):
                violations.append(
                    f"task {task_id!r}: reference {reference!r} must be a declared tool outside the task's tools,"
                    " taking the task's input"
                )
            input_schema, input_violations = _schema_file(root, item["input"])
            violations += input_violations
            if input_schema is not None:
                tasks.append(
                    TaskDefinition(
                        id=task_id,
                        description=item["description"].strip(),
                        runner=runner,
                        tools=tuple(task_tools),
                        input_path=item["input"],
                        input=input_schema,
                        reference=reference,
                        instructions=item["instructions"].strip(),
                    )
                )
        ids = [item["id"].strip() for item in raw["tasks"]]
        violations += [f"task {task_id!r} is declared twice" for task_id in sorted({i for i in ids if ids.count(i) > 1})]
    if violations:
        raise PluginError(root, violations)

    command = raw["runtime"]["command"]
    permissions = raw["permissions"]
    return PluginManifest(
        root=root,
        id=raw["id"],
        name=raw["name"].strip(),
        version=raw["version"].strip(),
        group=raw["group"].strip(),
        status=raw["status"],
        runtime="mcp_stdio",
        command=tuple(shlex.split(command) if isinstance(command, str) else command),
        permissions=Permissions(
            tuple(permissions["network"]["hosts"]), tuple(permissions["filesystem"]["write"])
        ),
        env=env,
        tools=tuple(tools),
        tasks=tuple(tasks),
    )


@dataclass(frozen=True)
class PluginListing:
    """An in-development plugin as a catalog shows it: what it is, never how to run it."""

    root: Path
    id: str
    name: str
    version: str
    group: str
    status: str

    def public(self) -> dict[str, Any]:
        readme = self.root / "README.md"
        return {
            "spec": SPEC,
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "group": self.group,
            "status": self.status,
            "readme": readme.read_text(encoding="utf-8") if readme.is_file() else "",
        }


def load_listing(source: str | Path) -> PluginManifest | PluginListing:
    """A ``ready`` plugin, which must pass every rule, or an in-development one's listing.

    An in-development plugin need only name itself correctly, so a plugin being built cannot
    stop a host that lists it; a ``ready`` one is held to all of :func:`load_manifest`.
    """
    root = Path(source).expanduser().resolve()
    try:
        raw = yaml.safe_load((root / MANIFEST).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PluginError(root, [f"{MANIFEST} not found"]) from None
    except yaml.YAMLError as error:
        raise PluginError(root, [f"{MANIFEST} is not YAML: {error}"]) from None
    violations = [
        f"{MANIFEST} {'.'.join(str(part) for part in error.absolute_path) or '(top level)'}: {error.message}"
        for error in Draft202012Validator(LISTING_SCHEMA).iter_errors(raw)
    ]
    if violations:
        raise PluginError(root, violations)
    if raw["status"] == "ready":
        return load_manifest(root)
    return PluginListing(
        root=root,
        id=raw["id"],
        name=raw["name"].strip(),
        version=raw["version"].strip(),
        group=raw["group"].strip(),
        status=raw["status"],
    )

