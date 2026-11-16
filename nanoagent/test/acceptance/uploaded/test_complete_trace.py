"""CLI acceptance gate: the complete trace.

One scripted harness (harnesses/scripted) creates a subagent span, two parallel hosted tool calls, direct and managed nested commands
with bounded streams and a timeout, a workspace edit and a verified answer. It also tries to forge usage and to run a managed command
outside the workspace. The real worker in the worker container records it all; every assertion reads the sealed trace through
step 3: event origins, the span tree, the correlation links, process evidence joined to managed commands, recorded usage against the
scripted upstream's ledger, and (with the process collector stopped while a managed command runs) a partial trace that keeps its
existing evidence.

    .venv/bin/python -m pytest test/acceptance/uploaded -m uploaded_acceptance -k trace
"""

from __future__ import annotations

import base64
import json
import sys
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

NANOAGENT = Path(__file__).resolve().parents[3]
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "test" / "acceptance" / "uploaded"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
    str(NANOAGENT / "examples" / "benchmark"),
]

import gateway_trace_support as gt  # noqa: E402
import support  # noqa: E402
from gateway_trace_support import Evidence, collect  # noqa: E402
from mockllm import MockProvider, RunHandle, load_scenario  # noqa: E402
from rush_server import RushServer, rush_server, unavailable  # noqa: E402
from support import Cli  # noqa: E402

from nanoagent.plugin.package import pack  # noqa: E402

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

TRACED = ("trace.txt", "traced")
ANSWER = {"path": "trace.txt", "bytes": 6}
FORGED = {"input": 999_999, "output": 999_999, "total": 1_999_998, "cache_read": 999_999}
MIB = 1 << 20
KEYS = {"tr-trace": "<<tr-trace>>", "tr-forge": "<<tr-forge>>", "tr-loss": "<<tr-loss>>"}


def tool(name: str, arguments: dict[str, Any], index: int, label: str, **fields: Any) -> dict[str, Any]:
    return {"op": "tool", "name": name, "arguments": arguments, "cause": {"from": "m1", "index": index}, "as": label, "span": "sub1", **fields}


def trace_script() -> list[dict[str, Any]]:
    return [
        {"op": "span", "action": "start", "id": "sub1", "kind": "subagent", "name": "researcher", "parent": "root"},
        {"op": "model", "as": "m1", "stream": True, "span": "sub1"},
        {"op": "parallel", "steps": [tool("write_note", {"name": TRACED[0], "text": TRACED[1]}, 0, "t1"), tool("inspect_sandbox", {}, 1, "t2")]},
        {"op": "model", "as": "m2", "stream": True, "span": "sub1", "after": "m1", "results": [{"index": 0, "tool": "t1"}, {"index": 1, "tool": "t2"}]},
        {"op": "span", "action": "end", "id": "sub1", "status": "ok"},
        # A direct subprocess and its own child: not through the command service.
        {"op": "subprocess", "argv": ["sh", "-c", "echo direct; sh -c 'echo nested-direct'"]},
        # Managed commands: a nested one with both streams, and one that must time out.
        {"op": "exec", "as": "e1", "span": "root", "argv": ["sh", "-c", "echo managed-out; echo managed-err >&2; sh -c 'echo nested-managed'"]},
        {"op": "exec", "as": "e3", "span": "root", "argv": ["sleep", "30"], "timeout_ms": 700},
        # A working directory outside the workspace, by traversal and through a link.
        {"op": "exec", "argv": ["true"], "cwd": "../.."},
        {"op": "subprocess", "argv": ["ln", "-s", "/", "escape"]},
        {"op": "exec", "argv": ["true"], "cwd": "escape"},
        {"op": "subprocess", "argv": ["rm", "escape"]},
        {"op": "write", "name": "edit.txt", "text": "edited"},
        # A decision span that names the first model call: the reference is checked against the gateway's own record.
        {"op": "span", "action": "start", "id": "d1", "kind": "decision", "name": "decide", "parent": "root", "data": {"call_id": "$m1"}},
        {"op": "span", "action": "end", "id": "d1", "status": "ok"},
        {"op": "answer", "answer": ANSWER},
    ]


