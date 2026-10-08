from __future__ import annotations

import io
import json
from datetime import date as Date
from urllib.parse import parse_qs, urlparse
from urllib.request import Request

# The index's sessions around the week ending Friday 2026-10-02 (no holiday in between).
SESSIONS = [
    "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28",
    "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05",
]  # fmt: skip


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def payload(data, *, error: str | None = None) -> Response:
    status = {
        "rCode": 400 if error else 200,
        "bCodeMessage": [{"code": 1001, "errorMessage": error}] if error else None,
    }
    return Response(json.dumps({"data": data, "message": None, "status": status}).encode())


def history(closes: dict[str, float], prefix: str, start: str, end: str) -> dict:
    """A historical-quotes `data`, newest first, as Nasdaq formats it."""
    rows = [
        {"date": Date.fromisoformat(day).strftime("%m/%d/%Y"), "close": f"{prefix}{close:,.2f}"}
        for day, close in sorted(closes.items(), reverse=True)
        if start <= day <= end
    ]
    return {"tradesTable": {"rows": rows or None}}


class FakeNasdaq:
    """Answers the constituent list with ``prices``' tickers, each one's history with its closes by
    date, and the index's history with ``sessions``."""

    def __init__(self, prices: dict[str, dict[str, float]], sessions: list[str] = SESSIONS) -> None:
        self.prices = prices
        self.sessions = sessions
        self.urls: list[str] = []

    def __call__(self, request: Request, timeout: float) -> Response:
        self.urls.append(request.full_url)
        assert "Mozilla" in request.get_header("User-agent")
        url = urlparse(request.full_url)
        if url.path == "/api/quote/list-type/nasdaq100":
            rows = [{"symbol": ticker, "companyName": f"{ticker} Inc."} for ticker in self.prices]
            return payload({"date": "Oct 6, 2026 3:08 PM", "totalrecords": len(rows), "data": {"rows": rows}})
        symbol = url.path.split("/")[3]
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        if symbol == "NDX":
            closes, prefix = {day: 30000.0 for day in self.sessions}, ""
        elif symbol in self.prices:
            closes, prefix = self.prices[symbol], "$"
        else:
            return payload(None, error="Symbol not exists.")
        return payload(history(closes, prefix, query["fromdate"], query["todate"]))
