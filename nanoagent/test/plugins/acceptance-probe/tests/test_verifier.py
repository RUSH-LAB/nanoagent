from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest
from slimconfig import build_output

import verifier
from contract import AbInput, AbOutput, ProbeInput, ProbeOutput, WaitInput
from plugin.ab import WORKSPACE_ENV, ab_reference
from plugin.probe import digest, wait

CASES = Path(__file__).resolve().parents[3] / "acceptance" / "benchmark" / "cases" / "fixtures"
CHECKS = ["outcome_exists", "schema_valid", "values_match", "side_effects", "no_extra_changes"]


def test_digests_the_token() -> None:
    assert digest(ProbeInput(token="alpha", wait_seconds=0.0)).digest == hashlib.sha256(b"alpha").hexdigest()[:12]


def test_refuses_a_refuse_token() -> None:
    with pytest.raises(ValueError, match="refuse-me"):
        digest(ProbeInput(token="refuse-me", wait_seconds=0.0))


def test_waits_as_asked() -> None:
    assert wait(WaitInput(wait_seconds=0.0)).waited == 0.0


def test_the_task_is_valid_exactly_when_the_digest_is_the_references() -> None:
    reference = build_output({"digest": "abc"}, ProbeOutput)
    arguments = {"token": "alpha", "wait_seconds": 0.0}
    assert verifier.verify_task("probe", arguments, build_output({"digest": "abc"}, ProbeOutput), reference, ".")["valid"] is True
    assert verifier.verify_task("probe", arguments, build_output({"digest": "abd"}, ProbeOutput), reference, ".")["valid"] is False


def staged(tmp_path, monkeypatch, fixtures):
    """The fixtures copied into a workspace, with the arguments naming them and the reference tool's output on them."""
    workspace = tmp_path / "workspace"
    shutil.copytree(CASES / fixtures, workspace)
    monkeypatch.setenv(WORKSPACE_ENV, str(workspace))
    arguments = AbInput(
        csv_paths=sorted(path.relative_to(workspace).as_posix() for path in workspace.glob("inputs/*.csv")),
        cloud_path="inputs/cloud.json",
        output_path="record.json",
        bucket_prefix="promo-assets-for-b",
        log_entry="AB_Test_Concluded: winner A, no change",
        tolerance=0.05,
    )
    return workspace, arguments, ab_reference(arguments)


def record_of(reference, **changes):
    return {"scenarios": [{"scenario": rate.scenario, "a_percent": rate.a_percent, "b_percent": rate.b_percent} for rate in reference.rates], "winner": reference.winner} | changes


def act(workspace, arguments, reference, record=None):
    """What a right agent leaves: the record, and the cloud state changed as the winner says."""
    (workspace / "record.json").write_text(json.dumps(record or record_of(reference)))
    cloud = json.loads((workspace / "inputs/cloud.json").read_text())
    if reference.winner == "B":
        cloud["buckets"].append("promo-assets-for-b-launch")
    else:
        cloud["logs"].append(arguments.log_entry)
    (workspace / "inputs/cloud.json").write_text(json.dumps(cloud))


def grade(workspace, arguments, reference):
    return verifier.verify_task("ab-report", arguments, AbOutput(record="record.json"), reference, str(workspace))


def statuses(verdict):
    return [check["status"] for check in verdict["details"]["checks"]]


def test_the_reference_computes_the_rates_the_winner_and_the_before_state(tmp_path, monkeypatch) -> None:
    workspace, _, reference = staged(tmp_path, monkeypatch, "b_wins")
    assert [rate.scenario for rate in reference.rates] == ["Beauty", "Electronics"]
    assert reference.empty_scenarios == ["Books"]
    assert reference.winner == "B"
    assert reference.seeded_sha256["inputs/ab_Books.csv"] == hashlib.sha256((workspace / "inputs/ab_Books.csv").read_bytes()).hexdigest()
    assert reference.cloud_buckets == ["abtesting_logging_main", "site-assets"]


