"""The `nanoagent.plugin/v1` rules, and the loader that refuses a plugin breaking any of them.

A plugin is a folder. :func:`load_manifest` loads it only when every rule holds, and otherwise
raises :class:`PluginError` listing every broken rule at once:

1. Layout: the folder has every file in :data:`REQUIRED_FILES` and every folder in
   :data:`REQUIRED_FOLDERS`; ``src/`` holds at least one file and ``tests/`` holds
   :data:`VERIFIER_TEST`, the verifier's own test.
2. ``.env`` lists the environment variables the plugin needs: one ``NAME`` per line, no values.
3. ``contract.py`` declares every tool's and task's typed input and output, and nothing but
   declarations (see :mod:`nanoagent.plugin.contract`).
4. ``nanoagent.yaml`` fills :class:`ManifestConfig` under slimconfig's rules: it names its class
   (``_ > nanoagent.plugin.manifest.ManifestConfig:``), sets every field and no other, and its
   ``tools`` and ``tasks`` are tables keyed by the contract's ``Tool`` and ``Task``.
5. Every task uses only declared tools. A task's ``runner`` is ``tool`` (exactly one tool,
   called directly with the task's input, so the task's input class is that tool's) or
   ``agent`` (an agent works the task with its tools). A ``reference`` tool, when set, takes
   the task's input and is not one of the task's tools: NanoAgent runs it before the task and
   pins its output for :func:`verify_task`.
6. ``verifier/`` is a deterministic verifier package (see :mod:`nanoagent.plugin.verifier`).
7. Nothing else: the top level holds only the standard layout (and :data:`TOOL_ARTIFACTS`),
   and ``verifier/`` only ``.py`` files. ``src/`` and ``tests/`` are the plugin's own to
   organize.
8. ``ui/`` is the plugin's front end: a static web page, ``ui/index.html`` and the files it
   loads, only :data:`UI_SUFFIXES` and at most :data:`UI_MAX_BYTES` in total. A host shows it in
   a sandboxed frame that talks to NanoAgent only through the ``nanoagent.ui/v1`` bridge
   (docs/plans/plugin-ui.md). ``ui/index.html`` and ``ui/kit/`` are the shared UI kit, the
   :data:`TEMPLATE`'s byte for byte; ``ui/app.js`` and ``ui/app.css`` are the plugin's own page,
   and it may add its own static assets beside them.
9. ``product/`` is the plugin's product page, what a catalog shows people before they open it,
   and holds exactly :data:`PRODUCT_FILES`. ``product.yaml`` fills :class:`ProductConfig`
   (``_ > nanoagent.plugin.manifest.ProductConfig:``): a tagline, a summary, 2 to 4 highlights
   and 2 to 5 steps, none blank. ``icon.svg`` is the app's icon: an SVG of at most
   :data:`ICON_MAX_BYTES` that draws only, with no script, event handler, embedded content or
   link outside itself.
10. The standard files are the :data:`TEMPLATE`'s, what ``nanoagent plugin new`` writes:
    ``LICENSE`` is its license with a year and the plugin's ``name``; ``.gitignore`` ignores
    every path it ignores; ``run.sh`` begins with its checks, and a plugin adds its own after
    them; ``README.md`` opens with ``# <name>`` and has its sections (:data:`README_SECTIONS`, in
    order), naming every tool under ``## Tools``; ``pyproject.toml`` names the project
    ``nanoagent-<id>`` and puts the plugin root on pytest's path.

Every tool call re-checks the rules (see :mod:`nanoagent.plugin.runtime`), so a plugin edited
after it was loaded is refused as well.
"""

from __future__ import annotations

import base64
import dataclasses
import enum
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from omegaconf import MISSING, OmegaConf
from slimconfig import Config, load_config, merge_specs, output_schema

from nanoagent.plugin.contract import CONTRACT, contract_module, contract_problems, read_contract
from nanoagent.plugin.verifier import verifier_problems

