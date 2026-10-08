"""Backend factory: one provider name in, one client out.

:func:`build_backend` asks :func:`nanoagent.inference.providers.build_provider` for the client
named by ``config.provider``, then honours ``config.tokenizer``. The client module is imported
only when its provider is selected, so importing this package never pulls in the ``openai`` SDK
until a chat provider is actually chosen.

The tokenizer wrap lives here, so every caller — the batch engine and the harness's
:class:`~nanoagent.runtime.model.Model` — gets the same token guarantee from the one place a
backend is built.
"""

from __future__ import annotations

from nanoagent.inference.backend import Backend
from nanoagent.inference.config import LeanInferConfig
from nanoagent.inference.providers import build_provider
from nanoagent.inference.types import Fidelity


def build_backend(config: LeanInferConfig) -> Backend:
    """Build the client named by ``config.provider``.

    With ``config.tokenizer`` set, the chat client is wrapped in a
    :class:`~nanoagent.inference.tokenizing.TokenizingBackend`, so its replies carry reconstructed
    ids. The sampler's own ids come from :class:`~nanoagent.inference.config.GenerateConfig`,
    which does not go through this factory.
    """
    backend = build_provider(config)
    if config.tokenizer is None or getattr(type(backend), "fidelity", None) is Fidelity.NATIVE:
        return backend
    # Imported here, not at module scope: the wrapper pulls in the tokenizer module, and this
    # factory is on the import path of every install, tokenizer or not.
    from nanoagent.inference.tokenizing import TokenizingBackend
    from nanoagent.inference.tokenizer import load_tokenizer

    return TokenizingBackend(backend, load_tokenizer(config.tokenizer))
