"""Step 3: read an attempt's saved or live trace from RUSH, in a process of its own.

It only reads: events (paged from `after`), the span index filtered by `span_kind`, `span_status` and `span_query`,
the payloads named by `payloads` (each checked against its SHA-256 and kept in payloads/), and the attempt's
accounting. With `follow`, events stream live from `after` (reconnecting from the last cursor) until the attempt
seals. Beside the trace it shows the attempt's outcome (how the harness ended, and the answer or refusal the worker read from its
workspace), its verdict with the verifier's named checks, and the workspace diff the attempt's `snapshot.taken` event recorded (what
the harness added, changed and deleted against the seeded fixtures), all taken from the events read, so from cursor 0. trace.json holds
the result; no step here asks a model for anything."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, Workspace

from nanoagent.uploaded.client import BenchmarkClient, ServerConfig, run_title


@dataclass
class TraceConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    attempt_id: str = MISSING
    after: int = MISSING
    follow: bool = MISSING
    # Span search: any left null does not filter; `span_limit` null takes the server's default.
    span_kind: str | None = None
    span_status: str | None = None
    span_query: str | None = None
    span_limit: int | None = None
    # SHA-256 digests of the payloads to fetch.
    payloads: list[str] = MISSING
    accounting: bool = MISSING


@dataclass
class PayloadLine:
    sha256: str
    size: int
    content_type: str | None
    redaction: str | None
    file: str


@dataclass
class Trace(Output):
    # Section order: the attempt's outcome, verdict and checks, workspace diff, then the events, spans and payloads.
    # The attempt's run: harness name@version on the benchmark (plugin @ plugin version).
    title: str
    attempt: dict[str, Any]
    # {status, reason, answer}: the execution status, and the worker's reading of the answer (`result.read`), null when it read none.
    outcome: dict[str, Any]
    # {verdict, explanation, verifier_error, checks}.
    verdict: dict[str, Any]
    # The `snapshot.taken` event's diff, `[{path, change, size}]`, and whether it was cut to fit; null when the events hold none.
    workspace_diff: dict[str, Any] | None
    events: list[dict[str, Any]]
    sealed: bool
    final_cursor: int | None
    high_water_cursor: int
    spans: list[dict[str, Any]]
    links: list[dict[str, Any]]
    payloads: list[PayloadLine]
    accounting: dict[str, Any] | None


@dataclass
class TraceLayout(Layout):
    trace: Trace
    payloads: Workspace


def read_events(client: BenchmarkClient, config: TraceConfig) -> tuple[list[dict[str, Any]], bool, int | None, int]:
    if not config.follow:
        log = client.events(config.attempt_id, config.after)
        return log.events, log.sealed, log.final_cursor, log.high_water_cursor
    events: list[dict[str, Any]] = []
    final_cursor = None
    for event in client.stream(config.attempt_id, config.after):
        if event.get("sealed"):
            final_cursor = event["final_cursor"]
            break
        print(f"{event['cursor']} {event['source']} {event['kind']}")
        events.append(event)
    high_water = events[-1]["cursor"] if events else config.after
    return events, True, final_cursor, high_water


def outcome_of(attempt: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    execution = attempt.get("execution") or {}
    reads = [event["data"]["outcome"] for event in events if event["kind"] == "result.read"]
    return {"status": execution.get("status"), "reason": execution.get("reason"), "answer": reads[-1].get("answer") if reads else None}


def diff_of(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    snapshots = [event["data"] for event in events if event["kind"] == "snapshot.taken"]
    return {"entries": snapshots[-1]["diff"], "truncated": snapshots[-1]["diff_truncated"]} if snapshots else None


def describe(attempt: dict[str, Any], outcome: dict[str, Any], diff: dict[str, Any] | None) -> str:
    """The outcome, the verdict with its checks, and the workspace diff, as text."""
    checks = " ".join(f"{check['name']}={check['status']}" for check in attempt.get("checks") or []) or "none"
    lines = [
        f"outcome: {outcome['status']}{' (' + outcome['reason'] + ')' if outcome['reason'] else ''}, answer {outcome['answer']!r}",
        f"verdict: {attempt.get('verdict') or attempt.get('verifier_error') or '-'}{' (' + attempt['explanation'] + ')' if attempt.get('explanation') else ''}",
        f"checks: {checks}",
    ]
    if diff is None:
        lines.append("workspace diff: no snapshot in the events read")
    else:
        lines.append(f"workspace diff ({len(diff['entries'])} files{', cut to fit' if diff['truncated'] else ''}):")
        lines += [f"  {entry['change']} {entry['path']} ({entry['size']} bytes)" for entry in diff["entries"]]
    return "\n".join(lines)


class ReadTrace(Run):
    config: TraceConfig
    layout: TraceLayout

    def main(self) -> None:
        config = self.config
        with config.server.client() as client:
            # The events first: with `follow` they end once the attempt seals, so the attempt read after them holds its sealed state.
            events, sealed, final_cursor, high_water = read_events(client, config)
            attempt = client.attempt(config.attempt_id)
            title = run_title(client.run(attempt["run_id"]))
            found = client.spans(config.attempt_id, kind=config.span_kind, status=config.span_status, q=config.span_query, limit=config.span_limit)
            payloads = []
            for digest in config.payloads:
                payload = client.payload(config.attempt_id, digest)
                path = Path(self.layout.payloads) / digest
                path.write_bytes(payload.data)
                payloads.append(PayloadLine(digest, len(payload.data), payload.content_type, payload.redaction, f"payloads/{digest}"))
            accounting = client.accounting(config.attempt_id) if config.accounting else None
        outcome = outcome_of(attempt, events)
        diff = diff_of(events)
        print(f"attempt {attempt['attempt_id']} of {title}: {len(events)} events, {len(found['spans'])} spans, sealed={sealed}")
        print(describe(attempt, outcome, diff))
        self.layout.trace = Trace(
            title=title,
            attempt=attempt,
            outcome=outcome,
            verdict={key: attempt.get(key) for key in ("verdict", "explanation", "verifier_error", "checks")},
            workspace_diff=diff,
            events=events,
            sealed=sealed,
            final_cursor=final_cursor,
            high_water_cursor=high_water,
            spans=found["spans"],
            links=found["links"],
            payloads=payloads,
            accounting=accounting,
        )


if __name__ == "__main__":
    ReadTrace().run()
