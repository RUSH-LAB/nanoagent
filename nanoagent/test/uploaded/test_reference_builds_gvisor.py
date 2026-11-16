"""Linux integration test: the JavaScript reference harnesses build network-less within the default build limits.

    limactl shell gvisor-dev -- bash deploy/gvisor/vm-test.sh test/uploaded/test_reference_builds_gvisor.py

The worker stages each harness's locked packages from the npm registry (host side, every integrity checked), then the
sandbox builds with no network. The build runs with the limits a run gets by default (`DEFAULT_LIMITS` in
helpinghands/src/server/benchmark/limits.js): a harness that does not fit them cannot be benchmarked without raising them.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import uuid
from pathlib import Path

import pytest
import yaml

from nanoagent.uploaded.collector import SeccheckCollector
from nanoagent.uploaded.contract import HarnessManifest
from nanoagent.uploaded.sandbox import BuildSpec, DockerSandboxSupervisor, Limits
from nanoagent.uploaded.toolchains import resolve_dependencies, toolchain

pytestmark = pytest.mark.gvisor

ROOT = Path(__file__).resolve().parents[2]
SOCKET = os.environ.get("RUSH_SECCHECK_SOCKET", "/run/rush-gvisor/seccheck.sock")
SCRATCH = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "scratch"
REGISTRY = os.environ.get("RUSH_NPM_REGISTRY", "https://registry.npmjs.org")
LIMITS_JS = ROOT.parent / "helpinghands" / "src" / "server" / "benchmark" / "limits.js"


def server_default(name: str) -> int:
    """A default of the server's limits, read from its source so the two cannot drift."""
    match = re.search(rf"^\s*{name}: \{{default: ([^,]+),", LIMITS_JS.read_text(), re.MULTILINE)
    assert match, f"{name} has no default in {LIMITS_JS}"
    return math.prod(int(factor) for factor in match.group(1).replace("_", "").split("*"))  # a product of integer literals


@pytest.mark.parametrize("harness", ["claude-code", "codex", "dsh", "pi"])
def test_a_reference_harness_builds_within_the_default_build_limits(harness: str) -> None:
    source = ROOT / "src" / "nanoagent" / "uploaded" / "reference_harnesses" / harness
    declared = yaml.safe_load((source / "harness.yaml").read_text())
    manifest = HarnessManifest(
        declared["name"], declared["version"], tuple(declared["dialects"]), declared["toolchain"], tuple(declared["lockfiles"]), tuple(declared["build"]["argv"]), tuple(declared["build"]["outputs"]), tuple(declared["run"]["argv"])
    )
    profile = toolchain(manifest.toolchain)
    limits = Limits(
        memory_bytes=server_default("build_memory_mb") << 20, workspace_bytes=server_default("build_output_bytes"), workspace_files=server_default("build_files"),
        tmp_bytes=server_default("build_tmp_bytes"), pids=server_default("pids"), cpus=1.0, wall_s=server_default("build_wall_ms") / 1000,
    )
    root = SCRATCH / f"reference-build-{harness}-{uuid.uuid4().hex[:8]}"
    collector = SeccheckCollector(SOCKET)
    collector.start()
    try:
        supervisor = DockerSandboxSupervisor(collector=collector)
        supervisor.startup(profile)
        closure = resolve_dependencies(profile, source, manifest.lockfiles, root / "deps", index_url=REGISTRY)
        artifact = supervisor.build(BuildSpec(f"ref-{harness}", profile, manifest, source, closure, root / "work", limits))
        assert all((artifact.directory / output).exists() for output in manifest.outputs)
    finally:
        collector.stop()
        shutil.rmtree(root, ignore_errors=True)
