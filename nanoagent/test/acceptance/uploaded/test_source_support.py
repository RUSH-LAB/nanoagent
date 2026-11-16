"""CLI acceptance gate: source support for all toolchains.

Run on the macOS host (the worker runs in the Lima VM `gvisor-dev`, see support.py):

    .venv/bin/python -m pytest test/acceptance/uploaded -m uploaded_acceptance -k source_support

Every case goes through the CLI steps: step 1 publishes the probe case set (the harness's own manifest names its toolchain), step 2 submits a source
(a fixture folder or a hand-made ZIP) and follows the run, step 3 reads the stored trace. One real worker with the real
toolchain images, offline builds and gVisor sandboxes serves them all; the package registries are local mocks generated from
the fixtures' lockfiles (registries.py). No fixture calls a model, so the scripted upstream must never be reached.
"""

from __future__ import annotations

import hashlib
import json
import stat
import sys
import uuid
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from slimconfig import load_layout

NANOAGENT = Path(__file__).resolve().parents[3]
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
    str(NANOAGENT / "examples" / "benchmark"),
]

import registries  # noqa: E402
import step2_submit_run  # noqa: E402
import step3_trace  # noqa: E402
import support  # noqa: E402
from mockllm import MockProvider, load_scenario  # noqa: E402
from rush_server import RushServer, rush_server, unavailable  # noqa: E402
from support import Cli, VmWorker  # noqa: E402

from nanoagent.plugin.package import pack  # noqa: E402

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

PROBE = NANOAGENT / "test" / "plugins" / "acceptance-probe"
SUITE = "source-support-probe"
WORKER_TOKEN = "worker-acceptance-token"
SOCKET = "/run/rush-gvisor/seccheck.sock"
FIXTURES = {
    "python_local": "python-3",
    "cpp": "cpp-20",
    "rust": "rust-1",
    "go": "go-1",
    "typescript": "typescript-5",
    "java": "java-21",
    "javascript": "javascript-22",
}
OUT = support.FINAL / "source-support"


@dataclass
class Outcome:
    run: Any
    trace: Any

    @property
    def attempt(self) -> Any:
        return self.run.attempts[0]

    @property
    def kinds(self) -> list[str]:
        return [event["kind"] for event in self.trace.events]

    @property
    def execution(self) -> dict[str, Any]:
        return self.trace.attempt["execution"]


class Rig:
    """The RUSH server, the CLI, the registries and the one worker of this module."""

    def __init__(self, rush: RushServer, run_dir: Path, worker: VmWorker, upstream_calls: Any) -> None:
        self.run_dir = run_dir
        self.cli = Cli(rush.base_url, rush.workspace_id, rush.token, OUT, rush.user_id)
        self.worker = worker
        self.upstream_calls = upstream_calls
        self.count = 0

    def submit(self, source: Path) -> Outcome:
        self.count += 1
        key = f"{SUITE}-{self.count}-{uuid.uuid4().hex[:6]}"
        home = self.run_dir / f"step2-{key}"
        # A harness version names one ZIP: a folder is stamped with the version of its content.
        self.cli.step("2", "submit_run", home, *support.submit_args(SUITE, plugin="acceptance-probe", key=key, source=support.stamp(source) if source.is_dir() else source, follow_timeout=1500))
        run = load_layout(home, step2_submit_run.RunLayout).run
        trace_home = self.run_dir / f"trace-{key}"
        self.cli.step("3", "trace", trace_home, f"attempt_id={run.attempts[0].attempt_id}")
        return Outcome(run, load_layout(trace_home, step3_trace.TraceLayout).trace)


