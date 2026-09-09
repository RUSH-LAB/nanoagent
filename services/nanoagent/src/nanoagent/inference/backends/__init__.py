"""Backend factory: select a transport by name with deferred imports.

:func:`build_backend` maps ``config.backend`` to a concrete backend and calls its
``from_config``. The lookup is :func:`nanoagent.inference.plugins.load_backend_class`: a built-in module
in this package if there is one, else a ``<name>.py`` in a plugin directory (see
:mod:`nanoagent.inference.plugins` for why a site's own transport lives outside ``src/``). Either way the
module is imported only when its name is selected — so importing this package never pulls in
the ``openai`` SDK until the sglang path is actually chosen.

It is also where ``config.tokenizer`` is honoured, so that every caller — the batch engine, the
harness's :class:`~nanoagent.runtime.model.Model`, a plugin transport that has never heard of
any of this — gets the same token guarantee from the one place a backend is built.
"""

from __future__ import annotations

from nanoagent.inference.backend import Backend
from nanoagent.inference.config import LeanInferConfig
from nanoagent.inference.plugins import load_backend_class
from nanoagent.inference.types import Fidelity


def build_backend(config: LeanInferConfig) -> Backend:
    """Build the backend named by ``config.backend``, searching ``config.plugin_dirs`` for plugins.

    With ``config.tokenizer`` set, a transport that cannot report the sampler's own ids is wrapped
    in a :class:`~nanoagent.inference.tokenizing.TokenizingBackend`, so its replies carry
    reconstructed ones. A native transport is returned unwrapped — it already produces the real
    thing, and re-encoding its text would overwrite an exact record with an approximate one. The
    fidelity is read with a default rather than an attribute access: a plugin written before the
    field existed is a chat transport, which is exactly what the default says.
    """
    cls = load_backend_class(config.backend, config.plugin_dirs)
    backend = cls.from_config(config)
    if config.tokenizer is None or getattr(cls, "fidelity", None) is Fidelity.NATIVE:
        return backend
    # Imported here, not at module scope: the wrapper pulls in the tokenizer module, and this
    # factory is on the import path of every install, tokenizer or not.
    from nanoagent.inference.tokenizing import TokenizingBackend
    from nanoagent.inference.tokenizer import load_tokenizer

    return TokenizingBackend(backend, load_tokenizer(config.tokenizer))
