"""Step 2: the cases every harness is run on. Each is one input of a plugin's agent task, its right
answer pinned once by the task's reference tool, and the prompt a coding agent is given for it.
The inputs say which cases are to answer and which to refuse (a day that is not over, before the
data's range). A case to answer is pinned only when the reference tool answers it, and a case to
refuse only when the reference tool refuses it; anything else (a data source that fails, a day that
has since passed) stops the step, naming why."""

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
    CITY_WEATHER = "city-weather"


@dataclass
class CaseInputs(Output):
    # Inputs of the plugin's task, as its contract's input class takes them: to answer, and to refuse.
    answer: list[dict[str, Any]]
    refuse: list[dict[str, Any]]


@dataclass
class PluginCasesConfig(Config):
    # The agent task the cases are of.
    task: str = MISSING
    # What a coding agent is told that the task's input does not say: its universe and data source.
    context: str = MISSING
    inputs: CaseInputs = MISSING
    # How many of the inputs to answer, and of those to refuse, from the first, are cases.
    answer: int = MISSING
    refuse: int = MISSING


@dataclass
class CasesConfig(Config):
    # Step 1's folder of unpacked plugins.
    plugins_folder: str = MISSING
    plugins: dict[Plugin, PluginCasesConfig] = MISSING
    # The coding agent's prompt, with {description}, {context}, {arguments}, {input_schema} and
    # {output_schema} filled in for each case.
    prompt: str = MISSING
    # Seconds the reference tool may take per case.
    timeout: float = MISSING


@dataclass
class Case(Output):
    id: str
    # The plugin's folder, and its agent task.
    plugin: str
    task: str
    arguments: dict[str, Any]
    prompt: str
    # The reference tool's output, the right answer; null when the reference tool refused the input.
    reference: dict[str, Any] | None
    # Why the reference tool refused the input, which every harness should refuse too; else null.
    refusal: str | None


@dataclass
class Cases(Output):
    cases: list[Case]


@dataclass
class CasesLayout(Layout):
    cases: Cases


async def pin(manifest, task, arguments: dict[str, Any], timeout: float, refuse: bool) -> tuple[dict[str, Any] | None, str | None]:
    """The reference tool's output for a case to answer, or why it refused a case to refuse."""
    with tempfile.TemporaryDirectory() as scratch:
        try:
            output = await call_tool_async(manifest, task.reference, arguments, workspace=Path(scratch), timeout=timeout)
        except RuntimeError as error:
            if refuse and f"{manifest.id} {task.reference} failed:" in str(error):
                return None, str(error)
            raise RuntimeError(f"{task.reference} could not answer {json.dumps(arguments)}, a case to answer: {error}") from error
    if refuse:
        raise RuntimeError(f"{task.reference} answered {json.dumps(arguments)}, a case to refuse")
    return output, None


class BuildCases(Run):
    """Pin every case's right answer and write each coding agent's prompt."""

    config: CasesConfig
    layout: CasesLayout

    def main(self) -> None:
        cases = []
        for name, plugin in self.config.plugins.items():
            folder = Path(self.config.plugins_folder, name.value).resolve()
            manifest = load_manifest(folder)
            task = manifest.task(plugin.task)
            chosen = []
            for kind, inputs, count in (("answer", plugin.inputs.answer, plugin.answer), ("refuse", plugin.inputs.refuse, plugin.refuse)):
                if not 0 <= count <= len(inputs):
                    raise ValueError(f"{name.value} has {len(inputs)} inputs to {kind}: {kind} must be 0 to {len(inputs)}, not {count}")
                chosen += [(arguments, kind == "refuse") for arguments in inputs[:count]]
            for index, (arguments, refuse) in enumerate(chosen, start=1):
                reference, refusal = asyncio.run(pin(manifest, task, arguments, self.config.timeout, refuse))
                prompt = self.config.prompt.format(
                    description=task.description,
                    context=plugin.context.strip(),
                    arguments=json.dumps(arguments, indent=2),
                    input_schema=json.dumps(output_schema(task.input_type), indent=2),
                    output_schema=json.dumps(output_schema(task.output_type), indent=2),
                )
                case = Case(
                    id=f"{name.value}-{index:02d}",
                    plugin=str(folder),
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
