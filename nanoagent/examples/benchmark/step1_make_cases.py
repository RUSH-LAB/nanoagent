"""Step 1: make the benchmark's cases, one per plugin. A plugin is benchmarked by one task of its
latest version: its first agent task whose reference tool is set, else its first decide task, else its
first agent task without a reference, else its first tool task. For every plugin without a cases file
yet, a model proposes one input to answer and the `context` a coding agent without the plugin's tools
needs; code decides whether it is kept. Plugins with no such task are listed, not worked.

The plugin is unpacked from its package in the local RUSH database and readied as the benchmark's
step 2 does (its `unpack`, `prepared_plugin`). The model sees the task's manifest entry, schemas,
instructions, README and the plugin's source. Its proposal is kept only when the input builds as the
task's input type and, for a task a tool pins (`reference_tool`), that tool answers it, pinned exactly
as the benchmark's step 2 pins it (its `pin`). For an agent task no tool pins, the model also proposes
an answer, and the case is kept only when the plugin's verifier accepts that answer and rejects a copy
of it code made wrong. Otherwise the error goes back to the model, up to `attempts` proposals; a task
with none kept, or a plugin that cannot be readied, is marked as having a bug in the bugs file
(examples/benchmark/configs/plugin_bugs.json) with its reason, and never tried again. A kept case is written as the benchmark's
cases file, examples/benchmark/configs/step1_<plugin>_cases.json: `answer` holds the one case and
`refuse` is empty. At most `workers` tasks are worked at once, as the plugins' data sources and the
model's API rate-limit."""

import asyncio
import json
import os
import re
import subprocess
import tempfile
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from openai import OpenAI
from slimconfig import Config, Layout, Output, Run, build_output, load_output, output_schema, write_output

from step2_single_run import Cases, isolate, logged, pin, prepared_plugin, reference_tool, unpack

from nanoagent.plugin import load_manifest
from nanoagent.plugin.python import PluginPython
from nanoagent.plugin.verifier import verify_task

# Every plugin's latest version, one tab-separated line: the plugin, the task it is benchmarked by
# (empty when it has none: the first agent task whose reference is set, else its first decide task,
# else its first agent task without a reference, else its first tool task), and all its tasks as
# task:runner, with :no-reference for an agent task whose reference is null.
PLUGINS_QUERY = """select p.id,
  coalesce((select t->>'id' from jsonb_array_elements(v.entry->'tasks') with ordinality as x(t, n)
            where t->>'runner' in ('agent', 'decide', 'tool')
            order by case when t->>'runner' = 'agent' and t->>'reference' is not null then 0
                          when t->>'runner' = 'decide' then 1 when t->>'runner' = 'agent' then 2 else 3 end, n
            limit 1), ''),
  coalesce((select string_agg(concat(t->>'id', ':', t->>'runner',
                    case when t->>'runner' = 'agent' and t->>'reference' is null then ':no-reference' end), ' ' order by n)
            from jsonb_array_elements(v.entry->'tasks') with ordinality as x(t, n)), '')
from market_plugin p join market_plugin_version v on v.plugin_id = p.id and v.version = p.version
order by p.id"""

# The plugin's files the model reads, by suffix, and what it never reads.
SOURCE_SUFFIXES = {".py", ".md", ".yaml", ".yml", ".json", ".toml", ".txt", ".csv"}
NOT_SOURCE = {"uv.lock", ".env", "LICENSE"}


@dataclass
class MakeCasesConfig(Config):
    # The local RUSH database (read only), and the psql that reads its marketplace.
    database: str = MISSING
    psql: str = MISSING
    # Where the benchmark's cases files live: a plugin with one there already is skipped.
    cases_dir: str = MISSING
    # The plugins marked as having a bug (PluginBugs): skipped, and every plugin that fails is added.
    bugs: str = MISSING
    # The plugins to work, or null for every plugin.
    only: list[str] | None = MISSING
    # The proposing model, on OpenRouter, and its price per million tokens (input, output).
    model: str = MISSING
    input_price: float = MISSING
    output_price: float = MISSING
    # The model's reply budget and how long a call may take.
    max_tokens: int = MISSING
    read_timeout: float = MISSING
    # OpenRouter's reasoning effort for the model (low, medium, high), or null for the model's own.
    reasoning_effort: str | None = MISSING
    # Proposals per task, tasks worked at once, and seconds the reference tool may take.
    attempts: int = MISSING
    workers: int = MISSING
    timeout: float = MISSING
    # Characters of each plugin file, and of all of them, the model reads.
    file_chars: int = MISSING
    source_chars: int = MISSING
    # The model's instructions, with {today} filled in, and its request, with the task filled in and
    # {pinning}: pinned_by, with the tool that pins the answer, or unpinned, for a task no tool pins.
    system_prompt: str = MISSING
    prompt: str = MISSING
    pinned_by: str = MISSING
    unpinned: str = MISSING


