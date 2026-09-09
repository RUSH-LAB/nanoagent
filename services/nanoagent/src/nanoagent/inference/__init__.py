"""The inference side of nanoagent: async batched LLM calls, and the SGLang server behind them.

This is where :class:`nanoagent.runtime.model.Model` — and so the agent loop — actually reaches a
model. It is also usable on its own, without an agent: :func:`~nanoagent.inference.engine.infer`
is a plain concurrent batch runner over a list of requests.

Public API:
  * :func:`~nanoagent.inference.engine.infer` — run a list of requests concurrently, returning a list of Responses in order.
  * :class:`~nanoagent.inference.config.LeanInferConfig` / :func:`~nanoagent.inference.config.load_config` — the YAML-driven (OmegaConf) run config.
  * :class:`~nanoagent.inference.types.Request` / :class:`~nanoagent.inference.types.Response` — the input / result shapes.
  * :class:`~nanoagent.inference.types.ToolCall` — a model-requested tool invocation (in :attr:`Response.tool_calls`).
  * :class:`~nanoagent.inference.types.Tokens` / :class:`~nanoagent.inference.types.Fidelity` — the token-level view of a reply, and whether its ids are the sampler's own; :func:`~nanoagent.inference.tokenizer.load_tokenizer` is what produces them.
  * :mod:`nanoagent.inference.serve` — the serve side: ``python -m nanoagent.inference.serve --config <yaml>``. One :class:`~nanoagent.inference.serve.SGLangServeConfig` covers EVERY topology; ``mode`` selects which (``single`` -> in-process ``sglang serve``; ``router`` / ``multinode`` -> :func:`~nanoagent.inference.router.run_router` brings up an ``sglang_router`` + N single-node engines). Starts the SGLang endpoint the client talks to; what each serving node runs.
  * :class:`~nanoagent.inference.serve.SGLangServer` + :class:`~nanoagent.inference.serve.SGLangServeConfig` — the unified config + dispatcher; also usable directly via ``SGLangServer.from_yaml(...).run()``.
  * :func:`~nanoagent.inference.serve.ensure_weights` — make sure a model's weight shards are on disk (downloading from HuggingFace if missing), returning the local dir; used by the launch side before exec.
  * :func:`~nanoagent.inference.launch.launch_from_yaml` — the launch dispatcher: ``python -m nanoagent.inference.launch --config <yaml>``, whose ``launch.target`` key selects WHERE to serve (``local`` -> serve in-process). Reads where to serve from config, so no per-deployment shell script is needed.
  * :func:`~nanoagent.inference.router.run_router` — internal launcher used by ``SGLangServer.run()`` when ``mode`` is ``router`` or ``multinode``: fan one model across an ``sglang_router`` + multiple single-node engines.

There is deliberately no multi-turn tool loop here. :class:`nanoagent.core.agent.Agent` is that
loop and is the only one in the package; this side returns ONE :class:`~nanoagent.inference.types.Response`
per request and lets the caller decide what to do with the tool calls in it.

Text is what a provider returns; token ids are what a trainer needs. ``config.tokenizer`` names the
vocabulary, and every reply then carries :attr:`Response.tokens` — :attr:`Fidelity.NATIVE` from
``backend: sglang_native`` (SGLang's ``/generate``, which reports the ids it sampled),
:attr:`Fidelity.RECONSTRUCTED` from any chat transport, where the ids were re-encoded here from
the text. One shape, and a label saying which of the two it is, because no chat API — OpenRouter's
or SGLang's own ``/v1`` — reports ids at all.

The transport is ``config.backend``: the built-in ``"sglang"`` (OpenAI-compatible HTTP), the
``"sglang_native"`` token-level one, or the name of a plugin file — see
:mod:`nanoagent.inference.plugins`, which loads ``<name>.py`` from
``config.plugin_dirs`` / ``$NANOAGENT_PLUGINS`` / ``<project root>/.meta/plugins`` so a
site-specific endpoint (an internal gateway, a team key) never has to enter this package.
:func:`~nanoagent.inference.plugins.available_backends` lists what is reachable. Either way the backend
module is imported only when selected, so importing this package does not pull in the ``openai``
SDK until a backend is built.

Every yaml entry point resolves a relative path against the PROJECT ROOT (see
:func:`~nanoagent.inference.config.load_yaml`), so one config path names one file no matter which
directory the process was started from.
"""

from __future__ import annotations

from nanoagent.inference.config import LeanInferConfig, load_config, load_yaml
from nanoagent.inference.engine import infer
from nanoagent.inference.launch import launch_from_yaml
from nanoagent.inference.plugins import BackendNotFound, available_backends
from nanoagent.inference.serve import SGLangServeConfig, SGLangServer, ensure_weights
from nanoagent.inference.tokenizer import Tokenizer, load_tokenizer
from nanoagent.inference.types import Fidelity, Request, Response, Tokens, ToolCall

__all__ = [
    "BackendNotFound",
    "Fidelity",
    "LeanInferConfig",
    "Request",
    "Response",
    "SGLangServeConfig",
    "SGLangServer",
    "Tokenizer",
    "Tokens",
    "ToolCall",
    "available_backends",
    "ensure_weights",
    "infer",
    "launch_from_yaml",
    "load_config",
    "load_tokenizer",
    "load_yaml",
]
