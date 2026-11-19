"""Assembles the folder to upload as the NanoAgent reference harness, from NanoAgent's working tree.

    python src/nanoagent/uploaded/reference_harnesses/nanoagent/assemble.py build/harnesses/nanoagent

The folder holds this directory's files plus `nanoagent/`: the unmodified NanoAgent modules the task tools path (main.py) and
NanoAgent's own CLI (`nanoagent chat` and `mgen`, which the RUSH terminal runs: nanoagent.uploaded.clis) import, copied from
`src/nanoagent` (and nothing else of it), so what runs is the working tree's engine, agent loop, chat client, CLI and decide
dataflow. `plugin`'s `__init__` is empty, since the real one imports the plugin runtime. Beside them are the two pure-Python
packages NanoAgent's config stack imports that no wheel carries (`slimconfig`, a git source, and omegaconf's `antlr4` runtime, an
sdist), copied from the environment this NanoAgent runs in; requirements.txt holds every other. The output is rebuilt from
scratch every time.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[2]
OWN = ("harness.yaml", "main.py", "requirements.txt")
# Whole packages, and single modules of packages whose `__init__` is left out.
PACKAGES = ("cli", "configs", "core", "execution", "harness", "inference", "profiler", "runtime", "tools", "trajectory")
MODULES = ("extensions.py", "plugin/dataflow.py")
EMPTY_INITS = ("plugin",)
WHEELLESS = ("slimconfig", "antlr4")


def assemble(destination: Path) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for name in OWN:
        shutil.copy2(HERE / name, destination / name)
    ignore = shutil.ignore_patterns("__pycache__")
    shutil.copytree(HERE / "taskharness", destination / "taskharness", ignore=ignore)
    package = destination / "nanoagent"
    package.mkdir()
    shutil.copy2(SOURCE / "__init__.py", package / "__init__.py")
    for name in PACKAGES:
        shutil.copytree(SOURCE / name, package / name, ignore=ignore)
    for module in MODULES:
        (package / module).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / module, package / module)
    for folder in EMPTY_INITS:
        (package / folder / "__init__.py").write_text("")
    for name in WHEELLESS:
        spec = importlib.util.find_spec(name)
        if spec is None or not spec.submodule_search_locations:
            raise RuntimeError(f"{name} is not installed beside this NanoAgent")
        shutil.copytree(spec.submodule_search_locations[0], destination / name, ignore=ignore)
    return destination


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: assemble.py <destination folder>")
    print(assemble(Path(sys.argv[1])))
