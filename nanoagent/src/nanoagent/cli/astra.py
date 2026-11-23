"""`astra`: this NanoAgent (with the stop rule and the MinHash redundancy filter) as a member's own agent in RUSH Lab.

Installed in a RUSH Lab Terminal session (`pip install --no-deps <this package>`), and run there once as `rush astra --help` so RUSH
keeps the installation, it is a harness a benchmark run can name:

    rush astra --variant base       this NanoAgent, both changes off (the baseline: the same code as RUSH's own `nanoagent`)
    rush astra --variant stop       the run ends once the answer is delivered (nanoagent.core.stop)
    rush astra --variant minhash    repeated or near-duplicate tool results are sent as a pointer or a diff (nanoagent.core.dedup)
    rush astra --variant both       both changes on

The case's prompt follows as the last argument, as RUSH gives every harness. It does exactly what RUSH's own `nanoagent` harness
does (the shell harness's rush.py, `mgen -p <prompt>`): it starts the plugin's task tools, points NanoAgent at the attempt's gateway
and model, and runs NanoAgent's `mgen` with them. Two things differ: this package's `nanoagent` comes first on the path (RUSH's own
build still supplies every dependency, so nothing else changes), and the variant's switches are set in the environment
(NANOAGENT_STOP_AFTER, NANOAGENT_DEDUP), which nanoagent.core.agent.Agent reads. Imports nothing but the standard library until it
hands over, so it runs from a `--no-deps` install.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import shutil
import sys
from pathlib import Path

STOP = "submit,write:answer.json,edit:answer.json"  # how a task harness and a RUSH case deliver the answer
VARIANTS = {
    "base": {"NANOAGENT_STOP_AFTER": "", "NANOAGENT_DEDUP": "0"},
    "stop": {"NANOAGENT_STOP_AFTER": STOP, "NANOAGENT_DEDUP": "0"},
    "minhash": {"NANOAGENT_STOP_AFTER": "", "NANOAGENT_DEDUP": "1"},
    "both": {"NANOAGENT_STOP_AFTER": STOP, "NANOAGENT_DEDUP": "1"},
}


def rush_module():
    """The shell harness's rush.py, which RUSH's `mgen` wrapper (bin/mgen) runs: found through that wrapper on PATH."""
    wrapper = shutil.which("mgen")
    if wrapper is None:
        raise SystemExit("astra: no `mgen` on PATH; run it in a RUSH Lab Terminal or case session")
    found = re.search(r"(\S+/rush\.py)", Path(wrapper).read_text(encoding="utf-8", errors="replace"))
    if found is None:
        raise SystemExit(f"astra: {wrapper} is not RUSH's mgen wrapper")
    spec = importlib.util.spec_from_file_location("rush_shell", found.group(1))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="astra", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--variant", choices=sorted(VARIANTS), default="base")
    parser.add_argument("rest", nargs=argparse.REMAINDER, help="mgen's arguments, the prompt last (it becomes `-p <prompt>`)")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if not args.rest:
        parser.print_help()
        return
    # RUSH gives the case's prompt as the last argument, as `mgen -p <prompt>` takes it.
    mgen_args = args.rest if "-p" in args.rest else [*args.rest[:-1], "-p", args.rest[-1]]

    ours = Path(__file__).resolve().parents[2]  # the folder holding this `nanoagent` package
    rush = rush_module()
    real_execvpe = os.execvpe

    def execvpe(file: str, argv: list[str], env: dict[str, str]) -> None:
        env = {**env, **VARIANTS[args.variant], "PYTHONPATH": os.pathsep.join([str(ours), env.get("PYTHONPATH", "")])}
        print(f"astra: NanoAgent from {ours / 'nanoagent'}, variant {args.variant}", file=sys.stderr, flush=True)
        real_execvpe(file, argv, env)

    os.execvpe = execvpe  # rush.nanoagent ends by exec'ing mgen with RUSH's build on PYTHONPATH; ours goes first
    rush.nanoagent("mgen", mgen_args)


if __name__ == "__main__":
    main()
