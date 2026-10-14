"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    PIN_WEEK = "pin_week"
    LIST_CONSTITUENTS = "list_constituents"
    GET_CLOSES = "get_closes"


class Task(Enum):
    LIST_WEEKLY_FALLERS = "list-weekly-fallers"


TICKER = "A ticker symbol as Nasdaq lists it, e.g. AAPL"
NAME = "The company's name as Nasdaq lists it"
AS_OF = "The week's last trading session, YYYY-MM-DD"
START = "The session 5 sessions before as_of"
LISTED_AT = "When Nasdaq stamped the constituent list (US Eastern)"


@dataclass
class WeekInput(Output):
    as_of: Annotated[
        str, "The week's last trading session, YYYY-MM-DD, a past weekday the market was open, e.g. last Friday"
    ]


@dataclass
class Constituent(Output):
    ticker: Annotated[str, TICKER]
    name: Annotated[str, NAME]


@dataclass
class PinnedConstituent(Output):
    ticker: Annotated[str, TICKER]
    name: Annotated[str, NAME]
    start_close: Annotated[float, "The close on start"]
    end_close: Annotated[float, "The close on as_of"]


@dataclass
class PinOutput(Output):
    as_of: Annotated[str, AS_OF]
    start: Annotated[str, START]
    listed_at: Annotated[str, LISTED_AT]
    pinned_at: Annotated[str, "When the week was pinned (UTC)"]
    constituents: Annotated[list[PinnedConstituent], "Every constituent Nasdaq lists now, with its closes at both ends"]


@dataclass
class ConstituentsOutput(Output):
    as_of: Annotated[str, AS_OF]
    start: Annotated[str, START]
    sessions: Annotated[list[str], "The week's sessions, start through as_of"]
    listed_at: Annotated[str, LISTED_AT]
    constituents: Annotated[list[Constituent], "Every constituent Nasdaq lists now"]


@dataclass
class Close(Output):
    ticker: Annotated[str, TICKER]
    close: Annotated[float, "Its close on the session, in US dollars"]


@dataclass
class ClosesInput(Output):
    tickers: Annotated[list[Annotated[str, TICKER]], "Up to 25 distinct tickers"]
    date: Annotated[str, "A past trading session, YYYY-MM-DD"]


@dataclass
class ClosesOutput(Output):
    date: Annotated[str, "The session, YYYY-MM-DD"]
    closes: Annotated[list[Close], "Each requested ticker's close, in the order requested"]


@dataclass
class Faller(Output):
    ticker: Annotated[str, TICKER]
    change_percent: Annotated[float, "Its change over the week in percent, to the cent, e.g. -6.25"]


@dataclass
class DrawdownOutput(Output):
    fallers: Annotated[list[Faller], "Every constituent that fell at least 5% over the week; [] for none"]


TOOLS = {
    Tool.PIN_WEEK: (WeekInput, PinOutput),
    Tool.LIST_CONSTITUENTS: (WeekInput, ConstituentsOutput),
    Tool.GET_CLOSES: (ClosesInput, ClosesOutput),
}
TASKS = {Task.LIST_WEEKLY_FALLERS: (WeekInput, DrawdownOutput)}
