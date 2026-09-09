"""`nanoagent` agent CLI — the umbrella entry point and the ``run`` subcommand.

:func:`main` dispatches by first token: ``run`` (handled here), ``chat``
(:mod:`nanoagent.cli.repl.app`) and ``browse`` (:mod:`nanoagent.cli.repl.browser`). The sibling commands are
imported lazily, so ``browse`` doesn't pull in ``openai``.

The ``run`` subcommand executes the structured-tool agent on one task, or a batch of them.
The agent's toolset is whatever the config's ``tools`` list names (tool-config YAMLs loaded by
:func:`~nanoagent.extensions.get_tools`), reproducing mini-swe-agent's behaviour against a local
SGLang-served model. Everything is yaml-driven — no argparse flags, just named config tokens:
``<name>_cfg=<YAML>`` files plus optional ``dotted.key=value`` overrides (see
:func:`~nanoagent.runtime.config.load_config_args`), later tokens winning.

Two modes, picked by the config (not a flag):

  * ``task`` set (``RunConfig``) — run one task as a one-shot, non-interactive session: it
    streams the model and prints each tool call live (same UX as ``chat``, but no
    confirmation and no follow-up prompt), then always saves the trajectory — to ``output``
    when set, otherwise a timestamped ``expdir/run/<YYYYMMDD_HHMMSS>.traj.json``.
  * ``tasks`` set (``BatchConfig``) — batch mode. Runs every ``{task_id, task}`` row of the
    ``tasks`` JSONL concurrently (BrowseComp ``{query_id, problem}`` rows also accepted),
    saving ``<output>/trajectories/<task_id>.traj.json`` plus a slim
    ``<output>/results.jsonl`` ledger. Re-running **resumes** (task_ids already in the ledger
    are skipped unless ``redo``); a task that raises is recorded with ``stop_reason="error"``
    rather than aborting the batch; Ctrl-C stops cleanly. ``output`` (the output directory)
    is required.

This module is the front end only: the batch driver itself is :mod:`nanoagent.runtime.batch` and its
live display :mod:`nanoagent.cli.progress`.

Usage — every command is ``nanoagent <command> <key=value tokens>`` (the installed console
script; ``python3 -m nanoagent <command> ...`` is the same entry point), run from the repo root
(the conventional CWD, which every ``code:``/``*_cfg=`` path resolves against)::

  # run — single task; `task` selects single mode, the trajectory is always saved:
  nanoagent run harness_cfg=myharness.yaml \
      task="list the python files" output=run.traj.json

  # run — batch over a tasks JSONL; a set `tasks` selects batch mode and `output` is the
  # (required) output directory. Re-run the same command to resume:
  nanoagent run harness_cfg=<harness.yaml> batch_cfg=<batch.yaml> \
      tasks=mytasks.jsonl output=expdir/batch
  # batch knobs: concurrency=16  filter='^id_'  slice=0:100  shuffle=true  redo=true  timeout=600

  # chat — interactive session (see :mod:`nanoagent.cli.repl.app`); browse — trajectory viewer TUI:
  nanoagent chat chat_cfg=mychat.yaml
  nanoagent browse path=expdir/chat/

  # override any model/agent leaf inline, on any command:
  #   ... agent.max_steps=30 model.temperature=0.7 model.base_url=http://localhost:7002/v1
"""

from __future__ import annotations

import asyncio
import logging
import sys
from importlib import import_module
from pathlib import Path

from nanoagent.runtime.config import (
    BatchConfig,
    load_config_args,
    peek,
    RunConfig,
)
from nanoagent.runtime import log_capture
from nanoagent.runtime.batch import filter_tasks, load_tasks, run_batch
from nanoagent.runtime.build import build_agent
from nanoagent.cli.progress import BatchProgress, format_tally
from rich.console import Console
from rich.logging import RichHandler

logger: logging.Logger = logging.getLogger(__name__)

_RUN_USAGE = (
    "usage: nanoagent run harness_cfg=<harness.yaml> "
    "{task='...' | batch_cfg=<batch.yaml> tasks=<tasks.jsonl> output=<dir>}"
)


