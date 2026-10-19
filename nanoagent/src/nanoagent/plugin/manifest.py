"""A plugin as NanoAgent's hosts see it, whichever spec it follows, and the loader that dispatches on its spec.

A plugin is a folder whose ``nanoagent.yaml`` declares the plugin format it follows, its
``spec``, such as ``spec: nanoagent.plugin/v0001``. :data:`SPECS` holds every spec this
NanoAgent runs, each with its folder, a package beside this module (such as
:mod:`nanoagent.plugin.v0001`) that is the whole spec: the rules a plugin is loaded under, the
classes its files name, and the page it is shown in. A spec's package defines:

    SPEC              its name, the key in SPECS
    PAGE              its page folder: index.html and the UI kit, kit/
    VERIFIER_IMPORTS  the modules a call of the plugin's verifier may import
    verifier_problems(folder)  every way the plugin's verifier/ breaks the spec's rules
    load(root)        the plugin folder as a PluginManifest, or PluginError

and imports nothing of NanoAgent's but this module. So a plugin keeps loading, running and
looking as it did on every NanoAgent that lists its spec, whatever else changes between
releases; one that names no spec this NanoAgent runs is refused, saying which it runs.

How specs change:

- A released spec's folder never changes, with one exception: a rule that closes a security
  hole tightens it in place, in a CHANGELOG entry of its own, and a published plugin that breaks
  the tightened rule is refused until its author publishes it again.
- Anything else a plugin could break on, a rule, a class its files name or the page kit's
  modules, is a new spec: the next folder (``v0002`` after ``v0001``), copied from the newest,
  added to SPECS, made :data:`SPEC`, with ``nanoagent plugin migrate`` moving a plugin from the
  spec before it (:mod:`nanoagent.plugin.authoring`).
- A spec stays in SPECS for at least three NanoAgent minor releases after the next one is
  released; its removal is a CHANGELOG entry of its own.

:func:`load_manifest` loads a plugin under its spec's rules into one :class:`PluginManifest`,
what the runtime, the verifier and the web host read, or raises :class:`PluginError` listing
every broken rule at once. What NanoAgent's template holds a plugin to as it is made and
published is checked apart from that, by :func:`nanoagent.plugin.authoring.check_plugin`.
"""

from __future__ import annotations

import importlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any

from omegaconf import OmegaConf
from slimconfig import merge_specs

PLUGIN_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MANIFEST = "nanoagent.yaml"
# Every spec this NanoAgent runs, and its package.
SPECS = {"nanoagent.plugin/v0001": "nanoagent.plugin.v0001"}
# The newest spec: the one `nanoagent plugin new` writes and `nanoagent plugin migrate` moves a plugin to.
SPEC = "nanoagent.plugin/v0001"
# The tool NanoAgent gives an agent task's agent, taking the task's output (nanoagent.plugin.tasks).
SUBMIT = "submit"
# What git, uv, Python and the test tools create in a checkout, and the coding agents' instructions
# (AGENTS.md, CLAUDE.md, GEMINI.md, which RUSH Lab writes into a project): allowed at the top level
# and anywhere else, never checked, never packed.
TOOL_ARTIFACTS = frozenset(
    {".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".DS_Store", "AGENTS.md", "CLAUDE.md", "GEMINI.md"}
)


class PluginError(ValueError):
    """A plugin breaks one or more rules; ``violations`` lists every one."""

    def __init__(self, root: Path, violations: list[str]) -> None:
        self.violations = violations
        lines = "\n".join(f"  - {violation}" for violation in violations)
        super().__init__(f"plugin {root} breaks the plugin rules:\n{lines}")


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_class: str  # the contract's input class, by name
    output_class: str
    input: dict[str, Any]  # its JSON Schema
    output: dict[str, Any]
    input_type: type = field(compare=False, repr=False)
    output_type: type = field(compare=False, repr=False)


@dataclass(frozen=True)
class TaskDefinition:
    id: str
    description: str
    runner: str  # "tool", "agent" or "decide"
    tools: tuple[str, ...]
    input_class: str
    input: dict[str, Any]
    output_class: str
    output: dict[str, Any]
    reference: str | None  # the tool whose output is pinned as the task's ground truth
    instructions: str
    input_type: type = field(compare=False, repr=False)
    output_type: type = field(compare=False, repr=False)


@dataclass(frozen=True)
class Permissions:
    network_hosts: tuple[str, ...]
    filesystem_write: tuple[str, ...]


@dataclass(frozen=True)
class Product:
    tagline: str
    summary: str
    highlights: tuple[str, ...]
    steps: tuple[str, ...]
    icon: str  # icon.svg as a data: URL, for an <img>, where an SVG cannot run anything


@dataclass(frozen=True)
class PluginManifest:
    root: Path
    spec: str  # the spec it follows, one of SPECS
    id: str
    name: str
    version: str
    status: str
    runtime: str
    command: tuple[str, ...]
    permissions: Permissions
    product: Product
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
            "spec": self.spec,
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "status": self.status,
            "runtime": {"type": self.runtime, "command": list(self.command)},
            "env": list(self.env),
            "permissions": {
                "network": {"hosts": list(self.permissions.network_hosts)},
                "filesystem": {"write": list(self.permissions.filesystem_write)},
            },
            "product": {
                "tagline": self.product.tagline,
                "summary": self.product.summary,
                "highlights": list(self.product.highlights),
                "steps": list(self.product.steps),
                "icon": self.product.icon,
            },
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input": tool.input_class,
                    "output": tool.output_class,
                }
                for tool in self.tools
            ],
            "tasks": [
                {
                    "id": task.id,
                    "description": task.description,
                    "runner": task.runner,
                    "tools": list(task.tools),
                    "input": task.input_class,
                    "output": task.output_class,
                    "reference": task.reference,
                    "instructions": task.instructions,
                }
                for task in self.tasks
            ],
        }


