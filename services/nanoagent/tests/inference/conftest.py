"""Fixtures shared by the launch-side tests."""

from __future__ import annotations

import socket
import sys
import types

import pytest


@pytest.fixture
def free_port() -> int:
    """A TCP port the OS says is free right now, for a test that needs a real bind to succeed.

    A hardcoded number is not a constant here: ``_free_port`` binds ``("", port)``, which fails
    with EADDRINUSE against an unrelated TIME-WAIT entry on ANY local address — including one left
    by a connection this machine made minutes ago and no longer holds a socket for. So the test
    fails on a developer box, days apart, for something no code in this repo did. Asking the OS
    for port 0 and closing immediately leaves no TIME-WAIT of its own (nothing ever connected),
    which is what makes the freed number reusable a microsecond later.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("", 0))
        return int(probe.getsockname()[1])


@pytest.fixture
def hub(monkeypatch):
    """A stand-in ``huggingface_hub``.

    It is a ``serve``-extra dependency, so it is genuinely absent from a client-only dev install —
    anything that reaches :func:`nanoagent.inference.serve.ensure_weights` needs this or it fails on the
    import guard instead of on what the test is about. ``snapshot_download`` refuses by default;
    a test that expects a fetch replaces it.
    """
    errors = types.ModuleType("huggingface_hub.errors")

    class LocalEntryNotFoundError(Exception):
        pass

    errors.LocalEntryNotFoundError = LocalEntryNotFoundError
    module = types.ModuleType("huggingface_hub")
    module.errors = errors
    module.snapshot_download = lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("unexpected download"))
    constants = types.ModuleType("huggingface_hub.constants")
    constants.HF_HUB_OFFLINE = True
    for name, mod in (
        ("huggingface_hub", module),
        ("huggingface_hub.errors", errors),
        ("huggingface_hub.constants", constants),
    ):
        monkeypatch.setitem(sys.modules, name, mod)
    return module
