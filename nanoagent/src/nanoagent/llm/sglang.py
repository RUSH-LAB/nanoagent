"""SGLang OpenAI-compatible chat configuration."""

from dataclasses import dataclass

from omegaconf import MISSING
from slimconfig import Config

from nanoagent.runtime.config import ModelConfig


@dataclass
class SGLangConfig(Config):
    model: str = MISSING
    base_url: str = MISSING
    max_tokens: int | None = MISSING
    temperature: float | None = MISSING
    max_attempts: int = MISSING
    read_timeout: float = MISSING
    extra_body: list[str] = MISSING
    input_price: float = MISSING
    output_price: float = MISSING

    def runtime(self) -> ModelConfig:
        return ModelConfig(
            model=self.model,
            provider="sglang",
            base_url=self.base_url,
            api_key=None,
            aws_region=None,
            aws_profile=None,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            request_timeout=self.read_timeout,
            max_retries=self.max_attempts - 1,
            extra_body=self.extra_body,
            input_price=self.input_price,
            output_price=self.output_price,
        )

    def __post_init__(self) -> None:
        if isinstance(self.max_attempts, int) and self.max_attempts < 1:
            raise ValueError("SGLang max_attempts must be >= 1")


__all__ = ["SGLangConfig"]
