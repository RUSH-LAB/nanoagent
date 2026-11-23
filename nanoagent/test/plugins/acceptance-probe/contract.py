"""Each tool's and task's typed input and output (see nanoagent.plugin.v0001.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    WAIT = "wait"
    DIGEST = "digest"
    AB_REFERENCE = "ab_reference"


class Task(Enum):
    PROBE = "probe"
    AB_REPORT = "ab-report"


@dataclass
class WaitInput(Output):
    wait_seconds: Annotated[float, "Seconds to wait"]


@dataclass
class WaitOutput(Output):
    waited: Annotated[float, "Seconds waited"]


@dataclass
class ProbeInput(Output):
    token: Annotated[str, "The token to digest"]
    wait_seconds: Annotated[float, "Seconds to wait before answering"]


@dataclass
class ProbeOutput(Output):
    digest: Annotated[str, "The first 12 hex digits of the token's SHA-256"]


@dataclass
class AbInput(Output):
    csv_paths: Annotated[list[str], "The scenarios' CSV files, relative to the workspace"]
    cloud_path: Annotated[str, "The cloud state file, relative to the workspace"]
    output_path: Annotated[str, "The record file to write, relative to the workspace"]
    bucket_prefix: Annotated[str, "The prefix of the bucket to add when B wins"]
    log_entry: Annotated[str, "The log entry to append when A wins or there is no winner"]
    tolerance: Annotated[float, "The largest allowed difference of a rate, in percentage points"]


@dataclass
class AbOutput(Output):
    record: Annotated[str, "The record file the agent wrote, relative to the workspace"]


@dataclass
class ScenarioRate(Output):
    scenario: Annotated[str, "The scenario's name"]
    a_percent: Annotated[float, "A's conversion rate, 0 to 100"]
    b_percent: Annotated[float, "B's conversion rate, 0 to 100"]


@dataclass
class AbReferenceOutput(Output):
    rates: Annotated[list[ScenarioRate], "The rate of each scenario that has rows"]
    empty_scenarios: Annotated[list[str], "The scenarios whose CSV has no rows: absent from the record"]
    winner: Annotated[str, "A, B or tie: the version with the higher mean of its scenarios' rates"]
    seeded_sha256: Annotated[dict[str, str], "Each staged file's SHA-256, by workspace path"]
    cloud_buckets: Annotated[list[str], "The buckets of the staged cloud state"]
    cloud_logs: Annotated[list[str], "The logs of the staged cloud state"]


TOOLS = {
    Tool.WAIT: (WaitInput, WaitOutput),
    Tool.DIGEST: (ProbeInput, ProbeOutput),
    Tool.AB_REFERENCE: (AbInput, AbReferenceOutput),
}
TASKS = {Task.PROBE: (ProbeInput, ProbeOutput), Task.AB_REPORT: (AbInput, AbOutput)}
