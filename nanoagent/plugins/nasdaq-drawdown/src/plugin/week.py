"""The past week of the Nasdaq-100: its constituents, their closes, and the pinned week."""

from __future__ import annotations

import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from contract import (
    Close,
    ClosesInput,
    ClosesOutput,
    Constituent,
    ConstituentsOutput,
    PinnedConstituent,
    PinOutput,
    WeekInput,
)
from plugin.nasdaq import PAUSE, close_on, closes, constituents, past_day, week

# Tickers per get_closes call: each takes one request, so a call stays well inside its timeout.
MAX_TICKERS = 25


def list_constituents(given: WeekInput, workspace: Path, *, opener=urllib.request.urlopen) -> ConstituentsOutput:
    """The week ending ``as_of`` (its first session and every session), and the constituents
    Nasdaq lists now."""
    sessions = week(given.as_of, opener=opener)
    listed = constituents(opener=opener)
    return ConstituentsOutput(
        as_of=given.as_of,
        start=sessions[0],
        sessions=sessions,
        listed_at=listed["listed_at"],
        constituents=[Constituent(**row) for row in listed["constituents"]],
    )


def get_closes(
    given: ClosesInput, workspace: Path, *, opener=urllib.request.urlopen, pause: float = PAUSE
) -> ClosesOutput:
    """Each ticker's close on the session ``date``."""
    tickers = given.tickers
    if not tickers or len(set(tickers)) != len(tickers) or len(tickers) > MAX_TICKERS:
        raise ValueError(f"tickers must be 1 to {MAX_TICKERS} distinct symbols")
    day = past_day(given.date)
    found = []
    for index, ticker in enumerate(tickers):
        if index:
            time.sleep(pause)
        found.append(Close(ticker=ticker, close=close_on(ticker, day, opener=opener)))
    return ClosesOutput(date=given.date, closes=found)


def pin_week(given: WeekInput, workspace: Path, *, opener=urllib.request.urlopen, pause: float = PAUSE) -> PinOutput:
    """Every constituent Nasdaq lists now, with its close on ``as_of`` and 5 sessions earlier."""
    as_of = given.as_of
    sessions = week(as_of, opener=opener)
    start = sessions[0]
    listed = constituents(opener=opener)
    pinned = []
    for row in listed["constituents"]:
        time.sleep(pause)
        found = closes(row["ticker"], "stocks", past_day(start), opener=opener)
        missing = [day for day in (start, as_of) if day not in found]
        if missing:
            raise ValueError(f"Nasdaq has no close for {row['ticker']} on {', '.join(missing)}")
        pinned.append(PinnedConstituent(**row, start_close=found[start], end_close=found[as_of]))
    return PinOutput(
        as_of=as_of,
        start=start,
        listed_at=listed["listed_at"],
        pinned_at=datetime.now(UTC).isoformat(timespec="seconds"),
        constituents=pinned,
    )
