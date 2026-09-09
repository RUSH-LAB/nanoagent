"""Offline tests for :mod:`nanoagent.tools.write` — the agent writing and using its own tools.

Three properties, in the order they matter:

* **same-run availability** — a tool written on step 1 is callable on step 2. If registration
  only took effect at the next startup the feature would be nearly useless, and a test that
  merely checked the files exist would not notice.
* **failure leaves nothing behind** — a module that will not import, and a tool whose NAME
  collides with an existing one, both come back as an error AND leave ``tools_dir`` clean. The
  collision case is the one with teeth: leaving the files there would make the NEXT startup's
  glob fail ``build_tool_map`` and brick the config.
* **persistence is free** — a second :func:`build_prompt_and_tools` over the same ``tools_dir``
  picks the tool up from disk, with no model call at all.

Fully offline: scripted in-process model, tmp_path, no server or network.

Run (from the repo root)::

    python3 -m pytest tests/tools/test_write.py -x -q
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.runtime.build import build_prompt_and_tools
from nanoagent.runtime.config import AgentConfig
from nanoagent.tools.write import WriteTool
from nanoagent.core.tool import JsonSchema, Tool

_ADD_TWO = '''
from nanoagent.core.tool import Tool


class AddTwo(Tool):
    """Add two numbers."""

    NAME = "add_two"
    PARAMETERS = {
        "type": "object",
        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        "required": ["a", "b"],
    }

    def run(self, a: float, b: float) -> str:
        return str(a + b)
'''


class _WritesThenCallsIt:
    """Turn 1 writes ``add_two``; turn 2 calls it; turn 3 answers with what it got back."""

    async def query(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], **_: Any
    ) -> Reply:
        done = sum(1 for m in messages if m.get("role") == "assistant")
        if done == 0:
            args = json.dumps({"name": "add_two", "code": _ADD_TWO})
            return Reply(content=None, tool_calls=[ToolCall("c1", "write_tool", args)])
        if done == 1:
            # Pins same-run availability: this name did not exist when the run started.
            assert any(t["function"]["name"] == "add_two" for t in tools)
            return Reply(
                content=None,
                tool_calls=[ToolCall("c2", "add_two", '{"a": 1, "b": 3}')],
            )
        return Reply(content=messages[-1]["content"])


def _cfg(**kwargs: object) -> AgentConfig:
    base = {
        "system_prompt": "BASE",
        "max_steps": 5,
        "cost_limit": None,
        "token_limit": None,
        "context_window": None,
        "hooks": [],
        "skills": None,
        "context_files": [],
        "events": None,
    }
    return AgentConfig(**{**base, **kwargs})  # type: ignore[arg-type]


async def test_a_tool_written_this_run_is_callable_the_next_turn(tmp_path: Path) -> None:
    agent = Agent(_WritesThenCallsIt(), [WriteTool(str(tmp_path))], system_prompt="SYS", max_steps=5)
    result = await agent.run("write yourself an adder and use it")
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "4"
    assert (tmp_path / "add_two.py").is_file() and (tmp_path / "add_two.yaml").is_file()


async def test_a_broken_module_errors_and_leaves_nothing_behind(tmp_path: Path) -> None:
    agent = Agent(_WritesThenCallsIt(), [WriteTool(str(tmp_path))], system_prompt="SYS", max_steps=5)
    tool = agent._tools["write_tool"]
    text, is_error = await tool.invoke(name="broken", code="def run(:\n")
    assert is_error and "failed to import tool module" in text
    assert list(tmp_path.iterdir()) == []  # rolled back, so the next startup glob is clean
    assert "broken" not in agent._tools


async def test_a_colliding_name_is_refused_and_rolled_back(tmp_path: Path) -> None:
    class _Existing(Tool):
        """Already here."""

        NAME = "add_two"
        PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    agent = Agent(
        _WritesThenCallsIt(),
        [WriteTool(str(tmp_path)), _Existing()],
        system_prompt="SYS",
        max_steps=5,
    )
    text, is_error = await agent._tools["write_tool"].invoke(name="add_two", code=_ADD_TWO)
    assert is_error and "duplicate tool name" in text
    # The files must NOT survive: globbed at the next startup they would fail build_tool_map.
    # A __pycache__ the (successful) import left behind may — it is not what that glob picks up,
    # the success path leaves one too, and whether it exists at all depends on
    # $PYTHONDONTWRITEBYTECODE. Only the source files are the contract.
    assert [p.name for p in tmp_path.iterdir() if p.name != "__pycache__"] == []
    assert agent._tools["add_two"] is not None


def test_a_previously_written_tool_is_loaded_at_startup(tmp_path: Path) -> None:
    (tmp_path / "add_two.py").write_text(_ADD_TWO)
    (tmp_path / "add_two.yaml").write_text(f"code: {tmp_path / 'add_two.py'}\n")
    _prompt, tools = build_prompt_and_tools(_cfg(), [], str(tmp_path))
    assert sorted(t.name for t in tools) == ["add_two", "write_tool"]


def test_no_tools_dir_means_the_agent_cannot_extend_itself() -> None:
    _prompt, tools = build_prompt_and_tools(_cfg(), [], None)
    assert tools == []


def test_the_name_must_be_a_usable_module_stem(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="lower_snake_case"):
        WriteTool(str(tmp_path)).run("../escape", _ADD_TWO)
    assert not tmp_path.exists() or list(tmp_path.iterdir()) == []
