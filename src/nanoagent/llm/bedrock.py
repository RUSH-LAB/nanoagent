"""Amazon Bedrock LLM configuration."""

from dataclasses import dataclass

from omegaconf import MISSING
from slimconfig import Config

from nanoagent.runtime.config import ModelConfig


@dataclass
class BedrockConfig(Config):
    model: str = MISSING
    region: str = MISSING
    profile: str | None = MISSING
    max_tokens: int | None = MISSING
    temperature: float | None = MISSING
    max_attempts: int = MISSING
    read_timeout: float = MISSING
    input_price: float = MISSING
    output_price: float = MISSING

    def runtime(self) -> ModelConfig:
        return ModelConfig(
            model=self.model,
            provider="bedrock",
            base_url=None,
            api_key=None,
            aws_region=self.region,
            aws_profile=self.profile,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            request_timeout=self.read_timeout,
            max_retries=self.max_attempts - 1,
            extra_body=[],
            input_price=self.input_price,
            output_price=self.output_price,
        )

    def __post_init__(self) -> None:
        if isinstance(self.max_attempts, int) and self.max_attempts < 1:
            raise ValueError("Bedrock max_attempts must be >= 1")


__all__ = ["BedrockConfig"]
