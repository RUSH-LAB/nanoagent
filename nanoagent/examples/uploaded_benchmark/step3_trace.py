"""Step 3: read an attempt's saved or live trace from RUSH, in a process of its own.

It only reads: events (paged from `after`), the span index filtered by `span_kind`, `span_status` and `span_query`,
the payloads named by `payloads` (each checked against its SHA-256 and kept in payloads/), and the attempt's
accounting. With `follow`, events stream live from `after` (reconnecting from the last cursor) until the attempt
seals. trace.json holds the result; no step here asks a model for anything."""

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
    # The attempt's run: harness name@version on the benchmark (plugin @ plugin version).
    title: str
    attempt: dict[str, Any]
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


class ReadTrace(Run):
    config: TraceConfig
    layout: TraceLayout

    def main(self) -> None:
        config = self.config
        with config.server.client() as client:
            attempt = client.attempt(config.attempt_id)
            title = run_title(client.run(attempt["run_id"]))
            events, sealed, final_cursor, high_water = read_events(client, config)
            found = client.spans(config.attempt_id, kind=config.span_kind, status=config.span_status, q=config.span_query, limit=config.span_limit)
            payloads = []
            for digest in config.payloads:
                payload = client.payload(config.attempt_id, digest)
                path = Path(self.layout.payloads) / digest
                path.write_bytes(payload.data)
                payloads.append(PayloadLine(digest, len(payload.data), payload.content_type, payload.redaction, f"payloads/{digest}"))
            accounting = client.accounting(config.attempt_id) if config.accounting else None
        verdict = attempt.get("verdict") or attempt.get("verifier_error") or "-"
        explanation = f" ({attempt['explanation']})" if attempt.get("explanation") else ""
        print(f"attempt {attempt['attempt_id']} of {title}: verdict {verdict}{explanation}, {len(events)} events, {len(found['spans'])} spans, sealed={sealed}")
        self.layout.trace = Trace(
            title=title,
            attempt=attempt,
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