SPEC = "nanoagent.plugin/v1"
PLUGIN_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
HOSTNAME = re.compile(r"^[^/:\s]+$")  # a hostname only: no scheme, port, or path
MANIFEST = "nanoagent.yaml"
# What `nanoagent plugin new` copies; rules 8 and 10 hold every plugin's standard files to it.
TEMPLATE = Path(__file__).with_name("template")
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
    "run.sh",  # exits 0 when this environment can run the plugin; run before every launch
)
REQUIRED_FOLDERS = (
    "src",
    "tests",
    "verifier",  # the deterministic verifier package (see nanoagent.plugin.verifier)
    "ui",  # the front end: a static web page, ui/index.html
    "product",  # the product page a catalog shows: product.yaml and icon.svg
)
PRODUCT = "product/product.yaml"
PRODUCT_FILES = ("product.yaml", "icon.svg")
ICON_MAX_BYTES = 64 * 1024
# SVG elements that run, embed or fetch something rather than draw.
ICON_FORBIDDEN = frozenset({"script", "foreignObject", "iframe", "embed", "object", "image", "use", "a"})
# What a front end may hold: static web files, nothing built or run at load.
UI_SUFFIXES = frozenset(
    {".html", ".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".json", ".md"}
)
UI_MAX_BYTES = 5 * 1024 * 1024
# What git, uv, Python and the test tools create in a checkout: allowed anywhere, never checked.
TOOL_ARTIFACTS = frozenset(
    {".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".DS_Store"}
)


class Status(enum.Enum):
    READY = "ready"
    IN_DEVELOPMENT = "in-development"  # listed by a catalog, never run


class Runner(enum.Enum):
    TOOL = "tool"
    AGENT = "agent"


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
    runner: str  # "tool" or "agent"
    tools: tuple[str, ...]
    input_class: str
    input: dict[str, Any]
    reference: str | None  # the tool whose output is pinned as the task's ground truth
    instructions: str
    input_type: type = field(compare=False, repr=False)


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


def _product(root: Path) -> tuple[Product | None, list[str]]:
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
    icon = base64.b64encode((root / "product" / "icon.svg").read_bytes()).decode()
    return Product(
        tagline=config.tagline.strip(),
        summary=config.summary.strip(),
        highlights=tuple(item.strip() for item in config.highlights),
        steps=tuple(item.strip() for item in config.steps),
        icon=f"data:image/svg+xml;base64,{icon}",
    ), violations


def _kit(ui: Path) -> dict[str, bytes]:
    """The shared UI kit in ``ui``: ``index.html`` and ``kit/``, by path."""
    files = [ui / "index.html", *sorted((ui / "kit").rglob("*"))]
    return {
        path.relative_to(ui).as_posix(): path.read_bytes()
        for path in files
        if path.is_file() and not TOOL_ARTIFACTS & set(path.relative_to(ui).parts)
    }


def _ui_violations(ui: Path) -> list[str]:
    files = [path for path in sorted(ui.rglob("*")) if path.is_file() and not TOOL_ARTIFACTS & set(path.relative_to(ui).parts)]
    kit, template = _kit(ui), _kit(TEMPLATE / "ui")
    violations = [
        f"missing ui/{name}" if name not in kit else f"ui/{name} is not the template's"
        for name in sorted(template)
        if kit.get(name) != template[name]
    ]
    violations += [f"unexpected ui/{name}: ui/kit/ holds only the template's kit" for name in sorted(kit.keys() - template.keys())]
    violations += [
        f"unexpected ui/{path.relative_to(ui).as_posix()}: ui/ holds only static web files"
        for path in files
        if path.suffix.lower() not in UI_SUFFIXES
    ]
    size = sum(path.stat().st_size for path in files)
    if size > UI_MAX_BYTES:
        violations.append(f"ui/ holds {size} bytes, over the {UI_MAX_BYTES}-byte limit")
    return violations


def _template_violations(root: Path) -> list[str]:
    """``.gitignore`` and ``run.sh`` start from the template's (rule 10)."""
    violations: list[str] = []
    if (root / ".gitignore").is_file():
        ignored = set((root / ".gitignore").read_text(encoding="utf-8").splitlines())
        violations += [
            f".gitignore must ignore {line}"
            for line in (TEMPLATE / "dot.gitignore").read_text(encoding="utf-8").splitlines()
            if line not in ignored
        ]
    template = (TEMPLATE / "run.sh").read_text(encoding="utf-8")
    if (root / "run.sh").is_file() and not (root / "run.sh").read_text(encoding="utf-8").startswith(template):
        violations.append("run.sh must begin with the template's checks; add the plugin's own after them")
    return violations


def _named_violations(root: Path, config: Any) -> list[str]:
    """``LICENSE``, ``README.md`` and ``pyproject.toml`` name the plugin as the template's do (rule 10)."""
    checks = (("LICENSE", _license_violations), ("README.md", _readme_violations), ("pyproject.toml", _pyproject_violations))
    return [
        violation
        for name, check in checks
        if (root / name).is_file()
        for violation in check((root / name).read_text(encoding="utf-8"), config)
    ]


def _license_violations(text: str, config: Any) -> list[str]:
    name = config.name.strip()
    pattern = re.escape((TEMPLATE / "LICENSE").read_text(encoding="utf-8"))
    pattern = pattern.replace(re.escape("{{year}}"), r"\d{4}").replace(re.escape("{{name}}"), re.escape(name))
    return [] if re.fullmatch(pattern, text) else [f"LICENSE must be the template's MIT license for The {name} authors"]


def _readme_violations(text: str, config: Any) -> list[str]:
    name = config.name.strip()
    lines = text.splitlines()
    violations = [] if lines[:1] == [f"# {name}"] else [f"README.md must open with # {name}"]
    headings = [number for number, line in enumerate(lines) if line.startswith("## ")]
    if [lines[number] for number in headings if lines[number] in README_SECTIONS] != list(README_SECTIONS):
        return [*violations, f"README.md must have the sections {', '.join(README_SECTIONS)}, once each and in that order"]
    start = lines.index(README_SECTIONS[0])
    tools = "\n".join(lines[start : headings[headings.index(start) + 1]])
    missing = [tool.value for tool in config.tools if f"`{tool.value}`" not in tools]
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
    return violations


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


def _listing_violations(config: ListingConfig) -> list[str]:
    violations = [] if PLUGIN_ID.fullmatch(config.id) else [f"{MANIFEST} id {config.id!r} is not a plugin id"]
    return violations + [
        f"{MANIFEST} {name} is blank" for name in ("name", "version") if not getattr(config, name).strip()
    ]


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
    violations = _listing_violations(config)
    if not config.runtime.command or not all(part.strip() for part in config.runtime.command):
        violations.append(f"{MANIFEST} runtime.command must be a non-empty list of words")
    violations += [
        f"{MANIFEST} permissions.network.hosts: {host!r} is not a hostname"
        for host in config.permissions.network.hosts
        if not HOSTNAME.fullmatch(host)
    ]
    violations += [
        f"{MANIFEST} tools.{tool.value}.description is blank"
        for tool, entry in config.tools.items()
        if not entry.description.strip()
    ]
    names = {tool.value for tool in config.tools}
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


def _usage_violations(config: Any, contract: Any) -> list[str]:
    """Each task's input class fits how it runs: its one tool's input, and its reference's."""
    violations: list[str] = []
    for key, task in config.tasks.items():
        given = contract.tasks[key.value]
        if task.runner is Runner.TOOL and (len(task.tools) != 1 or contract.tools[task.tools[0]][0] is not given):
            violations.append(f"task {key.value!r}: a tool runner has exactly one tool, and takes that tool's input")
        if task.reference is not None and (task.reference in task.tools or contract.tools[task.reference][0] is not given):
            violations.append(
                f"task {key.value!r}: reference {task.reference!r} must be a declared tool outside the task's tools,"
                " taking the task's input"
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
        product, product_violations = _product(root)
        violations += product_violations
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
        input_type = contract.tasks[key.value]
        tasks.append(
            TaskDefinition(
                id=key.value,
                description=task.description.strip(),
                runner=task.runner.value,
                tools=tuple(task.tools),
                input_class=input_type.__name__,
                input=output_schema(input_type),
                reference=task.reference,
                instructions=task.instructions.strip(),
                input_type=input_type,
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
