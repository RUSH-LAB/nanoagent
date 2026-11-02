"""The one place a config picks an inference provider.

:data:`PROVIDERS` is the whole list. The OpenAI-compatible names share
:class:`~nanoagent.inference.backends.sglang.ChatBackend`, the OpenAI-compatible ``/v1`` client:
OpenRouter, and the engines that serve a model from a server of one's own (:data:`SERVERS`), vLLM
and SGLang. SGLang's ``/generate`` endpoint is a different API and lives on
:class:`~nanoagent.inference.config.GenerateConfig`, not in this table. The chat client is
imported only when a provider is built, so importing this module does not pull in ``openai``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace

from nanoagent.inference.backend import Backend
from nanoagent.inference.config import LeanInferConfig

#: OpenRouter's OpenAI-compatible chat endpoint. Used when ``provider: openrouter`` leaves
#: ``base_url`` unset.
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

#: Read when ``provider: openrouter`` and ``api_key`` is null.
OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY"


@dataclass(frozen=True)
class Server:
    """An inference engine serving its own OpenAI-compatible ``/v1`` endpoint.

    A config that leaves ``base_url`` null reaches the server named by ``url_env``, and one that
    leaves ``api_key`` null sends the key in ``key_env``: the one the server was started with
    (``--api-key``), if it was.
    """

    name: str
    url_env: str
    key_env: str


#: The engines a server of one's own runs, by provider name. The PI runner (js/pi-runner) reads the
#: same variables.
SERVERS: dict[str, Server] = {
    "vllm": Server("vLLM", "VLLM_BASE_URL", "VLLM_API_KEY"),
    "sglang": Server("SGLang", "SGLANG_BASE_URL", "SGLANG_API_KEY"),
}


class MissingKeyError(ValueError):
    """A provider's API key is not set, so its models cannot run here."""


class MissingServerError(MissingKeyError):
    """No server is set for an engine of :data:`SERVERS`, so its models cannot run here."""


#: Every name :func:`build_provider` accepts, in the order an error message lists them.
PROVIDERS: tuple[str, ...] = ("sglang", "vllm", "openrouter", "bedrock")


def build_provider(config: LeanInferConfig) -> Backend:
    """Build the chat client named by ``config.provider``.

    ``openrouter`` defaults ``base_url`` to :data:`OPENROUTER_BASE_URL` and takes ``api_key`` from
    the config or from :data:`OPENROUTER_API_KEY_ENV`. A server engine (:data:`SERVERS`) takes
    ``base_url`` and ``api_key`` from the config or from its environment variables, and raises
    :class:`MissingServerError` with neither. An unknown name raises :class:`ValueError` naming
    every choice.
    """
    name = config.provider
    if name not in PROVIDERS:
        choices = ", ".join(PROVIDERS)
        raise ValueError(f"unknown provider {name!r}; choose from {choices}")
    if name == "bedrock":
        from nanoagent.inference.backends.bedrock import BedrockBackend

        return BedrockBackend.from_config(config)

    from nanoagent.inference.backends.sglang import ChatBackend

    return ChatBackend.from_config(_chat_config(config))


def _chat_config(config: LeanInferConfig) -> LeanInferConfig:
    """Fill the chat-client defaults that differ by provider, then hand off one config."""
    if config.provider == "openrouter":
        api_key = config.api_key or os.environ.get(OPENROUTER_API_KEY_ENV)
        if not api_key:
            raise MissingKeyError(
                f"No OpenRouter API key is set ({OPENROUTER_API_KEY_ENV}): add one to run {config.model}"
            )
        return replace(
            config,
            base_url=config.base_url or OPENROUTER_BASE_URL,
            api_key=api_key,
        )
    server = SERVERS[config.provider]
    base_url = config.base_url or os.environ.get(server.url_env)
    if not base_url:
        raise MissingServerError(f"No {server.name} server is set ({server.url_env}): add one to run {config.model}")
    if not base_url.startswith(("http://", "https://")):
        raise ValueError(f"{server.url_env} must start with http:// or https://, got {base_url!r}")
    return replace(config, base_url=base_url, api_key=config.api_key or os.environ.get(server.key_env))
