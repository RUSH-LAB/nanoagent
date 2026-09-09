"""Typed, OmegaConf-backed structured configuration for batch inference.

:class:`LeanInferConfig` is the single schema. ``backend`` picks the transport — the built-in
``"sglang"`` (OpenAI-compatible HTTP), or the name of a plugin file found in ``plugin_dirs``
(see :mod:`nanoagent.inference.plugins`); the remaining fields cover the model, sampling, concurrency,
retry, and per-1M-token prices used for cost accounting.

The dataclass carries concrete defaults so it can be built directly in code, and
:func:`load_config` merges a YAML file plus dotted ``key=value`` overrides onto it
(OmegaConf struct mode — unknown keys are rejected).

:func:`load_yaml` is the ONE yaml entry point every side of the package goes through
(client, serve, launch), so one relative path always names one file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

from omegaconf import OmegaConf
from slimconfig import load_mapping_yaml, resolve_path

if TYPE_CHECKING:
    from omegaconf import DictConfig


def load_yaml(path: str) -> DictConfig:
    """Load a yaml (with slimconfig ``defaults:`` composition) under the inference path rule.

    A relative ``path`` resolves against the PROJECT ROOT, not the current working directory:
    slimconfig's ``load_mapping_yaml`` on its own resolves against the CWD, so a config named
    the same way from two different working directories would otherwise load two different
    files. Every yaml entry point on this side (``SGLangServer.from_yaml``, ``launch_from_yaml``,
    :func:`load_config`) funnels through here so that rule holds everywhere, and an absolute path
    is passed through untouched.

    NOTE this is a DIFFERENT rule from :func:`nanoagent.extensions.resolve_config`, which resolves
    a tool manifest against the CWD first and the packaged configs second. Both are deliberate: a
    serving config names a checkout, a tool manifest names either the user's file or the wheel's.
    """
    return load_mapping_yaml(str(resolve_path(path)))


def _at_least(name: str, value: float | None, minimum: float) -> None:
    """Raise :class:`ValueError` unless ``value`` is ``None`` or at least ``minimum``.

    Both config schemas validate a pile of numeric floors in ``__post_init__``; routing them
    through one helper keeps every message in the same shape and keeps the check itself in one
    place. ``None`` passes: an unset optional knob means "leave the default in place".
    """
    if value is not None and value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")


def _greater_than(name: str, value: float | None, floor: float) -> None:
    """Raise :class:`ValueError` unless ``value`` is ``None`` or strictly greater than ``floor``."""
    if value is not None and value <= floor:
        raise ValueError(f"{name} must be > {floor}, got {value}")


@dataclass
class LeanInferConfig:
    """How to run a batch of completions: which transport, which model, and the knobs."""

    # transport: a built-in ("sglang" — OpenAI SDK over base_url) or the name of a plugin file
    # (see nanoagent.inference.plugins), which is how a site-specific endpoint is reached without its
    # details entering this package.
    backend: str = "sglang"
    # where to look for a plugin backend, searched BEFORE $NANOAGENT_PLUGINS and the default
    # <project root>/.meta/plugins. [] = just those two. Only consulted for a name that is not a
    # built-in, so the sglang path never touches the filesystem.
    plugin_dirs: list[str] = field(default_factory=list)
    # served model name (sglang --served-model-name).
    model: str = "default"
    # HuggingFace repo id or local dir of the tokenizer, which is what turns this into a
    # token-in/token-out client. REQUIRED by backend="sglang_native" (it sends input_ids, so the
    # chat template is applied here). Optional for a chat transport: naming one wraps it so its
    # replies still carry ids — reconstructed by re-encoding the text, and labelled
    # Fidelity.RECONSTRUCTED. null = no tokens at all, which is the honest answer for a provider
    # whose vocabulary we do not have.
    tokenizer: str | None = None
    # sglang OpenAI-compatible /v1 endpoint; required for backend="sglang".
    base_url: str | None = None
    # auth key passed to the OpenAI client; SGLang ignores it but the SDK requires a non-empty
    # string, so null becomes "EMPTY".
    api_key: str | None = None
    # null OMITS the field, leaving the server's own default — which is the only way to reach a
    # reasoning deployment, since those reject an explicit temperature once reasoning effort is set
    # (some demand it be absent, some demand exactly 1). 0.0 still means "send 0.0".
    temperature: float | None = 0.0
    max_tokens: int | None = None
    # extra sampling params passed through verbatim as the OpenAI request `extra_body` (e.g.
    # {repetition_penalty: 1.05} to break thinking-model repeat loops); {} = none. These are
    # SERVER-SPECIFIC — the examples are SGLang's, and a stricter gateway 400s on an unknown one.
    # A null value drops the param, which is how a config that inherits a shared base turns one
    # of its knobs off (writing `extra_body: {}` would merge, not replace).
    extra_body: dict[str, Any] = field(default_factory=dict)
    # split a thinking model's inline `<think>...</think>` trace out of the answer into
    # Response.reasoning (for a server with no reasoning parser); off = leave text verbatim.
    parse_thinking: bool = False
    # max in-flight requests — the engine's concurrency semaphore bound.
    concurrency: int = 8
    # group requests sharing a long common prompt prefix adjacently in dispatch order so a
    # prefix-caching backend (e.g. SGLang) reuses the cached prefix; results still return in
    # input order. Pure, behavior-preserving reordering — default off dispatches in input
    # order, byte-identical to before.
    group_by_prefix: bool = False
    # transient-failure retries (exponential backoff); 0 disables retry.
    max_retries: int = 3
    retry_base_delay: float = 1.0
    # ceiling (seconds) on a single backoff sleep, so a high attempt count can't sleep for
    # minutes: the delay is min(retry_max_delay, retry_base_delay * 2**attempt), then jittered.
    retry_max_delay: float = 60.0
    # sglang-only: per-request wall-clock timeout (seconds) bounding a single completion call;
    # matches the OpenAI SDK default.
    request_timeout: float = 600.0
    # per-1M-token prices for cost accounting; 0 keeps cost at 0 (e.g. a local model).
    input_price: float = 0.0
    output_price: float = 0.0

    def __post_init__(self) -> None:
        """Fail fast on out-of-range knobs, so a typo surfaces at config time, not mid-batch."""
        _at_least("concurrency", self.concurrency, 1)
        _at_least("max_retries", self.max_retries, 0)
        _at_least("retry_base_delay", self.retry_base_delay, 0)
        _at_least("retry_max_delay", self.retry_max_delay, 0)
        _at_least("temperature", self.temperature, 0)
        _at_least("input_price", self.input_price, 0)
        _at_least("output_price", self.output_price, 0)
        _greater_than("request_timeout", self.request_timeout, 0)
        _greater_than("max_tokens", self.max_tokens, 0)  # None = leave the server's own budget
        # Catch a base_url given without a scheme (e.g. "host:8000/v1") at config time — the
        # OpenAI SDK would otherwise fail deep in the first request. Checked for EVERY backend,
        # not just sglang: a plugin transport is an HTTP client too, and gating this on one
        # backend name would mean the check quietly stops applying the moment a config names a
        # plugin. None is allowed: a backend raises its own clear error when it needs the
        # endpoint, and a plugin that supplies its own default has nothing to validate yet.
        if self.base_url is not None and not self.base_url.startswith(
            ("http://", "https://")
        ):
            raise ValueError(
                f"base_url must start with http:// or https://, got {self.base_url!r}"
            )


def load_config(
    path: str | None = None, overrides: list[str] | None = None
) -> LeanInferConfig:
    """Build a :class:`LeanInferConfig` from an optional YAML file plus dotted ``key=value`` overrides.

    The YAML and overrides are merged onto the structured schema (OmegaConf struct mode), so unknown
    keys raise and field types are validated. With no arguments this returns the all-defaults config.
    """
    merged = OmegaConf.structured(LeanInferConfig)
    if path is not None:
        merged = OmegaConf.merge(merged, load_yaml(path))
    if overrides:
        merged = OmegaConf.merge(merged, OmegaConf.from_dotlist(overrides))
    return cast(LeanInferConfig, OmegaConf.to_object(merged))
