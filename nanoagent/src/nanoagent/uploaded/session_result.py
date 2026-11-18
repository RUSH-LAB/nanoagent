"""How a session's result reads, in `nanoagent harness` and in `rush score` (the worker's, so it imports no terminal code)."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def verdict(attempt: dict[str, Any]) -> str:
    """right or wrong by the plugin's verifier, or "no verdict" for an attempt with no answer (or refusal) to score, as the tab says."""
    if attempt["execution"]["status"] == "ended":
        return "ended"
    if attempt["execution"]["status"] not in ("answered", "refused"):
        return "no verdict"
    return {"pass": "right", "fail": "wrong"}.get(attempt.get("verdict"), "no verdict")


def thousands(count: int | None) -> str:
    return "—" if count is None else f"{count / 1000:.0f}k" if count >= 1000 else str(count)


def summary_line(result: dict[str, Any], path: Path | None = None) -> str:
    """harness · plugin · verdict · time · tokens · cost, then ``path`` (the run folder's result.json) when there is one."""
    cost = "—" if result["cost_usd"] is None else f"${result['cost_usd']:.4f}"
    seconds = "—" if result["elapsed_s"] is None else f"{result['elapsed_s']:.0f} s"
    tokens = f"{thousands(result['input_tokens'])} in / {thousands(result['output_tokens'])} out"
    return " · ".join([result["harness"], result["plugin"], result["verdict"], seconds, tokens, cost, *([] if path is None else [str(path)])])
