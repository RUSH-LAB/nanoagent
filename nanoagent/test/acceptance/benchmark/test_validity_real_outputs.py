"""4a validity predicates over every real run under examples/benchmark/outputs/ (gitignored: skipped when
absent). Folders are found by the layout their metadata.json declares. A folder the current schema
cannot read is stale and skipped with the reason; the predicates are never loosened to admit it."""

import json
import os
from pathlib import Path

import pytest
from expect import StaleRun, assert_valid_batch, assert_valid_report, assert_valid_single_run, load_run, run_folders, stale_reason

OUTPUTS = Path(__file__).resolve().parents[3] / "examples" / "benchmark" / "outputs"


def metadata_files() -> list[Path]:
    """Every metadata.json under the outputs, without walking the npm caches and node_modules batches keep."""
    found = []
    for root, folders, files in os.walk(OUTPUTS):
        folders[:] = [folder for folder in folders if not folder.startswith(".") and folder != "node_modules"]
        if "metadata.json" in files:
            found.append(Path(root) / "metadata.json")
    return sorted(found)


def declared(kind_file: str, kind: str) -> list[Path]:
    found = []
    for metadata in metadata_files():
        layout = json.loads(metadata.read_text(encoding="utf-8")).get("layout", {})
        if layout.get(kind_file) == kind:
            found.append(metadata.parent)
    return found


def report_pairs() -> list[tuple[Path, Path]]:
    pairs = []
    for report in declared("report.json", "Report"):
        argv = json.loads((report / "metadata.json").read_text(encoding="utf-8"))["argv"]
        runs = [Path(arg.removeprefix("runs=")) for arg in argv if arg.startswith("runs=")]
        if runs and (runs[0].parent / "batch.json").is_file():
            pairs.append((report, runs[0]))
    return pairs


def name(folder: Path) -> str:
    return str(folder.relative_to(OUTPUTS))


SECRET = os.environ.get("OPENROUTER_API_KEY")


@pytest.mark.parametrize("folder", declared("result.json", "SingleRun"), ids=name)
def test_single_run_is_valid(folder: Path) -> None:
    reason = stale_reason(folder)
    if reason:
        pytest.skip(f"stale: {reason}")
    assert_valid_single_run(folder, SECRET)


@pytest.mark.parametrize("folder", declared("batch.json", "Batch"), ids=name)
def test_batch_is_valid(folder: Path) -> None:
    if not (folder / "batch.json").is_file():
        pytest.skip("stale: metadata declares batch.json but the batch never wrote it")
    # Hidden folders (the batch's .npm-cache) are not runs; each run is <plugin>/<task>/<case>/<harness>.
    for run in sorted(path for path in (folder / "runs").glob("[!.]*/*/*/*") if path.is_dir()):
        reason = stale_reason(run)
        if reason:
            pytest.skip(f"stale: {run.relative_to(folder)}: {reason}")
    assert_valid_batch(folder, SECRET)


@pytest.mark.parametrize(
    ("report", "runs"), report_pairs(), ids=lambda value: name(value) if isinstance(value, Path) and value.is_relative_to(OUTPUTS) else None
)
def test_report_matches_its_runs(report: Path, runs: Path) -> None:
    if not (report / "report.json").is_file():
        pytest.skip("stale: metadata declares report.json but the report never wrote it")
    if not run_folders(runs):
        pytest.skip("stale: the runs the report summed are gone")
    for folder in run_folders(runs):
        try:
            load_run(folder)
        except StaleRun as stale:
            pytest.skip(f"stale: {folder.name}: {stale}")
    assert_valid_report(report, runs)
