"""The `nanoagent.plugin/v1` rules, and the loader that refuses a plugin breaking any of them.

A plugin is a folder. :func:`load_manifest` loads it only when every rule holds, and otherwise
raises :class:`PluginError` listing every broken rule at once:

1. Layout: the folder has every file in :data:`REQUIRED_FILES` and every folder in
   :data:`REQUIRED_FOLDERS`; ``src/`` holds at least one file and ``tests/`` holds
   :data:`VERIFIER_TEST`, the verifier's own test.
2. ``.env`` lists the environment variables the plugin needs: one ``NAME`` per line, no values.
3. ``contract.py`` declares every tool's and task's typed input and output, and nothing but
   declarations (see :mod:`nanoagent.plugin.contract`). A tool is named in snake_case
   (:data:`TOOL_NAME`) and a task in kebab-case, like a plugin id; every input class's name ends
   in ``Input`` and every output class's in ``Output``.
4. ``nanoagent.yaml`` fills :class:`ManifestConfig` under slimconfig's rules: it names its class
   (``_ > nanoagent.plugin.manifest.ManifestConfig:``), sets every field and no other, and its
   ``tools`` and ``tasks`` are tables keyed by the contract's ``Tool`` and ``Task``. Its
   ``nanoagent`` is the NanoAgent minor version the plugin runs on, ``~=X.Y.0``, and holds this
   NanoAgent's version. ``version`` is a PEP 440 version, the one ``pyproject.toml`` gives the
   project, and ``runtime.command`` is :data:`RUNTIME_COMMAND`, the plugin's own MCP server run
   from its locked environment.
5. Every task uses only declared tools, and has an input class and an output class. A task's
   ``runner`` is ``tool`` (exactly one tool, called directly with the task's input, so the
   task's input and output classes are that tool's), ``agent`` (an agent works the task with
   its tools and ends by calling :data:`SUBMIT` with the task's output, so no tool is named
   that) or ``decide`` (a model only decides: every tool argument and every output field is
   chosen from an Enum or bool, or copied or picked from a value of exactly its type in the
   task's input or an earlier output of one of the task's tools, never the reference tool's;
   see :mod:`nanoagent.plugin.dataflow`). A ``reference`` tool, when set, takes the task's input
   and is not one of the task's tools: NanoAgent runs it before the task and pins its output for
   :func:`verify_task`.
6. ``verifier/`` is a deterministic verifier package (see :mod:`nanoagent.plugin.verifier`).
7. Nothing else: the top level holds only the standard layout (and :data:`TOOL_ARTIFACTS`,
   which are never packed: what tools create in a checkout, and a coding agent's instructions),
   and ``verifier/`` only ``.py`` files. ``src/`` and ``tests/`` are the plugin's own to
   organize.
8. ``ui/`` is how the plugin's page draws its outputs: ``ui/renderers.js``, ``ui/renderers.css``
   and the static files they load, only :data:`UI_SUFFIXES` and at most :data:`UI_MAX_BYTES` in
   total. Every plugin's page is NanoAgent's, :data:`PAGE` (``index.html`` and the shared UI kit
   ``kit/``): a chat with the plugin's agent, in which each task it runs shows its output, drawn
   by ``renderers.js`` or from the output's JSON Schema. So ``ui/`` holds no ``index.html`` or
   ``kit/``, and no ``app.js`` or ``app.css``, a page of its own. A host shows the page in a
   sandboxed frame that talks to NanoAgent only through the ``nanoagent.ui/v1`` bridge
   (docs/plans/ai-native-plugins.md). ``renderers.js`` has a default export, the renderers by
   output class name, an object literal whose every key is the output class of one of the
   plugin's tasks. Every script imports only by a literal path relative to itself: the kit's
   modules and the plugin's own files in ``ui/``. A renderer draws only its output, with the kit's
   modules: the scripts name none of :data:`UI_GLOBALS`, the page, its host or the network, and
   reach for none of :data:`UI_PROPERTIES`, the ways out of the closed shadow root the kit draws
   each output in, the only place ``renderers.css`` applies. So the plugin's scripts and styles
   reach nothing around its output; NanoAgent's Content-Security-Policy for the page
   (``nanoagent.web.app.UI_POLICY``) refuses it the network.
9. ``product/`` is the plugin's product page, what a catalog shows people before they open it,
   and holds exactly :data:`PRODUCT_FILES`. ``product.yaml`` fills :class:`ProductConfig`
   (``_ > nanoagent.plugin.manifest.ProductConfig:``): a tagline, a summary, 2 to 4 highlights
   and 2 to 5 steps, none blank, and a ``ready`` plugin's are its own, none the template's
   placeholder. ``icon.svg`` is the app's icon: an SVG of at most
   :data:`ICON_MAX_BYTES` that draws only, with no script, event handler, embedded content or
   link outside itself.
10. The standard files are the :data:`TEMPLATE`'s, what ``nanoagent plugin new`` writes:
    ``LICENSE`` is its license with a year and the name of whoever holds the copyright; ``.gitignore`` ignores
    every path it ignores; ``README.md`` opens with ``# <name>`` and has its sections (:data:`README_SECTIONS`, in
    order), naming every tool and task under ``## Tools``; ``pyproject.toml`` names the project
    ``nanoagent-<id>``, puts the plugin root on pytest's path, and has the template's
    ``requires-python``, its dependencies and its ``slimconfig`` source, every other dependency
    bounded above and below.

Every tool call re-checks the rules (see :mod:`nanoagent.plugin.runtime`), so a plugin edited
after it was loaded is refused as well.
"""

