from __future__ import annotations

import json
from pathlib import Path

import pytest

import verifier

AS_OF = "2026-10-02"
ARGUMENTS = {"as_of": AS_OF}


def constituent(ticker: str, start_close: float, end_close: float) -> dict:
    return {"ticker": ticker, "name": f"{ticker} Inc.", "start_close": start_close, "end_close": end_close}


REFERENCE = {
    "ok": True,
    "as_of": AS_OF,
    "start": "2026-09-25",
    "listed_at": "Oct 6, 2026 3:08 PM",
    "pinned_at": "2026-10-06T19:10:00+00:00",
    "constituents": [
        constituent("ALNY", 400.0, 343.36),  # -14.16%
        constituent("KDP", 30.0, 28.5),  # exactly -5%: fell by at least 5%
        constituent("GILD", 120.0, 115.08),  # -4.10%
        constituent("AAPL", 333.0, 340.0),
    ],
}


def verdict(tmp_path: Path, tickers, *, arguments=ARGUMENTS, reference=REFERENCE) -> dict:
    if tickers is not None:
        (tmp_path / "tickers.json").write_text(json.dumps({"tickers": tickers}))
    return verifier.verify_task("nasdaq-down-5", arguments, reference, str(tmp_path))


@pytest.mark.parametrize("tickers", [["ALNY", "KDP"], ["KDP", "ALNY"]])
def test_approves_exactly_the_tickers_that_fell_at_least_5_percent(tmp_path: Path, tickers: list[str]) -> None:
    found = verdict(tmp_path, tickers)
    assert found["valid"] is True and found["score"] == 1.0
    assert found["details"]["expected"] == {"ALNY": -14.16, "KDP": -5.0}


def test_approves_an_empty_answer_when_none_fell(tmp_path: Path) -> None:
    reference = REFERENCE | {"constituents": [constituent("AAPL", 333.0, 340.0)]}
    found = verdict(tmp_path, [], reference=reference)
    assert found["valid"] is True and found["score"] == 1.0


@pytest.mark.parametrize(
    ("tickers", "score", "differences"),
    [
        (["ALNY"], 2 / 3, {"missing": {"KDP": -5.0}, "extra": {}, "not_constituents": []}),
        (["ALNY", "KDP", "GILD"], 0.8, {"missing": {}, "extra": {"GILD": -4.1}, "not_constituents": []}),
        (["ALNY", "KDP", "NVDA"], 0.8, {"missing": {}, "extra": {}, "not_constituents": ["NVDA"]}),
        ([], 0.0, {"missing": {"ALNY": -14.16, "KDP": -5.0}, "extra": {}, "not_constituents": []}),
    ],
)
def test_refuses_any_other_answer_and_scores_its_f1(
    tmp_path: Path, tickers: list[str], score: float, differences: dict
) -> None:
    found = verdict(tmp_path, tickers)
    assert found["valid"] is False
    assert found["score"] == pytest.approx(score)
    assert {key: found["details"][key] for key in differences} == differences


@pytest.mark.parametrize(
    ("tickers", "arguments", "message"),
    [
        (None, ARGUMENTS, "no answer at tickers.json"),
        (["ALNY", "ALNY", "KDP"], ARGUMENTS, "tickers must be distinct"),
        (["alny"], ARGUMENTS, "tickers must be a list of ticker symbols"),
        (["ALNY", "KDP"], {"as_of": "2026-10-01"}, "the pinned week ends on another day"),
    ],
)
def test_refuses_a_missing_malformed_or_mismatched_answer(
    tmp_path: Path, tickers, arguments: dict, message: str
) -> None:
    found = verdict(tmp_path, tickers, arguments=arguments)
    assert found["valid"] is False and found["score"] == 0.0
    assert message in found["message"]
    assert found["details"]["expected"] == {"ALNY": -14.16, "KDP": -5.0}


def test_checks_tool_inputs_and_outputs(tmp_path: Path) -> None:
    assert verifier.verify_input("get_closes", {"tickers": ["AAPL"] * 26, "date": AS_OF})["valid"] is False
    assert verifier.verify_input("get_closes", {"tickers": ["AAPL"], "date": "10/02/2026"})["valid"] is False
    assert verifier.verify_input("pin_week", ARGUMENTS)["valid"] is True
    assert verifier.verify_output("pin_week", ARGUMENTS, REFERENCE, str(tmp_path))["valid"] is True
    assert verifier.verify_output("pin_week", {"as_of": "2026-10-01"}, REFERENCE, str(tmp_path))["valid"] is False
    closes = {"ok": True, "date": AS_OF, "closes": [{"ticker": "MSFT", "close": 1.0}]}
    assert (
        verifier.verify_output("get_closes", {"tickers": ["AAPL"], "date": AS_OF}, closes, str(tmp_path))["valid"]
        is False
    )
    (tmp_path / "tickers.json").write_text(json.dumps({"tickers": ["AAPL"]}))
    saved = {"ok": True, "path": str(tmp_path / "tickers.json"), "tickers": 1}
    assert verifier.verify_output("submit_tickers", {"tickers": ["MSFT"]}, saved, str(tmp_path))["valid"] is False