def forge_script() -> list[dict[str, Any]]:
    """Output past the bound, and every way the harness can claim usage or another origin."""
    return [
        {"op": "model", "as": "m1", "stream": True},
        {"op": "tool", "name": "write_note", "arguments": {"name": TRACED[0], "text": TRACED[1]}, "cause": {"from": "m1", "index": 0}, "as": "t1"},
        {"op": "exec", "as": "e2", "argv": ["python", "-c", "import sys; sys.stdout.write('x' * 3000000); sys.stderr.write('e' * 3000000)"]},
        {"op": "span", "action": "start", "id": "d1", "kind": "decision", "name": "decide", "parent": "root", "data": {"usage": FORGED}},
        {"op": "span", "action": "end", "id": "d1", "status": "ok", "data": {"usage": FORGED, "tokens": 999_999}},
        {"op": "event", "body": {"event": "log", "span_id": "root", "message": "usage claimed at the top level", "usage": FORGED}},
        {"op": "event", "body": {"event": "log", "span_id": "root", "message": "claiming the gateway's origin", "origin": "gateway"}},
        {"op": "event", "body": {"event": "log", "span_id": "root", "message": "usage claimed in data", "data": {"usage": FORGED}}},
        {"op": "answer", "answer": ANSWER},
    ]


def loss_script() -> list[dict[str, Any]]:
    """Some evidence, then a managed command long enough for the collector to be stopped under it."""
    return [
        {"op": "model", "as": "m1", "stream": True},
        {"op": "tool", "name": "write_note", "arguments": {"name": TRACED[0], "text": TRACED[1]}, "cause": {"from": "m1", "index": 0}, "as": "t1"},
        {"op": "exec", "argv": ["sleep", "20"], "timeout_ms": 60000},
        {"op": "answer", "answer": ANSWER},
    ]


# -- fixtures -----------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        server.seed_plugin(pack(gt.note_plugin(support.SCRATCH / f"note-plugin-{uuid.uuid4().hex[:8]}")))
        yield server


@pytest.fixture(scope="module")
def run_dir() -> Path:
    path = support.SCRATCH / f"trace-{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True)
    return path


@pytest.fixture(scope="module")
def cli(rush: RushServer, run_dir: Path) -> Cli:
    return Cli(rush.base_url, rush.workspace_id, rush.token, support.FINAL / "gateway-trace" / run_dir.name, rush.user_id)


@pytest.fixture(scope="module")
def registry(run_dir: Path) -> Iterator[int]:
    with support.serve_directory(support.wheelhouse(gt.SCRIPTED / "requirements.txt", run_dir / "registry")) as port:
        yield port


@dataclass
class Traced:
    full: Evidence
    forge: Evidence
    ledger_handle: RunHandle
    forge_handle: RunHandle
    loss_midway: Any
    loss_final: Any
    loss_reopened: Any
    loss_attempt: str


def digests_of(trace: Any) -> list[str]:
    """What the assertions need beyond the harness's report and the tool outputs: the first request and every command's streams."""
    first = next(e for e in trace.events if e["kind"] == "model_call.admitted")
    streams = [d for e in trace.events if e["kind"] == "exec.completed" and e["data"]["ok"] for d in (e["data"]["stdout_sha256"], e["data"]["stderr_sha256"])]
    return [first["data"]["submitted_request_sha256"], *streams]


