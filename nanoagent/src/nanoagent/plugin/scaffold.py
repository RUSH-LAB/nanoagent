"""`nanoagent plugin new`: start a plugin from the template, with the reference plugin's structure.

The template (``nanoagent/plugin/template/``) is the layout of ``plugins/arxiv-source`` with one
small tool. Its files are copied with ``{{id}}``, ``{{name}}``, ``{{year}}``, ``{{author}}`` (git's
``user.name``: the builder holds the LICENSE's copyright) and ``{{nanoagent}}`` (this NanoAgent's
minor version, ``X.Y.0``) filled in;
``dot.<name>`` files become ``.<name>`` (dotfiles stay out of the package's ignore rules).
``uv lock`` then writes the lock, and the result must load under every plugin rule.
"""

from __future__ import annotations

import shutil
import subprocess
from datetime import date
from pathlib import Path

from nanoagent import __version__
from nanoagent.plugin.manifest import PLUGIN_ID, TEMPLATE, TOOL_ARTIFACTS, PluginManifest, load_manifest


def create_plugin(folder: Path) -> PluginManifest:
    """Create the plugin ``folder`` (a new folder named by the plugin id) and return its manifest."""
    plugin_id = folder.name
    if not PLUGIN_ID.fullmatch(plugin_id):
        raise ValueError(f"plugin folder name {plugin_id!r} must be an id: lowercase letters, numbers, single hyphens")
    if folder.exists():
        raise FileExistsError(f"{folder} already exists")
    if shutil.which("uv") is None:
        raise RuntimeError("uv is not installed: a plugin's environment is a uv project")
    author = subprocess.run(["git", "config", "user.name"], capture_output=True, text=True, check=False).stdout.strip()
    if not author:
        raise RuntimeError("git config user.name is not set: it names the plugin's copyright holder in LICENSE")
    values = {
        "{{id}}": plugin_id,
        "{{name}}": plugin_id.replace("-", " ").title(),
        "{{year}}": str(date.today().year),
        "{{author}}": author,
        "{{nanoagent}}": ".".join(__version__.split(".")[:2]) + ".0",
    }
    for source in sorted(TEMPLATE.rglob("*")):
        relative = source.relative_to(TEMPLATE)
        if not source.is_file() or TOOL_ARTIFACTS & set(relative.parts):
            continue
        name = relative.name
        if name.startswith("dot."):
            name = "." + name.removeprefix("dot.")
        target = folder / relative.parent / name
        target.parent.mkdir(parents=True, exist_ok=True)
        text = source.read_text(encoding="utf-8")
        for placeholder, value in values.items():
            text = text.replace(placeholder, value)
        target.write_text(text, encoding="utf-8")
        target.chmod(source.stat().st_mode)
    locked = subprocess.run(["uv", "lock", "--quiet"], cwd=folder, capture_output=True, text=True, check=False)
    if locked.returncode:
        raise RuntimeError(f"uv lock failed in {folder}: {locked.stderr.strip()}")
    return load_manifest(folder)