@dataclass
class MadeCases(Output):
    """Every plugin's task tried: its cases file, or why none was made; and what the model cost."""

    model: str
    tried: int
    made: int
    not_made: int
    # Plugins that already had a cases file, or were marked as having a bug.
    skipped: list[str]
    # Plugins with no task to benchmark, each with its tasks as task:runner.
    left_out: list[str]
    # Each task tried: plugin, task, attempts, and its cases file or the reason it has none.
    tasks: list[dict[str, Any]]
    input_tokens: int
    output_tokens: int
    cost: float


@dataclass
class PluginBugs(Output):
    """The plugins marked as having a bug: each failed once (could not be readied, or no proposal was
    kept), with its task and why, and is never tried again."""

    plugins: list[dict[str, str]]


@dataclass
class MakeCasesLayout(Layout):
    result: MadeCases


class Bugs:
    """The bugs file, a plugin added and written back as soon as it fails."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.plugins = load_output(str(path), PluginBugs).plugins

    def add(self, plugin: str, task: str, reason: str) -> None:
        with self.lock:
            self.plugins.append({"plugin": plugin, "task": task, "reason": reason})
            write_output(str(self.path), PluginBugs(plugins=self.plugins))


class Spend:
    """The model's tokens and cost over every call, from every worker."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost = 0.0

    def add(self, usage: Any, config: MakeCasesConfig) -> None:
        with self.lock:
            self.input_tokens += usage.prompt_tokens
            self.output_tokens += usage.completion_tokens
            self.cost += (usage.prompt_tokens * config.input_price + usage.completion_tokens * config.output_price) / 1e6


def existing_cases(folder: Path) -> dict[str, Cases]:
    """The cases files in ``folder``, by the plugin each holds; a plugin has one at most."""
    found: dict[str, Cases] = {}
    for path in sorted(folder.glob("step1_*_cases.json")):
        cases = load_output(str(path), Cases)
        if cases.plugin in found:
            raise RuntimeError(f"{cases.plugin} has two cases files, {path.name} and another: a plugin has one")
        found[cases.plugin] = cases
    return found


def source_text(root: Path, config: MakeCasesConfig) -> str:
    """The plugin's files for the model: manifest, README and contract first, then the rest, each
    file and the whole cut to the config's lengths."""
    first = [root / "nanoagent.yaml", root / "README.md", root / "contract.py"]
    rest = sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path not in first
        and path.suffix in SOURCE_SUFFIXES
        and path.name not in NOT_SOURCE
        and not any(part.startswith(".") or part in {"ui", "product"} for part in path.relative_to(root).parts[:-1])
    )
    # Tests come last: they show rules, but the tools and their data matter more.
    rest.sort(key=lambda path: path.relative_to(root).parts[0] == "tests")
    parts, total = [], 0
    for path in [path for path in first if path.is_file()] + rest:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if len(text) > config.file_chars:
            text = text[: config.file_chars] + f"\n... ({len(text) - config.file_chars} more characters cut)"
        block = f"=== {path.relative_to(root)} ===\n{text}\n"
        if total + len(block) > config.source_chars:
            parts.append(f"=== {path.relative_to(root)} (left out: the source budget is spent) ===\n")
            continue
        parts.append(block)
        total += len(block)
    return "".join(parts)


def proposal(text: str, keys: set[str]) -> dict[str, Any]:
    """The model's reply, one JSON object (maybe in a code fence) with exactly ``keys``: a nonempty
    context, and an input (and an answer) as JSON objects."""
    fenced = re.fullmatch(r"\s*```(?:json)?\s*(.*?)\s*```\s*", text, re.S)
    value = json.loads(fenced.group(1) if fenced else text)
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(f"the reply must be one JSON object with exactly the keys {sorted(keys)}")
    for key in keys - {"context"}:
        if not isinstance(value[key], dict):
            raise ValueError(f'"{key}" must be a JSON object')
    if not isinstance(value["context"], str) or not value["context"].strip():
        raise ValueError('"context" must be a nonempty string')
    return value | {"context": value["context"].strip()}