@pytest.fixture(scope="module")
def rig() -> Iterator[Rig]:
    reason = unavailable() or support.vm_available()
    if reason:
        pytest.skip(reason)
    run_dir = support.SCRATCH / f"source-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True)
    with pytest.MonkeyPatch.context() as env:
        env.setenv("BENCHMARK_WORKER_TOKEN", WORKER_TOKEN)
        with rush_server() as server, support.serve_directory(registries.registry(run_dir / "registry")) as port, MockProvider() as provider:
            server.seed_plugin(pack(PROBE))
            cli = Cli(server.base_url, server.workspace_id, server.token, OUT, server.user_id)
            cases = json.loads((NANOAGENT / "test" / "acceptance" / "benchmark" / "cases" / "probe_cases.json").read_text())
            cases |= {"answer": cases["answer"][:1], "refuse": []}
            (run_dir / "cases.json").write_text(json.dumps(cases))
            cli.step("1", "publish_benchmark", run_dir / "step1", *support.publish_args(name=SUITE, cases=run_dir / "cases.json"))
            # Never consumed: the fixtures make no model calls. The worker still needs an endpoint profile.
            handle = provider.register(
                load_scenario(support.SCENARIOS / "core-engine.yaml"), harness="nanoagent", model=support.MODEL, refs={"reference": support.REFERENCE}
            )
            host = f"http://{support.HOST}:{port}"
            config = run_dir / "worker.yaml"
            worker = VmWorker("source-support", config, OUT / "worker.log")
            indexes = {
                "python-3": f"{host}/simple",
                "go-1": f"{host}/go",
                "rust-1": f"{host}/crates",
                "typescript-5": f"{host}/npm",
                "javascript-22": f"{host}/npm",
                "java-21": f"{host}/maven",
            }
            text = support.worker_yaml(
                base_url=f"http://{support.HOST}:{server.base_url.rsplit(':', 1)[1]}",
                upstream=handle.base_url.replace("127.0.0.1", support.HOST),
                index=indexes["python-3"],
                socket=SOCKET,
                scratch=f"{worker.vm_home}/scratch",
            )
            first = f"    python-3: {indexes['python-3']}\n"
            assert first in text
            # The mock worker config already points javascript-22 at the real npm registry: the mock registry replaces it.
            text = text.replace("    javascript-22: https://registry.npmjs.org\n", "")
            text = text.replace(first, "".join(f"    {key}: {value}\n" for key, value in indexes.items()))
            config.write_text(text)
            worker.start()
            try:
                worker.wait_for("/claim", 900)
                yield Rig(server, run_dir, worker, handle.ledger)
            finally:
                worker.stop()


def assert_not_executed(outcome: Outcome, rig: Rig) -> None:
    """The attempt never reached a case sandbox: no launch, no process, no model call."""
    assert not {"case.launched", "process.exec", "model_call.admitted"} & set(outcome.kinds), outcome.kinds
    assert not rig.upstream_calls.calls


# -- every language builds and runs -------------------------------------------------------------------------------------


@pytest.mark.parametrize("fixture", list(FIXTURES))
def test_a_fixture_builds_and_runs_in_its_toolchain(fixture: str, rig: Rig) -> None:
    source = registries.stage_fixture(fixture, rig.run_dir / f"src-{fixture}")
    outcome = rig.submit(source)
    attempt = outcome.attempt
    assert (attempt.execution_status, attempt.verdict, attempt.sealed) == ("answered", "pass", True), outcome.execution
    assert (outcome.run.score["value"], outcome.run.score["unavailable_reason"]) == (1, None)
    assert not [kind for kind in outcome.kinds if kind.startswith("build.")], "the build is not in the trace"
    [result] = [event for event in outcome.trace.events if event["kind"] == "result.read"]
    assert result["data"]["outcome"] == {"status": "answered", "answer": {"digest": support.REFERENCE}}
    # Zero model calls: the harness computed the digest itself.
    assert not [kind for kind in outcome.kinds if kind.startswith("model_call")]
    assert not rig.upstream_calls.calls
    assert outcome.trace.attempt["coverage"]["status"] == "complete"


# -- rejected before execution ------------------------------------------------------------------------------------------

MANIFEST = "protocol: rush.harness.v1\nname: h\nversion: '1'\ndialects: [chat_completions]\ntoolchain: python-3\nlockfiles: []\nbuild:\n  argv: [sh, -c, cp main.py /build-out/main.py]\n  outputs: [main.py]\nrun:\n  argv: [python, /harness/main.py]\n"
ELF = b"\x7fELF" + bytes(60)


def make_zip(path: Path, entries: list[tuple[str | zipfile.ZipInfo, bytes]], manifest: str = MANIFEST) -> Path:
    # A harness version names one ZIP: the version is the digest of what the ZIP holds.
    content = hashlib.sha256(manifest.encode() + b"".join(str(getattr(name, "filename", name)).encode() + data for name, data in entries)).hexdigest()[:12]
    manifest = manifest.replace("version: '1'", f"version: '{content}'")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in [("harness.yaml", manifest.encode()), ("main.py", b"print('x')\n"), *entries]:
            archive.writestr(name, data)
    return path


def symlink() -> zipfile.ZipInfo:
    info = zipfile.ZipInfo("link")
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    return info


