from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from contract import Label, ParseInput, ReadInput, Record, VerdictsInput, VerdictsOutput
from plugin.bibtex import parse_bibtex, read_bibtex, submit_verdicts
from plugin.schema import normalize, to_record

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    shutil.copytree(FIXTURES, tmp_path / "inputs")
    return tmp_path


def test_normalize_drops_braces_and_collapses_whitespace_only() -> None:
    assert normalize("  {D}eep\n   {R}esidual  ") == "Deep Residual"
    assert normalize("Deep learning") != normalize("Deep Learning")


def test_parses_both_files_into_the_schema(workspace: Path) -> None:
    parsed = parse_bibtex(ParseInput(reference="inputs/reference.bib", raw="inputs/raw.bib"), workspace)
    assert len(parsed.reference) == 6
    assert [entry.key for entry in parsed.raw][:3] == ["transformer", "resnet", "nature_dl"]
    assert parsed.raw[0].record == parsed.reference[0].record == Record(
        entry_type="inproceedings",
        title="Attention Is All You Need",
        authors=[
            "Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit",
            "Llion Jones", "Aidan N. Gomez", "Lukasz Kaiser", "Illia Polosukhin",
        ],
        year="2017",
        venue="Advances in Neural Information Processing Systems",
        doi="10.48550/arXiv.1706.03762",
    )


def test_records_an_unparseable_entry_with_its_key(workspace: Path) -> None:
    [broken] = [entry for entry in read_bibtex(ReadInput(path="inputs/raw.bib"), workspace).entries if entry.record is None]
    assert broken.key == "kingma_broken"
    assert broken.error.startswith("unparseable: ")


@pytest.mark.parametrize(
    ("pairs", "problem"),
    [
        ([("title", "T"), ("author", "A")], "missing year"),
        ([("title", "T"), ("author", "A"), ("year", "2020"), ("journal", "J"), ("booktitle", "B")], "both"),
        ([("title", "T"), ("Title", "U"), ("author", "A"), ("year", "2020")], "a field twice"),
    ],
)
def test_an_entry_outside_the_schema_has_no_record(pairs: list[tuple[str, str]], problem: str) -> None:
    with pytest.raises(ValueError, match=problem):
        to_record("article", pairs)


def test_a_record_without_venue_or_doi_has_them_null() -> None:
    record = to_record("misc", [("title", "T"), ("author", "A and B"), ("year", "2020")])
    assert record == Record(entry_type="misc", title="T", authors=["A", "B"], year="2020", venue=None, doi=None)


def test_refuses_a_reference_that_does_not_parse(workspace: Path) -> None:
    with pytest.raises(ValueError, match="kingma_broken"):
        parse_bibtex(ParseInput(reference="inputs/raw.bib", raw="inputs/raw.bib"), workspace)


def test_refuses_a_key_used_twice(workspace: Path) -> None:
    (workspace / "twice.bib").write_text("@misc{a, title={T}, author={A}, year={1}}\n@misc{a, title={U}, author={B}, year={2}}\n")
    with pytest.raises(ValueError, match="keys twice: a"):
        read_bibtex(ReadInput(path="twice.bib"), workspace)


def test_refuses_paths_outside_the_workspace(workspace: Path) -> None:
    with pytest.raises(ValueError, match="workspace"):
        read_bibtex(ReadInput(path="../raw.bib"), workspace / "inputs")
    with pytest.raises(FileNotFoundError):
        read_bibtex(ReadInput(path="inputs/missing.bib"), workspace)


def test_submits_the_verdicts_to_verdicts_json(tmp_path: Path) -> None:
    submit_verdicts(VerdictsInput(verdicts={"a": Label.HALLUCINATED}), tmp_path)
    saved = submit_verdicts(VerdictsInput(verdicts={"a": Label.REAL, "b": Label.HALLUCINATED}), tmp_path)
    assert saved == VerdictsOutput(path=str(tmp_path / "verdicts.json"), verdicts=2)
    assert json.loads((tmp_path / "verdicts.json").read_text()) == {"a": "real", "b": "hallucinated"}
