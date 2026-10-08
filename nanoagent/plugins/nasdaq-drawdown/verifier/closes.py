from .checks import DATE, result, tickers_problem

MAX_TICKERS = 25


def verify_input(value):
    problem = tickers_problem(value.tickers, most=MAX_TICKERS)
    if problem:
        return result(False, problem)
    if not DATE.fullmatch(value.date):
        return result(False, "date must be YYYY-MM-DD")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    if output_value.date != input_value.date:
        return result(False, "closes are for another date")
    closes = output_value.closes
    if [row.ticker for row in closes] != input_value.tickers:
        return result(False, "closes do not cover exactly the requested tickers, in order")
    if not all(row.close > 0 for row in closes):
        return result(False, "a close is not positive")
    return result(True, "closes are well formed")
