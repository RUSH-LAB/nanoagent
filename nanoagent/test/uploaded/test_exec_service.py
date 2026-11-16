"""The managed command service and the harness event intake."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import anyio
import pytest

from nanoagent.uploaded.execservice import ExecError
from service_fakes import TOKEN, ScriptedTransport, make_rig

EXEC = {"argv": ["go", "test", "./pkg"], "cwd": ".", "timeout_ms": 5000}


def last(rig, kind):
    return rig.journal.of(kind)[-1].data


async def test_exec_runs_the_command_and_links_it_by_launch_id(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    (rig.workspace / "pkg").mkdir()
    async with rig.client() as client:
        response = await client.post("/exec", json={**EXEC, "cwd": "pkg"}, headers={"x-rush-span-id": "cmd-span"})
    assert response.status_code == 200 and response.json() == rig.commands.result
    assert response.headers["x-rush-call-id"] == "launch-1"
    assert rig.commands.calls == [(["go", "test", "./pkg"], "pkg", 5000, "cmd-span")]
    assert rig.journal.kinds() == ["exec.started", "exec.completed"]
    done = last(rig, "exec.completed")
    assert done["launch_id"] == "launch-1" and done["termination"] == {"status": "exited", "exit_code": 0} and done["stdout_truncated"] is False
    assert last(rig, "exec.started")["span_id"] == "cmd-span"
    assert rig.journal.body(last(rig, "exec.started")["command_sha256"]) == b'{"argv":["go","test","./pkg"],"cwd":"pkg"}'


@pytest.mark.parametrize(
    "body,code",
    [
        ({**EXEC, "argv": ["a\u0000b"]}, "invalid_argv"),
        ({**EXEC, "cwd": "../outside"}, "invalid_cwd"),
        ({**EXEC, "cwd": "/abs"}, "invalid_cwd"),
        ({**EXEC, "timeout_ms": 0}, "schema_violation"),
        ({"argv": ["x"]}, "schema_violation"),
    ],
)
async def test_invalid_calls_are_rejected_before_launch(tmp_path: Path, body: dict[str, Any], code: str) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        response = await client.post("/exec", json=body)
    assert response.status_code == 400 and response.json()["error"]["code"] == code
    assert rig.commands.calls == [] and last(rig, "exec.rejected")["code"] == code


async def test_a_cwd_the_runner_rejects_uses_the_error_envelope(tmp_path: Path) -> None:
    # Existence and links are the runner's to check against the real case workspace (see the gvisor sandbox tests).
    rig = make_rig(tmp_path, ScriptedTransport())
    rig.commands.error = ExecError("invalid_cwd", "cwd 'link' passes through a link", 400)
    async with rig.client() as client:
        response = await client.post("/exec", json={**EXEC, "cwd": "link"})
    assert response.status_code == 400 and response.json()["error"]["code"] == "invalid_cwd"


async def test_runner_failure_uses_the_error_envelope(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    rig.commands.error = ExecError("launch_failed", "no such binary", 500)
    async with rig.client() as client:
        response = await client.post("/exec", json=EXEC)
    assert response.status_code == 500 and response.json() == {"error": {"code": "launch_failed", "message": "no such binary"}}
    assert last(rig, "exec.completed")["ok"] is False and last(rig, "exec.completed")["error"]["code"] == "launch_failed"


async def test_a_result_that_breaks_the_contract_is_not_passed_on(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    rig.commands.result = {"termination": {"status": "exited"}, "stdout": {}, "stderr": {}}
    async with rig.client() as client:
        response = await client.post("/exec", json=EXEC)
    assert response.status_code == 502 and response.json()["error"]["code"] == "invalid_exec_result"


async def test_exec_requires_the_token_and_an_active_attempt(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        assert (await client.post("/exec", json=EXEC, headers={"authorization": "Bearer wrong"})).status_code == 401
        await rig.services.revoke(1)
        revoked = await client.post("/exec", json=EXEC)
    assert revoked.status_code == 403 and revoked.json()["error"]["code"] == "revoked" and rig.commands.calls == []
    assert [e.data["code"] for e in rig.journal.of("exec.rejected")] == ["unauthorized", "revoked"]


async def test_revoke_cancels_a_running_command_and_drains(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    started = anyio.Event()

    async def hang(argv, cwd, timeout_ms, span_id):
        started.set()
        await anyio.sleep(60)

    rig.commands.exec = hang  # type: ignore[method-assign]
    results = []

    async def call() -> None:
        async with rig.client() as client:
            results.append(await client.post("/exec", json=EXEC))

    async with anyio.create_task_group() as group:
        group.start_soon(call)
        await started.wait()
        await rig.services.revoke(2)
    assert results[0].status_code == 403 and results[0].json()["error"]["code"] == "revoked"


# ---- harness events ----------------------------------------------------------------------------------------------------


def start(sequence: int, span: str = "root", kind: str = "agent", parent: str | None = None) -> dict[str, Any]:
    event = {"protocol": "rush.harness.v1", "event": "span.start", "emitter_id": "e1", "sequence": sequence, "span_id": span, "kind": kind, "name": span}
    return event | ({"parent_span_id": parent} if parent else {})


async def test_events_return_receipts_and_identical_resend_returns_the_same_one(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        first = await client.post("/events", json=start(1))
        again = await client.post("/events", json=start(1))
        second = await client.post("/events", json=start(2, "child", "operation", "root"))
    assert first.status_code == 200 and first.json() == again.json() and second.json()["index"] == 1
    recorded = rig.journal.of("harness.event")
    assert len(recorded) == 2 and recorded[0].source == "harness" and recorded[0].data["origin"] == "harness"
    assert recorded[0].data["receipt"] == first.json() and recorded[0].data["received_ns"] > 0


@pytest.mark.parametrize(
    "event,status,code",
    [
        (start(1) | {"name": "different"}, 409, "conflicting_duplicate"),
        (start(3, "x", "operation", "root"), 422, "sequence_gap"),
        (start(2, "x", "operation", "ghost"), 422, "unknown_parent"),
        ({"protocol": "rush.harness.v1", "event": "bogus"}, 400, "schema_violation"),
    ],
)
async def test_bad_events_are_refused_and_recorded(tmp_path: Path, event: dict[str, Any], status: int, code: str) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        await client.post("/events", json=start(1))
        response = await client.post("/events", json=event)
    assert response.status_code == status and response.json()["error"]["code"] == code
    assert last(rig, "harness.rejected")["code"] == code and len(rig.journal.of("harness.event")) == 1


async def test_events_need_the_token(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        response = await client.post("/events", json=start(1), headers={"authorization": f"Bearer {TOKEN}x"})
    assert response.status_code == 401 and rig.journal.of("harness.event") == []
