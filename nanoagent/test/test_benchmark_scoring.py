import asyncio
import gc
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from slimconfig import load_output

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples" / "benchmark"))

from step2_single_run import Cases, Refusal, pin  # noqa: E402

from nanoagent.harness.base import RunnerRequest  # noqa: E402
from nanoagent.harness.subprocess import SubprocessRunner  # noqa: E402
from nanoagent.uploaded import case_sets  # noqa: E402

CONFIGS = Path(__file__).resolve().parents[1] / "examples" / "benchmark" / "configs"
REFUSAL = Refusal({"source": "x = = 1"}, "not valid Python")


def _pin(monkeypatch: pytest.MonkeyPatch, refusal: Refusal | None, reference: object) -> tuple:
    async def call(*args: object, **kwargs: object) -> object:
        if isinstance(reference, Exception):
            raise reference
        return reference

    monkeypatch.setattr(case_sets, "call_tool_async", call)
    return asyncio.run(pin(SimpleNamespace(id="p"), "ref", {"source": "x"}, refusal, 5.0))


def test_the_plugins_tool_decides_each_case(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _pin(monkeypatch, None, {"code": "var_0 = 1"}) == ({"code": "var_0 = 1"}, None)
    reference, rejection = _pin(monkeypatch, REFUSAL, RuntimeError("p ref failed: source is not valid Python"))
    assert reference is None and "not valid Python" in rejection
    # The plugin's input verification refusing the input is a rejection too.
    assert _pin(monkeypatch, REFUSAL, ValueError("source is not valid Python"))[0] is None


@pytest.mark.parametrize(
    ("refusal", "reference", "message"),
    [
        (None, RuntimeError("p ref failed: upstream 503"), "a case to answer"),
        (REFUSAL, {"code": "x"}, "a case to refuse"),
        # A rejection for any other reason, such as an outage, is no refusal.
        (REFUSAL, RuntimeError("p ref failed: upstream 503"), "without 'not valid Python'"),
    ],
)
def test_a_tool_that_disagrees_with_the_cases_fails(
    monkeypatch: pytest.MonkeyPatch, refusal: Refusal | None, reference: object, message: str
) -> None:
    with pytest.raises(RuntimeError, match=message):
        _pin(monkeypatch, refusal, reference)


@pytest.mark.parametrize("name", ["ast_canonicalizer", "ast_shingles", "city_weather"])
def test_every_case_to_refuse_names_its_rejection(name: str) -> None:
    cases = load_output(str(CONFIGS / f"step1_{name}_cases.json"), Cases)
    assert cases.refuse and all(refusal.reference_error for refusal in cases.refuse)
    arguments, refusal = cases.case(f"{cases.plugin}-{len(cases.answer) + 1:02d}")
    assert refusal is cases.refuse[0] and arguments == refusal.arguments


def test_no_case_to_refuse_can_come_due() -> None:
    # A future date to refuse must stay in the future: a date that has passed becomes answerable.
    cases = load_output(str(CONFIGS / "step1_city_weather_cases.json"), Cases)
    future = [refusal.arguments["date"] for refusal in cases.refuse if "not over" in refusal.reference_error]
    assert future and all(date >= "2099" for date in future)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.skipif(os.name == "nt", reason="process groups are POSIX")
def test_a_runner_in_its_own_group_leaves_no_child_behind(tmp_path: Path) -> None:
    pidfile = tmp_path / "child"
    # The runner starts a child of its own, then waits; it never answers.
    command = ["sh", "-c", f"sleep 300 & echo $! > {pidfile}; sleep 300"]

    async def survives() -> bool:
        """Whether the runner's child is still alive once the runner, in its own group, is cancelled."""
        runner = SubprocessRunner("probe", command, inherit_process_group=False)
        task = asyncio.create_task(runner.run(RunnerRequest(input="x"), lambda event: None))
        while not pidfile.is_file() or not pidfile.read_text().strip():
            await asyncio.sleep(0.05)
        child = int(pidfile.read_text())
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("the runner was not cancelled")
        deadline = time.monotonic() + 5
        while _alive(child) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        alive = _alive(child)
        if alive:
            # It holds the runner's pipes open: end it while this loop can still close them.
            os.kill(child, 9)
        del task
        gc.collect()
        await asyncio.sleep(0.1)
        return alive

    assert not asyncio.run(survives()), "the runner's child outlived it"