@pytest.fixture(scope="module")
def traced(rush: RushServer, cli: Cli, run_dir: Path, registry: int) -> Iterator[Traced]:
    """One worker, built on the collector-loss launcher, takes the full-trace run and then the run whose collector is stopped."""
    for suite, key in KEYS.items():
        gt.publish_note_benchmark(cli, run_dir, suite, *TRACED, key)
    trigger = f"/tmp/rush-lose-collector-{uuid.uuid4().hex[:8]}"  # noqa: S108 - a path in the worker container, outside the repository
    with MockProvider() as provider:
        members = {key: (load_scenario(support.SCENARIOS / "trace-complete.yaml"), {}) for key in KEYS.values()}
        base, handles = provider.register_pool(members, harness="probe", model=support.MODEL)
        worker = gt.start_worker(
            "trace-worker", rush.base_url, cli, run_dir, upstream=base, index=registry,
            entry=(str(Path(support.__file__).with_name("loss_worker.py")),), env={"RUSH_LOSE_COLLECTOR_FILE": trigger},
        )
        try:
            source = gt.scripted_source(run_dir / "source-trace", trace_script())
            report = gt.submit(cli, run_dir, source, "tr-trace", "trace-full")
            first = gt.read_trace(cli, report.attempts[0].attempt_id, run_dir / "trace-peek")
            full = collect(cli, run_dir, report, handles[KEYS["tr-trace"]], "full", *digests_of(first))

            forge_source = gt.scripted_source(run_dir / "source-forge", forge_script())
            forge_report = gt.submit(cli, run_dir, forge_source, "tr-forge", "trace-forge")
            forge_first = gt.read_trace(cli, forge_report.attempts[0].attempt_id, run_dir / "trace-forge-peek")
            forge = collect(cli, run_dir, forge_report, handles[KEYS["tr-forge"]], "forge", *digests_of(forge_first))

            loss_source = gt.scripted_source(run_dir / "source-loss", loss_script())
            attempt = gt.submit(cli, run_dir, loss_source, "tr-loss", "trace-loss", follow=False).attempts[0].attempt_id
            deadline = time.monotonic() + 900
            while True:
                midway = gt.read_trace(cli, attempt, run_dir / "trace-loss-midway")
                kinds = [event["kind"] for event in midway.events]
                if "exec.started" in kinds:
                    break
                assert not midway.sealed, f"the attempt ended before its command ran:\n{worker.text()[-3000:]}"
                assert time.monotonic() < deadline, worker.text()
                time.sleep(0.5)
            assert "exec.completed" not in kinds, "the command must still be running when the collector is lost"
            assert support.inside("touch", trigger).returncode == 0
            while True:
                final = gt.read_trace(cli, attempt, run_dir / "trace-loss-final")
                if final.sealed:
                    break
                assert time.monotonic() < deadline, worker.text()
                time.sleep(1)
        finally:
            worker.stop()
            support.inside("rm", "-f", trigger)
    reopened = gt.read_trace(cli, attempt, run_dir / "trace-loss-reopened")
    yield Traced(full, forge, handles[KEYS["tr-trace"]], handles[KEYS["tr-forge"]], midway, final, reopened, attempt)


# -- the full trace -----------------------------------------------------------------------------------------------------------


def span(trace: Any, span_id: str) -> dict[str, Any]:
    [found] = [s for s in trace.spans if s["id"] == span_id]
    return found


def by_kind(trace: Any, kind: str) -> list[dict[str, Any]]:
    return [s for s in trace.spans if s["kind"] == kind]


def decoded(evidence: Evidence, digest: str) -> bytes:
    return base64.b64decode(evidence.payload(digest)["base64"])


def test_the_trace_is_complete_and_scored(traced: Traced) -> None:
    full = traced.full
    assert (full.attempt.execution_status, full.attempt.verdict, full.attempt.sealed) == ("answered", "pass", True)
    coverage = full.attempt.coverage
    assert coverage["status"] == "complete" and coverage["loss_reasons"] == [] and coverage["collector_complete"] is True, coverage
    assert {"worker", "gateway", "process", "tool_broker"} <= set(coverage["expected_sources"]) <= set(coverage["observed_sources"])
    assert not full.events("verifier.completed") and full.trace.attempt["verdict"] == "pass"
    [outcome] = full.events("result.read")
    assert outcome["data"]["outcome"] == {"status": "answered", "answer": ANSWER}
    assert not traced.ledger_handle.ledger.violations


def test_the_prompt_is_the_first_user_message_of_the_first_model_call(traced: Traced) -> None:
    full = traced.full
    pinned = full.trace.attempt["prompt"]
    [first, *_] = full.events("model_call.admitted")
    messages = full.payload(first["data"]["submitted_request_sha256"])["messages"]
    assert [m["content"] for m in messages if m["role"] == "user"] == [pinned["user"]]
    sent = traced.ledger_handle.ledger.calls[0].request.messages  # type: ignore[union-attr]
    assert [m["content"] for m in sent if m["role"] == "system"] == [pinned["system"]] and [m["content"] for m in sent if m["role"] == "user"] == [pinned["user"]]


