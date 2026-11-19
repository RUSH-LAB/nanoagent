"""Each tool's and task's typed input and output (see nanoagent.plugin.v0001.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    WAIT = "wait"
    DIGEST = "digest"
    SLOW_WRITE = "slow_write"


class Task(Enum):
    PROBE = "probe"


@dataclass
class WaitInput(Output):
    wait_seconds: Annotated[float, "Seconds to wait"]


@dataclass
class WaitOutput(Output):
    waited: Annotated[float, "Seconds waited"]


@dataclass
class SlowWriteInput(Output):
    name: Annotated[str, "The workspace file to append to"]
    seconds: Annotated[float, "Seconds to keep appending"]


@dataclass
class SlowWriteOutput(Output):
    written: Annotated[int, "Bytes appended"]


@dataclass
class ProbeInput(Output):
    token: Annotated[str, "The token to digest"]
    wait_seconds: Annotated[float, "Seconds to wait before answering"]


@dataclass
class ProbeOutput(Output):
    digest: Annotated[str, "The first 12 hex digits of the token's SHA-256"]


TOOLS = {
    Tool.WAIT: (WaitInput, WaitOutput),
    Tool.DIGEST: (ProbeInput, ProbeOutput),
    Tool.SLOW_WRITE: (SlowWriteInput, SlowWriteOutput),
}
TASKS = {Task.PROBE: (ProbeInput, ProbeOutput)}
