"""Nasdaq's public API (`api.nasdaq.com`): the Nasdaq-100 constituent list and daily closes."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import date as Date
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

API = "https://api.nasdaq.com/api"
# The API refuses clients that do not look like a browser.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}
MAX_RESPONSE = 10 * 1024 * 1024
# A short pause between requests, to stay polite when one call fetches every constituent.
PAUSE = 0.5
MARKET = ZoneInfo("America/New_York")
INDEX = "NDX"
# The week: the close on `as_of` against the close this many sessions earlier.
SESSIONS = 5


def get(path: str, params: dict, *, opener=urllib.request.urlopen) -> dict:
    """The `data` of one API response; Nasdaq reports errors inside a 200 response, as `status`."""
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    with opener(urllib.request.Request(url, headers=HEADERS), timeout=60) as response:
        body = response.read(MAX_RESPONSE + 1)
    if len(body) > MAX_RESPONSE:
        raise ValueError(f"Nasdaq response exceeds {MAX_RESPONSE} bytes: {url}")
    payload = json.loads(body)
    status = payload.get("status") or {}
    if status.get("rCode") != 200 or payload.get("data") is None:
        messages = [item.get("errorMessage", "") for item in status.get("bCodeMessage") or []]
        raise ValueError(f"Nasdaq refused {url}: {'; '.join(messages) or status}")
    return payload["data"]


def past_day(value: str) -> Date:
    """A date before today in New York: a session still trading has no final close."""
    day = Date.fromisoformat(value)
    if day >= datetime.now(MARKET).date():
        raise ValueError(f"{value} is not a past day in New York: its close may not be final")
    return day


def constituents(*, opener=urllib.request.urlopen) -> dict:
    """The Nasdaq-100 constituents Nasdaq lists now, and the time Nasdaq stamps the list with."""
    data = get("quote/list-type/nasdaq100", {}, opener=opener)
    rows = data["data"]["rows"]
    if len(rows) != data["totalrecords"]:
        raise ValueError(f"Nasdaq listed {len(rows)} of {data['totalrecords']} constituents")
    tickers = [{"ticker": row["symbol"], "name": row["companyName"]} for row in rows]
    return {"listed_at": data["date"], "constituents": sorted(tickers, key=lambda row: row["ticker"])}


def closes(symbol: str, asset_class: str, since: Date, *, opener=urllib.request.urlopen) -> dict[str, float]:
    """Each session's close from ``since`` to today, by YYYY-MM-DD date.

    Nasdaq picks the period it serves from the requested range's length and ends it today, then
    cuts it to the range: a range that ends in the past can come back short. So the range always
    ends today.
    """
    today = datetime.now(MARKET).date()
    params = {"assetclass": asset_class, "fromdate": since.isoformat(), "todate": today.isoformat(), "limit": 9999}
    table = get(f"quote/{urllib.parse.quote(symbol)}/historical", params, opener=opener)["tradesTable"]
    return {_iso(row["date"]): float(row["close"].removeprefix("$").replace(",", "")) for row in table["rows"] or []}


def _iso(day: str) -> str:
    """Nasdaq's MM/DD/YYYY date as YYYY-MM-DD."""
    month, number, year = day.split("/")
    return Date(int(year), int(month), int(number)).isoformat()


def close_on(ticker: str, day: Date, *, opener=urllib.request.urlopen) -> float:
    """``ticker``'s close on the session ``day``."""
    found = closes(ticker, "stocks", day, opener=opener)
    if day.isoformat() not in found:
        raise ValueError(f"Nasdaq has no close for {ticker} on {day.isoformat()}: not a session it traded")
    return found[day.isoformat()]


def week(as_of: str, *, opener=urllib.request.urlopen) -> list[str]:
    """The Nasdaq-100 index's sessions from 5 before ``as_of`` through ``as_of``, oldest first."""
    day = past_day(as_of)
    found = sorted(date for date in closes(INDEX, "index", day - timedelta(days=30), opener=opener) if date <= as_of)
    if not found or found[-1] != as_of:
        raise ValueError(f"{as_of} is not a Nasdaq-100 trading session")
    # One earlier session must be there too, or the history may have been cut inside the week.
    if len(found) <= SESSIONS + 1:
        raise ValueError(f"Nasdaq's index history before {as_of} is too short to find the week")
    return found[-SESSIONS - 1 :]
