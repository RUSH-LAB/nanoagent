import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples" / "benchmark"))

from step2_coding_environment import coding_environment  # noqa: E402


def test_coding_harness_can_write_its_workspace_but_cannot_read_other_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox = {"darwin": "sandbox-exec", "linux": "bwrap"}.get(sys.platform)
    if sandbox is None or shutil.which(sandbox) is None:
        pytest.skip("the benchmark's OS sandbox is unavailable")
    import resource

    monkeypatch.setenv("BENCHMARK_TEST_AMBIENT_KEY", "ambient")
    monkeypatch.setenv("BENCHMARK_TEST_ROUTE_KEY", "route")
    # A custom batch folder and a local credential unrelated to its outputs.
    with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder:
        batch = Path(folder)
        workspace = batch / "case-a" / "workspace"
        workspace.mkdir(parents=True)
        own_result = workspace.parent / "result.json"
        own_result.write_text("private result")
        other_result = batch / "case-b" / "result.json"
        other_result.parent.mkdir()
        other_result.write_text("another run's result")
        credential = batch / "local.env"
        credential.write_text("private credential")
        (workspace / "outside").symlink_to(credential)
        cache = batch / "npm-cache"
        cache.mkdir()
        (cache / "prefetched").write_text("cached package")

        with coding_environment(workspace, credential_names={"BENCHMARK_TEST_ROUTE_KEY"}, npm_cache=cache) as (prefix, env):
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            subprocess.run(
                [
                    *prefix,
                    sys.executable,
                    "-c",
                    """
import os
import sys
import time
from pathlib import Path

assert "BENCHMARK_TEST_AMBIENT_KEY" not in os.environ
assert os.environ["BENCHMARK_TEST_ROUTE_KEY"] == "route"
for filename in sys.argv[1:]:
    try:
        Path(filename).read_text()
    except (PermissionError, FileNotFoundError):
        pass
    else:
        raise AssertionError(f"read protected benchmark data from {filename}")
    try:
        with Path(filename).open("r+"):
            raise AssertionError(f"opened protected data for writing: {filename}")
    except (PermissionError, FileNotFoundError):
        pass
cache = Path(os.environ["npm_config_cache"]) / "prefetched"
assert cache.read_text() == "cached package"
cache.write_text("private change")
Path(os.environ["TMPDIR"], "scratch").write_text("temporary")
Path("answer.json").write_text("answer")
started = time.process_time()
while time.process_time() - started < 0.1:
    pass
""",
                    str(own_result),
                    str(other_result),
                    str(credential),
                    "outside",
                    str(cache / "prefetched"),
                ],
                cwd=workspace,
                env=env,
                check=True,
            )
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            assert after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime >= 0.09
        assert (workspace / "answer.json").read_text() == "answer"
        assert (cache / "prefetched").read_text() == "cached package"


@pytest.mark.skipif(sys.platform not in {"darwin", "linux"}, reason="the benchmark requires a Unix sandbox")
def test_coding_answer_cannot_point_outside_workspace(tmp_path: Path) -> None:
    from step2_single_run import read_answer

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "private.json"
    outside.write_text('{"private": true}')
    answer = workspace / "answer.json"
    answer.symlink_to(outside)
    output, refusal, error = read_answer(workspace)
    assert output is refusal is None
    assert error is not None

    answer.unlink()
    answer.write_text('{"answer": true}')
    assert read_answer(workspace) == ({"answer": True}, None, None)


def test_the_manifest_decides_what_pins_a_case() -> None:
    import asyncio
    from types import SimpleNamespace

    from step2_single_run import pin, reference_tool

    def task(runner: str, reference: str | None) -> SimpleNamespace:
        return SimpleNamespace(id="t", runner=runner, reference=reference, tools=("work",))

    assert reference_tool(task("agent", "solve")) == "solve"
    assert reference_tool(task("decide", "solve")) == "solve"
    assert reference_tool(task("tool", "solve")) == "solve"
    # RUSH gives a tool task's one tool's output; an agent task with no reference is judged without one.
    assert reference_tool(task("tool", None)) == "work"
    assert reference_tool(task("agent", None)) is None
    assert asyncio.run(pin(None, None, {"x": 1}, False, 1.0)) is None
    with pytest.raises(ValueError, match="cannot pin a decide task"):
        reference_tool(task("decide", None))
    with pytest.raises(ValueError, match="cannot pin a review task"):
        reference_tool(task("review", None))
