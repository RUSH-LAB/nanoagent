"""The past week of the Nasdaq-100: its constituents, their closes, the pinned week, and the answer."""

from __future__ import annotations

import json
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from plugin.nasdaq import PAUSE, close_on, closes, constituents, past_day, week

# Tickers per get_closes call: each takes one request, so a call stays well inside its timeout.
MAX_TICKERS = 25
ANSWER = "tickers.json"


def list_constituents(as_of: str, *, opener=urllib.request.urlopen) -> dict:
    """The week ending ``as_of`` (its first session and every session), and the constituents
    Nasdaq lists now."""
    sessions = week(as_of, opener=opener)
    return {"ok": True, "as_of": as_of, "start": sessions[0], "sessions": sessions, **constituents(opener=opener)}


def get_closes(tickers: list[str], date: str, *, opener=urllib.request.urlopen, pause: float = PAUSE) -> dict:
    """Each ticker's close on the session ``date``."""
    if not tickers or len(set(tickers)) != len(tickers) or len(tickers) > MAX_TICKERS:
        raise ValueError(f"tickers must be 1 to {MAX_TICKERS} distinct symbols")
    day = past_day(date)
    found = []
    for index, ticker in enumerate(tickers):
        if index:
            time.sleep(pause)
        found.append({"ticker": ticker, "close": close_on(ticker, day, opener=opener)})
    return {"ok": True, "date": date, "closes": found}


def pin_week(as_of: str, *, opener=urllib.request.urlopen, pause: float = PAUSE) -> dict:
    """Every constituent Nasdaq lists now, with its close on ``as_of`` and 5 sessions earlier."""
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
        pinned.append(row | {"start_close": found[start], "end_close": found[as_of]})
    return {
        "ok": True,
        "as_of": as_of,
        "start": start,
        "listed_at": listed["listed_at"],
        "pinned_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "constituents": pinned,
    }


def submit_tickers(tickers: list[str], *, workspace: Path) -> dict:
    """Write the answer, the tickers that fell at least 5%, as `tickers.json`, replacing an earlier one."""
    if len(set(tickers)) != len(tickers):
        raise ValueError("tickers must be distinct")
    path = workspace.resolve() / ANSWER
    path.write_text(json.dumps({"tickers": tickers}, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "path": str(path), "tickers": len(tickers)}
