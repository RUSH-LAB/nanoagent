"""``mgen`` — the agent as a coding-CLI, in Claude Code's flag grammar.

    mgen -p "summarise what changed in the last commit"
    mgen --model claude-4-6-sonnet-genai --allowedTools bash,read
    mgen -p "..." --output-format json | jq -r .result
    mgen -c                                # carry on from the last session
    mgen --dump-config                     # what the flags above resolved to, as YAML

The point is the *protocol*, not the transport: which server answers is
:mod:`nanoagent.inference.plugins`' business (a plugin, an OpenAI-compatible gateway, a local SGLang),
so a script written against ``claude`` runs against whatever this repo can reach by changing
the config, not the script.

WHY THIS ONE TAKES FLAGS. Every other entry point here is yaml-only on purpose — a run must be
fully described by a file that can be committed and re-run. That argument is about *runs*: a
benchmark, a batch, a training rollout. This command is for the other thing, a human at a
terminal, where "which model, how many turns, which tools" is the question being asked and
editing a YAML to ask it is the wrong shape. The rule is kept where it matters instead of
dropped: the flags are a thin layer *over* a config file (``--config``, ``$MGEN_CONFIG``), they
only override leaves that already exist in the schema, and ``--dump-config`` prints the result
as a YAML that reproduces the invocation. Nothing a flag can express is unsayable in a config.

Print mode (``-p``) never asks for confirmation — there is nobody to ask — so it runs the tools
the config gave it, exactly like ``nanoagent run``. Interactive mode confirms each call unless
``--dangerously-skip-permissions``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

from nanoagent.runtime.config import InteractiveConfig, load_config_args
from nanoagent.extensions import PACKAGED_CONFIGS
from nanoagent.runtime.trajectory import TRAJECTORY_SUFFIX

#: The shipped default: a locally served model. Absolute, and inside the package, because `mgen`
#: is a terminal command run from wherever the user happens to be — a repo-relative default would
#: work only from one directory. Point $MGEN_CONFIG at your own (e.g. one whose model block names
#: a gateway backend) to make `mgen` alone do the right thing.
DEFAULT_CONFIG = str(PACKAGED_CONFIGS / "mgen.yaml")
CONFIG_ENV = "MGEN_CONFIG"
SUBDIR = "mgen"


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="mgen",
        description="Run the nanoagent coding agent from the terminal, in Claude Code's grammar.",
    )
    p.add_argument("prompt", nargs="*", help="the task; omit it to be asked interactively")
    p.add_argument(
        "-p", "--print", dest="print_mode", action="store_true",
        help="print mode: run the task once, print the result, exit (no REPL, no confirmation)",
    )
    p.add_argument("--model", help="served model name -> model.model")
    p.add_argument("--max-turns", type=int, help="cap on model turns -> agent.max_steps")
    p.add_argument(
        "--allowedTools", dest="allowed_tools", metavar="a,b,c",
        help="comma-separated tool NAMES to narrow the config's toolset to -> allowed_tools",
    )
    p.add_argument(
        "--output-format", choices=("text", "json"), default="text",
        help="print mode only: the answer alone, or a JSON result object (default: %(default)s)",
    )
    p.add_argument("-r", "--resume", metavar="PATH", help="a .traj.json / .session.json to continue")
    p.add_argument(
        "-c", "--continue", dest="continue_", action="store_true",
        help="continue the most recent mgen session",
    )
    p.add_argument(
        "--dangerously-skip-permissions", dest="yolo", action="store_true",
        help="interactive mode: run tool calls without confirming each one",
    )
    p.add_argument(
        "--config", default=os.environ.get(CONFIG_ENV) or DEFAULT_CONFIG,
        help=f"base YAML every flag overrides (default: ${CONFIG_ENV} or {DEFAULT_CONFIG})",
    )
    p.add_argument(
        "--set", dest="overrides", action="append", default=[], metavar="KEY=VALUE",
        help="override any other config leaf, e.g. --set model.temperature=0.2; repeatable",
    )
    p.add_argument(
        "--dump-config", action="store_true",
        help="print the resolved config as YAML and exit, instead of running",
    )
    return p


def _traj_root() -> Path:
    # Deferred: nanoagent.cli.repl.app builds a Model at import, which is the only openai import on
    # this path — `mgen --help` and `--dump-config` must not pay for it.
    from nanoagent.cli.repl.app import DEFAULT_TRAJ_DIR

    return Path(DEFAULT_TRAJ_DIR) / SUBDIR


def latest_session() -> str:
    """The most recently written trajectory under the mgen folder — what ``-c`` continues."""
    found = sorted(_traj_root().rglob(f"*{TRAJECTORY_SUFFIX}"), key=lambda p: p.stat().st_mtime)
    if not found:
        raise SystemExit(f"mgen: --continue: no session under {_traj_root()} yet")
    return str(found[-1])


def resolve_config(args: argparse.Namespace) -> InteractiveConfig:
    """The YAML, then ``--set``, then the flags — each applied to the leaf it names.

    Flags are applied as :func:`dataclasses.replace` on the nested block rather than as dotlist
    strings, so a prompt or a model name is never re-parsed as YAML on its way in.
    """
    cfg = load_config_args(InteractiveConfig, [f"mgen_cfg={args.config}", *args.overrides])
    if args.model:
        cfg.model = replace(cfg.model, model=args.model)
    if args.max_turns is not None:
        cfg.agent = replace(cfg.agent, max_steps=args.max_turns)
    if args.allowed_tools is not None:
        cfg.allowed_tools = [t for t in args.allowed_tools.split(",") if t]
    if args.yolo:
        cfg.yolo = True
    if args.prompt:
        cfg.task = " ".join(args.prompt)
    if args.resume or args.continue_:
        cfg.resume = args.resume or latest_session()
    return cfg


def session_path(cfg: InteractiveConfig) -> Path:
    """The file this session is saved to: ``<output folder>/<yymmdd-HHMMSS>.traj.json``.

    ``output`` is the FOLDER (chat's meaning, since this is chat's schema) and is left that way
    on the config — so a dumped config still says ``output: null`` and re-running it starts a
    new session rather than nesting one inside the last one's filename.
    """
    folder = Path(cfg.output) if cfg.output else _traj_root()
    return folder / f"{datetime.now():%y%m%d-%H%M%S}{TRAJECTORY_SUFFIX}"


def dump_config(cfg: InteractiveConfig) -> str:
    """The resolved config as YAML — the file that reproduces this invocation."""
    from omegaconf import OmegaConf

    return OmegaConf.to_yaml(OmegaConf.structured(cfg))


def _result_json(result: Any, path: Path) -> dict[str, Any]:
    """Claude Code's ``--output-format json`` keys where they exist, plus what we also know.

    Same names (``result``, ``session_id``, ``num_turns``, ``total_cost_usd``, ``is_error``) so a
    script that pipes this through ``jq -r .result`` does not care which CLI produced it.
    """
    return {
        "type": "result",
        "subtype": "error" if result.error else "success",
        "is_error": bool(result.error),
        "result": result.answer,
        "session_id": path.name.removesuffix(TRAJECTORY_SUFFIX),
        "num_turns": result.steps,
        "total_cost_usd": result.cost,
        "usage": result.usage,
        "stop_reason": result.stop_reason,
        "trajectory": str(path),
        "error": result.error,
    }


def run_print(cfg: InteractiveConfig, output_format: str) -> int:
    """One task, no REPL: the result on stdout and nothing else, the trajectory on disk."""
    from nanoagent.cli.repl.tree import load as load_session
    from nanoagent.runtime import trajectory
    from nanoagent.runtime.build import build_agent

    if cfg.task is None:
        raise SystemExit("mgen: -p needs a prompt (as an argument, or `task:` in the config)")
    agent = build_agent(cfg)
    messages = load_session(cfg.resume).messages if cfg.resume else None
    result = asyncio.run(agent.run(cfg.task, messages=messages))
    # Saved before printing: the answer is the cheap half, and a run whose transcript did not
    # survive is not resumable by the -c that usually follows.
    path = trajectory.save(
        result, session_path(cfg), meta={"task": cfg.task, "model": cfg.model.model}
    )
    if output_format == "json":
        print(json.dumps(_result_json(result, path)))
    else:
        print(result.answer)
    return 1 if result.error else 0


def run_interactive(cfg: InteractiveConfig) -> int:
    from nanoagent.cli.repl.app import ReplOptions, run_and_save

    run_and_save(
        replace(cfg, output=str(session_path(cfg))),  # run_and_save wants the concrete file
        resume=cfg.resume,
        options=ReplOptions(
            commands=list(cfg.commands),
            models=dict(cfg.models),
            theme=dict(cfg.theme),
            images=cfg.images,
        ),
        mode="yolo" if cfg.yolo else "confirm",
        confirm_exit=True,
        subdir=SUBDIR,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.output_format == "json" and not args.print_mode:
        raise SystemExit("mgen: --output-format json only applies to print mode (-p)")
    cfg = resolve_config(args)
    if args.dump_config:
        print(dump_config(cfg), end="")
        return 0
    if args.print_mode:
        return run_print(cfg, args.output_format)
    return run_interactive(cfg)


if __name__ == "__main__":
    raise SystemExit(main())
