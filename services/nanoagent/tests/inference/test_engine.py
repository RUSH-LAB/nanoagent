"""The batch engine: coercion, ordering, bounded concurrency, and per-item failure isolation."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from nanoagent.inference import LeanInferConfig, Request, Response, infer
from nanoagent.inference import engine as engine_mod


class FakeBackend:
    """Echoes each request's last message back, recording concurrency and whether it was closed."""

    def __init__(self, *, fail_on: str | None = None, delay: float = 0.0) -> None:
        self.fail_on = fail_on
        self.delay = delay
        self.seen: list[str] = []
        self.live = 0
        self.peak = 0
        self.closed = False

    async def generate(self, messages: list[dict[str, Any]], **_: Any) -> Response:
        self.live += 1
        self.peak = max(self.peak, self.live)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            text = str(messages[-1]["content"])
            self.seen.append(text)
            if text == self.fail_on:
                raise RuntimeError("boom")
            return Response(text=text, usage={"prompt_tokens": 1, "completion_tokens": 2})
        finally:
            self.live -= 1

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture
def fake(monkeypatch) -> FakeBackend:
    backend = FakeBackend()
    monkeypatch.setattr(engine_mod, "build_backend", lambda _cfg: backend)
    return backend


async def test_infer_returns_one_response_per_request_in_input_order(fake) -> None:
    out = await infer(["a", "b", "c"], LeanInferConfig())
    assert [r.text for r in out] == ["a", "b", "c"]


async def test_infer_closes_the_backend_when_the_batch_finishes(fake) -> None:
    await infer(["a"], LeanInferConfig())
    assert fake.closed


async def test_an_empty_batch_never_builds_a_backend(monkeypatch) -> None:
    def explode(_cfg):
        raise AssertionError("a backend was built for an empty batch")

    monkeypatch.setattr(engine_mod, "build_backend", explode)
    assert await infer([], LeanInferConfig()) == []


async def test_concurrency_bounds_the_in_flight_requests(monkeypatch) -> None:
    backend = FakeBackend(delay=0.01)
    monkeypatch.setattr(engine_mod, "build_backend", lambda _cfg: backend)
    await infer([str(i) for i in range(12)], LeanInferConfig(concurrency=3))
    assert backend.peak <= 3


async def test_one_failure_is_captured_and_does_not_sink_the_batch(monkeypatch) -> None:
    backend = FakeBackend(fail_on="b")
    monkeypatch.setattr(engine_mod, "build_backend", lambda _cfg: backend)
    out = await infer(["a", "b", "c"], LeanInferConfig())
    assert [r.text for r in out] == ["a", None, "c"]
    assert out[1].error is not None and "boom" in out[1].error


async def test_prefix_grouping_reorders_dispatch_but_not_results(monkeypatch) -> None:
    backend = FakeBackend()
    monkeypatch.setattr(engine_mod, "build_backend", lambda _cfg: backend)
    prompts = ["shared prefix / z", "other", "shared prefix / a"]
    out = await infer(prompts, LeanInferConfig(group_by_prefix=True, concurrency=1))
    assert [r.text for r in out] == prompts  # results stay in INPUT order
    # ...while the two shared-prefix requests were dispatched adjacently.
    assert backend.seen == ["other", "shared prefix / a", "shared prefix / z"]


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        ("hi", [{"role": "user", "content": "hi"}]),
        ({"role": "system", "content": "s"}, [{"role": "system", "content": "s"}]),
        ([{"role": "user", "content": "m"}], [{"role": "user", "content": "m"}]),
    ],
)
def test_coerce_normalizes_every_accepted_input_shape(item, expected) -> None:
    assert Request.coerce(item).messages == expected


def test_coerce_returns_an_existing_request_unchanged() -> None:
    req = Request(messages=[{"role": "user", "content": "x"}])
    assert Request.coerce(req) is req


def test_coerce_accepts_any_other_iterable_of_messages() -> None:
    """The catch-all: a tuple of messages is a conversation too, and materializing it here beats
    a backend receiving something it can't index."""
    assert Request.coerce(({"role": "user", "content": "x"},)).messages == [{"role": "user", "content": "x"}]


def test_a_coerced_shape_offers_no_tools() -> None:
    """Every loose input is a plain completion; tools have to be asked for by name."""
    assert Request.coerce("hi").tools is None


# ─── tools on the batch path ─────────────────────────────────────────────────────────────────


class ToolRecordingBackend:
    """Records the ``tools`` each request was sent with."""

    def __init__(self) -> None:
        self.tools_seen: list[Any] = []

    async def generate(self, messages: list[dict[str, Any]], *, tools=None, **_: Any) -> Response:
        self.tools_seen.append(tools)
        return Response(text=str(messages[-1]["content"]))

    async def aclose(self) -> None:
        pass


TOOL_SPEC = [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}}}]


async def test_a_requests_tools_reach_the_backend(monkeypatch) -> None:
    backend = ToolRecordingBackend()
    monkeypatch.setattr(engine_mod, "build_backend", lambda _cfg: backend)
    await infer([Request(messages=[{"role": "user", "content": "q"}], tools=TOOL_SPEC)], LeanInferConfig())
    assert backend.tools_seen == [TOOL_SPEC]


async def test_tools_are_per_request_so_one_batch_can_mix_them(monkeypatch) -> None:
    """The reason tools ride the Request and not the config: a batch is not one conversation."""
    backend = ToolRecordingBackend()
    monkeypatch.setattr(engine_mod, "build_backend", lambda _cfg: backend)
    await infer(
        ["plain", Request(messages=[{"role": "user", "content": "q"}], tools=TOOL_SPEC)],
        LeanInferConfig(concurrency=1),
    )
    assert backend.tools_seen == [None, TOOL_SPEC]


# ─── the batch summary ───────────────────────────────────────────────────────────────────────


def test_the_batch_summary_totals_counts_tokens_and_cost() -> None:
    responses = [
        Response(text="a", usage={"prompt_tokens": 10, "completion_tokens": 20}, cost=0.5),
        Response(error="boom"),
        Response(text="c", usage={"prompt_tokens": 5}, cost=0.25),
    ]
    assert engine_mod._summarize_batch(responses, elapsed=1.23456) == {
        "requests": 3,
        "errors": 1,
        "prompt_tokens": 15,
        "completion_tokens": 20,
        "cost": 0.75,
        "elapsed_s": 1.235,
    }


def test_an_empty_batch_summarizes_to_zeros() -> None:
    assert engine_mod._summarize_batch([], elapsed=0.0)["requests"] == 0


async def test_a_finished_batch_is_logged_at_info(fake, caplog) -> None:
    """The one operational breadcrumb a long run leaves behind — it must survive refactors of the
    summary shape."""
    with caplog.at_level("INFO", logger="nanoagent.inference.engine"):
        await infer(["a", "b"], LeanInferConfig())
    assert "'requests': 2" in caplog.text
