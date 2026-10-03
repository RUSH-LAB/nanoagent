from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input: dict[str, Any]
    output: dict[str, Any]


@dataclass(frozen=True)
class TaskDefinition:
    id: str
    description: str
    tools: tuple[str, ...]
    instructions: str


@dataclass(frozen=True)
class SoftwareManifest:
    root: Path
    id: str
    name: str
    version: str
    command: tuple[str, ...]
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
            "spec": "nanoagent.software/v1",
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "runtime": {"command": list(self.command)},
            "tools": [tool.__dict__ for tool in self.tools],
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


def load_manifest(source: str | Path) -> SoftwareManifest:
    path = Path(source).expanduser().resolve()
    if path.is_dir():
        path = path / "nanoagent.yaml"
    if not path.is_file():
        raise FileNotFoundError(f"software manifest not found: {path}")
    raw = _mapping(yaml.safe_load(path.read_text(encoding="utf-8")), "manifest")
    if raw.get("spec") != "nanoagent.software/v1":
        raise ValueError("manifest spec must be nanoagent.software/v1")

    runtime = _mapping(raw.get("runtime"), "runtime")
    command_value = runtime.get("command")
    if isinstance(command_value, str):
        command = tuple(shlex.split(command_value))
    elif isinstance(command_value, list) and all(isinstance(part, str) and part for part in command_value):
        command = tuple(command_value)
    else:
        raise ValueError("runtime.command must be a command string or string list")
    if not command:
        raise ValueError("runtime.command must not be empty")

    tools = tuple(
        ToolDefinition(
            name=_text(item.get("name"), "tool.name"),
            description=_text(item.get("description"), "tool.description"),
            input=_mapping(item.get("input", {}), "tool.input"),
            output=_mapping(item.get("output", {}), "tool.output"),
        )
        for item in (_mapping(value, "tool") for value in raw.get("tools", []))
    )
    tool_names = {tool.name for tool in tools}
    if len(tool_names) != len(tools):
        raise ValueError("tool names must be unique")

    tasks = tuple(
        TaskDefinition(
            id=_text(item.get("id"), "task.id"),
            description=_text(item.get("description"), "task.description"),
            tools=tuple(item.get("tools", [])),
            instructions=_text(item.get("instructions"), "task.instructions"),
        )
        for item in (_mapping(value, "task") for value in raw.get("tasks", []))
    )
    if len({task.id for task in tasks}) != len(tasks):
        raise ValueError("task ids must be unique")
    for task in tasks:
        unknown = set(task.tools) - tool_names
        if unknown:
            raise ValueError(f"task {task.id!r} references unknown tools: {', '.join(sorted(unknown))}")

    return SoftwareManifest(
        root=path.parent,
        id=_text(raw.get("id"), "id"),
        name=_text(raw.get("name"), "name"),
        version=_text(raw.get("version"), "version"),
        command=command,
        tools=tools,
        tasks=tasks,
    )
