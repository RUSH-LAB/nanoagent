"""A server of one's own: vLLM or SGLang, at its OpenAI-compatible ``/v1`` address."""

from dataclasses import dataclass

from omegaconf import MISSING
from slimconfig import Config

from nanoagent.inference.providers import SERVERS
from nanoagent.runtime.config import ModelConfig

# What a request to a server's model adds so that it does not think, as NanoAgent runs every app's
# model: a chat template that reads enable_thinking (Qwen3's, GLM's) thinks unless told not to,
# spending the output limit before it answers or decides, and any other template ignores it. A
# ModelConfig.extra_body token.
NO_THINKING = 'chat_template_kwargs={"enable_thinking": false}'


@dataclass
class ServerConfig(Config):
    # The engine the server runs: vllm or sglang (nanoagent.inference.providers.SERVERS).
    engine: str = MISSING
    model: str = MISSING
    # Its /v1 address; null reads the engine's VLLM_BASE_URL or SGLANG_BASE_URL.
    base_url: str | None = MISSING
    max_tokens: int | None = MISSING
    temperature: float | None = MISSING
    max_attempts: int = MISSING
    read_timeout: float = MISSING

    def runtime(self) -> ModelConfig:
        # A null api_key: the client sends the engine's VLLM_API_KEY or SGLANG_API_KEY, which a
        # server started without --api-key ignores. A server of one's own costs nothing.
        return ModelConfig(
            model=self.model,
            provider=self.engine,
            base_url=self.base_url,
            api_key=None,
            aws_region=None,
            aws_profile=None,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            request_timeout=self.read_timeout,
            max_retries=self.max_attempts - 1,
            extra_body=[NO_THINKING],
            input_price=0.0,
            output_price=0.0,
        )

    def __post_init__(self) -> None:
        if self.engine != MISSING and self.engine not in SERVERS:
            raise ValueError(f"Server engine must be {' or '.join(SERVERS)}, got {self.engine!r}")
        if isinstance(self.max_attempts, int) and self.max_attempts < 1:
            raise ValueError("Server max_attempts must be >= 1")


__all__ = ["NO_THINKING", "ServerConfig"]