def test_events_keep_the_origin_of_the_boundary_that_stamped_them(traced: Traced) -> None:
    full = traced.full
    origins: dict[str, set[str]] = {}
    for event in full.trace.events:
        origins.setdefault(event["source"], set()).add(event["kind"])
    assert set(origins) == {"worker", "gateway", "tool_broker", "exec", "harness", "process"}, sorted(origins)
    assert origins["gateway"] == {"model_call.admitted", "model_call.dispatched", "model_call.response"}
    assert origins["tool_broker"] == {"tool.invoked", "tool.completed"}
    assert origins["exec"] == {"exec.started", "exec.completed", "exec.rejected"}
    assert origins["harness"] == {"harness.event"}
    assert {"process.exec", "process.exit"} <= origins["process"]
    assert {"attempt.started", "case.launched", "case.exited", "snapshot.taken", "result.read", "collector.health"} <= origins["worker"]
    # Everything the harness sent is stamped as harness-reported; everything else was recorded by the side that observed it.
    assert {event["data"]["origin"] for event in full.events("harness.event")} == {"harness"}
    harness_spans = [s for s in full.trace.spans if s["id"].startswith("h:")]
    assert {s["id"] for s in harness_spans} == {"h:root", "h:sub1", "h:d1"} and {s["provenance"] for s in harness_spans} == {"harness_reported"}
    assert {s["provenance"] for s in full.trace.spans if not s["id"].startswith("h:")} == {"observed"}


def test_a_harness_cannot_forge_usage_or_an_origin(traced: Traced) -> None:
    forge = traced.forge
    # The event intake refuses unknown fields (usage and an origin at the top level) and records each refusal.
    rejected = forge.events("harness.rejected")
    assert len(rejected) == 2 and {event["data"]["http_status"] for event in rejected} == {400}
    assert [(o["status"], o["code"]) for o in forge.where(op="event")][:2] == [(400, rejected[0]["data"]["code"]), (400, rejected[1]["data"]["code"])]
    # A claim inside `data` is accepted for what it is: harness-reported data on its span.
    [decision] = [s for s in forge.trace.spans if s["id"] == "h:d1"]
    assert decision["provenance"] == "harness_reported" and decision["attributes"]["data"]["usage"] == FORGED
    # None of it changes the recorded usage: the gateway's per-call usage is the scripted upstream's own, and so are the totals.
    served = traced.forge_handle.ledger.main_calls
    responses = forge.events("model_call.response")
    assert len(served) == len(responses) == 1
    usage = responses[0]["data"]["usage"]
    call = served[0]
    assert (usage["input"], usage["cache_read"], usage["cache_write"], usage["output"], usage["reasoning"]) == (
        call.usage.input, call.usage.cached, call.usage.cache_write, call.usage.output, call.usage.reasoning,
    )
    metrics = forge.run.metrics
    assert metrics["total_tokens"]["total"] == call.usage.input + call.usage.output == 645
    assert metrics["input_tokens"]["total"] == call.usage.input and metrics["output_tokens"]["total"] == call.usage.output
    assert all(metrics[key]["missing_attempts"] == 0 for key in metrics) and forge.attempt.metrics["usage_complete"] is True
    assert forge.trace.accounting["totals"]["calls"] == 1 and "999999" not in json.dumps(forge.trace.accounting)
    assert forge.attempt.verdict == "pass"


def test_output_past_the_bound_is_truncated_and_makes_the_trace_partial_with_its_reasons(traced: Traced) -> None:
    forge = traced.forge
    [completed] = [e["data"] for e in forge.events("exec.completed")]
    assert completed["termination"] == {"status": "exited", "exit_code": 0} and completed["stdout_truncated"] and completed["stderr_truncated"]
    assert len(decoded(forge, completed["stdout_sha256"])) == len(decoded(forge, completed["stderr_sha256"])) == MIB, "each stream is cut at the output bound"
    assert forge.where(op="exec")[0]["stdout_truncated"] is True and forge.where(op="exec")[0]["stderr_truncated"] is True
    coverage = forge.attempt.coverage
    assert coverage["status"] == "partial" and coverage["collector_complete"] is True and coverage["loss_reasons"] == []
    [truncated] = coverage["truncated"]
    assert truncated.startswith("command ") and truncated.endswith(" output")
    assert sorted(coverage["reasons"]) == sorted([f"truncated evidence: {truncated}", "harness events were rejected"])
    assert [r["kind"] for r in coverage["rejected"]] == ["harness.rejected", "harness.rejected"]