def mutations(value: Any) -> Iterator[Any]:
    """Copies of ``value`` each with one leaf made wrong, in order: a number plus one, a string with
    a suffix, a boolean flipped, a nonempty list without its last item."""
    if isinstance(value, bool):
        yield not value
    elif isinstance(value, int | float):
        yield value + 1
    elif isinstance(value, str):
        yield value + " (wrong)"
    elif isinstance(value, list):
        if value:
            yield value[:-1]
        for index, item in enumerate(value):
            for wrong in mutations(item):
                yield [*value[:index], wrong, *value[index + 1 :]]
    elif isinstance(value, dict):
        for key, item in value.items():
            for wrong in mutations(item):
                yield value | {key: wrong}


def check_unpinned(manifest, task, arguments: dict[str, Any], answer: dict[str, Any]) -> str:
    """For a task no tool pins: the verifier must accept the proposed answer and reject a copy of it
    made wrong by code (the first that is still a valid output it rejects); what was rejected."""
    build_output(answer, task.output_type)
    with tempfile.TemporaryDirectory() as scratch:
        verdict = verify_task(manifest, task.id, arguments, answer, None, Path(scratch))
        if not verdict.valid:
            raise ValueError(f"the verifier rejected the proposed answer: {verdict.message}")
        for wrong in mutations(answer):
            try:
                build_output(wrong, task.output_type)
            except (TypeError, ValueError):
                continue
            verdict = verify_task(manifest, task.id, arguments, wrong, None, Path(scratch))
            if not verdict.valid:
                return f"accepted the answer and rejected a wrong copy ({verdict.message})"
    raise ValueError("the verifier accepted every wrong copy of the proposed answer, so it cannot tell a wrong answer here")


def make_case(
    config: MakeCasesConfig, python: PluginPython, client: OpenAI, spend: Spend, bugs: Bugs, plugin: str, task_id: str, path: Path
) -> dict[str, Any]:
    """Propose and check one task's case; write its cases file when one is kept."""
    record: dict[str, Any] = {"plugin": plugin, "task": task_id, "attempts": 0}
    with tempfile.TemporaryDirectory(prefix="benchmark-cases-") as unpacked:
        try:
            unpack(config.database, config.psql, plugin, Path(unpacked))
            with prepared_plugin(Path(unpacked, plugin), python) as folder:
                manifest = load_manifest(folder)
                task = manifest.task(task_id)
                tool = reference_tool(task)
                if tool is None:
                    keys, pinning = {"context", "input", "answer"}, config.unpinned
                else:
                    keys, pinning = {"context", "input"}, config.pinned_by.format(tool=tool, description=manifest.tool(tool).description)
                messages = [
                    {"role": "system", "content": config.system_prompt.format(today=today())},
                    {
                        "role": "user",
                        "content": config.prompt.format(
                            plugin=plugin,
                            task=task.id,
                            description=task.description,
                            instructions=task.instructions,
                            input_schema=json.dumps(output_schema(task.input_type), indent=2),
                            output_schema=json.dumps(output_schema(task.output_type), indent=2),
                            runner=task.runner,
                            pinning=pinning,
                            source=source_text(folder, config),
                        ),
                    },
                ]
                error = None
                for attempt in range(1, config.attempts + 1):
                    record["attempts"] = attempt
                    reply = client.chat.completions.create(
                        model=config.model,
                        messages=messages,
                        max_tokens=config.max_tokens,
                        extra_body={} if config.reasoning_effort is None else {"reasoning": {"effort": config.reasoning_effort}},
                    )
                    spend.add(reply.usage, config)
                    choice = reply.choices[0]
                    text = choice.message.content or ""
                    messages.append({"role": "assistant", "content": text})
                    try:
                        if not text.strip():
                            raise ValueError(f"the reply was empty (finish reason {choice.finish_reason}): think less, then reply")
                        value = proposal(text, keys)
                        arguments, context = value["input"], value["context"]
                        build_output(arguments, task.input_type)
                        if tool is None:
                            record["check"] = check_unpinned(manifest, task, arguments, value["answer"])
                        else:
                            asyncio.run(pin(manifest, tool, arguments, False, config.timeout))
                    except (ValueError, TypeError, RuntimeError, TimeoutError) as failure:
                        error = f"{type(failure).__name__}: {failure}"
                        print(f"{plugin} · {task_id}: proposal {attempt} rejected: {error[:300]}", flush=True)
                        messages.append(
                            {"role": "user", "content": f"That proposal was rejected:\n{error[:4000]}\n\nPropose again, the same JSON object."}
                        )
                        continue
                    write_output(str(path), Cases(plugin=plugin, task=task.id, context=context, answer=[arguments], refuse=[]))
                    record["file"] = str(path)
                    print(f"{plugin} · {task_id}: made {path.name} on proposal {attempt}", flush=True)
                    return record
                record["reason"] = f"no proposal of {config.attempts} was kept; the last: {error}"
        except (subprocess.SubprocessError, RuntimeError, ValueError, OSError) as failure:
            # The plugin could not be unpacked or readied, or its task cannot be pinned: no proposal can be checked.
            record["reason"] = f"the plugin or its task could not be readied: {type(failure).__name__}: {failure}"
    bugs.add(plugin, task_id, record["reason"])
    print(f"{plugin} · {task_id}: not made, marked as having a bug: {record['reason'][:300]}", flush=True)
    return record


