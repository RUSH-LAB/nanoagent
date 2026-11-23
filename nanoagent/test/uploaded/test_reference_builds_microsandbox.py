"""Linux integration test: the JavaScript reference harnesses build network-less within the default build limits.

    .venv/bin/python -m pytest -p no:cacheprovider -m microsandbox test/uploaded/test_reference_builds_microsandbox.py

The worker stages each harness's locked packages from the npm registry (host side, every integrity checked), then the
sandbox builds with no network. The build runs with the limits a run gets by default (`BUILD_LIMITS` below): a harness that does not fit them cannot be benchmarked without raising them.
"""

from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

import pytest
import yaml

from nanoagent.uploaded.contract import HarnessManifest
from nanoagent.uploaded.sandbox import BuildSpec, Limits, MicrosandboxSupervisor
from nanoagent.uploaded.toolchains import resolve_dependencies, toolchain

pytestmark = pytest.mark.microsandbox

ROOT = Path(__file__).resolve().parents[2]
TOOLS = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "guest-tools"
SCRATCH = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "scratch"
REGISTRY = os.environ.get("RUSH_NPM_REGISTRY", "https://registry.npmjs.org")
# The default build limits of a run (`DEFAULT_LIMITS` in helpinghands/src/server/benchmark/limits.js, not in the worker image):
# change them together.
BUILD_LIMITS = Limits(
    memory_bytes=3072 << 20, workspace_bytes=1 << 30, workspace_files=100_000, tmp_bytes=512 << 20, pids=256, cpus=1.0, wall_s=600.0
)


@pytest.mark.parametrize("harness", ["claude-code", "codex", "dsh", "pi"])
def test_a_reference_harness_builds_within_the_default_build_limits(harness: str) -> None:
    source = ROOT / "src" / "nanoagent" / "uploaded" / "reference_harnesses" / "shell" / "locks" / harness
    declared = yaml.safe_load((source / "harness.yaml").read_text())
    manifest = HarnessManifest(
        declared["name"], declared["version"], tuple(declared["dialects"]), declared["toolchain"], tuple(declared["lockfiles"]), tuple(declared["build"]["argv"]), tuple(declared["build"]["outputs"]), tuple(declared["run"]["argv"])
    )
    profile = toolchain(manifest.toolchain)
    root = SCRATCH / f"reference-build-{harness}-{uuid.uuid4().hex[:8]}"
    try:
        supervisor = MicrosandboxSupervisor(tools=TOOLS)
        supervisor.startup(profile)
        closure = resolve_dependencies(profile, source, manifest.lockfiles, root / "deps", index_url=REGISTRY)
        artifact = supervisor.build(BuildSpec(f"ref-{harness}", profile, manifest, source, closure, root / "work", BUILD_LIMITS))
        assert all((artifact.directory / output).exists() for output in manifest.build_outputs)
    finally:
        shutil.rmtree(root, ignore_errors=True)
