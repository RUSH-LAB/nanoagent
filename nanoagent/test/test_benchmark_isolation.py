import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples" / "benchmark"))

from step1_coding_environment import coding_environment  # noqa: E402


def test_coding_harness_can_write_its_workspace_but_cannot_read_other_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox = {"darwin": "sandbox-exec", "linux": "bwrap"}.get(sys.platform)
    if sandbox is None or shutil.which(sandbox) is None:
        pytest.skip("the benchmark's OS sandbox is unavailable")

    monkeypatch.setenv("BENCHMARK_TEST_AMBIENT_KEY", "ambient")
    monkeypatch.setenv("BENCHMARK_TEST_ROUTE_KEY", "route")
    # A custom batch folder outside the standard outputs and system temp trees.
    with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder:
        batch = Path(folder)
        workspace = batch / "case-a" / "workspace"
        workspace.mkdir(parents=True)
        own_result = workspace.parent / "result.json"
        own_result.write_text("private result")
        other_result = batch / "case-b" / "result.json"
        other_result.parent.mkdir()
        other_result.write_text("another run's result")

        with coding_environment(workspace, credential_names={"BENCHMARK_TEST_ROUTE_KEY"}, protected=[batch]) as (prefix, env):
            subprocess.run(
                [
                    *prefix,
                    sys.executable,
                    "-c",
                    """
import os
import sys
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
Path("answer.json").write_text("answer")
""",
                    str(own_result),
                    str(other_result),
                ],
                cwd=workspace,
                env=env,
                check=True,
            )
        assert (workspace / "answer.json").read_text() == "answer"