REJECTIONS = {
    "traversal": ([("../escape.txt", b"x")], MANIFEST, "traversal"),
    "duplicate-path": ([("main.py", b"print('again')\n")], MANIFEST, "duplicate_path"),
    "link": ([(symlink(), b"/etc/passwd")], MANIFEST, "link"),
    "prebuilt-binary": ([("data.txt", ELF)], MANIFEST, "prebuilt_binary"),
    "oversized-expansion": ([("zeros.txt", bytes(20 << 20))], MANIFEST, "compression_ratio"),
    "unknown-toolchain": ([], MANIFEST.replace("python-3", "cobol-85"), "unknown_toolchain"),
}


@pytest.mark.parametrize("name", list(REJECTIONS))
def test_a_bad_source_is_rejected_by_the_worker_before_any_case_sandbox(name: str, rig: Rig) -> None:
    entries, manifest, code = REJECTIONS[name]
    outcome = rig.submit(make_zip(rig.run_dir / f"bad-{name}.zip", entries, manifest))
    # The server reads the manifest only; the worker's validation of the rest finalizes the attempt as build_failed with the code.
    assert outcome.execution == {"status": "build_failed", "reason": code}, outcome.execution
    assert outcome.attempt.verdict != "pass" and outcome.trace.sealed
    assert_not_executed(outcome, rig)
    assert not [kind for kind in outcome.kinds if kind.startswith("build.")], "a failed build is reported on the attempt, not in the trace"


# -- locked dependencies ------------------------------------------------------------------------------------------------


def change_after(text: str, prefix: str) -> str:
    """``text`` with the character right after the first ``prefix`` replaced by a different one."""
    index = text.index(prefix) + len(prefix)
    return text[:index] + ("0" if text[index] != "0" else "1") + text[index + 1 :]


def mutate_go(root: Path, how: str) -> None:
    if how == "altered":
        (root / "go.sum").write_text(change_after((root / "go.sum").read_text(), "github.com/tidwall/gjson v1.17.3 h1:"))
    else:
        with (root / "go.sum").open("a") as out:
            out.write("example.com/missing v1.0.0 h1:" + "A" * 43 + "=\nexample.com/missing v1.0.0/go.mod h1:" + "A" * 43 + "=\n")
        with (root / "go.mod").open("a") as out:
            out.write("\nrequire example.com/missing v1.0.0\n")


def mutate_rust(root: Path, how: str) -> None:
    lock = (root / "Cargo.lock").read_text()
    if how == "altered":
        (root / "Cargo.lock").write_text(change_after(lock, 'checksum = "'))
    else:
        (root / "Cargo.lock").write_text(
            lock
            + '\n[[package]]\nname = "missing-crate"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "'
            + "0" * 64
            + '"\n'
        )


def mutate_npm(root: Path, how: str) -> None:
    lock = json.loads((root / "package-lock.json").read_text())
    packages = lock["packages"]
    if how == "altered":
        key = next(name for name in packages if name.startswith("node_modules/"))
        integrity = packages[key]["integrity"]
        packages[key]["integrity"] = integrity[:-3] + ("AAA" if not integrity.endswith("AAA") else "BBB")
    else:
        packages["node_modules/missing-pkg"] = {
            "version": "1.0.0",
            "resolved": "https://registry.npmjs.org/missing-pkg/-/missing-pkg-1.0.0.tgz",
            "integrity": "sha512-" + "A" * 86 + "==",
        }
    (root / "package-lock.json").write_text(json.dumps(lock))


def mutate_java(root: Path, how: str) -> None:
    lock = (root / "maven.lock").read_text()
    if how == "altered":
        (root / "maven.lock").write_text(lock.replace("sha256:57", "sha256:58"))
    else:
        (root / "maven.lock").write_text(lock + "com.example:missing:1.0.0 sha256:" + "0" * 64 + "\n")


MUTATIONS = {"go": mutate_go, "rust": mutate_rust, "javascript": mutate_npm, "java": mutate_java}
EXPECTED = {"missing": "dependency_unavailable", "altered": "hash_mismatch"}


@pytest.mark.parametrize("how", ["missing", "altered"])
@pytest.mark.parametrize("fixture", list(MUTATIONS))
def test_a_missing_or_altered_locked_dependency_fails_the_build(fixture: str, how: str, rig: Rig) -> None:
    source = registries.stage_fixture(fixture, rig.run_dir / f"src-{fixture}-{how}")
    MUTATIONS[fixture](source, how)
    outcome = rig.submit(source)
    assert outcome.execution == {"status": "build_failed", "reason": EXPECTED[how]}, outcome.execution
    assert_not_executed(outcome, rig)
