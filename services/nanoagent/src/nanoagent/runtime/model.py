"""The chat model the agent loop talks to — a thin adapter over :mod:`nanoagent.inference`.

:class:`Model` is the single public backend (a :class:`~nanoagent.core.agent.ChatModel`): the
agent loop and interactive session only ever see
``Model.query(messages, tools, *, on_delta=None) -> Reply`` and never import a provider SDK.
It owns no transport of its own — all inference (tool-schema encoding, streaming, retry, the
transports themselves) lives in :mod:`nanoagent.inference`, and this module is the ONE place the
loop side reaches into it. :class:`Model` just:

  1. translates the loop's :class:`~nanoagent.runtime.config.ModelConfig` into a
     :class:`~nanoagent.inference.config.LeanInferConfig` (carrying the fields by name),
  2. builds the matching backend via :func:`nanoagent.inference.backends.build_backend`, and
  3. maps each :class:`~nanoagent.inference.types.Response` onto the loop's
     :class:`~nanoagent.core.agent.Reply` (text + tool calls + usage + cost + reasoning).

``ModelConfig.backend`` names the transport and is passed through verbatim, to be resolved
against the built-ins (``"sglang"``, the OpenAI SDK against an SGLang ``/v1`` endpoint) and then
against the plugin directories in ``$NANOAGENT_PLUGINS`` — which is how ``backend: mygateway``
finds ``mygateway.py`` in a directory the package does not ship. There is deliberately no
allowlist here: it would have to be edited for every new plugin, and
:mod:`nanoagent.inference.plugins` already names the backends it did find and the directories it
searched when it rejects one. The transport module is imported only when the backend is built, so
constructing one never pulls in another's stack.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import fields
from typing import Any

from nanoagent.inference import LeanInferConfig
from nanoagent.inference.backend import Backend
from nanoagent.inference.backends import build_backend
from nanoagent.inference.types import Response
from nanoagent.core.agent import Reply, ToolCall
from nanoagent.runtime.config import ModelConfig


class Model:
    """Unified chat model: a thin adapter mapping the agent loop onto an inference backend.

    Holds a single long-lived backend across all turns (reusing one connection pool). Unlike
    :func:`nanoagent.inference.infer`, which closes the backend it builds, a :class:`Model` lives
    for the whole CLI/interactive session. Short-lived commands let process exit reclaim it;
    long-lived hosts call :meth:`aclose` during shutdown.
    """

    def __init__(self, backend: Backend) -> None:
        self._backend = backend

    @classmethod
    def from_config(cls, cfg: ModelConfig) -> Model:
        """Build a :class:`Model` by translating ``cfg`` into an inference backend.

        :class:`~nanoagent.runtime.config.ModelConfig`'s fields are a strict subset of
        :class:`LeanInferConfig`'s, with the same names and meanings — it is the same set of
        knobs re-declared as all-required, because a nanoagent config may not inherit a hidden
        default. So the translation is a field-name projection: adding a knob to ModelConfig
        carries it across automatically, and a name that has no LeanInferConfig counterpart
        fails loudly here instead of being silently dropped by a hand-written copy. Fields only
        LeanInferConfig has (parse_thinking, concurrency, retry backoff) keep their own defaults.
        """
        lean_cfg = LeanInferConfig(**{f.name: getattr(cfg, f.name) for f in fields(cfg)})
        return cls(build_backend(lean_cfg))

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> Reply:
        """Run one tool-calling turn through the backend and map the result to a :class:`Reply`.

        ``on_delta(kind, text)`` streams fragments as they arrive; the SGLang transport
        streams token by token.
        """
        response = await self._backend.generate(
            messages, tools=tools, on_delta=on_delta
        )
        return _to_reply(response)

    async def aclose(self) -> None:
        """Close the transport pool held by a long-lived host."""
        closer = getattr(self._backend, "aclose", None)
        if closer is not None:
            await closer()


def _to_reply(response: Response) -> Reply:
    """Map an inference :class:`~nanoagent.inference.types.Response` onto the loop's :class:`Reply`."""
    return Reply(
        content=response.text,
        tool_calls=[
            ToolCall(id=c.id, name=c.name, arguments=c.arguments)
            for c in response.tool_calls
        ],
        usage=response.usage,
        cost=response.cost,
        reasoning=response.reasoning,
    )
