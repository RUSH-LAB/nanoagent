from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import plugin.schema
import verifier
import verifier.schema
from plugin.bibtex import parse_bibtex, read_bibtex, submit_verdicts

FIXTURES = Path(__file__).parent / "fixtures"
ARGUMENTS = {"reference": "inputs/reference.bib", "raw": "inputs/raw.bib"}
# The right verdict for every entry of tests/fixtures/raw.bib.
EXPECTED = {
    "transformer": "real",
    "resnet": "real",
    "nature_dl": "real",
    "bert": "hallucinated",  # wrong year
    "adam": "hallucinated",  # invented co-author
    "lstm": "hallucinated",  # altered title
    "vaswani_attention": "hallucinated",  # fake DOI
    "gradient_folding": "hallucinated",  # invented paper
    "kingma_broken": "hallucinated",  # unparseable
}


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    shutil.copytree(FIXTURES, tmp_path / "inputs")
    return tmp_path


@pytest.fixture
def reference(workspace: Path) -> dict:
    return parse_bibtex(ARGUMENTS["reference"], ARGUMENTS["raw"], workspace=workspace)


def verdicts(workspace: Path, value: object) -> str:
    (workspace / "verdicts.json").write_text(json.dumps(value))
    return str(workspace)


@pytest.mark.parametrize("text", ["  {D}eep\n {{R}}esidual\t", "", "a}b{c", "Ünïcode space"])
def test_the_verifier_and_the_plugin_normalize_alike(text: str) -> None:
    assert verifier.schema.normalize(text) == plugin.schema.normalize(text)


def test_approves_every_right_verdict(workspace: Path, reference: dict) -> None:
    verdict = verifier.verify_task("check-bibtex", ARGUMENTS, reference, verdicts(workspace, EXPECTED))
    assert verdict["valid"] is True and verdict["score"] == 1.0
    assert verdict["details"]["expected"] == EXPECTED


@pytest.mark.parametrize(
    ("changes", "key", "problem"),
    [
        ({"transformer": "hallucinated"}, "transformer", "verdict hallucinated is wrong: the entry is real"),
        ({"bert": "real"}, "bert", "verdict real is wrong: the entry is hallucinated"),
        ({"kingma_broken": "real"}, "kingma_broken", "verdict real is wrong: the entry is hallucinated"),
        ({"resnet": "unsure"}, "resnet", "verdict 'unsure' is not real or hallucinated"),
        ({"he2016deep": "real"}, "he2016deep", "not a raw entry"),
    ],
)
def test_refuses_a_wrong_verdict(workspace: Path, reference: dict, changes: dict, key: str, problem: str) -> None:
    verdict = verifier.verify_task("check-bibtex", ARGUMENTS, reference, verdicts(workspace, EXPECTED | changes))
    assert verdict["valid"] is False
    assert verdict["details"]["problems"] == {key: problem}


def test_refuses_a_missing_verdict_and_scores_the_right_ones(workspace: Path, reference: dict) -> None:
    partial = {key: label for key, label in EXPECTED.items() if key != "adam"}
    verdict = verifier.verify_task("check-bibtex", ARGUMENTS, reference, verdicts(workspace, partial))
    assert verdict["valid"] is False and verdict["score"] == 8 / 9
    assert verdict["details"]["problems"] == {"adam": "no verdict"}


def test_refuses_no_verdicts_file_or_a_malformed_one(workspace: Path, reference: dict) -> None:
    assert verifier.verify_task("check-bibtex", ARGUMENTS, reference, str(workspace))["valid"] is False
    malformed = verifier.verify_task("check-bibtex", ARGUMENTS, reference, verdicts(workspace, ["real"]))
    assert malformed["valid"] is False and malformed["score"] == 0.0


def test_checks_the_tools_outputs(workspace: Path, reference: dict) -> None:
    assert verifier.verify_output("parse_bibtex", ARGUMENTS, reference, str(workspace))["valid"] is True
    read = read_bibtex("inputs/raw.bib", workspace=workspace)
    assert verifier.verify_output("read_bibtex", {"path": "inputs/raw.bib"}, read, str(workspace))["valid"] is True
    saved = submit_verdicts(EXPECTED, workspace=workspace)
    assert verifier.verify_output("submit_verdicts", {"verdicts": EXPECTED}, saved, str(workspace))["valid"] is True
    unnormalized = json.loads(json.dumps(reference))
    unnormalized["raw"][0]["record"]["title"] = "{Attention} Is All You Need"
    assert verifier.verify_output("parse_bibtex", ARGUMENTS, unnormalized, str(workspace))["valid"] is False


def test_checks_the_tools_inputs() -> None:
    assert verifier.verify_input("parse_bibtex", ARGUMENTS)["valid"] is True
    assert verifier.verify_input("read_bibtex", {"path": "../reference.bib"})["valid"] is False
    assert verifier.verify_input("submit_verdicts", {"verdicts": {"a": "maybe"}})["valid"] is False
