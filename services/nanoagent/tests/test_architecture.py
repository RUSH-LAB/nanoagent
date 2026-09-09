"""Keep the package layers pointing inward as the codebase evolves."""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE_ROOT = Path(__file__).parents[1] / "src" / "nanoagent"

ALLOWED_IMPORTS = {
    "adapters": {"adapters"},
    "core": {"core"},
    "inference": {"inference"},
    "runtime": {"core", "extensions", "inference", "runtime", "tools"},
    "tools": {"core", "extensions", "tools"},
}


def _nanoagent_imports(path: Path) -> set[str]:
    imported: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names = [node.module]
        for name in names:
            if name == "nanoagent":
                imported.add("__init__")
            elif name.startswith("nanoagent."):
                imported.add(name.split(".", 2)[1])
    return imported


def test_package_layers_only_import_inward() -> None:
    violations: list[str] = []
    for layer, allowed in ALLOWED_IMPORTS.items():
        for path in sorted((PACKAGE_ROOT / layer).rglob("*.py")):
            forbidden = _nanoagent_imports(path) - allowed
            if forbidden:
                violations.append(
                    f"{path.relative_to(PACKAGE_ROOT)} imports {sorted(forbidden)}"
                )

    assert not violations, "package-layer violations:\n" + "\n".join(violations)
