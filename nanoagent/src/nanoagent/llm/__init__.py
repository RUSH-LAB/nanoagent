"""Concrete LLM configurations for NanoAgent compositions."""

from nanoagent.llm.bedrock import BedrockConfig
from nanoagent.llm.openrouter import OpenRouterConfig
from nanoagent.llm.sglang import SGLangConfig

__all__ = ["BedrockConfig", "OpenRouterConfig", "SGLangConfig"]
