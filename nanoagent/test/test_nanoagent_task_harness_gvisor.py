"""Linux integration test: the NanoAgent task tools harness builds in the worker's network-less python-3 build.

    docker run --rm --init --privileged --cgroupns=private -v rush-worker-docker:/var/lib/docker rush-benchmark-worker:dev \
        python -m pytest -p no:cacheprovider -o addopts= -m 'gvisor or not gvisor' test/test_nanoagent_task_harness_gvisor.py

The worker stages the hashed wheels of requirements.txt from PyPI (host side, every sha256 verified), then the sandbox
builds with no network and /deps as the only package source; the built artifact must import the harness.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
import yaml

from nanoagent.uploaded.collector import SeccheckCollector
from nanoagent.uploaded.contract import HarnessManifest
from nanoagent.uploaded.sandbox import BuildSpec, DockerSandboxSupervisor, Limits
from nanoagent.uploaded.toolchains import resolve_dependencies, toolchain

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "nanoagent" / "uploaded" / "reference_harnesses" / "nanoagent"))
from assemble import assemble  # noqa: E402

pytestmark = pytest.mark.gvisor

SOCKET = os.environ.get("RUSH_SECCHECK_SOCKET", "/run/rush-gvisor/seccheck.sock")
PROFILE = toolchain("python-3")
SCRATCH = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "scratch"
INDEX = os.environ.get("RUSH_PYPI_INDEX", "https://pypi.org/simple/")


def test_the_harness_builds_offline_from_its_hashed_wheels_and_imports() -> None:
    root = SCRATCH / f"nanoagent-harness-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True)
    collector = SeccheckCollector(SOCKET)
    collector.start()
    try:
        source = assemble(root / "source")
        declared = yaml.safe_load((source / "harness.yaml").read_text())
        manifest = HarnessManifest(
            declared["name"], declared["version"], tuple(declared["dialects"]), declared["toolchain"], tuple(declared["lockfiles"]), tuple(declared["build"]["argv"]), tuple(declared["build"]["outputs"]), tuple(declared["run"]["argv"])
        )
        supervisor = DockerSandboxSupervisor(collector=collector)
        supervisor.startup(PROFILE)
        closure = resolve_dependencies(PROFILE, source, manifest.lockfiles, root / "deps", index_url=INDEX)
        artifact = supervisor.build(BuildSpec("nanoagent-harness", PROFILE, manifest, source, closure, root / "build-work", Limits(wall_s=300)))
        assert {"main.py", "taskharness", "nanoagent", "site"} <= {path.name for path in artifact.directory.iterdir()}
        # The runtime image, as at run time: the artifact at /harness, nothing else.
        probe = (
            "import sys; sys.path[:0] = ['/harness/site', '/harness']; from taskharness import shims; shims.install();"
            "import taskharness.run, taskharness.work; print('imported')"
        )
        done = subprocess.run(
            ["docker", "run", "--rm", "--network=none", "-v", f"{artifact.directory}:/harness:ro", PROFILE.runtime_image, "python", "-c", probe],
            capture_output=True, text=True, timeout=120,
        )
        assert done.stdout.strip() == "imported", done.stderr
    finally:
        collector.stop()
        shutil.rmtree(root, ignore_errors=True)
