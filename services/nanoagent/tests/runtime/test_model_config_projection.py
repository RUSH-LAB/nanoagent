"""Pins the nanoagent -> nanoagent.inference config bridge: ModelConfig is a strict subset of LeanInferConfig.

nanoagent and nanoagent.inference keep SEPARATE model schemas on purpose, because their contracts differ:
:class:`~nanoagent.runtime.config.ModelConfig` is all-``MISSING`` (a run config must set every knob
explicitly — no silent defaults), while :class:`~nanoagent.inference.LeanInferConfig` carries concrete
defaults so it can be built in code (``nanoagent.inference.infer``). Merging them would cost one of those
two properties.

The price of two schemas is that they can drift, so :meth:`nanoagent.runtime.model.Model.from_config`
translates by FIELD-NAME PROJECTION rather than a hand-written copy. This test pins the invariant
that projection relies on — every ModelConfig field name exists on LeanInferConfig with the same
type — so adding a knob to one side and forgetting the other fails here rather than silently
dropping the knob at runtime (which is invisible: the request just goes out mis-configured).

What it consumes: the two dataclass schemas only — no network, no backend, no SGLang.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_model_config_projection.py -x -q
"""

from __future__ import annotations

from dataclasses import fields

from nanoagent.inference import LeanInferConfig
from nanoagent.runtime.config import ModelConfig


def test_every_model_config_field_exists_on_lean_infer_config():
    lean = {f.name: f.type for f in fields(LeanInferConfig)}
    missing = [f.name for f in fields(ModelConfig) if f.name not in lean]
    assert not missing, (
        f"ModelConfig fields with no LeanInferConfig counterpart: {missing} — "
        "Model.from_config projects by name, so add them to LeanInferConfig or map them by hand"
    )
    mismatched = [f.name for f in fields(ModelConfig) if lean[f.name] != f.type]
    assert not mismatched, f"same name, different type on the two schemas: {mismatched}"


def test_projection_carries_every_knob_across():
    cfg = ModelConfig(
        model="m",
        backend="sglang",
        base_url="http://h:1/v1",
        api_key=None,
        temperature=0.7,
        max_tokens=99,
        request_timeout=123.0,
        max_retries=5,
        extra_body={"repetition_penalty": 1.05},
        input_price=1.0,
        output_price=2.0,
    )
    lean = LeanInferConfig(**{f.name: getattr(cfg, f.name) for f in fields(cfg)})
    for f in fields(cfg):
        assert getattr(lean, f.name) == getattr(cfg, f.name), f.name
