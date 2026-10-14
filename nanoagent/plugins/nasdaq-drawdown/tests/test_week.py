from __future__ import annotations

from datetime import datetime
from urllib.parse import parse_qs, urlparse

import pytest
from fakes import SESSIONS, FakeNasdaq

from contract import Close, ClosesInput, Constituent, PinnedConstituent, WeekInput
from plugin.nasdaq import MARKET
from plugin.week import get_closes, list_constituents, pin_week

AS_OF = "2026-10-02"
START = "2026-09-25"
PRICES = {"AAPL": {START: 1234.5, AS_OF: 1172.77}, "MSFT": {START: 400.0, AS_OF: 390.0}}
WEEK = WeekInput(as_of=AS_OF)


def test_lists_the_constituents_and_the_week() -> None:
    listed = list_constituents(WEEK, opener=FakeNasdaq(PRICES))
    assert listed.start == START
    assert listed.sessions == ["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", AS_OF]
    assert listed.constituents == [
        Constituent(ticker="AAPL", name="AAPL Inc."),
        Constituent(ticker="MSFT", name="MSFT Inc."),
    ]
    assert listed.listed_at == "Oct 6, 2026 3:08 PM"


def test_pins_each_constituents_closes_at_both_ends_of_the_week() -> None:
    nasdaq = FakeNasdaq(PRICES)
    pinned = pin_week(WEEK, opener=nasdaq, pause=0)
    assert pinned.start == START
    assert pinned.constituents[0] == PinnedConstituent(
        ticker="AAPL", name="AAPL Inc.", start_close=1234.5, end_close=1172.77
    )
    # Every history request runs to today: Nasdaq cuts a range that ends in the past short.
    today = datetime.now(MARKET).date().isoformat()
    assert all(parse_qs(urlparse(url).query)["todate"] == [today] for url in nasdaq.urls if "historical" in url)


def test_gets_closes_on_a_session() -> None:
    found = get_closes(ClosesInput(tickers=["MSFT", "AAPL"], date=START), opener=FakeNasdaq(PRICES), pause=0)
    assert found.date == START
    assert found.closes == [Close(ticker="MSFT", close=400.0), Close(ticker="AAPL", close=1234.5)]


@pytest.mark.parametrize(
    ("tickers", "date", "error"),
    [
        (["AAPL"], "2026-09-26", "no close for AAPL on 2026-09-26"),
        (["ZZZZ"], START, "Symbol not exists"),
        (["AAPL"] * 2, START, "distinct"),
        (["AAPL"], datetime.now(MARKET).date().isoformat(), "not a past day"),
    ],
)
def test_get_closes_fails_clearly(tickers: list[str], date: str, error: str) -> None:
    with pytest.raises(ValueError, match=error):
        get_closes(ClosesInput(tickers=tickers, date=date), opener=FakeNasdaq(PRICES), pause=0)


def test_refuses_a_day_that_is_not_a_session() -> None:
    with pytest.raises(ValueError, match="not a Nasdaq-100 trading session"):
        list_constituents(WeekInput(as_of="2026-10-03"), opener=FakeNasdaq(PRICES))


def test_refuses_a_history_too_short_to_hold_the_week() -> None:
    with pytest.raises(ValueError, match="too short"):
        pin_week(WEEK, opener=FakeNasdaq(PRICES, sessions=SESSIONS[3:]), pause=0)


def test_pin_fails_when_a_constituent_has_no_close_at_the_start() -> None:
    with pytest.raises(ValueError, match="no close for NEW on 2026-09-25"):
        pin_week(WEEK, opener=FakeNasdaq(PRICES | {"NEW": {AS_OF: 10.0}}), pause=0)