def _run_single(argv: list[str]) -> int:
    # Deferred so `browse` never pulls openai (the REPL imports Model at module load).
    from nanoagent.cli.repl.app import run_and_save

    cfg = load_config_args(RunConfig, argv)
    if cfg.task is None:
        raise SystemExit("run: config sets neither `task` (single) nor `tasks` (batch)")
    # Single-task run = a one-shot, non-interactive (yolo, no follow-up) chat session, so it
    # streams the model and prints each tool call live, then always saves the trajectory.
    run_and_save(cfg, mode="yolo", confirm_exit=False, subdir="run")
    return 0


def _run_batch(argv: list[str], console: Console) -> int:
    cfg = load_config_args(BatchConfig, argv)
    if not cfg.output:
        raise SystemExit("run: batch mode requires `output` (an output directory)")
    output_dir = Path(cfg.output)
    tasks = filter_tasks(
        load_tasks(cfg.tasks),
        filter_re=cfg.filter,
        slice_spec=cfg.slice,
        shuffle=cfg.shuffle,
    )

    # `shown` = concurrency: at most that many tasks run at once, so every in-flight one is
    # visible without scrolling.
    with BatchProgress(console, max_steps=cfg.agent.max_steps, shown=cfg.concurrency) as bar:
        try:
            rows = asyncio.run(
                run_batch(
                    tasks,
                    agent=build_agent(cfg),
                    output_dir=output_dir,
                    concurrency=cfg.concurrency,
                    model_name=cfg.model.model,
                    redo=cfg.redo,
                    timeout=cfg.timeout,
                    on_start=bar.on_start,
                    on_step=bar.on_step,
                    on_done=bar.on_done,
                )
            )
        except KeyboardInterrupt:
            print(
                "\ninterrupted — re-run the same command to resume (finished tasks are skipped)"
            )
            return 130

    print(f"done: {len(rows)} task(s) -> {output_dir}/results.jsonl")
    print("  " + (format_tally(bar.tally) or "(nothing pending)"))
    # Where the wall-clock went, summed over tasks: LLM (model queries) vs tool dispatch (the
    # search calls). Summed across concurrent rollouts, so these overlap in real time — they
    # are the work breakdown, not the run's wall-clock.
    model_time = sum(r["model_time"] for r in rows)
    tools_time = sum(r["tools_time"] for r in rows)
    if model_time or tools_time:
        print(f"  time: llm={model_time:.1f}s  search={tools_time:.1f}s (summed over tasks)")
    return 0


def _run(argv: list[str]) -> int:
    """The ``run`` subcommand: one task (config ``task``) or a batch (config ``tasks``)."""
    if not argv:
        print(_RUN_USAGE)
        return 2
    console = Console(stderr=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(message)s",
        handlers=[
            RichHandler(console=console, show_path=False),
            # Fold each task's own WARNING+ records into its trajectory's `logs`
            # (the RichHandler above still streams everything to stderr / the .log).
            log_capture.TaskLogCollector(level=logging.WARNING),
        ],
    )
    # The OpenAI SDK's httpx transport logs an INFO line per request ("HTTP Request: POST
    # .../chat/completions 200 OK") — one per model turn per task, which floods the batch
    # progress bar. Quiet these third-party loggers to WARNING; our own INFO logs stay.
    for noisy in ("httpx", "httpcore", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if peek(argv, "tasks"):  # a tasks JSONL is configured → batch mode
        return _run_batch(argv, console)
    return _run_single(argv)


# Sibling subcommands delegate to their own module's ``main()``; ``run`` is handled here.
# Held as module paths (not imports) so each loads lazily — ``browse`` never pulls openai.
_DELEGATES = {
    "chat": "nanoagent.cli.repl.app",
    "browse": "nanoagent.cli.repl.browser",
    "web": "nanoagent.web.cli",
    # The one command that takes argparse flags rather than config tokens; it is also installed
    # as its own console script, `mgen` (see nanoagent.cli.mgen for why it is the exception).
    "mgen": "nanoagent.cli.mgen",
}
_USAGE = "usage: nanoagent {run|chat|browse|mgen|web} [args...]"


def main(argv: list[str] | None = None) -> int:
    """Umbrella entry: dispatch the ``run`` / ``chat`` / ``browse`` subcommand by name."""
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    if not argv or argv[0] not in ("run", *_DELEGATES):
        print(_USAGE)
        return 0 if argv and argv[0] in ("-h", "--help") else 2
    command, rest = argv[0], argv[1:]
    if command == "run":
        return _run(rest)
    return import_module(_DELEGATES[command]).main(rest)


if __name__ == "__main__":
    raise SystemExit(main())
