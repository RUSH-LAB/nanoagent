"""Reproduces the committed `package-lock.json` of each JavaScript reference harness from its `package.json`.

    .venv/bin/python src/nanoagent/uploaded/reference_harnesses/regenerate_locks.py [--check] [harness ...]

The lock is what the worker's build resolves from (the build is network-less), so it must hold only what a Linux worker
can use. Each lock is generated with `npm install --package-lock-only --ignore-scripts` and then:

- optional platform packages are pruned to Linux on x64 or arm64 with glibc (the worker's runtime images are Debian);
- `@deepseek-ai/libreoffice-kit-wasm` and `@img/sharp-wasm32` are dropped (WebAssembly fallbacks the Linux native packages
  make unnecessary);
- an `integrity` the generated lock lacks is filled from the registry (`npm view <name>@<version> dist.integrity`).

`--check` regenerates in a temporary folder and fails when a committed lock differs; otherwise the locks are rewritten.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESSES = ("claude-code", "codex", "dsh", "pi", "shell")
ARCHITECTURES = {"x64", "arm64"}
DROPPED = {"node_modules/@deepseek-ai/libreoffice-kit-wasm", "node_modules/@img/sharp-wasm32"}


def usable(key: str, entry: dict) -> bool:
    """Whether a Linux x64 or arm64 glibc worker can use the package at ``key``."""
    if key.rsplit("node_modules/", 1)[-1] in {name.removeprefix("node_modules/") for name in DROPPED}:
        return False
    # The registry's metadata for some packages carries no `libc`; their names say it.
    if "musl" in key.rsplit("/", 1)[-1] or entry.get("libc") == ["musl"]:
        return False
    if "os" in entry and "linux" not in entry["os"]:
        return False
    return "cpu" not in entry or bool(ARCHITECTURES & set(entry["cpu"]))


def generate(harness: str, work: Path) -> str:
    work.mkdir(parents=True)
    (work / "package.json").write_bytes((HERE / harness / "package.json").read_bytes())
    subprocess.run(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=work, check=True, capture_output=True)
    lock = json.loads((work / "package-lock.json").read_text(encoding="utf-8"))
    packages = {key: entry for key, entry in lock["packages"].items() if not key or usable(key, entry)}
    for key, entry in packages.items():
        if key and "resolved" in entry and "integrity" not in entry and not entry.get("inBundle"):
            name = key.rsplit("node_modules/", 1)[1]
            integrity = subprocess.run(["npm", "view", f"{name}@{entry['version']}", "dist.integrity"], check=True, capture_output=True, text=True).stdout.strip()
            # npm writes `integrity` right after `resolved`.
            fields = list(entry.items())
            at = [field for field, _ in fields].index("resolved") + 1
            entry.clear()
            entry.update([*fields[:at], ("integrity", integrity), *fields[at:]])
    lock["packages"] = packages
    return json.dumps(lock, indent=2) + "\n"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    names = [a for a in argv if not a.startswith("--")] or list(HARNESSES)
    unknown = [name for name in names if name not in HARNESSES]
    if unknown:
        raise SystemExit(f"not a JavaScript reference harness: {', '.join(unknown)}; they are {', '.join(HARNESSES)}")
    differing = []
    with tempfile.TemporaryDirectory() as scratch:
        for name in names:
            text = generate(name, Path(scratch) / name)
            committed = HERE / name / "package-lock.json"
            if check:
                if committed.read_text(encoding="utf-8") != text:
                    differing.append(name)
            else:
                committed.write_text(text, encoding="utf-8")
    if differing:
        print(f"package-lock.json differs from a regeneration: {', '.join(differing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
