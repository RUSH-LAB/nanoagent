"""The shared backoff helper: what is retried, what is not, and how long it waits.

Every backend's request goes through :func:`retry_async`, so its policy is what decides whether a
rate-limited batch recovers or a bad API key burns ``max_retries`` sleeps before failing. The
sleeps are captured rather than performed, so the schedule is asserted exactly and the tests are
instant.
"""

from __future__ import annotations

import pytest

from nanoagent.inference.backend import retry_async


@pytest.fixture
def slept(monkeypatch) -> list[float]:
    """Records every backoff delay instead of sleeping it."""
    delays: list[float] = []

    async def fake_sleep(d: float) -> None:
        delays.append(d)

    monkeypatch.setattr("nanoagent.inference.backend.asyncio.sleep", fake_sleep)
    return delays


def _flaky(failures: int, error: Exception | None = None):
    """A coroutine factory that raises ``failures`` times, then returns "ok"."""
    state = {"n": 0}

    async def fn() -> str:
        state["n"] += 1
        if state["n"] <= failures:
            raise error or RuntimeError(f"transient {state['n']}")
        return "ok"

    return fn, state


async def test_a_first_try_success_never_sleeps(slept) -> None:
    fn, state = _flaky(0)
    assert await retry_async(fn, max_retries=3, base_delay=1.0) == "ok"
    assert (state["n"], slept) == (1, [])


async def test_a_transient_failure_is_retried_until_it_succeeds(slept) -> None:
    fn, state = _flaky(2)
    assert await retry_async(fn, max_retries=3, base_delay=1.0) == "ok"
    assert state["n"] == 3
    assert slept == [1.0, 2.0]  # base_delay * 2**attempt


async def test_the_last_error_is_re_raised_once_retries_run_out(slept) -> None:
    fn, state = _flaky(99)
    with pytest.raises(RuntimeError, match="transient 3"):
        await retry_async(fn, max_retries=2, base_delay=1.0)
    assert state["n"] == 3  # the initial call plus max_retries
    assert len(slept) == 2  # ...and no sleep after the final failure


async def test_a_declared_abort_error_fails_fast(slept) -> None:
    """A 4xx (bad key, malformed request) will fail identically on every retry — sleeping through
    max_retries of them just delays the error the caller has to see."""
    fn, state = _flaky(99, error=ValueError("401 unauthorized"))
    with pytest.raises(ValueError, match="401"):
        await retry_async(fn, max_retries=5, base_delay=1.0, abort_errors=(ValueError,))
    assert (state["n"], slept) == (1, [])


async def test_max_delay_caps_the_exponential_growth(slept) -> None:
    """Without a cap, attempt 10 of an exponential schedule sleeps for a quarter of an hour."""
    fn, _ = _flaky(4)
    await retry_async(fn, max_retries=9, base_delay=1.0, max_delay=3.0)
    assert slept == [1.0, 2.0, 3.0, 3.0]


async def test_jitter_subtracts_from_the_wait_and_never_exceeds_it(monkeypatch, slept) -> None:
    """Full jitter spreads a herd of clients across the window [0, delay) — it only ever shortens
    the wait, so it can't quietly stretch a bounded schedule past max_delay."""
    monkeypatch.setattr("nanoagent.inference.backend.random.random", lambda: 0.75)
    fn, _ = _flaky(2)
    await retry_async(fn, max_retries=3, base_delay=4.0, jitter=1.0)
    assert slept == [1.0, 2.0]  # 4*(1-0.75), 8*(1-0.75)


async def test_jitter_cannot_push_a_wait_past_max_delay(monkeypatch, slept) -> None:
    monkeypatch.setattr("nanoagent.inference.backend.random.random", lambda: 0.0)  # the worst case: no cut
    fn, _ = _flaky(3)
    await retry_async(fn, max_retries=5, base_delay=4.0, max_delay=5.0, jitter=1.0)
    assert max(slept) <= 5.0
