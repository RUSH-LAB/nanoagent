"""Linux integration test: the NanoAgent task tools harness builds in the worker's network-less python-3 build.

    .venv/bin/python -m pytest -p no:cacheprovider -m microsandbox test/test_nanoagent_task_harness_microsandbox.py

The worker stages the hashed wheels of requirements.txt from PyPI (host side, every sha256 verified), then the sandbox
builds with no network and /deps as the only package source; the built artifact must import the harness.
"""

from __future__ import annotations

import os
import shutil
import sys
import uuid
from pathlib import Path

import pytest
import yaml

from nanoagent.uploaded.contract import HarnessManifest
from microsandbox import MountConfig, MountKind, Network

from nanoagent.uploaded.sandbox import BuildSpec, Limits, MicrosandboxSupervisor
from nanoagent.uploaded.toolchains import resolve_dependencies, toolchain

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "nanoagent" / "uploaded" / "reference_harnesses" / "nanoagent"))
from assemble import assemble  # noqa: E402

pytestmark = pytest.mark.microsandbox

TOOLS = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "guest-tools"
PROFILE = toolchain("python-3")
SCRATCH = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "scratch"
INDEX = os.environ.get("RUSH_PYPI_INDEX", "https://pypi.org/simple/")


def test_the_harness_builds_offline_from_its_hashed_wheels_and_imports() -> None:
    root = SCRATCH / f"nanoagent-harness-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True)
    try:
        source = assemble(root / "source")
        declared = yaml.safe_load((source / "harness.yaml").read_text())
        manifest = HarnessManifest(
            declared["name"], declared["version"], tuple(declared["dialects"]), declared["toolchain"], tuple(declared["lockfiles"]), tuple(declared["build"]["argv"]), tuple(declared["build"]["outputs"]), tuple(declared["run"]["argv"])
        )
        supervisor = MicrosandboxSupervisor(tools=TOOLS)
        supervisor.startup(PROFILE)
        closure = resolve_dependencies(PROFILE, source, manifest.lockfiles, root / "deps", index_url=INDEX)
        artifact = supervisor.build(BuildSpec("nanoagent-harness", PROFILE, manifest, source, closure, root / "build-work", Limits(wall_s=300)))
        assert {"main.py", "taskharness", "nanoagent", "slimconfig", "antlr4", "site"} <= {path.name for path in artifact.directory.iterdir()}
        # The runtime image, as at run time: the artifact at /harness, nothing else.
        probe = (
            "import sys; sys.path[:0] = ['/harness/site', '/harness'];"
            "import taskharness.run, taskharness.work, nanoagent.cli.mgen, nanoagent.cli.repl.app; print('imported')"
        )
        async def run_probe():
            vm = await supervisor._create(
                f"rush-probe-{uuid.uuid4().hex[:8]}", PROFILE.runtime_image, Limits(), Network.none(),
                {"/harness": MountConfig(kind=MountKind.BIND, bind=str(artifact.directory), readonly=True)},
            )
            try:
                return await vm.exec("python", ["-c", probe], timeout=120)
            finally:
                await supervisor._destroy(vm)

        done = supervisor._loop.run(run_probe())
        assert done.stdout_text.strip() == "imported", done.stderr_text
    finally:
        shutil.rmtree(root, ignore_errors=True)
