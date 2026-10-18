"""What NanoAgent's template holds a plugin to as it is made and published, beyond its spec's rules.

A plugin's spec (:mod:`nanoagent.plugin.manifest`) is what running and listing it rely on, and
never changes. The template, :data:`TEMPLATE`, what ``nanoagent plugin new`` writes, changes
with NanoAgent, and so do these rules, so they are checked only where a plugin is made or
published: ``nanoagent plugin new``, ``inspect`` and ``pack`` (:func:`check_plugin`). Installing
and running a plugin checks its spec's rules alone, so a published plugin is never refused for a
rule its author had no chance to meet.

:func:`check_plugin` loads a plugin under its spec's rules and these, raising
:class:`PluginError` with every broken rule of both at once:

1. The standard layout: every file in :data:`STANDARD_FILES` and folder in
   :data:`STANDARD_FOLDERS`, ``tests/`` holding :data:`VERIFIER_TEST`, the verifier's own test,
   and nothing else: the top level holds only these (and :data:`TOOL_ARTIFACTS`, which are never
   packed: what tools create in a checkout, and a coding agent's instructions), ``verifier/``
   only ``.py`` files and ``product/`` only its files. ``src/`` and ``tests/`` are the plugin's own
   to organize.
2. The standard files are the template's: ``LICENSE`` is its license with a year and the name of
   whoever holds the copyright; ``.gitignore`` ignores every path it ignores; ``README.md`` opens
   with ``# <name>`` and has its sections (:data:`README_SECTIONS`, in order), naming every tool
   and task under ``## Tools``; ``pyproject.toml`` names the project ``nanoagent-<id>`` at the
   manifest's version, puts the plugin root on pytest's path, and has the template's
   ``requires-python``, its dependencies and its ``slimconfig`` source, every other dependency
   bounded above and below.
3. A ``ready`` plugin's ``product/product.yaml`` is its own, none of it the template's placeholder.

:func:`migrate` moves a plugin made before plugins declared their spec onto :data:`SPEC`.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

from omegaconf import OmegaConf
from packaging.requirements import InvalidRequirement, Requirement
from slimconfig import merge_specs

from nanoagent.plugin.contract import CONTRACT
from nanoagent.plugin.manifest import MANIFEST, SPEC, SPECS, TOOL_ARTIFACTS, PluginError, PluginManifest, load_manifest

# What `nanoagent plugin new` copies.
TEMPLATE = Path(__file__).with_name("template")
STANDARD_FILES = (MANIFEST, CONTRACT, "README.md", "LICENSE", "pyproject.toml", "uv.lock", ".gitignore", ".env")
STANDARD_FOLDERS = ("src", "tests", "verifier", "ui", "product")
VERIFIER_TEST = "tests/test_verifier.py"
README_SECTIONS = ("## Tools", "## Layout", "## Develop and run")
PRODUCT = "product/product.yaml"
PRODUCT_FILES = ("product.yaml", "icon.svg")
# The line a plugin made before specs names its NanoAgent with, such as `nanoagent: ~=0.6.0`.
PRE_SPEC = re.compile(r"^nanoagent: .*$", re.MULTILINE)


def check_plugin(source: str | Path) -> PluginManifest:
    """Load the plugin folder ``source`` under its spec's rules and the template's, or raise
    :class:`PluginError` naming every broken rule."""
    root = Path(source).expanduser().resolve()
    try:
        manifest, violations = load_manifest(root), []
    except PluginError as error:
        manifest, violations = None, error.violations
    violations += _layout_violations(root) + _gitignore_violations(root)
    if manifest is not None:
        violations += _named_violations(root, manifest) + _placeholder_violations(manifest)
    if violations:
        raise PluginError(root, list(dict.fromkeys(violations)))
    return manifest


def migrate(source: str | Path) -> PluginManifest:
    """Move the plugin folder ``source``, made for NanoAgent 0.6 or earlier, onto :data:`SPEC`.

    Its ``nanoagent`` line becomes ``spec: <SPEC>``, ``nanoagent.yaml`` and ``product.yaml`` name
    :data:`SPEC`'s classes for ``nanoagent.plugin.manifest``'s, and ``run.sh``, which NanoAgent 0.6
    stopped running, goes. The plugin must then pass :func:`check_plugin`, whose error lists any
    other change it needs.
    """
    root = Path(source).expanduser().resolve()
    manifest = root / MANIFEST
    text = manifest.read_text(encoding="utf-8")
    if not PRE_SPEC.search(text):
        raise ValueError(f"{manifest} has no nanoagent line: it is not a plugin made before plugins declared their spec")
    module = SPECS[SPEC] + "."
    manifest.write_text(PRE_SPEC.sub(f"spec: {SPEC}", text, count=1).replace("nanoagent.plugin.manifest.", module), encoding="utf-8")
    if (root / PRODUCT).is_file():
        (root / PRODUCT).write_text((root / PRODUCT).read_text(encoding="utf-8").replace("nanoagent.plugin.manifest.", module), encoding="utf-8")
    (root / "run.sh").unlink(missing_ok=True)
    return check_plugin(root)


def _layout_violations(root: Path) -> list[str]:
    """The standard layout, and nothing else (rule 1)."""
    violations = [f"missing {name}" for name in STANDARD_FILES if not (root / name).is_file()]
    violations += [f"missing {name}/" for name in STANDARD_FOLDERS if not (root / name).is_dir()]
    if (root / "tests").is_dir() and not (root / VERIFIER_TEST).is_file():
        violations.append(f"missing {VERIFIER_TEST}")
    standard = {*STANDARD_FILES, *STANDARD_FOLDERS, *TOOL_ARTIFACTS}
    violations += [f"unexpected {path.name}" for path in sorted(root.iterdir()) if path.name not in standard]
    if (root / "verifier").is_dir():
        violations += [
            f"unexpected verifier/{path.relative_to(root / 'verifier').as_posix()}: only .py files belong there"
            for path in sorted((root / "verifier").rglob("*"))
            if path.is_file() and path.suffix != ".py" and not TOOL_ARTIFACTS & set(path.relative_to(root).parts)
        ]
    if (root / "product").is_dir():
        names = {path.name for path in (root / "product").iterdir() if path.name not in TOOL_ARTIFACTS}
        violations += [f"unexpected product/{name}" for name in sorted(names - set(PRODUCT_FILES))]
    return violations


def _gitignore_violations(root: Path) -> list[str]:
    """``.gitignore`` starts from the template's (rule 2)."""
    if not (root / ".gitignore").is_file():
        return []
    ignored = set((root / ".gitignore").read_text(encoding="utf-8").splitlines())
    template = (TEMPLATE / "dot.gitignore").read_text(encoding="utf-8").splitlines()
    return [f".gitignore must ignore {line}" for line in template if line not in ignored]


