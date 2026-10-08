"""Checks shared by the tool verifiers. Pure functions of their arguments and the files on disk."""

import re

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TICKER = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def result(valid, message, *, score=None, **details):
    return {
        "valid": valid,
        "score": float(valid) if score is None else score,
        "message": message,
        "details": details,
    }


def tickers_problem(tickers, *, most=None):
    """What is wrong with a list of ticker symbols (a tool's input, or the answer file's), or None."""
    if not isinstance(tickers, list) or not all(
        isinstance(ticker, str) and TICKER.fullmatch(ticker) for ticker in tickers
    ):
        return "tickers must be a list of ticker symbols"
    if len(set(tickers)) != len(tickers):
        return "tickers must be distinct"
    if most is not None and not 1 <= len(tickers) <= most:
        return f"tickers must hold 1 to {most} symbols"
    return None


def week_problem(input_value, output_value):
    """What is wrong with a week's `as_of`, `start` and constituents, or None."""
    if output_value.as_of != input_value.as_of:
        return "the week ends on another day"
    if not DATE.fullmatch(output_value.start) or not output_value.start < input_value.as_of:
        return "the week's start is not a date before as_of"
    tickers = [row.ticker for row in output_value.constituents]
    if not tickers or len(set(tickers)) != len(tickers):
        return "the constituents are empty or list a ticker twice"
    return None
