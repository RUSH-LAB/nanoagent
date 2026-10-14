"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    SEARCH_PAPERS = "search_papers"
    DOWNLOAD_SOURCE = "download_source"
    SAVE_SEARCH_RESULTS = "save_search_results"
    LIST_DAILY_PAPERS = "list_daily_papers"
    SAVE_RAW_PAPER = "save_raw_paper"


class Task(Enum):
    SEARCH_PAPERS = "search-papers"
    SAVE_PAPER_SOURCE = "save-paper-source"
    SAVE_SEARCH_RESULTS = "save-search-results"
    FIND_AND_SAVE_PAPER = "find-and-save-paper"
    WRITE_DAILY_DIGEST = "write-daily-digest"


QUERY = (
    "An arXiv API search_query built from the request: ti: title, au: author, abs: abstract, cat: category,"
    ' joined by AND/OR, e.g. ti:"attention is all you need" or au:vaswani AND cat:cs.CL'
)
DESTINATION = "A new folder relative to the plugin workspace, e.g. papers/attention"
DATE = "A UTC date, YYYY-MM-DD"
VERSIONED_ID = "The arXiv identifier with its version"
NEW_ID = "An arXiv id of the form YYMM.NNNNN"
TITLE = "The title, as arXiv lists it"
AUTHORS = "The authors' names, as arXiv lists them, in order"
PUBLISHED = "When the first version was submitted, an ISO 8601 UTC timestamp"
ABS_URL = "The paper's arXiv abstract page"
SOURCE_URL = "The arXiv e-print URL the source archive came from"
FOLDER = "The folder the source was unpacked in, inside the plugin workspace"
FILES = "The unpacked files, relative to the folder"


@dataclass
class Paper(Output):
    arxiv_id: Annotated[str, VERSIONED_ID]
    title: Annotated[str, TITLE]
    authors: Annotated[list[str], AUTHORS]
    summary: Annotated[str, "The abstract, as arXiv lists it"]
    published: Annotated[str, PUBLISHED]
    abs_url: Annotated[str, ABS_URL]


@dataclass
class SavedPaperOutput(Output):
    arxiv_id: Annotated[str, VERSIONED_ID]
    title: Annotated[str, TITLE]
    authors: Annotated[list[str], AUTHORS]
    summary: Annotated[str, "The abstract, as arXiv lists it"]
    published: Annotated[str, PUBLISHED]
    abs_url: Annotated[str, ABS_URL]
    source_url: Annotated[str, SOURCE_URL]
    folder: Annotated[str, FOLDER]
    files: Annotated[list[str], FILES]


@dataclass
class DailyPaper(Output):
    arxiv_id: Annotated[str, NEW_ID]
    title: Annotated[str, TITLE]
    authors: Annotated[list[str], AUTHORS]
    published: Annotated[str, PUBLISHED]
    abs_url: Annotated[str, ABS_URL]


@dataclass
class Person(Output):
    name: Annotated[str, "The person's full name, as given"]
    papers: Annotated[list[DailyPaper], "The papers by the person first submitted on the date"]


@dataclass
class Entry(Output):
    arxiv_id: Annotated[str, NEW_ID]
    title: Annotated[str, "Exactly as arXiv lists it"]
    authors: Annotated[list[str], "Exactly as arXiv lists them, in order"]
    summary: Annotated[str, "Exactly two lines, separated by one newline"]
    link: Annotated[str, "https://arxiv.org/abs/<arxiv_id>"]
    folder: Annotated[str, "Where save_raw_paper saved its source, exactly as it returned it"]


@dataclass
class SearchInput(Output):
    query: Annotated[str, QUERY]
    max_results: Annotated[int, "How many papers to return, best match first, 1 to 50"]


@dataclass
class SearchOutput(Output):
    query: Annotated[str, "The search_query, as given"]
    source_url: Annotated[str, "The arXiv API request the papers came from"]
    papers: Annotated[list[Paper], "The matching papers, best match first"]


@dataclass
class DownloadInput(Output):
    arxiv_id: Annotated[str, "A modern or legacy arXiv identifier, optionally with a version"]
    destination: Annotated[str, DESTINATION]


@dataclass
class DownloadOutput(Output):
    arxiv_id: Annotated[str, "The arXiv identifier, as given without surrounding spaces"]
    source_url: Annotated[str, SOURCE_URL]
    folder: Annotated[str, FOLDER]
    files: Annotated[list[str], FILES]


@dataclass
class SaveInput(Output):
    query: Annotated[str, QUERY]
    max_results: Annotated[int, "How many of the best matches to save, 1 to 10"]
    destination: Annotated[
        str, "A new folder relative to the plugin workspace; each paper goes in <destination>/<arxiv id>"
    ]


@dataclass
class SaveOutput(Output):
    query: Annotated[str, "The search_query, as given"]
    folder: Annotated[str, "The destination folder, inside the plugin workspace"]
    papers: Annotated[list[SavedPaperOutput], "Each saved paper, best match first, its source in <folder>/<arxiv id>"]


@dataclass
class FindInput(Output):
    request: Annotated[str, "The paper in the person's words: its title, topic, authors or year"]
    destination: Annotated[str, DESTINATION]


@dataclass
class DailyInput(Output):
    people: Annotated[list[str], "The monitored people's full names"]
    date: Annotated[str, DATE]


@dataclass
class DailyOutput(Output):
    date: Annotated[str, DATE]
    people: Annotated[list[Person], "Each monitored person, in the order given, with their papers"]


@dataclass
class RawInput(Output):
    arxiv_id: Annotated[str, "YYMM.NNNNN, optionally with a version"]
    date: Annotated[str, DATE]


@dataclass
class RawOutput(Output):
    arxiv_id: Annotated[str, NEW_ID]
    title: Annotated[str, TITLE]
    authors: Annotated[list[str], AUTHORS]
    folder: Annotated[
        str,
        "The folder the source was unpacked in: docs/raw/{first_author_name}-{paper_short_name}-{arxiv_id}-{date}"
        " inside the plugin workspace",
    ]
    files: Annotated[list[str], FILES]


@dataclass
class DigestOutput(Output):
    date: Annotated[str, DATE]
    entries: Annotated[list[Entry], "One per paper, a paper by several of the people once"]


TOOLS = {
    Tool.SEARCH_PAPERS: (SearchInput, SearchOutput),
    Tool.DOWNLOAD_SOURCE: (DownloadInput, DownloadOutput),
    Tool.SAVE_SEARCH_RESULTS: (SaveInput, SaveOutput),
    Tool.LIST_DAILY_PAPERS: (DailyInput, DailyOutput),
    Tool.SAVE_RAW_PAPER: (RawInput, RawOutput),
}
TASKS = {
    Task.SEARCH_PAPERS: (SearchInput, SearchOutput),
    Task.SAVE_PAPER_SOURCE: (DownloadInput, DownloadOutput),
    Task.SAVE_SEARCH_RESULTS: (SaveInput, SaveOutput),
    Task.FIND_AND_SAVE_PAPER: (FindInput, SavedPaperOutput),
    Task.WRITE_DAILY_DIGEST: (DailyInput, DigestOutput),
}
