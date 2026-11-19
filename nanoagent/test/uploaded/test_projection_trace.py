"""A builder for stored evidence records, shaped exactly as the services and the worker write them."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any

from nanoagent.uploaded import records as R

S = 1_000_000_000
T0 = 100 * S


def sec(x: float) -> int:
    return round(x * S)


def usage_dict(input_: int | None, output: int | None, cost: str | None = "0.001") -> dict[str, Any]:
    total = None if input_ is None or output is None else input_ + output
    return {
        "input": input_, "output": output, "total": total, "cache_read": 0 if input_ is not None else None, "cache_write": 0 if input_ is not None else None,
        "reasoning": None, "supplied_total": total, "cost_usd": cost, "provenance": "chat_completions:body", "discrepancies": [], "source_ids": [], "earlier": [],
    }  # fmt: skip


def chat_request(*tool_results: tuple[str, Any], extra: str = "") -> dict[str, Any]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": "go" + extra}]
    messages += [{"role": "tool", "tool_call_id": call_id, "content": content} for call_id, content in tool_results]
    return {"model": "m", "messages": messages}


class Trace:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []
        self.payloads: dict[str, bytes] = {}
        self.redactions: dict[str, str] = {}
        self._seq: dict[str, int] = defaultdict(int)
        self._worker_seq = 0

    # ---- plumbing ------------------------------------------------------------------------------------------------

    def payload(self, value: Any) -> str:
        data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        sha = hashlib.sha256(data).hexdigest()
        self.payloads[sha] = data
        return sha

    def add(self, source: str, kind: str, at: int, data: dict[str, Any], payloads: tuple[str, ...] = (), *, skip_sequence: int = 0) -> None:
        self._seq[source] += 1 + skip_sequence
        n = self._seq[source]
        self.records.append(
            {"event_id": f"{source}-{n:06d}", "source": source, "kind": kind, "sequence": n, "occurred_ns": str(at) if n % 2 else at, "data": data, "payload_sha256s": list(payloads)}
        )

    def fact(self, item: R.Fact, at: int) -> None:
        self.add(item.source, item.kind, at, item.to_data())

    # ---- worker --------------------------------------------------------------------------------------------------

    def started(self, *, expected: tuple[str, ...] = ("gateway", "tool_broker", "exec", "harness", "process", "worker"), reference: float = 100.0, tolerance: int = 1_000_000) -> None:
        self.fact(
            R.AttemptStarted("att-1", "w1", {"label": "prod", "mode": "openrouter"}, "vendor/model", ("chat_completions",), "p" * 64, "task_tools", {"python": "3.12"}, "s" * 64, "rev1",
                             {"max_model_calls": 20}, (), {"reference_tokens_per_second": reference, "clock_tolerance_ns": tolerance}, expected),
            T0 - sec(5),
        )  # fmt: skip

    def lifecycle(self, *, launch: float = 0.0, quiesce: float, health: bool = True, cpu: tuple[int, int] | None = None) -> None:
        self.fact(R.CaseLaunched("c" * 64, T0 + sec(launch), ("python", "main.py")), T0 + sec(launch))
        self.fact(R.CaseExited({"status": "exited", "exit_code": 0}, T0 + sec(quiesce)), T0 + sec(quiesce))
        self.fact(R.CaseQuiesced(T0 + sec(quiesce)), T0 + sec(quiesce))
        if health:
            self.fact(R.CollectorHealth(True, (), 12, 0), T0 + sec(quiesce))
        if cpu:
            self.fact(R.CpuCounters([{"identity": "p1", "user_ns": cpu[0], "system_ns": cpu[1]}]), T0 + sec(quiesce))

    def finish(self, at: float) -> None:
        diff = [{"path": "config.yaml", "change": "modified", "sha256": "a" * 64, "size": 10}, {"path": "new.txt", "change": "added"}]
        self.fact(R.SnapshotTaken([], self.payload({"files": {}, "skipped": {}, "diff": diff})), T0 + sec(at))
        self.fact(R.ResultRead({"status": "answered", "answer": "done"}), T0 + sec(at + 0.1))

    # ---- gateway -------------------------------------------------------------------------------------------------

    def model_call(
        self,
        call_id: str,
        *,
        ordinal: int,
        start: float,
        end: float,
        span_ref: str | None = None,
        request: dict[str, Any] | None = None,
        proposals: tuple[dict[str, Any], ...] = (),
        usage: tuple[int | None, int | None] = (100, 50),
        terminal: str = "completed",
        frames: tuple[tuple[int, float], ...] | None = None,
        early: dict[str, int] | None = None,
        maybe_reached: bool = True,
        respond: bool = True,
        client: str | None = None,
    ) -> str:
        body = request or chat_request(extra=call_id)
        submitted, effective = self.payload(body), self.payload({"effective": body})
        a, d = T0 + sec(start), T0 + sec(end)
        self.add(
            "gateway", "model_call.admitted", a - 1000,
            {"call_id": call_id, "dialect": "chat_completions", "span_id": span_ref, "model": "vendor/model", "stream": frames is not None, "ordinal": ordinal,
             "submitted_request_sha256": submitted, "effective_request_sha256": effective, "request_headers": {} if client is None else {"user-agent": client}},
            (submitted, effective),
        )  # fmt: skip
        self.add("gateway", "model_call.dispatched", a, {"call_id": call_id, "span_id": span_ref, "effective_request_sha256": effective}, (effective,))
        if not respond:
            return submitted
        regs = [{"tool_call_id": p["call_id"], "frame_index": (early or {}).get(p["call_id"], p["completed_frame"]), "registered_ns": d, "early": p["call_id"] in (early or {})} for p in proposals]
        data: dict[str, Any] = {
            "call_id": call_id, "dialect": "chat_completions", "span_id": span_ref, "terminal": terminal, "http_status": 200 if terminal == "completed" else 500, "dispatched_ns": a,
            "headers_ns": a + 1, "first_byte_ns": a + 2, "completed_ns": d, "maybe_reached_upstream": maybe_reached, "error": None, "usage": None if usage[0] is None and usage[1] is None else usage_dict(*usage),
            "usage_error": None, "proposals": list(proposals), "registrations": regs, "provider": "prov", "resolved_model": "vendor/model", "finish_reason": "tool_calls" if proposals else "stop",
        }  # fmt: skip
        shas = [submitted, effective]
        if frames is not None:
            index = self.payload([{"index": i, "offset": 0, "bytes": n, "available_ns": a + sec(t), "event": None} for i, (n, t) in enumerate(frames)])
            data.update(frame_count=len(frames), frames_payload_sha256=index)
            shas.append(index)
        self.add("gateway", "model_call.response", d, data, tuple(shas))
        return submitted

    @staticmethod
    def proposal(call_id: str, name: str, args: dict[str, Any], frame: int | None = None) -> dict[str, Any]:
        return {"name": name, "call_id": call_id, "raw_arguments": json.dumps(args), "arguments": args, "arguments_error": None, "started_frame": frame, "completed_frame": frame}

    # ---- tool broker ---------------------------------------------------------------------------------------------

    def tool(self, call_id: str, tool: str, args: dict[str, Any], *, start: float, end: float, cause: tuple[str, str] | None = None, adaptation: dict[str, Any] | None = None,
             output: dict[str, Any] | None = None, span_ref: str | None = None) -> dict[str, Any]:  # fmt: skip
        args_sha = self.payload(args)
        output = output if output is not None else {"ok": True}
        out_sha = self.payload(output)
        link = None if cause is None else {"model_call_id": cause[0], "tool_call_id": cause[1]}
        self.add("tool_broker", "tool.invoked", T0 + sec(start) - 1000,
                 {"call_id": call_id, "tool": tool, "writes": False, "span_id": span_ref, "cause": link, "adapted": adaptation is not None, "adaptation": adaptation, "arguments_sha256": args_sha}, (args_sha,))  # fmt: skip
        self.add("tool_broker", "tool.completed", T0 + sec(end),
                 {"call_id": call_id, "tool": tool, "ok": True, "duration_ns": sec(end - start), "output_sha256": out_sha}, (out_sha,))  # fmt: skip
        return output

    # ---- exec and process ----------------------------------------------------------------------------------------

    def command(self, request_id: str, launch_id: str, argv: list[str], *, start: float, end: float, cwd: str = ".", span_ref: str | None = None, code: int = 0) -> None:
        cmd = self.payload({"argv": argv, "cwd": cwd})
        self.add("exec", "exec.started", T0 + sec(start) - 1000, {"request_id": request_id, "span_id": span_ref, "cwd": cwd, "timeout_ms": 1000, "command_sha256": cmd}, (cmd,))
        out, err = self.payload({"data": "b2s=", "truncated": False}), self.payload({"data": "", "truncated": False})
        self.add("exec", "exec.completed", T0 + sec(end),
                 {"request_id": request_id, "launch_id": launch_id, "ok": True, "duration_ns": sec(end - start), "span_id": span_ref, "termination": {"status": "exited", "exit_code": code},
                  "stdout_sha256": out, "stderr_sha256": err, "stdout_truncated": False, "stderr_truncated": False}, (out, err))  # fmt: skip

    def process(self, tgid: int, argv: list[str], *, start: float, end: float, start_time: int = 5, parent: tuple[int, int] | None = None, launch_id: str | None = None) -> None:
        if parent is not None:
            self.fact(R.ProcessClone(tgid, start_time, parent[0], parent[1], T0 + sec(start)), T0 + sec(start))
        self.fact(R.ProcessExec(tgid, start_time, argv, "/rush/workspace", T0 + sec(start), launch_id), T0 + sec(start))
        self.fact(R.ProcessExit(tgid, start_time, T0 + sec(end), exit_code=0), T0 + sec(end))

    # ---- harness -------------------------------------------------------------------------------------------------

    def _event(self, at: float, header: str | None, event: dict[str, Any]) -> None:
        sha = self.payload(event)
        self.add("harness", "harness.event", T0 + sec(at),
                 {"origin": "harness", "received_ns": T0 + sec(at), "span_id": header, "event_sha256": sha, "event": event["event"], "receipt": {}}, (sha,))  # fmt: skip
        self._emitter_seq = getattr(self, "_emitter_seq", 0) + 1

    def span_start(self, at: float, span_id: str, kind: str, name: str, parent: str | None = None, data: dict[str, Any] | None = None) -> None:
        n = getattr(self, "_emitter_seq", 0) + 1
        event = {"protocol": "1", "event": "span.start", "emitter_id": "e1", "sequence": n, "span_id": span_id, "kind": kind, "name": name, "data": data or {}}
        if parent:
            event["parent_span_id"] = parent
        self._event(at, None, event)

    def span_end(self, at: float, span_id: str, status: str = "ok", data: dict[str, Any] | None = None) -> None:
        n = getattr(self, "_emitter_seq", 0) + 1
        self._event(at, None, {"protocol": "1", "event": "span.end", "emitter_id": "e1", "sequence": n, "span_id": span_id, "status": status, "data": data or {}})
