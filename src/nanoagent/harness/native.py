"""NanoAgent's native agent-loop harness."""

from __future__ import annotations

from typing import Protocol

from nanoagent.core import workspace
from nanoagent.core.agent import Agent, AgentResult, StopReason
from nanoagent.harness.base import ProgressSink, RunnerCapabilities, RunnerRequest, RunnerResult
from nanoagent.runtime.build import build_agent
from nanoagent.runtime.config import AgentDefinitionConfig
from nanoagent.runtime.model import Model


class AgentFactory(Protocol):
    def __call__(self, instructions: str | None) -> tuple[Agent, str]: ...


class NativeRunner:
    """Run requests through NanoAgent's in-process agent loop."""

    name = "native"
    capabilities = RunnerCapabilities(
        streaming=True,
        reasoning=True,
        tools=True,
        usage=True,
        cancellation=True,
        history=True,
    )

    def __init__(
        self,
        cfg: AgentDefinitionConfig,
        *,
        agent_factory: AgentFactory | None = None,
    ) -> None:
        self._cfg = cfg
        self._model = None if agent_factory is not None else Model.from_config(cfg.model)
        self._factory = agent_factory or self._configured_agent

    def _configured_agent(self, instructions: str | None) -> tuple[Agent, str]:
        clean = instructions.strip() if instructions else ""
        suffix = f"Application instructions:\n{clean}" if clean else None
        agent = build_agent(self._cfg, model=self._model, prompt_suffix=suffix)
        return agent, agent.system_prompt

    async def run(self, request: RunnerRequest, emit: ProgressSink) -> RunnerResult:
        agent, system_prompt = self._factory(request.instructions)
        transcript = [
            {"role": "system", "content": system_prompt},
            *[dict(message) for message in request.messages],
        ]
        emitted_tools = 0
        terminal_snapshot: AgentResult | None = None

        def on_delta(kind: str, text: str) -> None:
            emit({"type": "delta", "kind": kind, "text": text})

        def on_step(result: AgentResult) -> None:
            nonlocal emitted_tools, terminal_snapshot
            for row in result.tool_calls[emitted_tools:]:
                emit({"type": "tool", **row})
            emitted_tools = len(result.tool_calls)
            if result.stop_reason is StopReason.RUNNING:
                emit(
                    {
                        "type": "step",
                        "step": result.steps,
                        "usage": result.usage,
                        "cost": result.cost,
                        "metrics": (
                            result.profile.steps[-1].to_dict()
                            if result.profile is not None and result.profile.steps
                            else None
                        ),
                    }
                )
            else:
                terminal_snapshot = result

        try:
            if request.workspace is None:
                result = await agent.run(
                    request.input,
                    messages=transcript,
                    on_delta=on_delta,
                    on_step=on_step,
                )
            else:
                with workspace.use(request.workspace):
                    result = await agent.run(
                        request.input,
                        messages=transcript,
                        on_delta=on_delta,
                        on_step=on_step,
                    )
        except Exception:
            if terminal_snapshot is None:
                raise
            result = terminal_snapshot
        return RunnerResult.from_agent_result(result)

    async def aclose(self) -> None:
        if self._model is not None:
            await self._model.aclose()

    def availability(self) -> tuple[bool, str | None]:
        return True, None

    @property
    def definition(self) -> AgentDefinitionConfig:
        """Resolved native definition, including profile model overrides."""
        return self._cfg


NativeHarness = NativeRunner

__all__ = ["AgentFactory", "NativeHarness", "NativeRunner"]
