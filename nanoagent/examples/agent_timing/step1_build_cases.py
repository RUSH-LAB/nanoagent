"""Step 1: the cases every agent is timed on. Each is one plugin task's input, its right answer pinned
once by the task's reference tool, and the prompt a coding agent is given for it. An input the
reference tool refuses (a day that is not over, a market that was closed) is a case every agent
should refuse too."""

import asyncio
import json
import tempfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, output_schema

from nanoagent.plugin import load_manifest
from nanoagent.plugin.runtime import call_tool_async


class Plugin(Enum):
    NASDAQ_DROPS = "nasdaq-drops"
    CITY_WEATHER = "city-weather"


@dataclass
class CaseInputs(Output):
    # Each one input of the plugin's task, as its contract's input class takes it.
    inputs: list[dict[str, Any]]


@dataclass
class PluginCasesConfig(Config):
    # The plugin's folder, and the agent task the cases are of.
    folder: str = MISSING
    task: str = MISSING
    # What a coding agent is told that the task's input does not say: its universe and data source.
    context: str = MISSING
    inputs: CaseInputs = MISSING


@dataclass
class BuildCasesConfig(Config):
    plugins: dict[Plugin, PluginCasesConfig] = MISSING
    # The coding agent's prompt, with {description}, {context}, {arguments}, {input_schema} and
    # {output_schema} filled in for each case.
    prompt: str = MISSING
    # Seconds the reference tool may take per case.
    timeout: float = MISSING


@dataclass
class Case(Output):
    id: str
    plugin: str
    task: str
    arguments: dict[str, Any]
    prompt: str
    # The reference tool's output, the right answer; null when the reference tool refused the input.
    reference: dict[str, Any] | None
    # Why the reference tool refused the input, which every agent should refuse too; else null.
    refusal: str | None


@dataclass
class Cases(Output):
    cases: list[Case]


@dataclass
class CasesLayout(Layout):
    cases: Cases


async def pin(manifest, task, arguments: dict[str, Any], timeout: float) -> tuple[dict[str, Any] | None, str | None]:
    """The reference tool's output for ``arguments``, or why it refused them."""
    with tempfile.TemporaryDirectory() as scratch:
        try:
            output = await call_tool_async(manifest, task.reference, arguments, workspace=Path(scratch), timeout=timeout)
        except RuntimeError as error:
            # Only the tool's own refusal makes a case to refuse; anything else fails the run.
            if f"{manifest.id} {task.reference} failed:" not in str(error):
                raise
            return None, str(error)
    return output, None


class BuildCases(Run):
    """Pin every case's right answer and write each coding agent's prompt."""

    config: BuildCasesConfig
    layout: CasesLayout

    def main(self) -> None:
        cases = []
        for name, plugin in self.config.plugins.items():
            manifest = load_manifest(plugin.folder)
            task = manifest.task(plugin.task)
            for index, arguments in enumerate(plugin.inputs.inputs, start=1):
                reference, refusal = asyncio.run(pin(manifest, task, arguments, self.config.timeout))
                prompt = self.config.prompt.format(
                    description=task.description,
                    context=plugin.context.strip(),
                    arguments=json.dumps(arguments, indent=2),
                    input_schema=json.dumps(output_schema(task.input_type), indent=2),
                    output_schema=json.dumps(output_schema(task.output_type), indent=2),
                )
                case = Case(
                    id=f"{name.value}-{index:02d}",
                    plugin=plugin.folder,
                    task=task.id,
                    arguments=arguments,
                    prompt=prompt,
                    reference=reference,
                    refusal=refusal,
                )
                print(f"{case.id}: {json.dumps(arguments)} → {'refuse: ' + refusal if refusal else 'pinned'}")
                cases.append(case)
        self.layout.cases = Cases(cases=cases)


if __name__ == "__main__":
    BuildCases().run()
