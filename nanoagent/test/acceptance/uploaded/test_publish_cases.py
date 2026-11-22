"""CLI acceptance, step 1: a case file with fixtures publishes a benchmark whose pinned references hold the fixtures' own digests, and a
case file the plugin cannot judge deterministically is refused with what to change.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_publish_cases.py -m uploaded_acceptance

The real RUSH server on a scratch PostgreSQL and the real step 1, which runs the plugin's reference tool on every case's staged fixtures.
No worker is needed: nothing runs a case here.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
import stack as st
from stack import Stack

pytestmark = [pytest.mark.rush_server, pytest.mark.uploaded_acceptance]

ID = "acceptance-probe"


@pytest.fixture(scope="module")
def s() -> Iterator[Stack]:
    if reason := st.unavailable():
        pytest.skip(reason)
    with st.stack("test_publish_cases", worker=False) as stack:
        yield stack


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    """A case-file folder holding the `ab-report` case file and its fixtures folders, to change."""
    shutil.copytree(st.CASES / "fixtures", tmp_path / "fixtures")
    shutil.copy(st.AB_CASES, tmp_path / "cases.yaml")
    return tmp_path


def edited(folder: Path, change: Any) -> Path:
    document = yaml.safe_load((folder / "cases.yaml").read_text())
    change(document)
    (folder / "cases.yaml").write_text(yaml.safe_dump(document, sort_keys=False))
    return folder / "cases.yaml"


def refused(s: Stack, cases: Path, name: str) -> str:
    """The step's failure message: the last line of its traceback. Nothing is published then."""
    done = s.publish(name, cases, check=False)
    assert done.returncode != 0, done.stdout
    assert "published benchmark" not in done.stdout
    return done.stderr.strip().splitlines()[-1]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_a_case_file_with_fixtures_publishes_and_pins_the_before_state(s: Stack, folder: Path) -> None:
    published = s.publish("ab-report", folder / "cases.yaml")
    assert published["created"] is True
    benchmark = s.client.benchmark(published["benchmark"]["benchmark_id"])
    answer_b, answer_a, refusal = benchmark["cases"]
    assert [case["kind"] for case in benchmark["cases"]] == ["answer", "answer", "refuse"]
    assert [case["case_id"] for case in benchmark["cases"]] == [f"{ID}-01", f"{ID}-02", f"{ID}-03"]
    cases = yaml.safe_load((folder / "cases.yaml").read_text())
    # What the member reads is the case's exact prompt and its fixtures' digest and files, never the archive or a reference.
    assert [case["prompt"] for case in benchmark["cases"]] == [case["prompt"] for case in (*cases["cases"], *cases["refuse"])]
    assert refusal["fixtures"] is None and refusal["expected_error"] == "is not a staged fixture"
    for case, fixture in ((answer_b, "b_wins"), (answer_a, "a_wins")):
        files = {path.relative_to(folder / "fixtures" / fixture).as_posix(): sha256_of(path) for path in (folder / "fixtures" / fixture).rglob("*") if path.is_file()}
        assert case["fixtures"]["files"] == files and set(case["fixtures"]) == {"sha256", "files"}
        assert case["prompt_sha256"] == hashlib.sha256(case["prompt"].encode()).hexdigest()
        # The archive RUSH keeps for that digest hashes to it, and the reference the reference tool pinned holds the before-state hashes.
        assert s.row(f"select encode(sha256(archive), 'hex') from benchmark_fixtures where sha256 = '{case['fixtures']['sha256']}'") == case["fixtures"]["sha256"]
        [reference] = [
            json.loads(line) for line in s.row(
                f"select reference from benchmark_case_set_private where case_set_id = '{benchmark['case_set_id']}' and case_id = '{case['case_id']}'"
            ).splitlines()
        ]  # fmt: skip
        assert reference["seeded_sha256"] == files
        assert reference["empty_scenarios"] == [("Books" if fixture == "b_wins" else "Garden")]
    assert not {"reference", "private_reference", "archive"} & set(answer_b)


def test_republishing_identically_answers_created_false_and_other_content_under_the_name_is_409(s: Stack, folder: Path) -> None:
    first = s.publish("republished", folder / "cases.yaml")
    again = s.publish("republished", folder / "cases.yaml")
    assert (first["created"], again["created"]) == (True, False)
    assert again["benchmark"]["benchmark_id"] == first["benchmark"]["benchmark_id"]
    other = edited(folder, lambda document: document["cases"][0].update(prompt=document["cases"][0]["prompt"] + " Be quick."))
    assert refused(s, other, "republished") == (
        "nanoagent.uploaded.client.BenchmarkError: 409 benchmark_name_taken: Benchmark republished is published for acceptance-probe 0.1.0 "
        "with different content; a changed benchmark needs a new name"
    )


def test_the_lint_names_the_argument_a_prompt_does_not_state(s: Stack, folder: Path) -> None:
    cases = edited(folder, lambda document: document["cases"][0]["arguments"].update(bucket_prefix="promo-unstated-prefix"))
    assert refused(s, cases, "lint") == f"nanoagent.uploaded.case_sets.PreparationError: case {ID}-01: the prompt does not state argument bucket_prefix (promo-unstated-prefix)"


def test_arguments_that_do_not_build_into_the_tasks_input_class_are_refused(s: Stack, folder: Path) -> None:
    cases = edited(folder, lambda document: document["cases"][1]["arguments"].pop("tolerance"))
    assert refused(s, cases, "input-class") == (
        f"nanoagent.uploaded.case_sets.PreparationError: case {ID}-02: its arguments do not fit the input of task ab-report: AbInput is missing field(s): tolerance"
    )


def test_a_fixture_that_is_a_symlink_is_refused_naming_its_path(s: Stack, folder: Path) -> None:
    (folder / "fixtures" / "b_wins" / "inputs" / "link.csv").symlink_to("ab_Beauty.csv")
    assert refused(s, folder / "cases.yaml", "symlink") == f"nanoagent.uploaded.case_sets.PreparationError: case {ID}-01: the fixture inputs/link.csv is a symlink"


def test_a_refusal_case_whose_reference_tool_answers_is_refused(s: Stack, folder: Path) -> None:
    def answerable(document: dict[str, Any]) -> None:
        refusal = document["refuse"][0]
        refusal["fixtures"] = "fixtures/b_wins"
        refusal["arguments"]["csv_paths"] = ["inputs/ab_Beauty.csv"]
        refusal["prompt"] = refusal["prompt"].replace("inputs/ab_Missing.csv", "inputs/ab_Beauty.csv")

    assert refused(s, edited(folder, answerable), "refusal-answers") == (
        f"nanoagent.uploaded.case_sets.PreparationError: case {ID}-03: ab_reference answered "
        '{"csv_paths": ["inputs/ab_Beauty.csv"], "cloud_path": "inputs/cloud.json", "output_path": "record.json", '
        '"bucket_prefix": "promo-assets-for-b", "log_entry": "AB_Test_Concluded: winner A, no change", "tolerance": 0.05}, a case to refuse'
    )


def test_the_old_case_shape_is_refused(s: Stack, folder: Path) -> None:
    def old(document: dict[str, Any]) -> None:
        document["context"] = "Synthetic."
        document["answer"] = [case["arguments"] for case in document.pop("cases")]

    assert refused(s, edited(folder, old), "old-shape") == (
        "nanoagent.uploaded.case_sets.PreparationError: the case file does not fit the case file shape: CaseSet has key(s) CaseSet does not declare: answer, context"
    )