from __future__ import annotations

import base64
import dataclasses
import enum
import posixpath
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from omegaconf import MISSING, OmegaConf
from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version
from slimconfig import Config, load_config, merge_specs, output_schema

from nanoagent import __version__
from nanoagent.plugin.contract import CONTRACT, contract_module, contract_problems, read_contract
from nanoagent.plugin.dataflow import unfillable
from nanoagent.plugin.verifier import verifier_problems

SPEC = "nanoagent.plugin/v1"
PLUGIN_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TASK_ID = PLUGIN_ID
TOOL_NAME = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
# The only ``nanoagent`` range a plugin declares: one NanoAgent minor version, such as ``~=0.6.0``.
NANOAGENT_RANGE = re.compile(r"^~=\d+\.\d+\.0$")
# How every plugin's MCP server starts, in the plugin folder, from its uv.lock.
RUNTIME_COMMAND = ("uv", "run", "--frozen", "python", "-m", "plugin")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
HOSTNAME = re.compile(r"^[^/:\s]+$")  # a hostname only: no scheme, port, or path
MANIFEST = "nanoagent.yaml"
# The tool NanoAgent gives an agent task's agent, taking the task's output (nanoagent.plugin.tasks).
SUBMIT = "submit"
# What `nanoagent plugin new` copies; rule 10 holds every plugin's standard files to it.
TEMPLATE = Path(__file__).with_name("template")
# The frame NanoAgent serves every plugin's ui/ in: index.html and the shared UI kit, kit/.
PAGE = Path(__file__).with_name("page")
VERIFIER_TEST = "tests/test_verifier.py"
README_SECTIONS = ("## Tools", "## Layout", "## Develop and run")
# The standard plugin layout: every plugin has these at its root.
REQUIRED_FILES = (
    MANIFEST,
    CONTRACT,  # every tool's and task's typed input and output (see nanoagent.plugin.contract)
    "README.md",
    "LICENSE",
    "pyproject.toml",
    "uv.lock",
    ".gitignore",
    ".env",  # the environment variables the plugin needs, one name per line, no values
)
REQUIRED_FOLDERS = (
    "src",
    "tests",
    "verifier",  # the deterministic verifier package (see nanoagent.plugin.verifier)
    "ui",  # how the plugin's page draws its outputs, ui/renderers.js, served in NanoAgent's PAGE
    "product",  # the product page a catalog shows: product.yaml and icon.svg
)
PRODUCT = "product/product.yaml"
PRODUCT_FILES = ("product.yaml", "icon.svg")
ICON_MAX_BYTES = 64 * 1024
# SVG elements that run, embed or fetch something rather than draw.
ICON_FORBIDDEN = frozenset({"script", "foreignObject", "iframe", "embed", "object", "image", "use", "a"})
# What a front end may hold: static web files, nothing built or run at load.
UI_SUFFIXES = frozenset({".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".json", ".md"})
UI_MAX_BYTES = 5 * 1024 * 1024
UI_FILES = ("renderers.js", "renderers.css")
# A page of a plugin's own, which NanoAgent's page replaced (rule 8).
UI_PAGE = ("app.js", "app.css")
UI_SCRIPTS = frozenset({".js", ".mjs"})
# What rule 8 reads from ui/'s scripts: renderers.js's default export and every module they import
# (statically or with import()).
UI_DEFAULT_EXPORT = re.compile(r"^\s*export\s+default\b|\bas\s+default\b", re.MULTILINE)
UI_IMPORT = re.compile(r"""\b(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?(["'])(.*?)\1""")
UI_DYNAMIC_IMPORT = re.compile(r"""\bimport\s*\((?:\s*(["'])(.*?)\1\s*\))?""")
# What a renderer's scripts never name (rule 8): the page, its host and the network.
UI_GLOBALS = (
    "document",
    "window",
    "globalThis",
    "self",
    "parent",
    "top",
    "opener",
    "frames",
    "location",
    "history",
    "navigator",
    "postMessage",
    "eval",
    "Function",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "localStorage",
    "sessionStorage",
    "indexedDB",
)
UI_GLOBAL = re.compile(r"(?<![\w$.])(" + "|".join(UI_GLOBALS) + r")(?![\w$])(?!\s*:(?!:))")
# The properties that lead from a renderer's own elements out of its shadow root, to the page or
# its window, or to the Function constructor (rule 8).
UI_PROPERTIES = (
    "ownerDocument",
    "defaultView",
    "getRootNode",
    "parentNode",
    "parentElement",
    "offsetParent",
    "host",
    "assignedSlot",
    "composedPath",
    "view",
    "contentWindow",
    "contentDocument",
    "constructor",
    "__proto__",
)
UI_PROPERTY = re.compile(r"(?<!\.)\.\s*(" + "|".join(UI_PROPERTIES) + r")(?![\w$])")
# What git, uv, Python and the test tools create in a checkout, and the coding agents' instructions
# (AGENTS.md, CLAUDE.md, GEMINI.md, which RUSH Lab writes into a project): allowed at the top level
# and anywhere else, never checked, never packed.
TOOL_ARTIFACTS = frozenset(
    {".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".DS_Store", "AGENTS.md", "CLAUDE.md", "GEMINI.md"}
)


class Status(enum.Enum):
    READY = "ready"
    IN_DEVELOPMENT = "in-development"  # listed by a catalog, never run


class Runner(enum.Enum):
    TOOL = "tool"
    AGENT = "agent"
    DECIDE = "decide"


class RuntimeType(enum.Enum):
    MCP_STDIO = "mcp_stdio"


class WriteScope(enum.Enum):
    WORKSPACE = "workspace"


@dataclass
class ListingConfig(Config):
    """What a catalog needs to list a plugin: the identifying head of `nanoagent.yaml`."""

    id: str = MISSING
    name: str = MISSING
    version: str = MISSING
    status: Status = MISSING


@dataclass
class RuntimeConfig(Config):
    type: RuntimeType = MISSING
    # The MCP server's command line, run in the plugin folder.
    command: list[str] = MISSING


@dataclass
class NetworkConfig(Config):
    hosts: list[str] = MISSING


@dataclass
class FilesystemConfig(Config):
    write: list[WriteScope] = MISSING


@dataclass
class PermissionsConfig(Config):
    network: NetworkConfig = field(default_factory=NetworkConfig)
    filesystem: FilesystemConfig = field(default_factory=FilesystemConfig)


@dataclass
class ProductConfig(Config):
    """``product/product.yaml``: the plugin as a catalog presents it to the people who use it."""

    # One line on what it does for you.
    tagline: str = MISSING
    # A few sentences on what it is.
    summary: str = MISSING
    # What sets it apart, one short sentence each.
    highlights: list[str] = MISSING
    # How you use it, in order.
    steps: list[str] = MISSING


@dataclass
class ToolConfig(Config):
    description: str = MISSING


@dataclass
class TaskConfig(Config):
    description: str = MISSING
    runner: Runner = MISSING
    # The tools the task may use, by name.
    tools: list[str] = MISSING
    # The tool whose output is pinned as the task's ground truth, by name, or null.
    reference: str | None = MISSING
    instructions: str = MISSING


@dataclass
class ManifestConfig(ListingConfig):
    """The whole of `nanoagent.yaml`. Each plugin's file fills a subclass that adds its tables,
    ``tools: dict[contract.Tool, ToolConfig]`` and ``tasks: dict[contract.Task, TaskConfig]``."""

    # The NanoAgent versions the plugin runs on, a PEP 440 range such as ``~=0.3.0``.
    nanoagent: str = MISSING
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)
    permissions: PermissionsConfig = field(default_factory=PermissionsConfig)


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
            "spec": SPEC,
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


def _layout_violations(root: Path) -> list[str]:
    violations = [f"missing {name}" for name in REQUIRED_FILES if not (root / name).is_file()]
    violations += [f"missing {name}/" for name in REQUIRED_FOLDERS if not (root / name).is_dir()]
    if (root / "ui").is_dir():
        violations += _ui_violations(root / "ui")
    if (root / "product").is_dir():
        violations += _product_violations(root / "product")
    if (root / "src").is_dir() and not any(path.is_file() for path in (root / "src").rglob("*")):
        violations.append("src/ holds no files")
    if (root / "tests").is_dir() and not (root / VERIFIER_TEST).is_file():
        violations.append(f"missing {VERIFIER_TEST}")
    violations += _template_violations(root)
    standard = {*REQUIRED_FILES, *REQUIRED_FOLDERS, *TOOL_ARTIFACTS}
    violations += [f"unexpected {path.name}" for path in sorted(root.iterdir()) if path.name not in standard]
    if (root / "verifier").is_dir():
        violations += [
            f"unexpected verifier/{path.relative_to(root / 'verifier').as_posix()}: only .py files belong there"
            for path in sorted((root / "verifier").rglob("*"))
            if path.is_file() and path.suffix != ".py" and not TOOL_ARTIFACTS & set(path.relative_to(root).parts)
        ]
    return violations


def _product_violations(folder: Path) -> list[str]:
    """``product/`` holds exactly its files, and ``icon.svg`` only draws (rule 9)."""
    names = {path.name for path in folder.iterdir() if path.name not in TOOL_ARTIFACTS}
    violations = [f"missing product/{name}" for name in PRODUCT_FILES if name not in names]
    violations += [f"unexpected product/{name}" for name in sorted(names - set(PRODUCT_FILES))]
    icon = folder / "icon.svg"
    if icon.is_file():
        violations += _icon_violations(icon)
    return violations


def _local(name: str) -> str:
    """An XML element or attribute name without its namespace."""
    return name.rpartition("}")[2]


def _icon_violations(icon: Path) -> list[str]:
    size = icon.stat().st_size
    if size > ICON_MAX_BYTES:
        return [f"product/icon.svg holds {size} bytes, over the {ICON_MAX_BYTES}-byte limit"]
    try:
        root = ElementTree.fromstring(icon.read_bytes())
    except ElementTree.ParseError as error:
        return [f"product/icon.svg is not well-formed XML: {error}"]
    if root.tag != "{http://www.w3.org/2000/svg}svg":
        return ["product/icon.svg must be an <svg> in the SVG namespace"]
    violations: list[str] = []
    for element in root.iter():
        tag = _local(element.tag)
        if tag in ICON_FORBIDDEN:
            violations.append(f"product/icon.svg may only draw, not hold <{tag}>")
        if tag == "style" and ("url(" in (element.text or "") or "@import" in (element.text or "")):
            violations.append("product/icon.svg may not load anything from its <style>")
        for name, value in element.attrib.items():
            if _local(name).lower().startswith("on"):
                violations.append(f"product/icon.svg may not set the event handler {_local(name)}")
            elif _local(name) == "href" and not value.startswith("#"):
                violations.append(f"product/icon.svg may not link outside itself: {value!r}")
    return violations


def _placeholders() -> list[re.Pattern[str]]:
    """The template's product.yaml texts, whatever name it was given."""
    template = load_config(ProductConfig, [str(TEMPLATE / PRODUCT)])
    texts = [template.tagline, template.summary, *template.highlights, *template.steps]
    return [re.compile(re.escape(text).replace(re.escape("{{name}}"), ".*")) for text in texts]


def _product(root: Path, status: Status) -> tuple[Product | None, list[str]]:
    """``product/product.yaml`` and ``icon.svg`` as the :class:`Product` a catalog shows, or its violations."""
    try:
        config = load_config(ProductConfig, [str(root / PRODUCT)])
    except Exception as error:  # noqa: BLE001 - every way the file fails is a violation
        return None, [f"{PRODUCT}: {type(error).__name__}: {error}"]
    violations = [f"{PRODUCT} {name} is blank" for name in ("tagline", "summary") if not getattr(config, name).strip()]
    for name, low, high in (("highlights", 2, 4), ("steps", 2, 5)):
        items = getattr(config, name)
        if not low <= len(items) <= high:
            violations.append(f"{PRODUCT} {name} must hold {low} to {high} entries, not {len(items)}")
        if not all(item.strip() for item in items):
            violations.append(f"{PRODUCT} {name} has a blank entry")
    if status is Status.READY:
        texts = [config.tagline, config.summary, *config.highlights, *config.steps]
        if any(pattern.fullmatch(text.strip()) for pattern in _placeholders() for text in texts):
            violations.append(f"{PRODUCT} still holds the template's placeholder text; a ready plugin describes itself")
    icon = base64.b64encode((root / "product" / "icon.svg").read_bytes()).decode()
    return Product(
        tagline=config.tagline.strip(),
        summary=config.summary.strip(),
        highlights=tuple(item.strip() for item in config.highlights),
        steps=tuple(item.strip() for item in config.steps),
        icon=f"data:image/svg+xml;base64,{icon}",
    ), violations


def is_page_path(relative: str) -> bool:
    """Whether ``relative``, a path in ``ui/``, is :data:`PAGE`'s: ``index.html`` or in ``kit/``."""
    return relative == "index.html" or relative.split("/", 1)[0] == "kit"


def page_files() -> list[Path]:
    """:data:`PAGE`'s files: ``index.html`` and ``kit/``."""
    return [PAGE / "index.html", *sorted(path for path in (PAGE / "kit").rglob("*") if path.is_file() and not TOOL_ARTIFACTS & set(path.parts))]


def ui_files(ui: Path) -> list[Path]:
    """The plugin's own files in ``ui``."""
    return [path for path in sorted(ui.rglob("*")) if path.is_file() and not TOOL_ARTIFACTS & set(path.relative_to(ui).parts)]


def _ui_violations(ui: Path) -> list[str]:
    """``ui/`` holds the renderers :data:`PAGE` draws outputs with, and its scripts import only what it serves (rule 8)."""
    files = ui_files(ui)
    violations = [f"missing ui/{name}" for name in UI_FILES if not (ui / name).is_file()]
    violations += [
        f"unexpected ui/{name}: NanoAgent's chat is every plugin's page; ui/renderers.js draws its outputs"
        for name in UI_PAGE
        if (ui / name).is_file()
    ]
    for path in files:
        relative = path.relative_to(ui).as_posix()
        if is_page_path(relative):
            violations.append(f"unexpected ui/{relative}: NanoAgent serves the page's index.html and kit/")
        elif path.suffix.lower() not in UI_SUFFIXES:
            violations.append(f"unexpected ui/{relative}: ui/ holds only static web files")
    size = sum(path.stat().st_size for path in files)
    if size > UI_MAX_BYTES:
        violations.append(f"ui/ holds {size} bytes, over the {UI_MAX_BYTES}-byte limit")
    if (ui / "renderers.js").is_file():
        text = (ui / "renderers.js").read_text(encoding="utf-8")
        if not UI_DEFAULT_EXPORT.search(text):
            violations.append("ui/renderers.js must export its renderers, by output class name, as its default export")
        elif renderer_names(text) is None:
            violations.append("ui/renderers.js's default export must be an object literal, its renderers keyed by output class name")
    served = {path.relative_to(ui).as_posix() for path in files}
    for path in files:
        if path.suffix.lower() in UI_SCRIPTS and not is_page_path(path.relative_to(ui).as_posix()):
            text = path.read_text(encoding="utf-8")
            violations += _import_violations(path.relative_to(ui), text, served)
            code = _js_code(text)
            violations += [
                f"ui/{path.relative_to(ui).as_posix()} uses {name}: a renderer draws only its output, with the kit's modules"
                for name in dict.fromkeys(match.group(1) for match in UI_GLOBAL.finditer(code))
            ]
            violations += [
                f"ui/{path.relative_to(ui).as_posix()} reaches for .{name}: a renderer stays inside its own output"
                for name in dict.fromkeys(match.group(1) for match in UI_PROPERTY.finditer(code))
            ]
    return violations


def renderer_names(text: str) -> list[str] | None:
    """The keys of ``text``'s default export, renderers.js's ``export default { ... }``, or None
    when that is not an object literal with plain keys."""
    code = _js_code(text)
    start = re.search(r"\bexport\s+default\s*\{", code)
    if start is None:
        return None
    names: list[str] = []
    depth, expect = 1, True
    for match in re.finditer(r"[A-Za-z_$][\w$]*|\.\.\.|[{}()\[\],:]|\S", code[start.end() :]):
        token = match.group()
        if token in "{([":
            depth += 1
        elif token in "})]":
            depth -= 1
            if depth == 0:
                return names
        elif depth == 1 and token == ",":
            expect = True
        elif depth == 1 and expect:
            if not re.fullmatch(r"[A-Za-z_$][\w$]*", token):
                return None
            names.append(token)
            expect = False
    return None


def _js_code(text: str) -> str:
    """``text``, a script, with its comments and the text of its strings blanked: what it runs."""
    out: list[str] = []
    depths: list[int] = []  # the brace depth of each template literal's open ${...}
    i, n = 0, len(text)

    def skip_template(i: int) -> int:
        """From inside a template literal to its end, or into its next ${...}."""
        while i < n:
            if text[i] == "\\":
                i += 2
            elif text[i] == "`":
                return i + 1
            elif text.startswith("${", i):
                depths.append(0)
                return i + 2
            else:
                i += 1
        return n

    while i < n:
        char = text[i]
        if text.startswith("//", i):
            i = text.find("\n", i) if "\n" in text[i:] else n
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif char in "'\"":
            i += 1
            while i < n and text[i] != char and text[i] != "\n":
                i += 2 if text[i] == "\\" else 1
            i += 1
        elif char == "`":
            i = skip_template(i + 1)
        elif char == "}" and depths and depths[-1] == 0:
            depths.pop()
            i = skip_template(i + 1)
        else:
            if depths and char in "{}":
                depths[-1] += 1 if char == "{" else -1
            out.append(char)
            i += 1
            continue
        out.append(" ")
    return "".join(out)


def _import_violations(script: Path, text: str, served: set[str]) -> list[str]:
    """Every module ``script`` imports is a literal path relative to it, the kit's or in ``ui/``."""
    violations = [
        f"ui/{script.as_posix()} calls import() with a computed path; import only literal paths"
        for match in UI_DYNAMIC_IMPORT.finditer(text)
        if match.group(2) is None
    ]
    specifiers = [match.group(2) for match in UI_IMPORT.finditer(text)]
    specifiers += [match.group(2) for match in UI_DYNAMIC_IMPORT.finditer(text) if match.group(2) is not None]
    for specifier in specifiers:
        target = posixpath.normpath(posixpath.join(script.parent.as_posix(), specifier))
        if not specifier.startswith(("./", "../")):
            violations.append(f"ui/{script.as_posix()} imports {specifier!r}: import only ./ or ../ paths, the kit's or ui/'s own")
        elif target.startswith("../") or target == "..":
            violations.append(f"ui/{script.as_posix()} imports {specifier!r}, outside ui/")
        elif not ((PAGE / target).is_file() if is_page_path(target) else target in served):
            violations.append(f"ui/{script.as_posix()} imports {specifier!r}, which NanoAgent does not serve")
    return violations


def _template_violations(root: Path) -> list[str]:
    """``.gitignore`` starts from the template's (rule 10)."""
    violations: list[str] = []
    if (root / ".gitignore").is_file():
        ignored = set((root / ".gitignore").read_text(encoding="utf-8").splitlines())
        violations += [
            f".gitignore must ignore {line}" for line in (TEMPLATE / "dot.gitignore").read_text(encoding="utf-8").splitlines() if line not in ignored
        ]
    return violations


def _named_violations(root: Path, config: Any) -> list[str]:
    """``LICENSE``, ``README.md`` and ``pyproject.toml`` are the template's with their names filled in (rule 10)."""
    checks = (("LICENSE", _license_violations), ("README.md", _readme_violations), ("pyproject.toml", _pyproject_violations))
    return [violation for name, check in checks if (root / name).is_file() for violation in check((root / name).read_text(encoding="utf-8"), config)]


def _license_violations(text: str, config: Any) -> list[str]:
    """The template's MIT license, its copyright held by whoever built the plugin."""
    pattern = re.escape((TEMPLATE / "LICENSE").read_text(encoding="utf-8"))
    pattern = pattern.replace(re.escape("{{year}}"), r"\d{4}").replace(re.escape("{{author}}"), r"[^\s{}][^\n{}]*")
    return [] if re.fullmatch(pattern, text) else ["LICENSE must be the template's MIT license with its holder named"]


def _readme_violations(text: str, config: Any) -> list[str]:
    name = config.name.strip()
    lines = text.splitlines()
    violations = [] if lines[:1] == [f"# {name}"] else [f"README.md must open with # {name}"]
    headings = [number for number, line in enumerate(lines) if line.startswith("## ")]
    if [lines[number] for number in headings if lines[number] in README_SECTIONS] != list(README_SECTIONS):
        return [*violations, f"README.md must have the sections {', '.join(README_SECTIONS)}, once each and in that order"]
    start = lines.index(README_SECTIONS[0])
    tools = "\n".join(lines[start : headings[headings.index(start) + 1]])
    missing = [key.value for key in [*config.tools, *config.tasks] if f"`{key.value}`" not in tools]
    return violations + ([f"README.md {README_SECTIONS[0]} does not name {', '.join(missing)}"] if missing else [])


def _pyproject_violations(text: str, config: Any) -> list[str]:
    try:
        pyproject = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        return [f"pyproject.toml: {error}"]
    violations = []
    if pyproject.get("project", {}).get("name") != f"nanoagent-{config.id}":
        violations.append(f"pyproject.toml must name the project nanoagent-{config.id}")
    if "." not in pyproject.get("tool", {}).get("pytest", {}).get("ini_options", {}).get("pythonpath", []):
        violations.append('pyproject.toml must put the plugin root on pytest\'s path: pythonpath = ["."]')
    project = pyproject.get("project", {})
    if project.get("version") != config.version:
        violations.append(f"pyproject.toml must give the project {MANIFEST}'s version, {config.version}")
    template = tomllib.loads((TEMPLATE / "pyproject.toml").read_text(encoding="utf-8"))
    if project.get("requires-python") != template["project"]["requires-python"]:
        violations.append(f"pyproject.toml must require Python {template['project']['requires-python']}")
    dependencies = project.get("dependencies", [])
    violations += [f"pyproject.toml must depend on {required}" for required in template["project"]["dependencies"] if required not in dependencies]
    for dependency in dependencies:
        if dependency in template["project"]["dependencies"]:
            continue
        try:
            operators = {spec.operator for spec in Requirement(dependency).specifier}
        except InvalidRequirement:
            violations.append(f"pyproject.toml dependency {dependency!r} is not a requirement")
            continue
        if not (operators & {"~=", "=="} or {">=", "<"} <= operators):
            violations.append(f"pyproject.toml dependency {dependency!r} must be bounded both ways, as >=X,<Y")
    sources = pyproject.get("tool", {}).get("uv", {}).get("sources", {})
    if sources.get("slimconfig") != template["tool"]["uv"]["sources"]["slimconfig"]:
        violations.append("pyproject.toml must take slimconfig from the template's [tool.uv.sources] entry")
    return violations


def _env_names(path: Path) -> tuple[tuple[str, ...], list[str]]:
    """The variable names `.env` declares, one `NAME` per line, and its violations."""
    names: list[str] = []
    violations: list[str] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name = line
        if not ENV_NAME.fullmatch(name):
            violations.append(f".env line {number} must be a variable NAME alone, with no = or value")
        elif name in names:
            violations.append(f".env line {number} declares {name} twice")
        else:
            names.append(name)
    return tuple(names), violations


def _listing_violations(config: ListingConfig) -> list[str]:
    violations = [] if PLUGIN_ID.fullmatch(config.id) else [f"{MANIFEST} id {config.id!r} is not a plugin id"]
    if not config.name.strip():
        violations.append(f"{MANIFEST} name is blank")
    try:
        Version(config.version)
    except InvalidVersion:
        violations.append(f"{MANIFEST} version {config.version!r} is not a PEP 440 version, such as 0.1.0")
    return violations


def _manifest_class(contract: Any) -> type:
    """The plugin's own :class:`ManifestConfig`: its tables keyed by its contract's Tool and Task."""
    return dataclasses.make_dataclass(
        "PluginManifestConfig",
        [
            ("tools", dict[contract.Tool, ToolConfig], MISSING),
            ("tasks", dict[contract.Task, TaskConfig], MISSING),
        ],
        bases=(ManifestConfig,),
        module=__name__,
    )


def _config_violations(config: Any) -> list[str]:
    """The rules a config class cannot state: non-blank text, hostnames, and how tasks use tools."""
    violations = _listing_violations(config) + _nanoagent_violations(config.nanoagent)
    if tuple(config.runtime.command) != RUNTIME_COMMAND:
        violations.append(f"{MANIFEST} runtime.command must be [{', '.join(RUNTIME_COMMAND)}]")
    violations += [
        f"{MANIFEST} permissions.network.hosts: {host!r} is not a hostname"
        for host in config.permissions.network.hosts
        if not HOSTNAME.fullmatch(host)
    ]
    violations += [f"{MANIFEST} tools.{tool.value}.description is blank" for tool, entry in config.tools.items() if not entry.description.strip()]
    names = {tool.value for tool in config.tools}
    violations += [f"{MANIFEST} tool {name!r} is not a snake_case tool name" for name in names if not TOOL_NAME.fullmatch(name)]
    violations += [f"{MANIFEST} task {key.value!r} is not a kebab-case task id" for key in config.tasks if not TASK_ID.fullmatch(key.value)]
    if SUBMIT in names:
        violations.append(f"{MANIFEST} names a tool {SUBMIT!r}: NanoAgent gives agent tasks that one")
    for key, task in config.tasks.items():
        where = f"{MANIFEST} tasks.{key.value}"
        violations += [f"{where}.{name} is blank" for name in ("description", "instructions") if not getattr(task, name).strip()]
        if not task.tools:
            violations.append(f"{where}.tools is empty")
        unknown = sorted(set(task.tools) - names)
        if unknown:
            violations.append(f"task {key.value!r} uses undeclared tools: {', '.join(unknown)}")
        if task.reference is not None and task.reference not in names:
            violations.append(f"task {key.value!r}: reference {task.reference!r} is not a declared tool")
    return violations


def _nanoagent_violations(versions: str) -> list[str]:
    """``nanoagent`` is one NanoAgent minor version, ``~=X.Y.0``, holding this NanoAgent's version (rule 4)."""
    minor = ".".join(__version__.split(".")[:2]) + ".0"
    try:
        accepted = SpecifierSet(versions) if NANOAGENT_RANGE.fullmatch(versions) else None
    except InvalidSpecifier:
        accepted = None
    if accepted is None:
        return [f"{MANIFEST} nanoagent {versions!r} is not one NanoAgent minor version, such as ~={minor}"]
    if __version__ not in accepted:
        return [f"{MANIFEST} nanoagent: the plugin runs on NanoAgent {versions}, not this NanoAgent, {__version__}"]
    return []


def _class_name_violations(contract: Any) -> list[str]:
    """Every input class's name ends in ``Input`` and every output class's in ``Output`` (rule 3)."""
    violations: list[str] = []
    for table, entries in (("TOOLS", contract.tools), ("TASKS", contract.tasks)):
        for key, (given, output) in entries.items():
            if not given.__name__.endswith("Input"):
                violations.append(f"{CONTRACT} {table}[{key!r}]: input class {given.__name__} must be named ...Input")
            if not output.__name__.endswith("Output"):
                violations.append(f"{CONTRACT} {table}[{key!r}]: output class {output.__name__} must be named ...Output")
    return list(dict.fromkeys(violations))


def _renderer_violations(text: str, contract: Any) -> list[str]:
    """renderers.js draws only the output classes of the plugin's tasks (rule 8)."""
    outputs = {output.__name__ for _given, output in contract.tasks.values()}
    return [f"ui/renderers.js draws {name}, which no task outputs" for name in renderer_names(text) or [] if name not in outputs]


def _usage_violations(config: Any, contract: Any) -> list[str]:
    """Each task's classes fit how it runs: its one tool's input and output, every value a decide
    task needs, and its reference's input."""
    violations: list[str] = []
    for key, task in config.tasks.items():
        given, output = contract.tasks[key.value]
        if task.runner is Runner.TOOL and (len(task.tools) != 1 or contract.tools[task.tools[0]] != (given, output)):
            violations.append(f"task {key.value!r}: a tool runner has exactly one tool, and takes that tool's input and gives its output")
        if task.runner is Runner.DECIDE:
            targets = {f"{tool} input": contract.tools[tool][0] for tool in task.tools} | {"output": output}
            sources = [given, *(contract.tools[tool][1] for tool in task.tools)]
            violations += [
                f"task {key.value!r}: a decide runner fills every field by choice or by copy, but {slot} is no"
                " Enum or bool and no task input or tool output has a value of its type"
                for slot in unfillable(targets, sources)
            ]
        if task.reference is not None and (task.reference in task.tools or contract.tools[task.reference][0] is not given):
            violations.append(
                f"task {key.value!r}: reference {task.reference!r} must be a declared tool outside the task's tools, taking the task's input"
            )
    return violations


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
    if not (root / CONTRACT).is_file() or not (root / MANIFEST).is_file():
        raise PluginError(root, violations)
    problems = contract_problems(root / CONTRACT)
    if problems:
        raise PluginError(root, violations + problems)

    try:
        with contract_module(root) as module:
            contract, contract_violations = read_contract(module)
            violations += contract_violations
            if contract is None:
                raise PluginError(root, violations)
            config = load_config(_manifest_class(module), [str(root / MANIFEST)])
    except PluginError:
        raise
    except Exception as error:  # noqa: BLE001 - every way the contract or the manifest fails is a violation
        raise PluginError(root, [*violations, f"{type(error).__name__}: {error}"]) from error
    violations += _config_violations(config) + _named_violations(root, config)
    product = None
    if (root / PRODUCT).is_file() and (root / "product" / "icon.svg").is_file():
        product, product_violations = _product(root, config.status)
        violations += product_violations
    violations += _class_name_violations(contract)
    if (root / "ui" / "renderers.js").is_file():
        violations += _renderer_violations((root / "ui" / "renderers.js").read_text(encoding="utf-8"), contract)
    if not violations:
        violations += _usage_violations(config, contract)
    if violations:
        raise PluginError(root, violations)

    tools = []
    for key, entry in config.tools.items():
        input_type, output_type = contract.tools[key.value]
        tools.append(
            ToolDefinition(
                name=key.value,
                description=entry.description.strip(),
                input_class=input_type.__name__,
                output_class=output_type.__name__,
                input=output_schema(input_type),
                output=output_schema(output_type),
                input_type=input_type,
                output_type=output_type,
            )
        )
    tasks = []
    for key, task in config.tasks.items():
        input_type, output_type = contract.tasks[key.value]
        tasks.append(
            TaskDefinition(
                id=key.value,
                description=task.description.strip(),
                runner=task.runner.value,
                tools=tuple(task.tools),
                input_class=input_type.__name__,
                input=output_schema(input_type),
                output_class=output_type.__name__,
                output=output_schema(output_type),
                reference=task.reference,
                instructions=task.instructions.strip(),
                input_type=input_type,
                output_type=output_type,
            )
        )
    return PluginManifest(
        root=root,
        id=config.id,
        name=config.name.strip(),
        version=config.version.strip(),
        status=config.status.value,
        runtime=config.runtime.type.value,
        command=tuple(config.runtime.command),
        permissions=Permissions(
            tuple(config.permissions.network.hosts),
            tuple(scope.value for scope in config.permissions.filesystem.write),
        ),
        product=product,
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
    status: str

    def public(self) -> dict[str, Any]:
        readme = self.root / "README.md"
        return {
            "spec": SPEC,
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "status": self.status,
            "readme": readme.read_text(encoding="utf-8") if readme.is_file() else "",
        }


def load_listing(source: str | Path) -> PluginManifest | PluginListing:
    """A ``ready`` plugin, which must pass every rule, or an in-development one's listing.

    An in-development plugin need only name itself correctly (:class:`ListingConfig`), so a
    plugin being built cannot stop a host that lists it; a ``ready`` one is held to all of
    :func:`load_manifest`.
    """
    root = Path(source).expanduser().resolve()
    if not (root / MANIFEST).is_file():
        raise PluginError(root, [f"{MANIFEST} not found"])
    try:
        merged = OmegaConf.to_container(merge_specs([str(root / MANIFEST)]), resolve=False)
        head = {name: merged[name] for name in (f.name for f in dataclasses.fields(ListingConfig)) if name in merged}
        listing = load_config(ListingConfig, [head])
    except ValueError as error:
        raise PluginError(root, [f"{MANIFEST}: {error}"]) from None
    violations = _listing_violations(listing)
    if violations:
        raise PluginError(root, violations)
    if listing.status is Status.READY:
        return load_manifest(root)
    return PluginListing(
        root=root,
        id=listing.id,
        name=listing.name.strip(),
        version=listing.version.strip(),
        status=listing.status.value,
    )
