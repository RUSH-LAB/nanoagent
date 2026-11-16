"""Projection to the comparison input: `compare.Attempt` with run conditions and canonical action inputs."""

from __future__ import annotations

from typing import TYPE_CHECKING

from nanoagent.uploaded.compare import Action, Attempt, FieldCoverage, RunConditions
from nanoagent.uploaded.projection_model import TIMING_METHOD_ID
from nanoagent.uploaded.projection_normalize import load_json
from nanoagent.uploaded.timing import Unknown

if TYPE_CHECKING:
    from collections.abc import Mapping

    from nanoagent.uploaded.projection_model import Projection


def _coverage(redactions: Mapping[str, str], **shas: str | None) -> dict[str, str]:
    """Per-field evidence: missing when the digest is unknown, redacted/truncated per the stored status."""
    out: dict[str, str] = {}
    for name, sha in shas.items():
        status = redactions.get(sha or "", "none")
        out[name] = "missing" if sha is None else ("complete" if status == "none" else "redacted")
    return out


def _field(sha: str | None, present: bool, redactions: Mapping[str, str]) -> str:
    if redactions.get(sha or "", "none") != "none":
        return "redacted"
    return "complete" if present else "missing"


def to_compare_attempt(p: Projection, payloads: Mapping[str, bytes] | None = None, redactions: Mapping[str, str] | None = None) -> Attempt:
    """Actions are model calls (model plus effective request digest), plugin tool calls (name plus canonical arguments)
    and managed commands (argv plus cwd), in recorded order, linked by ``after`` through the projection's causal links."""
    payloads, redactions = payloads or {}, redactions or {}
    a = p.attempt
    providers = {c.provider for c in p.model_calls if c.provider}
    dialects = {c.dialect for c in p.model_calls if c.dialect} or set(a.dialects)
    scalars = tuple(sorted((k, v) for k, v in a.limits.items() if isinstance(v, (int, float, bool))))
    conditions = RunConditions(
        harness_revision=a.harness_revision,
        prompt_digest=a.prompt_sha256,
        endpoint_profile=a.endpoint_label,
        model=a.model,
        provider=next(iter(providers)) if len(providers) == 1 else None,
        dialect=next(iter(dialects)) if len(dialects) == 1 else None,
        policy=a.policy,
        internet_access=a.limits.get("internet_access"),
        egress_hosts=a.egress_hosts if a.policy == "task_tools" else None,
        limits=scalars or None,
        timing_method=f"{TIMING_METHOD_ID};clock_tolerance_ns={a.method.clock_tolerance_ns}",
        reference_tokens_per_second=a.method.reference_tokens_per_second,
        coverage="partial" if p.coverage.partial else "complete",
    )
    after: dict[str, list[str]] = {}
    for link in p.links:
        if link.kind in ("proposal_invocation", "result_delivery"):
            source = link.from_id.split("/")[0]  # a proposal's action is its model call
            after.setdefault(link.to_id, []).append(source)
    actions: list[Action] = []
    for c in p.model_calls:
        if c.rejected is not None:
            continue
        sid = f"m:{c.call_id}"
        usage = c.usage
        cov = _coverage(redactions, input=c.effective_sha256, output=c.response_sha256)
        actions.append(
            Action(
                sid, "model_call", c.model or "", {"model": c.model, "request_sha256": c.effective_sha256}, p.scopes.get(sid, ()), c.dispatched_ns, c.completed_ns, tuple(after.get(sid, ())),
                None, c.terminal, {"finish_reason": c.finish_reason, "proposals": [{"name": x.name, "arguments": x.arguments} for x in c.proposals]},
                None if c.dispatched_ns is None or c.completed_ns is None else c.completed_ns - c.dispatched_ns,
                usage.total if usage else None, usage.cost_usd if usage else None,
                FieldCoverage(input=cov["input"], output="complete" if c.terminal else "missing", status="complete" if c.terminal else "missing",
                              timing="complete" if c.completed_ns is not None else "missing",
                              tokens="complete" if usage and usage.total is not None else "missing", cost="complete" if usage and usage.cost_usd is not None else "missing"),
            )  # fmt: skip
        )
    for t in p.tool_invocations:
        if t.rejected is not None or t.tool is None:
            continue
        sid = f"t:{t.call_id}"
        args = load_json(payloads, t.arguments_sha256)
        out = load_json(payloads, t.output_sha256)
        timed = t.start_ns is not None and t.end_ns is not None
        actions.append(
            Action(
                sid, "tool", t.tool, args, p.scopes.get(sid, ()), t.start_ns, t.end_ns, tuple(after.get(sid, ())), None, None if t.ok is None else ("ok" if t.ok else "error"), out,
                t.end_ns - t.start_ns if timed else None, None, None,  # type: ignore[operator]
                FieldCoverage(input=_field(t.arguments_sha256, args is not None, redactions),
                              output=_field(t.output_sha256, out is not None, redactions) if t.ok else "complete", status="complete" if t.ok is not None else "missing",
                              timing="complete" if timed else "missing", tokens="complete", cost="complete"),
            )  # fmt: skip
        )
    for c in p.commands:
        if c.rejected is not None:
            continue
        sid = f"c:{c.request_id}"
        timed = c.start_ns is not None and c.end_ns is not None
        known = c.argv is not None
        actions.append(
            Action(
                sid, "command", c.argv[0] if c.argv else "", {"argv": list(c.argv), "cwd": c.cwd} if c.argv is not None else None, p.scopes.get(sid, ()), c.start_ns, c.end_ns, tuple(after.get(sid, ())),
                None, _termination(c.termination), {"termination": c.termination, "stdout_sha256": c.stdout_sha256, "stderr_sha256": c.stderr_sha256},
                c.end_ns - c.start_ns if timed else None, None, None,  # type: ignore[operator]
                FieldCoverage(input="complete" if known else "missing", output="complete" if c.termination is not None else "missing",
                              status="complete" if c.termination is not None else "missing", timing="complete" if timed else "missing", tokens="complete", cost="complete"),
            )  # fmt: skip
        )
    actions.sort(key=lambda x: (x.start_ns is None, x.start_ns or 0))
    covered = frozenset({(), *p.scopes.values()}) if not p.coverage.partial else frozenset()
    estimated = p.metrics.timing.estimated_ns if p.metrics.timing else None
    return Attempt(conditions, tuple(actions), covered, None if estimated is None or isinstance(estimated, Unknown) else estimated)


def _termination(t: Mapping[str, object] | None) -> str | None:
    if t is None:
        return None
    return f"{t.get('status')}:{t.get('exit_code', t.get('signal'))}"
