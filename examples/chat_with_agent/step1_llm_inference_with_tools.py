from dataclasses import dataclass, field
from pathlib import Path

from omegaconf import MISSING
from slimconfig import Config, Run

from nanoagent.harness import ChatLayout, Conversation, HarnessProfile, Turn
from nanoagent.harness.nanoagent import NanoAgentConfig, NanoAgentRunner
from nanoagent.llm.bedrock import BedrockConfig
from nanoagent.runtime.config import (
    AgentDefinitionConfig,
)


@dataclass
class PromptConfig(Config):
    system_prompt: str = MISSING
    user_prompt: str = MISSING


@dataclass
class TaskConfig(Config):
    prompt: PromptConfig = field(default_factory=PromptConfig)


@dataclass
class ChatConfig(Config):
    """The independent model, harness, toolbox, agent policy, and task."""

    llm: BedrockConfig = field(default_factory=BedrockConfig)
    harness: NanoAgentConfig = field(default_factory=NanoAgentConfig)
    toolbox: list[str] = MISSING
    task: TaskConfig = field(default_factory=TaskConfig)


def build(config: ChatConfig, workspace: Path) -> Conversation:
    definition = AgentDefinitionConfig(
        model=config.llm.runtime(),
        agent=config.harness.runtime(system_prompt=config.task.prompt.system_prompt),
        tools=config.toolbox,
        tools_dir=None,
        allowed_tools=None,
    )
    runner = NanoAgentRunner(definition)
    profile = HarnessProfile(
        id="nanoagent",
        label=f"NanoAgent · {config.llm.model}",
        harness="nanoagent",
        model=config.llm.model,
        runner=runner,
    )
    return Conversation.start(
        profile,
        instructions="",
        system_prompt=config.task.prompt.system_prompt,
        workspace=workspace,
        render=False,
    )


def show(turn: Turn) -> None:
    for event in turn.events:
        if event.get("type") == "tool":
            print(f"  tool: {event['name']}({event['arguments']})")
    if turn.answer:
        print(f"agent: {turn.answer}")


class Chat(Run):
    """One configured message answered by one composed NanoAgent harness."""

    config: ChatConfig
    layout: ChatLayout

    def main(self) -> None:
        prompt = self.config.task.prompt
        with build(self.config, self.layout.workspace) as chat:
            print(f"user: {prompt.user_prompt}")
            show(chat.send(prompt.user_prompt))
            self.layout.messages = chat.trajectory()


if __name__ == "__main__":
    Chat().run()
