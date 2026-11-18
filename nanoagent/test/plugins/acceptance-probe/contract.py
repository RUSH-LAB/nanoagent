"""Each tool's and task's typed input and output (see nanoagent.plugin.v0001.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    WAIT = "wait"
    DIGEST = "digest"


class Task(Enum):
    PROBE = "probe"


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


TOOLS = {
    Tool.WAIT: (WaitInput, WaitOutput),
    Tool.DIGEST: (ProbeInput, ProbeOutput),
}
TASKS = {Task.PROBE: (ProbeInput, ProbeOutput)}
