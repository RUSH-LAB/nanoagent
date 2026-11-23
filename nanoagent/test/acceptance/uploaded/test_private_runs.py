"""CLI acceptance, two members: runs are private. The second member sees the first's published benchmark and can run it, but steps 5 and
4 show none of the first member's runs, and reading one of them by id is 404.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_private_runs.py -m uploaded_acceptance

Each member has their own worker (a worker claims only its member's runs); they take turns on this machine, on one scratch.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
import stack as st
from stack import Stack, join_workspace
from support import Cli, Worker

from nanoagent.uploaded.client import BenchmarkClient
from rush_server import worker_credential

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

B_CASE = "acceptance-probe-01"


@dataclass
class Members:
    s: Stack
    alice_run: dict[str, Any]
    bob_cli: Cli
    bob_run: dict[str, Any]
    before: dict[str, Any]  # what bob's steps 5 and 4 showed before he ran anything


@pytest.fixture(scope="module")
def members() -> Iterator[Members]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_private_runs", extra_users=("bob",)) as s:
        bob = join_workspace(s.rush, "bob")
        s.publish("ab-report", st.AB_B_CASES)
        s.script(st.B_WINS, "nanoagent", st.script_of(*st.ab_acts("b_wins")))
        [alice_run] = s.submit("ab-report", ["nanoagent"], "alice")
        # Before bob runs anything, his table and his comparison hold none of alice's run.
        table, _ = s.table("ab-report", as_json=True, cli=bob)
        before = {"table": table, "compare": s.compare("ab-report", "nanoagent", "claude", cli=bob)}
        # Bob's own worker takes over this machine's scratch, and he runs the same benchmark.
        s.worker.stop()
        credential = worker_credential(s.rush.base_url, bob.token)
        s.rush.advertise("mock", internet_access=False, credential=credential)  # as the worker's first claim does, before bob's run is created
        bob_worker = Worker("test_private_runs_bob", s.run_dir / "worker.yaml", s.logs / "worker-bob.log", credential=credential)
        bob_worker.start()
        try:
            s.script(st.B_WINS, "nanoagent", st.script_of(*st.ab_acts("b_wins")))
            [bob_run] = s.submit("ab-report", ["nanoagent"], "bob", cli=bob)
        finally:
            bob_worker.stop()
        yield Members(s, alice_run, bob, bob_run, before)


def test_the_second_member_sees_the_first_members_published_benchmark_and_can_run_it(members: Members) -> None:
    bob = BenchmarkClient(members.s.rush.base_url, members.s.rush.workspace_id, members.bob_cli.token)
    assert [benchmark["name"] for benchmark in bob.benchmarks(st.PLUGIN)] == ["ab-report"]
    assert members.bob_run["status"] == "complete" and members.bob_run["score"]["value"] == 1 and members.bob_run["case_ids"] == [B_CASE]
    assert members.bob_run["run_id"] != members.alice_run["run_id"]


def test_step_5_and_step_4_show_none_of_the_first_members_runs(members: Members) -> None:
    s = members.s
    assert members.before["table"]["rows"] == [] and members.before["compare"]["table"]["rows"] == []
    after, _ = s.table("ab-report", as_json=True, cli=members.bob_cli)
    assert [row["run_id"] for row in after["rows"]] == [members.bob_run["run_id"]]
    assert after["rows"][0]["attempts"] == {B_CASE: members.bob_run["attempts"][0]["attempt_id"]}
    compared = s.compare("ab-report", "nanoagent", "claude", cli=members.bob_cli)
    assert [row["run_id"] for row in compared["table"]["rows"]] == [members.bob_run["run_id"]]
    # And alice's own table is hers alone.
    mine, _ = s.table("ab-report", as_json=True)
    assert [row["run_id"] for row in mine["rows"]] == [members.alice_run["run_id"]]


def test_reading_the_first_members_run_by_id_is_404_as_for_an_id_that_does_not_exist(members: Members) -> None:
    s = members.s
    run_id, attempt_id = members.alice_run["run_id"], members.alice_run["attempts"][0]["attempt_id"]
    headers = {"authorization": f"Bearer {members.bob_cli.token}"}
    base = f"{s.rush.base_url}/api/workspaces/{s.rush.workspace_id}/benchmark"
    absent = "00000000-0000-4000-8000-000000000000"
    for path, missing in (
        (f"runs/{run_id}", f"runs/{absent}"),
        (f"attempts/{attempt_id}", f"attempts/{absent}"),
        (f"attempts/{attempt_id}/events", f"attempts/{absent}/events"),
        (f"attempts/{attempt_id}/spans", f"attempts/{absent}/spans"),
        (f"attempts/{attempt_id}/accounting", f"attempts/{absent}/accounting"),
        (f"attempts/{attempt_id}/recording", f"attempts/{absent}/recording"),
    ):
        mine, absent_one = httpx.get(f"{base}/{path}", headers=headers, timeout=60), httpx.get(f"{base}/{missing}", headers=headers, timeout=60)
        assert mine.status_code == absent_one.status_code == 404, (path, mine.status_code, mine.text)
        assert mine.json()["code"].startswith("unknown_") and mine.json()["code"] == absent_one.json()["code"], (path, mine.json(), absent_one.json())
    # The owner reads them.
    assert httpx.get(f"{base}/runs/{run_id}", headers={"authorization": f"Bearer {s.rush.token}"}, timeout=60).status_code == 200
