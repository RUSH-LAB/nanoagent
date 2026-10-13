"""Compile vendor/Stockfish into the wheel, as chess_move_stockfish/stockfish.

vendor/Stockfish is official-stockfish/Stockfish at 762dd1da9a5d (stockfish-dev-20260803), its
src/, scripts/ and licence. The tree is copied to a scratch folder and built there with `make build
ARCH=native`, so the plugin's own copy is never written to. Stockfish embeds its NNUE net in the
binary, and the net (95 MB) is not in the tree; it is fetched from GitHub's copy of
official-stockfish/networks and checked against the sha256 its name carries before make sees it.
"""

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

from setuptools import Distribution, setup
from setuptools.command.build_py import build_py

STOCKFISH = Path(__file__).resolve().parent / "vendor" / "Stockfish"
NETWORKS = "https://media.githubusercontent.com/media/official-stockfish/networks/master/"


def fetch_net(src: Path) -> None:
    """Put the net evaluate.h names into ``src``, refusing one whose sha256 is not in its name."""
    name = re.search(r'#define EvalFileDefaultName\s+"(nn-([0-9a-f]{12})\.nnue)"', (src / "evaluate.h").read_text())
    if not name:
        raise RuntimeError(f"no EvalFileDefaultName in {src / 'evaluate.h'}")
    with urllib.request.urlopen(NETWORKS + name[1], timeout=300) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest()[:12] != name[2]:
        raise RuntimeError(f"{NETWORKS + name[1]} is not the net its name says")
    (src / name[1]).write_bytes(data)


class BuildStockfish(build_py):
    def run(self) -> None:
        super().run()
        with tempfile.TemporaryDirectory(prefix="chess-move-stockfish-") as scratch:
            tree = Path(scratch) / "Stockfish"
            shutil.copytree(STOCKFISH, tree)
            fetch_net(tree / "src")
            subprocess.run(["make", f"-j{os.cpu_count()}", "build", "ARCH=native"], cwd=tree / "src", check=True)
            shutil.copy2(tree / "src" / "stockfish", Path(self.build_lib) / "chess_move_stockfish" / "stockfish")


class BinaryDistribution(Distribution):
    """A wheel for this platform only: it carries a compiled program."""

    def has_ext_modules(self) -> bool:
        return True


setup(cmdclass={"build_py": BuildStockfish}, distclass=BinaryDistribution)
