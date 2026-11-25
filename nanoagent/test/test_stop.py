"""The stop rule (nanoagent.core.stop): the run ends once the call that delivers the answer succeeded."""

from __future__ import annotations

import asyncio
import json

import pytest

from nanoagent.core import workspace
from nanoagent.core.agent import Agent, Reply, ToolCall
from nanoagent.core.stop import stop_rule
from nanoagent.tools.file import Write


def row(name: str, is_error: bool = False, **arguments) -> dict:
    return {"name": name, "arguments": arguments, "is_error": is_error}


def test_specs_parse_from_a_list_or_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    assert stop_rule(["submit", " write:answer.json ", ""]).specs == (("submit", None), ("write", "answer.json"))
    monkeypatch.setenv("NANOAGENT_STOP_AFTER", "edit:answer.json")
    assert stop_rule(None).specs == (("edit", "answer.json"),)
    monkeypatch.delenv("NANOAGENT_STOP_AFTER")
    assert not stop_rule(None) and not stop_rule([])


@pytest.mark.parametrize(
    ("call", "ends"),
    [
        (row("write", path="answer.json", content='{"mrr": 0.75}'), True),
        (row("write", path="./sub/answer.json", content='{"a": 1}'), True),
        (row("write", path="answer.json", content="not json yet"), False),  # a half-written answer never ends the run
        (row("write", path="answer.json", content="[1, 2]"), False),
        (row("write", path="notes.json", content='{"a": 1}'), False),
        (row("write", is_error=True, path="answer.json", content='{"a": 1}'), False),
        (row("edit", path="answer.json", old="null", new="0.75"), True),
        (row("read", path="answer.json"), False),
        (row("submit"), True),
    ],
)
def test_which_calls_deliver_the_answer(call: dict, ends: bool) -> None:
    assert stop_rule(["submit", "write:answer.json", "edit:answer.json"]).ends_run(call) is ends


class Answerer:
    """Writes a draft, then answer.json, then would close with a chat message (the turn the rule saves)."""

    def __init__(self) -> None:
        self.calls = 0

    async def query(self, messages, tools, **_):
        self.calls += 1
        files = {1: ("notes.txt", "draft"), 2: ("answer.json", json.dumps({"mrr": 0.75}))}
        if self.calls in files:
            path, content = files[self.calls]
            return Reply(content=None, tool_calls=[ToolCall(f"w{self.calls}", "write", json.dumps({"path": path, "content": content}))])
        return Reply(content="Done: answer.json is filled in.")


@pytest.mark.parametrize(("stop_after", "calls"), [([], 3), (["write:answer.json"], 2)])
def test_the_loop_ends_after_answer_json_is_written(stop_after, calls, tmp_path) -> None:
    model = Answerer()
    with workspace.use(tmp_path):
        result = asyncio.run(Agent(model, [Write()], system_prompt="s", max_steps=6, stop_after=stop_after).run("go"))
    assert model.calls == calls and result.stop_reason == "answer"
    assert json.loads((tmp_path / "answer.json").read_text()) == {"mrr": 0.75}
