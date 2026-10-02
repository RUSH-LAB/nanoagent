"""The one place a config picks an inference provider.

:data:`PROVIDERS` is the whole list. Both names share
:class:`~nanoagent.inference.backends.sglang.ChatBackend`, the OpenAI-compatible ``/v1`` client.
SGLang's ``/generate`` endpoint is a different API and lives on
:class:`~nanoagent.inference.config.GenerateConfig`, not in this table. The chat client is
imported only when a provider is built, so importing this module does not pull in ``openai``.
"""

from __future__ import annotations

import os
from dataclasses import replace

from nanoagent.inference.backend import Backend
from nanoagent.inference.config import LeanInferConfig

#: OpenRouter's OpenAI-compatible chat endpoint. Used when ``provider: openrouter`` leaves
#: ``base_url`` unset.
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

#: Read when ``provider: openrouter`` and ``api_key`` is null.
OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY"

#: Every name :func:`build_provider` accepts, in the order an error message lists them.
PROVIDERS: tuple[str, ...] = ("sglang", "openrouter")


def build_provider(config: LeanInferConfig) -> Backend:
    """Build the chat client named by ``config.provider``.

    ``sglang`` requires ``base_url``. ``openrouter`` defaults ``base_url`` to
    :data:`OPENROUTER_BASE_URL` and takes ``api_key`` from the config or from
    :data:`OPENROUTER_API_KEY_ENV`. An unknown name raises :class:`ValueError` naming both choices.
    """
    name = config.provider
    if name not in PROVIDERS:
        choices = ", ".join(PROVIDERS)
        raise ValueError(f"unknown provider {name!r}; choose from {choices}")
    from nanoagent.inference.backends.sglang import ChatBackend

    return ChatBackend.from_config(_chat_config(config))


def _chat_config(config: LeanInferConfig) -> LeanInferConfig:
    """Fill the chat-client defaults that differ by provider, then hand off one config."""
    if config.provider == "openrouter":
        api_key = config.api_key or os.environ.get(OPENROUTER_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                "provider='openrouter' requires config.api_key or the "
                f"{OPENROUTER_API_KEY_ENV} environment variable"
            )
        return replace(
            config,
            base_url=config.base_url or OPENROUTER_BASE_URL,
            api_key=api_key,
        )
    if config.base_url is None:
        raise ValueError(
            "provider='sglang' requires config.base_url (an SGLang /v1 endpoint)"
        )
    return config