def spec_module(spec: str) -> ModuleType:
    """The package of ``spec``, one of :data:`SPECS`."""
    return importlib.import_module(SPECS[spec])


def is_page_path(relative: str) -> bool:
    """Whether ``relative``, a path in ``ui/``, is the page's: ``index.html`` or in ``kit/``."""
    return relative == "index.html" or relative.split("/", 1)[0] == "kit"


def page_files(page: Path) -> list[Path]:
    """The files of a spec's page folder ``page``: ``index.html`` and ``kit/``."""
    return [page / "index.html", *sorted(path for path in (page / "kit").rglob("*") if path.is_file() and not TOOL_ARTIFACTS & set(path.parts))]


def ui_files(ui: Path) -> list[Path]:
    """The plugin's own files in ``ui``."""
    return [path for path in sorted(ui.rglob("*")) if path.is_file() and not TOOL_ARTIFACTS & set(path.relative_to(ui).parts)]


def plugin_spec(root: Path) -> str:
    """The spec ``root``'s ``nanoagent.yaml`` declares, one of :data:`SPECS`, or :class:`PluginError`.

    The file is read without its classes, which belong to the spec, and unresolved, so a
    ``${oc.env:...}`` is not read here.
    """
    if not (root / MANIFEST).is_file():
        raise PluginError(root, [f"missing {MANIFEST}"])
    try:
        head = OmegaConf.to_container(merge_specs([str(root / MANIFEST)]), resolve=False)
    except Exception as error:  # noqa: BLE001 - every way the file fails is a violation
        raise PluginError(root, [f"{MANIFEST}: {type(error).__name__}: {error}"]) from None
    spec = head.get("spec") if isinstance(head, dict) else None
    if isinstance(spec, str) and spec in SPECS:
        return spec
    runs = ", ".join(SPECS)
    if spec is None and isinstance(head, dict) and "nanoagent" in head:
        problem = (
            f"{MANIFEST} names the NanoAgent it was made for, nanoagent: {head['nanoagent']}, from before plugins"
            f" declared their spec; `nanoagent plugin migrate <folder>` moves it to {SPEC}"
        )
    elif spec is None:
        problem = f"{MANIFEST} declares no spec, the plugin format it follows: this NanoAgent runs {runs}"
    else:
        problem = f"{MANIFEST} spec {spec!r} is not one this NanoAgent runs: {runs}"
    raise PluginError(root, [problem])


def load_manifest(source: str | Path) -> PluginManifest:
    """Load the plugin folder ``source`` under its spec's rules, or raise :class:`PluginError` naming every broken rule."""
    root = Path(source).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"plugin folder not found: {root}")
    return spec_module(plugin_spec(root)).load(root)
