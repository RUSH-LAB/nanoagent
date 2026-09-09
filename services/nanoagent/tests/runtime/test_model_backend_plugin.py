"""``ModelConfig.backend`` reaches the plugin resolver verbatim — plugin names included.

:meth:`nanoagent.runtime.model.Model.from_config` used to gate the name behind its own allowlist
(``("sglang", "openai")``). That was wrong twice over: it named ``openai``, which is not a backend
this package resolves, and it rejected every *plugin* backend — so the whole ``$NANOAGENT_PLUGINS``
seam that ``src/nanoagent/configs/mgen.yaml`` documents failed before
:mod:`nanoagent.inference.plugins` was ever consulted.

The rule this pins is that the loop side keeps no list of backend names.
:mod:`nanoagent.inference.plugins` owns resolution (built-ins, then ``$NANOAGENT_PLUGINS``), and it
owns the rejection too — its message names the backends it did find and the directories it
searched, which an allowlist here cannot.

The plugin is written into ``tmp_path`` rather than reusing a real one: what is under test is the
pass-through, not any particular gateway, and a test that needs a plugin already on disk is a test
that fails outside one checkout.

What it consumes: no network and no server — building a backend only constructs a client.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_model_backend_plugin.py -x -q
"""

from __future__ import annotations

from pathlib import Path

import pytest
from nanoagent.runtime.config import ModelConfig
from nanoagent.runtime.model import Model

_PLUGIN = '''
from nanoagent.inference.backends.sglang import SglangBackend


class HouseBackend(SglangBackend):
    """A plugin backend: nothing but a name the built-ins do not have."""


BACKEND = HouseBackend
'''


def _cfg(backend: str) -> ModelConfig:
    return ModelConfig(
        model="m",
        backend=backend,
        base_url="http://127.0.0.1:1/v1",
        api_key="k",
        temperature=None,
        max_tokens=16,
        request_timeout=30.0,
        max_retries=0,
        extra_body={},
        input_price=0.0,
        output_price=0.0,
    )


def test_plugin_backend_name_is_passed_through(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "house.py").write_text(_PLUGIN)
    monkeypatch.setenv("NANOAGENT_PLUGINS", str(tmp_path))
    model = Model.from_config(_cfg("house"))
    assert type(model._backend).__name__ == "HouseBackend"


def test_the_pre_merge_env_var_still_resolves_a_plugin(tmp_path: Path, monkeypatch) -> None:
    """``$LEANINFER_PLUGINS``, the name from when the inference side was its own package, still works.

    A deployment that exports the old name in a shell profile or a job spec must not silently
    fall back to the built-in transport when it upgrades — that is a run whose numbers came from
    a different endpoint than the config says, which nobody notices until the table is written.
    """
    (tmp_path / "house.py").write_text(_PLUGIN)
    monkeypatch.delenv("NANOAGENT_PLUGINS", raising=False)
    monkeypatch.setenv("LEANINFER_PLUGINS", str(tmp_path))
    assert type(Model.from_config(_cfg("house"))._backend).__name__ == "HouseBackend"


def test_unknown_backend_is_rejected_by_the_resolver(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "house.py").write_text(_PLUGIN)
    monkeypatch.setenv("NANOAGENT_PLUGINS", str(tmp_path))
    # A ValueError either way, so a caller that handled the old allowlist error still works —
    # but this one can list `house`, which is exactly what an allowlist here could not do.
    with pytest.raises(ValueError, match="house") as excinfo:
        Model.from_config(_cfg("nosuchbackend"))
    assert "nosuchbackend" in str(excinfo.value)