def _named_violations(root: Path, manifest: PluginManifest) -> list[str]:
    """``LICENSE``, ``README.md`` and ``pyproject.toml`` are the template's with their names filled in (rule 2)."""
    checks = (("LICENSE", _license_violations), ("README.md", _readme_violations), ("pyproject.toml", _pyproject_violations))
    return [
        violation for name, check in checks if (root / name).is_file() for violation in check((root / name).read_text(encoding="utf-8"), manifest)
    ]


def _license_violations(text: str, manifest: PluginManifest) -> list[str]:
    """The template's MIT license, its copyright held by whoever built the plugin."""
    pattern = re.escape((TEMPLATE / "LICENSE").read_text(encoding="utf-8"))
    pattern = pattern.replace(re.escape("{{year}}"), r"\d{4}").replace(re.escape("{{author}}"), r"[^\s{}][^\n{}]*")
    return [] if re.fullmatch(pattern, text) else ["LICENSE must be the template's MIT license with its holder named"]


def _readme_violations(text: str, manifest: PluginManifest) -> list[str]:
    lines = text.splitlines()
    violations = [] if lines[:1] == [f"# {manifest.name}"] else [f"README.md must open with # {manifest.name}"]
    headings = [number for number, line in enumerate(lines) if line.startswith("## ")]
    if [lines[number] for number in headings if lines[number] in README_SECTIONS] != list(README_SECTIONS):
        return [*violations, f"README.md must have the sections {', '.join(README_SECTIONS)}, once each and in that order"]
    start = lines.index(README_SECTIONS[0])
    tools = "\n".join(lines[start : headings[headings.index(start) + 1]])
    names = [*(tool.name for tool in manifest.tools), *(task.id for task in manifest.tasks)]
    missing = [name for name in names if f"`{name}`" not in tools]
    return violations + ([f"README.md {README_SECTIONS[0]} does not name {', '.join(missing)}"] if missing else [])


def _pyproject_violations(text: str, manifest: PluginManifest) -> list[str]:
    try:
        pyproject = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        return [f"pyproject.toml: {error}"]
    violations = []
    if pyproject.get("project", {}).get("name") != f"nanoagent-{manifest.id}":
        violations.append(f"pyproject.toml must name the project nanoagent-{manifest.id}")
    if "." not in pyproject.get("tool", {}).get("pytest", {}).get("ini_options", {}).get("pythonpath", []):
        violations.append('pyproject.toml must put the plugin root on pytest\'s path: pythonpath = ["."]')
    project = pyproject.get("project", {})
    if project.get("version") != manifest.version:
        violations.append(f"pyproject.toml must give the project {MANIFEST}'s version, {manifest.version}")
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


def _placeholder_violations(manifest: PluginManifest) -> list[str]:
    """A ready plugin's product page holds none of the template's placeholder text, whatever name it was given (rule 3)."""
    if manifest.status != "ready":
        return []
    template = OmegaConf.to_container(merge_specs([str(TEMPLATE / PRODUCT)]))
    texts = [template["tagline"], template["summary"], *template["highlights"], *template["steps"]]
    patterns = [re.compile(re.escape(text.strip()).replace(re.escape("{{name}}"), ".*")) for text in texts]
    product = manifest.product
    own = [product.tagline, product.summary, *product.highlights, *product.steps]
    if any(pattern.fullmatch(text) for pattern in patterns for text in own):
        return [f"{PRODUCT} still holds the template's placeholder text; a ready plugin describes itself"]
    return []
