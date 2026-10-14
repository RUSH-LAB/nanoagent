from __future__ import annotations

import json
from pathlib import Path

import pytest
from slimconfig import build_output, plain_output

import plugin.schema
import verifier
import verifier.schema
from contract import TASKS, TOOLS, Task, Tool
from plugin.bibtex import parse_bibtex, read_bibtex

FIXTURES = Path(__file__).parent / "fixtures"
ARGUMENTS = {
    "reference": (FIXTURES / "reference.bib").read_text(encoding="utf-8"),
    "raw": (FIXTURES / "raw.bib").read_text(encoding="utf-8"),
}
TITLES = {
    "transformer": "Attention Is All You Need",
    "resnet": "Deep Residual Learning for Image Recognition",
    "nature_dl": "Deep learning",
    "bert": "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    "adam": "Adam: A Method for Stochastic Optimization",
    "lstm": "Long Short-Term Memory Recurrent Networks",
    "vaswani_attention": "Attention Is All You Need",
    "gradient_folding": "Recursive Gradient Folding for Sparse Mixture-of-Experts Transformers",
}


def verdict(key: str, label: str, closest: str | None = None, differs: tuple[str, ...] = (), error: str | None = None) -> dict:
    return {"key": key, "title": TITLES.get(key), "label": label, "closest": closest, "differs": list(differs), "error": error}


# The right verdict for every entry of tests/fixtures/raw.bib.
EXPECTED = [
    verdict("transformer", "real", "vaswani2017attention"),
    verdict("resnet", "real", "he2016deep"),
    verdict("nature_dl", "real", "lecun2015deep"),
    verdict("bert", "fixable", "devlin2019bert", ("year",)),
    verdict("adam", "fixable", "kingma2015adam", ("authors",)),  # invented co-author
    verdict("lstm", "fixable", "hochreiter1997long", ("title",)),
    verdict("vaswani_attention", "fixable", "vaswani2017attention", ("doi",)),
    verdict("gradient_folding", "invented"),
    verdict("kingma_broken", "unreadable", error="unparseable: Unexpectedly reached end of file."),
]


@pytest.fixture
def reference() -> dict:
    return plain_output(parse_bibtex(build_output(ARGUMENTS, TOOLS[Tool.PARSE_BIBTEX][0])))


# The verifier gets contract instances, as NanoAgent's sandbox builds them from JSON.
def verify_input(tool: str, value: dict) -> dict:
    return verifier.verify_input(tool, build_output(value, TOOLS[Tool(tool)][0]))


def verify_output(tool: str, value: dict, output: dict, workspace: Path) -> dict:
    given, made = TOOLS[Tool(tool)]
    return verifier.verify_output(tool, build_output(value, given), build_output(output, made), str(workspace))


def verify_task(reference: dict, verdicts: list[dict], workspace: Path) -> dict:
    given, made = TASKS[Task.CHECK_BIBTEX]
    pinned = TOOLS[Tool.PARSE_BIBTEX][1]
    return verifier.verify_task(
        "check-bibtex",
        build_output(ARGUMENTS, given),
        build_output({"verdicts": verdicts}, made),
        build_output(reference, pinned),
        str(workspace),
    )


def changed(key: str, **fields: object) -> list[dict]:
    return [one | fields if one["key"] == key else one for one in EXPECTED]


@pytest.mark.parametrize("text", ["  {D}eep\n {{R}}esidual\t", "", "a}b{c", "Ünïcode space"])
def test_the_verifier_and_the_plugin_normalize_alike(text: str) -> None:
    assert verifier.schema.normalize(text) == plugin.schema.normalize(text)


def test_approves_every_right_verdict(tmp_path: Path, reference: dict) -> None:
    result = verify_task(reference, EXPECTED, tmp_path)
    assert result["valid"] is True and result["score"] == 1.0


@pytest.mark.parametrize(
    ("verdicts", "key", "problem"),
    [
        (changed("transformer", label="fixable"), "transformer", "wrong label: the entry is real"),
        (changed("bert", label="real", differs=[]), "bert", "wrong label, differs: the entry is fixable"),
        (changed("adam", differs=["authors", "doi"]), "adam", "wrong differs: the entry is fixable"),
        (changed("lstm", closest="kingma2015adam"), "lstm", "wrong closest: the entry is fixable"),
        (changed("gradient_folding", label="fixable", closest="kingma2015adam"), "gradient_folding", "wrong label, closest: the entry is invented"),
        (changed("kingma_broken", label="invented", error=None), "kingma_broken", "wrong label, error: the entry is unreadable"),
        (EXPECTED + [verdict("he2016deep", "real", "he2016deep")], "he2016deep", "not a raw entry"),
        (EXPECTED + [EXPECTED[0]], "transformer", "more than one verdict"),
        (EXPECTED[1:], "transformer", "no verdict"),
        (EXPECTED[::-1], "order", "the verdicts are not in the order of the raw BibTeX"),
    ],
)
def test_refuses_a_wrong_verdict(tmp_path: Path, reference: dict, verdicts: list[dict], key: str, problem: str) -> None:
    result = verify_task(reference, verdicts, tmp_path)
    assert result["valid"] is False
    assert result["details"]["problems"] == {key: problem}


def test_scores_the_right_verdicts(tmp_path: Path, reference: dict) -> None:
    result = verify_task(reference, [one for one in EXPECTED if one["key"] != "adam"], tmp_path)
    assert result["valid"] is False and result["score"] == 8 / 9


def test_checks_the_tools_outputs(tmp_path: Path, reference: dict) -> None:
    assert verify_output("parse_bibtex", ARGUMENTS, reference, tmp_path)["valid"] is True
    read = {"bibtex": ARGUMENTS["raw"]}
    output = plain_output(read_bibtex(build_output(read, TOOLS[Tool.READ_BIBTEX][0])))
    assert verify_output("read_bibtex", read, output, tmp_path)["valid"] is True
    unnormalized = json.loads(json.dumps(reference))
    unnormalized["raw"][0]["record"]["title"] = "{Attention} Is All You Need"
    assert verify_output("parse_bibtex", ARGUMENTS, unnormalized, tmp_path)["valid"] is False


def test_checks_the_tools_inputs() -> None:
    assert verify_input("parse_bibtex", ARGUMENTS)["valid"] is True
    assert verify_input("parse_bibtex", ARGUMENTS | {"raw": " "})["valid"] is False
    assert verify_input("read_bibtex", {"bibtex": ""})["valid"] is False