def today() -> str:
    return subprocess.check_output(["date", "-u", "+%Y-%m-%d"], text=True).strip()


class CaseMaker(Run):
    """Make one case for every benchmarked plugin without a cases file."""

    config: MakeCasesConfig
    layout: MakeCasesLayout

    def main(self) -> int:
        with logged():
            return self.work()

    def work(self) -> int:
        config = self.config
        if "OPENROUTER_API_KEY" not in os.environ:
            raise RuntimeError("OPENROUTER_API_KEY is not set: the run script reads it from the repository's .env")
        found = subprocess.run(
            [config.psql, config.database, "--no-psqlrc", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1"],
            input=PLUGINS_QUERY,
            capture_output=True,
            text=True,
        )
        if found.returncode != 0:
            raise RuntimeError(f"psql could not read the marketplace's plugins from {config.database}: {found.stderr.strip()}")
        rows = [line.split("\t") for line in found.stdout.splitlines() if line]
        left_out = [f"{plugin} ({tasks or 'no tasks'})" for plugin, task, tasks in rows if not task]
        benchmarked = [(plugin, task) for plugin, task, _ in rows if task]
        folder = Path(config.cases_dir)
        existing = existing_cases(folder)
        for plugin, task in benchmarked:
            if plugin in existing and existing[plugin].task != task:
                raise RuntimeError(f"{plugin}'s cases file holds {existing[plugin].task}, not the task it is benchmarked by, {task}")
        bugs = Bugs(Path(config.bugs))
        buggy = {bug["plugin"] for bug in bugs.plugins}
        skipped = [plugin for plugin, _ in benchmarked if plugin in existing or plugin in buggy]
        todo = [(p, t) for p, t in benchmarked if p not in skipped and (config.only is None or p in config.only)]
        paths = {(p, t): folder / f"step1_{p.replace('-', '_')}_cases.json" for p, t in todo}
        taken = [path.name for path in paths.values() if path.exists()]
        if taken:
            raise RuntimeError(f"cases files of other plugins already have the names {taken}")
        print(
            f"{len(rows)} plugins; {len(benchmarked)} with a task to benchmark, {len(left_out)} without;"
            f" {len(existing)} have cases files, {len(buggy)} are marked as having a bug; {len(todo)} to make",
            flush=True,
        )
        python = isolate()
        client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"], timeout=config.read_timeout, max_retries=2)
        spend = Spend()
        with ThreadPoolExecutor(max_workers=config.workers) as pool:
            records = list(pool.map(lambda item: make_case(config, python, client, spend, bugs, *item, paths[item]), todo))
        made = sum(1 for record in records if "file" in record)
        self.layout.result = MadeCases(
            model=config.model,
            tried=len(records),
            made=made,
            not_made=len(records) - made,
            skipped=skipped,
            left_out=left_out,
            tasks=records,
            input_tokens=spend.input_tokens,
            output_tokens=spend.output_tokens,
            cost=spend.cost,
        )
        print(
            f"tried {len(records)} · made {made} · not made {len(records) - made}"
            f" · {spend.input_tokens:,} in / {spend.output_tokens:,} out · ${spend.cost:.4f}"
        )
        return 0


if __name__ == "__main__":
    CaseMaker().run()