def test_the_reference_rejects_a_file_that_is_not_staged(tmp_path, monkeypatch) -> None:
    _, arguments, _ = staged(tmp_path, monkeypatch, "b_wins")
    arguments.csv_paths = ["inputs/ab_Missing.csv"]
    with pytest.raises(ValueError, match="is not a staged fixture"):
        ab_reference(arguments)


@pytest.mark.parametrize("fixtures", ["b_wins", "a_wins"])
def test_ab_report_passes_when_the_state_is_as_the_reference_says(tmp_path, monkeypatch, fixtures) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, fixtures)
    act(workspace, arguments, reference)
    (workspace / "answer.json").write_text(json.dumps({"answer": {"record": "record.json"}}))
    verdict = grade(workspace, arguments, reference)
    assert verdict["valid"] is True
    assert statuses(verdict) == ["passed"] * 5
    assert [check["name"] for check in verdict["details"]["checks"]] == CHECKS


def test_ab_report_accepts_the_answer_file_the_worker_seeded_and_the_agent_filled(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    (workspace / "answer.json").write_text('{\n  "record": null\n}\n')  # seeded before the session starts
    act(workspace, arguments, reference)
    (workspace / "answer.json").write_text('{\n  "record": "record.json"\n}\n')  # then filled in
    assert statuses(grade(workspace, arguments, reference)) == ["passed"] * 5


def fails_at(verdict, name):
    assert verdict["valid"] is False
    index = CHECKS.index(name)
    assert statuses(verdict) == ["passed"] * index + ["failed"] + ["skipped"] * (len(CHECKS) - index - 1)
    assert verdict["message"] == verdict["details"]["checks"][index]["message"]


def test_no_record_fails_outcome_exists(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    fails_at(grade(workspace, arguments, reference), "outcome_exists")


def test_a_malformed_record_fails_schema_valid(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    act(workspace, arguments, reference)
    (workspace / "record.json").write_text("{not json")
    fails_at(grade(workspace, arguments, reference), "schema_valid")


def test_a_rate_off_by_a_tenth_fails_values_match(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    record = record_of(reference)
    record["scenarios"][0]["a_percent"] += 0.1
    act(workspace, arguments, reference, record)
    fails_at(grade(workspace, arguments, reference), "values_match")


def test_a_rate_within_the_tolerance_passes(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    record = record_of(reference)
    record["scenarios"][0]["a_percent"] += 0.04
    act(workspace, arguments, reference, record)
    assert grade(workspace, arguments, reference)["valid"] is True


def test_the_trap_scenario_in_the_record_fails_values_match(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    record = record_of(reference)
    record["scenarios"].append({"scenario": "Books", "a_percent": 0, "b_percent": 0})
    act(workspace, arguments, reference, record)
    verdict = grade(workspace, arguments, reference)
    fails_at(verdict, "values_match")
    assert "no rows" in verdict["message"]


def test_a_bucket_added_when_a_wins_fails_side_effects(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "a_wins")
    act(workspace, arguments, reference)
    cloud = json.loads((workspace / "inputs/cloud.json").read_text())
    cloud["logs"] = reference.cloud_logs
    cloud["buckets"].append("promo-assets-for-b-launch")
    (workspace / "inputs/cloud.json").write_text(json.dumps(cloud))
    fails_at(grade(workspace, arguments, reference), "side_effects")


def test_an_edited_csv_fails_no_extra_changes(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    act(workspace, arguments, reference)
    with (workspace / "inputs/ab_Beauty.csv").open("a") as csv_file:
        csv_file.write("7/29 06:00-06:59,1,1,1,1\n")
    fails_at(grade(workspace, arguments, reference), "no_extra_changes")


def test_an_extra_file_fails_no_extra_changes(tmp_path, monkeypatch) -> None:
    workspace, arguments, reference = staged(tmp_path, monkeypatch, "b_wins")
    act(workspace, arguments, reference)
    (workspace / "notes.txt").write_text("scratch")
    fails_at(grade(workspace, arguments, reference), "no_extra_changes")
