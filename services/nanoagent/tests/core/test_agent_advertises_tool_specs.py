"""Offline test: ``Agent.run`` ADVERTISES each tool's OpenAI function spec to the model.

This pins the request-OUT half of the proxy seam — nanoagent transparently proxies the
agent's LLM calls: when :meth:`nanoagent.core.agent.Agent.run` calls its chat model it
hands the model every registered tool as that tool's :meth:`~nanoagent.core.tool.Tool.to_openai_spec`
output. :class:`~nanoagent.core.agent.Agent` builds ``self._tool_specs = [t.to_openai_spec() for t in
tools]`` once at construction and passes it as the ``tools`` argument of every
``self._model.query(messages, self._tool_specs)`` call (``agent.py``).

No existing nanoagent test captures the ``tools`` argument handed to ``ChatModel.query`` and
asserts its content: ``test_tool*.py`` pin ``Tool.to_openai_spec()`` standalone,
and ``test_context.py``'s mock records query *messages* but never the ``tools`` arg. This is
the request-OUT complement to the capture-BACK trajectory tests.

A scripted :class:`~nanoagent.core.agent.ChatModel` (``_RecordToolsModel``) records the tool-specs
argument of every ``query`` call into ``seen_tools`` and answers on turn 1 with no tool call, so
the real ``Agent.run`` terminates cleanly (``StopReason.ANSWER``) after exactly one query. A
distinctive pure-Python :class:`~nanoagent.core.tool.Tool` (``lookup_widget`` — a docstring
description plus a non-trivial parameters schema with a property and a required list) is the one
registered tool, so the recorded specs can be compared exact-dict against a fresh
``to_openai_spec()`` and field-by-field against literal expected content.

Non-vacuity: changing ``agent.py``'s ``query(messages, self._tool_specs)`` to
``query(messages, [])`` (or emptying ``self._tool_specs``) makes the exact-spec assertion fail.

Fully offline: an in-process scripted model + a pure-Python tool — no openai / inference stack /
network / server / GPU / native extension, and no disk. The ``on_delta`` keyword mirrors the one
the real model backend accepts; the agent loop itself queries positionally.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_advertises_tool_specs.py -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason
from nanoagent.core.tool import JsonSchema, Tool


class _LookupWidgetTool(Tool):
    """Look up a widget in the catalog by its id and return its spec."""

    NAME = "lookup_widget"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {
            "widget_id": {
                "type": "string",
                "description": "the catalog id of the widget to look up",
            },
        },
        "required": ["widget_id"],
    }

    def run(self, widget_id: str) -> str:
        return f"widget {widget_id}"


class _RecordToolsModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that records every query's ``tools`` arg.

    Each ``query`` appends the tool-specs argument it received to ``seen_tools`` and returns a
    final answer with NO tool call, so the real :meth:`Agent.run` ends on the first turn with
    ``StopReason.ANSWER`` after exactly one query. No model server is contacted; ``on_delta``
    mirrors the keyword the real model backend accepts (the agent loop queries positionally).
    """

    def __init__(self) -> None:
        self.seen_tools: list[list[dict[str, Any]]] = []

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.seen_tools.append(tools)
        return Reply(content="DONE")


async def test_agent_run_advertises_each_tool_openai_spec() -> None:
    # Drive the REAL agent loop with one distinctive tool. The model answers immediately, so the
    # loop makes exactly one query — and that query must carry the tool's OpenAI function spec.
    tool = _LookupWidgetTool()
    model = _RecordToolsModel()
    result = await Agent(model, [tool], system_prompt="SYS").run("look it up")

    # (1) The run ended on the model's tool-call-free reply -> a clean ANSWER.
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"

    # (2) Exactly one query was issued (the model answered on turn 1).
    assert len(model.seen_tools) == 1

    # (3) That query advertised exactly the tool's OpenAI spec. Build the expected from a FRESH
    # to_openai_spec() (a new instance, not the registered one) so the assertion pins serialized
    # CONTENT, not object identity, and never drifts from a hand-copied dict.
    assert model.seen_tools[0] == [_LookupWidgetTool().to_openai_spec()]

    # (4) Pin the advertised CONTENT against the tool's identity with literals. (3) compares
    # against a fresh render of the SAME class, so a silent change to NAME/docstring/PARAMETERS
    # would move both sides together and slip past it; these literal checks would catch that. The
    # parameters literal intentionally duplicates the class's PARAMETERS as an independent pin of
    # the on-the-wire schema.
    advertised = model.seen_tools[0]
    assert len(advertised) == 1
    spec = advertised[0]
    assert spec["type"] == "function"
    function = spec["function"]
    assert function["name"] == "lookup_widget"
    assert function["description"] == "Look up a widget in the catalog by its id and return its spec."
    assert function["parameters"] == {
        "type": "object",
        "properties": {
            "widget_id": {
                "type": "string",
                "description": "the catalog id of the widget to look up",
            },
        },
        "required": ["widget_id"],
    }
