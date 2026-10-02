"""`nanoagent benchmark`: run a named benchmark against a named runner profile."""

from __future__ import annotations

import asyncio
import json
import sys

from nanoagent.benchmark.engine import run_benchmark
from nanoagent.benchmark.registry import BenchmarkRegistry
from nanoagent.runtime.config import BenchmarkRunConfig, load_config_args
from nanoagent.runtime.harness import RunnerRegistry

_USAGE = (
    "usage: nanoagent benchmark {list|run} benchmark_cfg=<benchmark.yaml> "
    "[benchmark=<name> profile=<name> output=<dir>]"
)


async def _execute(cfg: BenchmarkRunConfig) -> dict:
    benchmarks = BenchmarkRegistry.from_config(cfg.benchmarks)
    benchmark = benchmarks.resolve(cfg.benchmark)
    runners = RunnerRegistry.from_config(cfg, cfg.profiles, cfg.profile)
    profile = runners.resolve(cfg.profile)
    try:
        return await run_benchmark(
            benchmark,
            profile,
            output_dir=cfg.output,
            concurrency=cfg.concurrency,
            filter_re=cfg.filter,
            slice_spec=cfg.slice,
            shuffle=cfg.shuffle,
            redo=cfg.redo,
            timeout=cfg.timeout,
        )
    finally:
        await runners.aclose()


async def _list(cfg: BenchmarkRunConfig) -> dict:
    benchmarks = BenchmarkRegistry.from_config(cfg.benchmarks)
    runners = RunnerRegistry.from_config(cfg, cfg.profiles, cfg.profile)
    try:
        return {"benchmarks": benchmarks.public(), **runners.public()}
    finally:
        await runners.aclose()


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    if not argv or argv[0] not in {"list", "run"}:
        print(_USAGE)
        return 2
    command, tokens = argv[0], argv[1:]
    cfg = load_config_args(BenchmarkRunConfig, tokens)
    result = asyncio.run(_list(cfg) if command == "list" else _execute(cfg))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
