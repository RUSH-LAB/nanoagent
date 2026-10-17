"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    PROBE = "probe"
    HOG = "hog"
    SWARM = "swarm"
    FORKS = "forks"


class Task(Enum):
    PROBE = "probe"
    HOG = "hog"
    SWARM = "swarm"
    FORKS = "forks"


@dataclass
class ProbeInput(Output):
    declared: Annotated[str, "A host the plugin declares, which the egress proxy lets it reach over HTTPS"]
    undeclared: Annotated[str, "A public host the plugin does not declare"]
    private: Annotated[str, "A host the plugin declares whose address is not public"]


@dataclass
class ProbeOutput(Output):
    report: Annotated[str, "What the sandbox let the plugin see and reach, as JSON"]


@dataclass
class HogInput(Output):
    megabytes: Annotated[int, "How many megabytes to try to hold"]


@dataclass
class HogOutput(Output):
    held: Annotated[int, "The megabytes it held when it stopped"]


@dataclass
class SwarmInput(Output):
    count: Annotated[int, "How many processes to start"]
    megabytes: Annotated[int, "How many megabytes each holds"]


@dataclass
class SwarmOutput(Output):
    started: Annotated[int, "The processes it started"]
    killed: Annotated[int, "Those the kernel had stopped when it looked"]


@dataclass
class ForksInput(Output):
    count: Annotated[int, "How many processes to try to start"]
    hold_seconds: Annotated[int, "How long to hold them before returning, leaving them to end with the run; 0 stops them at once"]


@dataclass
class ForksOutput(Output):
    started: Annotated[int, "The processes it started before one could not be"]


TOOLS = {
    Tool.PROBE: (ProbeInput, ProbeOutput),
    Tool.HOG: (HogInput, HogOutput),
    Tool.SWARM: (SwarmInput, SwarmOutput),
    Tool.FORKS: (ForksInput, ForksOutput),
}
TASKS = {
    Task.PROBE: (ProbeInput, ProbeOutput),
    Task.HOG: (HogInput, HogOutput),
    Task.SWARM: (SwarmInput, SwarmOutput),
    Task.FORKS: (ForksInput, ForksOutput),
}