def test_the_subagent_scope_holds_its_model_calls_and_parallel_tools(traced: Traced) -> None:
    full = traced.full
    root = span(full.trace, "h:root")
    sub = span(full.trace, "h:sub1")
    assert (sub["kind"], sub["name"], sub["parent"], sub["scope"], sub["status"]) == ("subagent", "researcher", "h:root", "agent/researcher", "ok")
    assert root["kind"] == "agent" and root["parent"] == "phase:harness"
    inside = [s for s in full.trace.spans if s["parent"] == "h:sub1"]
    assert sorted(s["kind"] for s in inside) == ["model_call", "model_call", "tool", "tool"]
    assert {s["scope"] for s in inside} == {"agent/researcher"} and {s["provenance"] for s in inside} == {"observed"}
    tools = [s for s in inside if s["kind"] == "tool"]
    assert sorted(s["target"] for s in tools) == ["inspect_sandbox", "write_note"]
    # Parallel: each tool started before the other had finished.
    first, second = sorted(tools, key=lambda s: s["start_ns"])
    assert second["start_ns"] < first["end_ns"], "the two hosted tool calls overlapped"
    # Managed commands were attributed to the root agent span through X-Rush-Span-Id; the two refused ones to none.
    commands = by_kind(full.trace, "command")
    assert len(commands) == 4 and {c["parent"] for c in commands if c["attributes"]["argv"] not in (None, ["true"])} == {"h:root"}


def test_correlation_links_tie_proposals_tools_results_commands_and_processes(traced: Traced) -> None:
    full = traced.full
    links = full.trace.links
    kinds = sorted({link["kind"] for link in links})
    assert {"proposal_invocation", "result_delivery", "harness_reference", "process_lineage"} <= set(kinds), kinds
    [m1, m2] = [e["data"]["call_id"] for e in full.events("model_call.response")]
    proposals = sorted((link["from"], link["method"]) for link in links if link["kind"] == "proposal_invocation")
    assert proposals == [(f"m:{m1}/call_0", "broker_cause"), (f"m:{m1}/call_1", "broker_cause")]
    delivered = [link for link in links if link["kind"] == "result_delivery"]
    assert len(delivered) == 2 and {link["to"] for link in delivered} == {f"m:{m2}"} and {link["attributes"]["content_match"] for link in delivered} == {"exact"}
    # The decision span's claim that it refers to the first model call is checked against the gateway's own record.
    [reference] = [link for link in links if link["kind"] == "harness_reference"]
    assert (reference["from"], reference["to"], reference["method"]) == ("h:d1", f"m:{m1}", "harness_reported")
    assert reference["attributes"] == {"reference": m1, "validated": True}
    # Every managed command is joined to its process by the supervisor's launch ID, not by timing or argv.
    commands = [c for c in by_kind(full.trace, "command") if c["attributes"]["launch_id"]]
    joins = {link["from"]: link for link in links if link["kind"] == "command_process"}
    assert len(commands) == 2 and {c["id"] for c in commands} == set(joins), "one process per managed command"
    for command in commands:
        link = joins[command["id"]]
        assert link["method"] == "launch_id" and link["attributes"]["launch_id"] == command["attributes"]["launch_id"]


def test_direct_and_managed_nested_commands_have_protected_process_evidence(traced: Traced) -> None:
    full = traced.full
    execs = [e["data"] for e in full.events("process.exec")]
    argvs = [data["argv"] for data in execs]
    for argv in (["sh", "-c", "echo direct; sh -c 'echo nested-direct'"], ["sh", "-c", "echo nested-direct"], ["sh", "-c", "echo nested-managed"]):
        assert argv in argvs, argvs
    assert any(argv[:2] == ["sh", "-c"] and argv[2].startswith("echo managed-out") for argv in argvs)
    assert all(data["cwd"] == "/rush/workspace" for data in execs if data["argv"][:1] == ["sh"])
    # Managed commands each carry the supervisor's own launch ID in the command service's record; process evidence has the argv and cwd.
    managed = [data for data in execs if data["argv"][:2] == ["sh", "-c"] and data["argv"][2].startswith("echo managed-out")]
    assert managed
    launches = [e["data"]["launch_id"] for e in full.events("exec.completed") if e["data"]["ok"]]
    assert len(launches) == 2 and len(set(launches)) == 2 and all(launches)
    # The supervisor's marker is in an observed execve of the member's process, so its process.exec records carry the launch ID.
    assert sorted({data["launch_id"] for data in execs if data.get("launch_id")}) == sorted(launches)
    assert all(data["argv"][:2] != ["/usr/bin/env", "-u"] or data["launch_id"] in launches for data in execs)
    # Lineage: the nested shell is a child of its parent shell, both for the direct and for the managed command.
    lineage = [link for link in full.trace.links if link["kind"] == "process_lineage"]
    assert len(lineage) >= 2
    exits = [e["data"] for e in full.events("process.exit")]
    processes = {(data["tgid"], data["start_time"]) for data in execs}
    assert len(exits) >= len(processes) - 1 and all("exit_code" in data or "signal" in data for data in exits)


