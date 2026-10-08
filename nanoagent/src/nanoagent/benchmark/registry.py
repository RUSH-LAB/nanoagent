"""Build named benchmark adapters from operator-owned configuration."""

from __future__ import annotations

import importlib
import inspect
from pathlib import Path
from typing import Any

from nanoagent.benchmark.adapters import JsonlExactMatchBenchmark, SWEbenchBenchmark
from nanoagent.benchmark.protocol import BenchmarkAdapter, BaseBenchmarkAdapter
from nanoagent.extensions import load_module
from nanoagent.runtime.config import (
    BenchmarkDefinitionConfig,
    load_registry,
    parse_kv_list,
)


class BenchmarkRegistry:
    def __init__(self, benchmarks: dict[str, BenchmarkAdapter]) -> None:
        self._benchmarks = dict(benchmarks)

    @classmethod
    def from_config(cls, definition_paths: list[str]) -> BenchmarkRegistry:
        definitions = load_registry(definition_paths, BenchmarkDefinitionConfig)
        return cls({name: build_benchmark(name, definition) for name, definition in definitions.items()})

    def resolve(self, name: str) -> BenchmarkAdapter:
        try:
            return self._benchmarks[name]
        except KeyError:
            known = ", ".join(sorted(self._benchmarks)) or "none"
            raise KeyError(f"unknown benchmark {name!r} (configured: {known})") from None

    def public(self) -> list[dict[str, Any]]:
        return [self._benchmarks[name].public() for name in sorted(self._benchmarks)]


def build_benchmark(name: str, definition: BenchmarkDefinitionConfig) -> BenchmarkAdapter:
    adapter = definition.adapter
    common = {
        "name": name,
        "label": definition.label,
        "version": definition.version,
        "primary_metric": definition.primary_metric,
        "options": parse_kv_list(adapter.options),
    }
    if adapter.type == "jsonl_exact_match":
        return JsonlExactMatchBenchmark(**common)
    if adapter.type == "swebench":
        return SWEbenchBenchmark(**common)
    if adapter.type != "python":
        raise ValueError(f"benchmark {name!r}: unsupported adapter type {adapter.type!r}")
    if not adapter.code:
        raise ValueError(f"benchmark {name!r}: python adapter requires adapter.code")
    code = adapter.code
    module = load_module(Path(code)) if code.endswith(".py") or "/" in code else importlib.import_module(code)
    classes = [
        value
        for _, value in inspect.getmembers(module, inspect.isclass)
        if issubclass(value, BaseBenchmarkAdapter)
        and value is not BaseBenchmarkAdapter
        and value.__module__ == module.__name__
    ]
    if len(classes) != 1:
        raise ValueError(
            f"benchmark {name!r}: {code} must define exactly one BaseBenchmarkAdapter subclass"
        )
    return classes[0](**common)
