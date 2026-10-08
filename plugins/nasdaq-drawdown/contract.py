"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    PIN_WEEK = "pin_week"
    LIST_CONSTITUENTS = "list_constituents"
    GET_CLOSES = "get_closes"
    SUBMIT_TICKERS = "submit_tickers"


class Task(Enum):
    NASDAQ_DOWN_5 = "nasdaq-down-5"


TICKER = "A ticker symbol as Nasdaq lists it, e.g. AAPL"
START = "The session 5 sessions before as_of"
LISTED_AT = "When Nasdaq stamped the constituent list (US Eastern)"


@dataclass
class WeekInput(Output):
    as_of: Annotated[str, "The week's last trading session, YYYY-MM-DD, a past day"]


@dataclass
class Constituent(Output):
    ticker: str
    name: str


@dataclass
class PinnedConstituent(Output):
    ticker: str
    name: str
    start_close: Annotated[float, "The close on start"]
    end_close: Annotated[float, "The close on as_of"]


@dataclass
class PinOutput(Output):
    as_of: str
    start: Annotated[str, START]
    listed_at: Annotated[str, LISTED_AT]
    pinned_at: Annotated[str, "When the week was pinned (UTC)"]
    constituents: list[PinnedConstituent]


@dataclass
class ConstituentsOutput(Output):
    as_of: str
    start: Annotated[str, START]
    sessions: Annotated[list[str], "The week's sessions, start through as_of"]
    listed_at: Annotated[str, LISTED_AT]
    constituents: list[Constituent]


@dataclass
class Close(Output):
    ticker: str
    close: float


@dataclass
class ClosesInput(Output):
    tickers: Annotated[list[Annotated[str, TICKER]], "Up to 25 distinct tickers"]
    date: Annotated[str, "A past trading session, YYYY-MM-DD"]


@dataclass
class ClosesOutput(Output):
    date: str
    closes: list[Close]


@dataclass
class SubmitInput(Output):
    tickers: Annotated[
        list[Annotated[str, TICKER]], "Every constituent that fell at least 5% over the week; [] for none"
    ]


@dataclass
class SubmitOutput(Output):
    path: str
    tickers: int


TOOLS = {
    Tool.PIN_WEEK: (WeekInput, PinOutput),
    Tool.LIST_CONSTITUENTS: (WeekInput, ConstituentsOutput),
    Tool.GET_CLOSES: (ClosesInput, ClosesOutput),
    Tool.SUBMIT_TICKERS: (SubmitInput, SubmitOutput),
}
TASKS = {Task.NASDAQ_DOWN_5: WeekInput}
