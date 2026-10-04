from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

PLUGIN_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
REQUIRED_FILES = (
    "README.md",
    "verifier.py",
)


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
    tools: tuple[str, ...]
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
    runtime: str
    command: tuple[str, ...]
    permissions: Permissions
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
            "runtime": {"type": self.runtime, "command": list(self.command)},
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
                    "tools": list(task.tools),
                    "instructions": task.instructions,
                }
                for task in self.tasks
            ],
        }


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a mapping")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _string_list(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ValueError(f"{label} must be a string list")
    return tuple(value)


def _schema(root: Path, value: Any, label: str) -> tuple[str, dict[str, Any]]:
    relative = Path(_text(value, label))
    if relative.is_absolute() or ".." in relative.parts or relative.suffix != ".json":
        raise ValueError(f"{label} must be a JSON file inside the plugin")
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise FileNotFoundError(f"{label} not found: {relative}")
    schema = _mapping(json.loads(path.read_text(encoding="utf-8")), label)
    Draft202012Validator.check_schema(schema)
    return relative.as_posix(), schema


def load_manifest(source: str | Path) -> PluginManifest:
    path = Path(source).expanduser().resolve()
    if path.is_dir():
        path = path / "nanoagent.yaml"
    if not path.is_file():
        raise FileNotFoundError(f"plugin manifest not found: {path}")
    root = path.parent
    missing = [name for name in REQUIRED_FILES if not (root / name).is_file()]
    if missing:
        raise ValueError(f"plugin is missing required files: {', '.join(missing)}")

    raw = _mapping(yaml.safe_load(path.read_text(encoding="utf-8")), "manifest")
    if raw.get("spec") != "nanoagent.plugin/v1":
        raise ValueError("manifest spec must be nanoagent.plugin/v1")
    plugin_id = _text(raw.get("id"), "id")
    if not PLUGIN_ID.fullmatch(plugin_id):
        raise ValueError("id must contain lowercase letters, numbers, and single hyphens")

    runtime = _mapping(raw.get("runtime"), "runtime")
    if runtime.get("type") != "mcp_stdio":
        raise ValueError("runtime.type must be mcp_stdio")
    command_value = runtime.get("command")
    if isinstance(command_value, str):
        command = tuple(shlex.split(command_value))
    elif isinstance(command_value, list) and all(
        isinstance(part, str) and part for part in command_value
    ):
        command = tuple(command_value)
    else:
        raise ValueError("runtime.command must be a command string or string list")
    if not command:
        raise ValueError("runtime.command must not be empty")

    permission_data = _mapping(raw.get("permissions"), "permissions")
    network = _mapping(permission_data.get("network"), "permissions.network")
    filesystem = _mapping(permission_data.get("filesystem"), "permissions.filesystem")
    hosts = _string_list(network.get("hosts"), "permissions.network.hosts")
    writes = _string_list(filesystem.get("write"), "permissions.filesystem.write")
    if any("/" in host or ":" in host for host in hosts):
        raise ValueError("network hosts must be hostnames without schemes, ports, or paths")
    if set(writes) - {"workspace"}:
        raise ValueError("filesystem write permissions only support workspace")

    tools = []
    for value in raw.get("tools", []):
        item = _mapping(value, "tool")
        input_path, input_schema = _schema(root, item.get("input"), "tool.input")
        output_path, output_schema = _schema(root, item.get("output"), "tool.output")
        tools.append(
            ToolDefinition(
                name=_text(item.get("name"), "tool.name"),
                description=_text(item.get("description"), "tool.description"),
                input_path=input_path,
                output_path=output_path,
                input=input_schema,
                output=output_schema,
            )
        )
    tool_tuple = tuple(tools)
    tool_names = {tool.name for tool in tool_tuple}
    if not tool_tuple or len(tool_names) != len(tool_tuple):
        raise ValueError("plugins require one or more uniquely named tools")

    tasks = tuple(
        TaskDefinition(
            id=_text(item.get("id"), "task.id"),
            description=_text(item.get("description"), "task.description"),
            tools=_string_list(item.get("tools"), "task.tools"),
            instructions=_text(item.get("instructions"), "task.instructions"),
        )
        for item in (_mapping(value, "task") for value in raw.get("tasks", []))
    )
    if not tasks or len({task.id for task in tasks}) != len(tasks):
        raise ValueError("plugins require one or more uniquely identified tasks")
    for task in tasks:
        unknown = set(task.tools) - tool_names
        if unknown:
            raise ValueError(f"task {task.id!r} references unknown tools: {', '.join(sorted(unknown))}")

    return PluginManifest(
        root=root,
        id=plugin_id,
        name=_text(raw.get("name"), "name"),
        version=_text(raw.get("version"), "version"),
        runtime="mcp_stdio",
        command=command,
        permissions=Permissions(hosts, writes),
        tools=tool_tuple,
        tasks=tasks,
    )
