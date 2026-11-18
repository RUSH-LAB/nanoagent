"""Assembles the folder to upload as the NanoAgent task tools harness, from NanoAgent's working tree.

    python src/nanoagent/uploaded/reference_harnesses/nanoagent/assemble.py build/harnesses/nanoagent

The folder holds this directory's files plus `nanoagent/`: the unmodified NanoAgent modules the task tools path imports,
copied from `src/nanoagent` (and nothing else of it), so what runs is the working tree's engine, agent loop, chat client
and decide dataflow. The three package `__init__` files of the parts left out (`plugin`, `inference`, `inference.backends`)
are empty, since the real ones import the CLI, web and config stacks. The output is rebuilt from scratch every time.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[2]
OWN = ("harness.yaml", "main.py", "requirements.txt")
# Whole packages, and single modules of packages whose `__init__` is left out.
IGNORE = shutil.ignore_patterns("__pycache__")
PACKAGES = ("core", "profiler")
MODULES = (
    "plugin/dataflow.py",
    "inference/backend.py",
    "inference/config.py",
    "inference/http.py",
    "inference/thinking.py",
    "inference/types.py",
    "inference/backends/sglang.py",
)
EMPTY_INITS = ("plugin", "inference", "inference/backends")


def assemble(destination: Path) -> Path:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for name in OWN:
        shutil.copy2(HERE / name, destination / name)
    shutil.copytree(HERE / "taskharness", destination / "taskharness", ignore=IGNORE)
    package = destination / "nanoagent"
    package.mkdir()
    shutil.copy2(SOURCE / "__init__.py", package / "__init__.py")
    for name in PACKAGES:
        shutil.copytree(SOURCE / name, package / name, ignore=IGNORE)
    for module in MODULES:
        (package / module).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / module, package / module)
    for folder in EMPTY_INITS:
        (package / folder / "__init__.py").write_text("")
    return destination


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: assemble.py <destination folder>")
    print(assemble(Path(sys.argv[1])))
