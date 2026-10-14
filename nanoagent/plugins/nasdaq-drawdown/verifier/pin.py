"""pin_week (the nasdaq-down-5 reference) and the nasdaq-down-5 task's outcome check."""

from decimal import Decimal

from .checks import DATE, result, tickers_problem, week_problem

# A constituent fell by at least 5% when its close on as_of is at most 95% of its close at the start.
KEPT = Decimal("0.95")
# A faller's change, in percent, may differ from the pinned one by its rounding: a cent (and float slack).
CENT = 0.01 + 1e-9


def verify_input(value):
    if not DATE.fullmatch(value.as_of):
        return result(False, "as_of must be YYYY-MM-DD")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    problem = week_problem(input_value, output_value)
    if problem:
        return result(False, problem)
    for row in output_value.constituents:
        if not row.start_close > 0 or not row.end_close > 0:
            return result(False, f"{row.ticker} has a close that is not positive")
    return result(True, "the week is pinned", constituents=len(output_value.constituents))


def _week(reference):
    """Each pinned constituent: whether it fell by at least 5%, and its change in percent, to the cent."""
    found = {}
    for row in reference.constituents:
        start, end = Decimal(str(row.start_close)), Decimal(str(row.end_close))
        found[row.ticker] = (end <= start * KEPT, float(((end / start - 1) * 100).quantize(Decimal("0.01"))))
    return found


def verify_task(arguments, output, reference, workspace):
    """Approve the output only when its fallers are exactly the pinned constituents that fell by at
    least 5%, each with its change to the cent; score it by F1 against that set."""
    week = _week(reference)
    expected = {ticker for ticker, (fell, _) in week.items() if fell}
    report = {"expected": {ticker: week[ticker][1] for ticker in sorted(expected)}}
    if reference.as_of != arguments.as_of:
        return result(False, "the pinned week ends on another day", score=0.0, **report)
    tickers = [row.ticker for row in output.fallers]
    problem = tickers_problem(tickers)
    if problem:
        return result(False, f"fallers: {problem}", score=0.0, **report)

    submitted = set(tickers)
    hits = len(submitted & expected)
    score = 2 * hits / (len(submitted) + len(expected)) if submitted or expected else 1.0
    differences = {
        # Expected but not submitted, submitted constituents that fell less, unknown tickers, and
        # expected tickers given another change.
        "missing": {ticker: week[ticker][1] for ticker in sorted(expected - submitted)},
        "extra": {ticker: week[ticker][1] for ticker in sorted(submitted - expected) if ticker in week},
        "not_constituents": sorted(submitted - set(week)),
        "wrong_changes": {
            row.ticker: week[row.ticker][1]
            for row in output.fallers
            if row.ticker in expected and abs(row.change_percent - week[row.ticker][1]) > CENT
        },
    }
    wrong = len(expected - submitted) + len(submitted - expected)
    if wrong:
        message = f"{wrong} ticker(s) differ from the {len(expected)} that fell at least 5% (F1 {score:.2f})"
        return result(False, message, score=score, **differences, **report)
    if differences["wrong_changes"]:
        message = f"{len(differences['wrong_changes'])} faller(s) have a change off by more than a cent"
        return result(False, message, score=score, **differences, **report)
    return result(True, f"exactly the {len(expected)} ticker(s) that fell at least 5%", score=score, **report)