def test_managed_command_streams_are_captured_and_a_timeout_is_a_termination(traced: Traced) -> None:
    full = traced.full
    completed = [e["data"] for e in full.events("exec.completed") if e["data"]["ok"]]
    assert len(completed) == 2
    first, slow = completed
    assert first["termination"] == {"status": "exited", "exit_code": 0} and not first["stdout_truncated"] and not first["stderr_truncated"]
    assert decoded(full, first["stdout_sha256"]) == b"managed-out\nnested-managed\n" and decoded(full, first["stderr_sha256"]) == b"managed-err\n"
    assert slow["termination"] == {"status": "timed_out"}
    [observed_slow] = full.where(op="exec", argv=["sleep", "30"])
    assert observed_slow["termination"] == {"status": "timed_out"}


def test_a_managed_command_outside_the_workspace_is_rejected_and_recorded(traced: Traced) -> None:
    full = traced.full
    # A traversing cwd is refused before anything is launched; one through a link is refused by the runner against the real workspace.
    assert full.rejected("exec.rejected") == ["invalid_cwd"]
    [traversal] = full.events("exec.rejected")
    assert traversal["data"]["http_status"] == 400 and "not a canonical relative path" in traversal["data"]["message"]
    [through_link] = [e["data"] for e in full.events("exec.completed") if not e["data"]["ok"]]
    assert through_link["error"]["code"] == "invalid_cwd" and "passes through a link" in through_link["error"]["message"] and through_link["launch_id"] is None
    assert len(full.events("exec.started")) == 3 and len(full.events("exec.completed")) == 3
    assert [o["code"] for o in full.where(op="exec") if o["status"] == 400] == ["invalid_cwd", "invalid_cwd"]
    spans = {s["status"]: s for s in by_kind(full.trace, "command") if s["attributes"]["argv"] in (None, ["true"])}
    assert spans["rejected"]["attributes"]["rejected"]["code"] == "invalid_cwd" and "error" in spans
    assert not any(p["argv"] == ["true"] for p in (e["data"] for e in full.events("process.exec"))), "neither command ever ran"


def test_the_workspace_edit_and_the_hosted_write_are_in_the_snapshot(traced: Traced) -> None:
    full = traced.full
    [snapshot] = full.events("snapshot.taken")
    entries = {entry["path"]: entry for entry in snapshot["data"]["diff"]}
    assert set(entries) == {"trace.txt", "edit.txt"}, "the link the harness made and removed is not in the final workspace"
    assert all(entry["change"] == "added" for entry in entries.values()) and entries["edit.txt"]["size"] == len("edited")
    [snapshot_span] = by_kind(full.trace, "snapshot")
    assert snapshot_span["attributes"]["changes"] == {"added": 2, "modified": 0, "deleted": 0}


# -- the collector stopped under a running managed command ----------------------------------------------------------------------


def test_a_forced_loss_marks_the_trace_partial_and_keeps_existing_evidence(traced: Traced, cli: Cli, run_dir: Path) -> None:
    midway, final = traced.loss_midway, traced.loss_final
    coverage = final.attempt["coverage"]
    assert coverage["status"] == "partial" and "collector_stopped" in coverage["loss_reasons"] and coverage["collector_complete"] is False, coverage
    [health] = [e for e in final.events if e["kind"] == "collector.health"]
    assert health["data"]["complete"] is False and "collector_stopped" in health["data"]["loss_reasons"]
    # Everything recorded before the loss is still there, unchanged and in order, including the command that was running.
    assert midway.events and all(final.events[event["cursor"] - 1] == event for event in midway.events)
    assert {"case.launched", "model_call.response", "tool.completed", "exec.started"} <= {event["kind"] for event in midway.events}
    assert "exec.completed" in {event["kind"] for event in final.events}
    # The gateway, broker, command service and harness evidence is whole; only process evidence is incomplete.
    spans = {s["kind"]: s for s in final.spans}
    assert {"model_call", "tool", "command"} <= set(spans) and all(s["status"] == "ok" for s in final.spans if s["kind"] in ("model_call", "tool", "command"))
    assert final.attempt["execution"]["status"] == "answered" and final.attempt["verdict"] == "pass" and final.sealed
    reopened = traced.loss_reopened
    assert reopened.events == final.events and reopened.attempt["coverage"] == coverage
