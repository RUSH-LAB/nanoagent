"""CLI acceptance gate: plugin benchmarks, harness identity and everyone's results (docs/plans/plugin-benchmarks.md, step 13).

One probe plugin at 0.1.0 and 0.2.0, two members (A and B) of one workspace, one real worker in the worker container and one scripted upstream. Every
member action goes through the CLI steps (1: publish a benchmark, 2: submit a run, 4: compare, 5: results); the member API is read
directly only for what the CLI does not surface (the case set view, 404s for another member's records, raw responses).

The loop harness (harnesses/metrics_loop) asks the model once and submits the scripted answer, so the scripted usage is exactly what
the run summaries must add up to. Runs, in the order the scripted upstream serves them:

    main@0.1.0   A bench-loop@1 task_tools (320 tokens), the same ZIP again (330), A bench-loop@2 coding (210), B bench-loop@1 coding (230)
    classroom@0.2.0   A bench-loop@1 task_tools (250), then a harness calling a dialect its manifest does not declare (no model call)
    classroom@0.1.0   A bench-loop@1 task_tools whose answer reports no usage

    .venv/bin/python -m pytest test/acceptance/uploaded/test_plugin_benchmarks.py -m uploaded_acceptance
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import sys
import uuid
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import yaml

NANOAGENT = Path(__file__).resolve().parents[3]
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "test" / "acceptance" / "uploaded"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
    str(NANOAGENT / "examples" / "benchmark"),
]

import gate_support as gate  # noqa: E402
import plugins  # noqa: E402
import scripted  # noqa: E402
import step1_publish_benchmark  # noqa: E402
import step2_submit_run  # noqa: E402
import step4_compare  # noqa: E402
import step5_results  # noqa: E402
import support  # noqa: E402
from mockllm import MockProvider, RunHandle, Scenario  # noqa: E402
from recovery_support import Member, alice, join_workspace  # noqa: E402
from rush_server import RushServer, rush_server, unavailable, worker_credential  # noqa: E402
from scripted import ANSWER, turn  # noqa: E402
from slimconfig import load_layout  # noqa: E402
from support import Cli  # noqa: E402

from nanoagent.plugin import load_manifest  # noqa: E402
from nanoagent.plugin.package import inspect_package, pack  # noqa: E402
from nanoagent.plugin.tasks import task_prompt  # noqa: E402
from nanoagent.uploaded.client import BenchmarkClient, BenchmarkError  # noqa: E402
from nanoagent.uploaded.reference import build_reference  # noqa: E402

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

PLUGIN = "bench-probe"
HARNESS = "bench-loop"
# A worker prices only the models of nanoagent.uploaded.worker.Model; the gate's worker prices this one beside test/model, and the
# mock upstream answers it, so a run that calls it proves the benchmark, not the runner, picked the model.
BENCHMARK_MODEL = "deepseek/deepseek-v4-flash-0731"
# No worker prices it: a benchmark pinning it is refused at publication.
UNPRICED_MODEL = "vendor/unpriced-model"
CONTEXT = "View context."
CODING_TEMPLATE = "Plugin benchmark coding prompt for {description}.\nInput: {arguments}\nWrite {workspace}/answer.json; literal braces {{ok}}."
TASK_INSTRUCTIONS = "Plugin benchmark instructions: submit the digest of the token."
MAIN_LIMITS = {"max_model_calls": 7, "wall_time_ms": 300_000, "max_output_tokens_per_call": 512}
SCRIPT = {"dialect": "chat_completions", "instrument": False, "retries": 2, "backoff_s": 0.1}
# Scripted usage per run: prompt + completion tokens.
USAGE = {"tools-1": (300, 20), "tools-2": (310, 20), "coding": (200, 10), "bob": (210, 20), "classroom-0.2.0": (240, 10)}
SUMMARY_FIELDS = {"run_id", "harness", "benchmark", "plugin", "model", "policy", "user", "metrics", "status", "score", "created_at"}


@dataclass
class Evidence:
    rush: RushServer
    a: Member
    b: Member
    cli: Cli
    cli_b: Cli
    client: BenchmarkClient
    client_b: BenchmarkClient
    run_dir: Path
    handle: RunHandle
    plugin_dirs: dict[str, Path]
    packages: dict[str, bytes]
    published: dict[str, Any]  # step 1's reports by name
    failures: dict[str, Any]  # the failed processes of the refusals
    runs: dict[str, Any]  # step 2's reports by name
    sources: dict[str, bytes]  # the ZIP of each uploaded harness
    results: dict[str, Any]  # step 5's layouts by name

    def benchmark(self, name: str) -> dict[str, Any]:
        return self.client.benchmark(self.published[name].benchmark["benchmark_id"])

    def run(self, name: str) -> dict[str, Any]:
        return (self.client_b if name == "bob" else self.client).run(self.runs[name].run_id)

    def sha(self, name: str) -> str:
        return hashlib.sha256(self.sources[name]).hexdigest()


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server(extra_users=("bob",)) as server:
        # Publishing happens before the worker starts: the models it will price are advertised now, as its claims will.
        server.advertise("mock", internet_access=False, models=(support.MODEL, BENCHMARK_MODEL))
        yield server


def harness(
    destination: Path, *, version: str, name: str = HARNESS, script: dict[str, Any] = SCRIPT, dialects: tuple[str, ...] = ("chat_completions",), drop: tuple[str, ...] = ()
) -> Path:
    """The loop harness as ``name@version`` (``HARNESS`` unless given) declaring ``dialects`` (and no ``drop`` field of the manifest): the version is chosen, so
    content that differs under one version is for the test to vary through ``script``."""
    shutil.copytree(scripted.LOOP, destination)
    (destination / "script.json").write_text(json.dumps(script))
    manifest = destination / "harness.yaml"
    text = manifest.read_text()
    text = re.sub(r"^name:.*$", f"name: {name}", text, count=1, flags=re.MULTILINE)
    text = re.sub(r"^version:.*$", f'version: "{version}"', text, count=1, flags=re.MULTILINE)
    text = re.sub(r"^dialects:.*$", f"dialects: [{', '.join(dialects)}]", text, count=1, flags=re.MULTILINE)
    for field in drop:
        text = re.sub(rf"^{field}:.*\n", "", text, count=1, flags=re.MULTILINE)
    manifest.write_text(text)
    return destination


def publish_from_folder(cli: Cli, home: Path, *, folder: Path, package: bytes, **options: Any) -> Any:
    """Step 1 with the plugin's local folder (step 1's `plugin_source: folder`) instead of the market's latest version."""
    cli.step(
        "1",
        "publish_benchmark",
        home,
        *support.publish_args(**options),
        "plugin_source=folder",
        f"folder={folder}",
        f"sha256={hashlib.sha256(package).hexdigest()}",
    )
    return load_layout(home, step1_publish_benchmark.PublishLayout).benchmark


def output_of(done: Any) -> str:
    return done.stdout + done.stderr


@pytest.fixture(scope="module")
def evidence(rush: RushServer) -> Iterator[Evidence]:
    run_dir = support.SCRATCH / f"plugin-benchmarks-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True)
    logs = support.FINAL / "plugin-benchmarks" / run_dir.name
    cli = Cli(rush.base_url, rush.workspace_id, rush.token, logs, rush.user_id)
    client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
    plugin_dirs = {version: plugins.variant(run_dir / f"plugin-{version}", plugin_id=PLUGIN, version=version) for version in ("0.1.0", "0.2.0")}
    packages = {version: pack(folder) for version, folder in plugin_dirs.items()}
    rush.seed_plugin(packages["0.1.0"])
    bob = join_workspace(rush, "bob", rush.workspace_id, [PLUGIN])
    cli_b = Cli(rush.base_url, rush.workspace_id, bob.token, logs, bob.user_id)

    gate.cases_file(run_dir / "main.json", PLUGIN, ["alpha"], [])
    gate.cases_file(run_dir / "view.json", PLUGIN, ["alpha", "beta"], ["refuse-valid"], CONTEXT)
    published: dict[str, Any] = {}
    failures: dict[str, Any] = {}

    def publish(name: str, case_file: str, home: str, *, benchmark: str | None = None, **options: Any) -> Any:
        return gate.publish_benchmark(
            cli, run_dir / f"step1-{home}", name=benchmark or name, cases=run_dir / f"{case_file}.json", model=BENCHMARK_MODEL, **options
        )

    # Both versions must be published before 0.2.0 exists (step 1 downloads the market's latest); main keeps 0.1.0's package stored.
    published["main"] = publish("main", "main", "main", template=CODING_TEMPLATE, instructions=TASK_INSTRUCTIONS, limits=MAIN_LIMITS)
    published["main-again"] = publish("main", "main", "main-again", template=CODING_TEMPLATE, instructions=TASK_INSTRUCTIONS, limits=MAIN_LIMITS)
    published["view"] = publish("view", "view", "view")
    failures["main-taken"] = publish(
        "main",
        "main",
        "main-taken",
        template=CODING_TEMPLATE,
        instructions=TASK_INSTRUCTIONS,
        limits={**MAIN_LIMITS, "max_model_calls": 6},
        check=False,
    )
    failures["too-many-calls"] = publish("too-many-calls", "main", "too-many-calls", limits={"max_model_calls": 10_000_000}, check=False)
    failures["nobody"] = publish("nobody", "main", "nobody", endpoint="nobody", check=False)
    failures["unpriced"] = gate.publish_benchmark(cli, run_dir / "step1-unpriced", name="unpriced", cases=run_dir / "main.json", model=UNPRICED_MODEL, check=False)

    package_file = run_dir / "plugin-0.2.0.tar.gz"
    package_file.write_bytes(packages["0.2.0"])
    entry_file = run_dir / "plugin-0.2.0.json"
    entry_file.write_text(json.dumps(inspect_package(packages["0.2.0"])))
    plugins.publish_version(rush.database, rush.user_id, package_file, entry_file)

    published["classroom-0.2.0"] = publish("classroom", "main", "classroom-0.2.0", benchmark="classroom", plugin_version="0.2.0")
    published["classroom-0.2.0-again"] = publish("classroom", "main", "classroom-0.2.0-again", benchmark="classroom", plugin_version="0.2.0")
    failures["classroom-0.2.0-taken"] = publish(
        "classroom", "main", "classroom-0.2.0-taken", benchmark="classroom", plugin_version="0.2.0", limits={"max_model_calls": 9}, check=False
    )
    # 0.2.0 is the market's latest now: 0.1.0's benchmark is published from the local 0.1.0 folder, whose package is the published one.
    classroom_old = dict(name="classroom", cases=run_dir / "main.json", plugin_version="0.1.0", model=BENCHMARK_MODEL)
    published["classroom-0.1.0"] = publish_from_folder(
        cli, run_dir / "step1-classroom-0.1.0", folder=plugin_dirs["0.1.0"], package=packages["0.1.0"], **classroom_old
    )
    published["classroom-0.1.0-again"] = publish_from_folder(
        cli, run_dir / "step1-classroom-0.1.0-again", folder=plugin_dirs["0.1.0"], package=packages["0.1.0"], **classroom_old
    )

    sources = {
        "a-v1": harness(run_dir / "a-v1", version="1"),
        "a-v2": harness(run_dir / "a-v2", version="2", script={**SCRIPT, "retries": 1}),
        "b-v1": harness(run_dir / "b-v1", version="1", script={**SCRIPT, "retries": 3}),
        "changed-v1": harness(run_dir / "changed-v1", version="1", script={**SCRIPT, "retries": 0}),
        "no-name": harness(run_dir / "no-name", version="9", drop=("name",)),
        "no-version": harness(run_dir / "no-version", version="9", drop=("version",)),
        "reserved": harness(run_dir / "reserved", version="1", name="claude-code"),
        "dialect": harness(run_dir / "dialect", version="dialect", script={**SCRIPT, "dialect": "responses"}),
    }
    zips = {name: step2_submit_run.zip_source(str(folder)) for name, folder in sources.items()}

    def turn_of(name: str) -> Any:
        prompt, completion = USAGE[name]
        return turn(act=ANSWER, prompt=prompt, completion=completion)

    turns = [
        turn_of("tools-1"),
        turn_of("tools-2"),
        turn_of("coding"),
        turn_of("bob"),
        turn_of("classroom-0.2.0"),
        turn(act=ANSWER, report_usage=False),
    ]
    (run_dir / "registry").mkdir()
    runs: dict[str, Any] = {}
    results: dict[str, Any] = {}
    with support.serve_directory(run_dir / "registry") as index, MockProvider() as provider:
        handle = provider.register(Scenario(name="plugin-benchmarks", turns=turns), harness="nanoagent", model=BENCHMARK_MODEL)
        worker = gate.start_worker("plugin-benchmarks", rush.base_url, cli, run_dir, upstream=handle.base_url, index=index, models=(BENCHMARK_MODEL,))
        try:

            def submit(who: Cli, name: str, benchmark: str, key: str, source: str, **options: Any) -> Any:
                return gate.submit(
                    who, run_dir / f"step2-{name}", benchmark, plugin=PLUGIN, key=key, source=sources[source], follow_timeout=1500, **options
                )

            runs["tools-1"] = submit(cli, "tools-1", "main", "pb-tools-1", "a-v1", policy="task_tools")
            # The harness's identity comes from its manifest: a manifest without a name or a version, and other bytes under a taken version.
            for name in ("no-name", "no-version"):
                failures[name] = submit(cli, name, "main", f"pb-{name}", name, check=False)
            failures["changed-v1"] = submit(cli, "changed-v1", "main", "pb-changed-v1", "changed-v1", check=False)
            runs["tools-2"] = submit(cli, "tools-2", "main", "pb-tools-2", "a-v1", policy="task_tools")
            runs["coding"] = submit(cli, "coding", "main", "pb-coding", "a-v2", policy="coding")
            # A worker claims only its own member's runs, and a member's run is previewed only against their own worker's capabilities: bob's
            # run needs a worker with bob's credential. The container serves one worker at a time, so alice's stops while bob's runs.
            worker.stop()
            rush.advertise("mock", internet_access=False, models=(support.MODEL, BENCHMARK_MODEL), credential=worker_credential(rush.base_url, bob.token))
            worker = gate.start_worker("plugin-benchmarks-bob", rush.base_url, cli_b, run_dir, upstream=handle.base_url, index=index, models=(BENCHMARK_MODEL,))
            runs["bob"] = submit(cli_b, "bob", "main", "pb-bob", "b-v1", policy="coding")
            worker.stop()
            rush.advertise("mock", internet_access=False, models=(support.MODEL, BENCHMARK_MODEL))
            worker = gate.start_worker("plugin-benchmarks-alice", rush.base_url, cli, run_dir, upstream=handle.base_url, index=index, models=(BENCHMARK_MODEL,))
            runs["classroom-0.2.0"] = submit(cli, "classroom-0.2.0", "classroom", "pb-c02", "a-v1", plugin_version="0.2.0", policy="task_tools")
            runs["dialect"] = submit(cli, "dialect", "classroom", "pb-dialect", "dialect", plugin_version="0.2.0", policy="task_tools")
            runs["classroom-0.1.0"] = submit(cli, "classroom-0.1.0", "classroom", "pb-c01", "a-v1", plugin_version="0.1.0", policy="task_tools")
        finally:
            worker.stop()

        def read(who: Cli, name: str, *overrides: str) -> None:
            who.step("5", "results", run_dir / f"step5-{name}", *overrides)
            results[name] = load_layout(run_dir / f"step5-{name}", step5_results.ResultsLayout).results

        for name, version, benchmark in (
            ("main", "0.1.0", "main"),
            ("classroom-0.1.0", "0.1.0", "classroom"),
            ("classroom-0.2.0", "0.2.0", "classroom"),
            ("view", "0.1.0", "view"),
        ):
            read(cli, f"all-{name}", "scope=all", f"plugin={PLUGIN}", f"plugin_version={version}", f"benchmark={benchmark}")
        read(cli, "mine-a", "scope=mine")
        read(cli_b, "mine-b", "scope=mine")
        yield Evidence(
            rush,
            alice(rush),
            bob,
            cli,
            cli_b,
            client,
            BenchmarkClient(rush.base_url, rush.workspace_id, bob.token),
            run_dir,
            handle,
            plugin_dirs,
            packages,
            published,
            failures,
            runs,
            zips,
            results,
        )


def sent(evidence: Evidence, index: int, role: str) -> list[str]:
    """The ``role`` messages of the ``index``th request the scripted upstream served."""
    request = evidence.handle.ledger.main_calls[index].request
    assert request is not None
    return [m["content"] for m in request.messages if m["role"] == role]


def rows(layout: Any) -> list[dict[str, Any]]:
    return [row for section in layout.sections for group in section.groups for row in group.runs]


# -- publication ------------------------------------------------------------------------------------------------------------


def test_a_benchmark_name_is_unique_per_plugin_version_and_an_identical_republish_is_not_new(evidence: Evidence) -> None:
    old, new = evidence.published["classroom-0.1.0"], evidence.published["classroom-0.2.0"]
    assert old.created is True and new.created is True
    assert old.benchmark["benchmark_id"] != new.benchmark["benchmark_id"]
    assert (old.benchmark["plugin"]["version"], new.benchmark["plugin"]["version"]) == ("0.1.0", "0.2.0")
    assert old.benchmark["plugin"]["sha256"] == hashlib.sha256(evidence.packages["0.1.0"]).hexdigest()
    assert new.benchmark["plugin"]["sha256"] == hashlib.sha256(evidence.packages["0.2.0"]).hexdigest()
    for version, report in (("0.1.0", old), ("0.2.0", new)):
        assert [b["benchmark_id"] for b in evidence.client.benchmarks(PLUGIN, version) if b["name"] == "classroom"] == [
            report.benchmark["benchmark_id"]
        ]
    # The same name and content again is the same benchmark, stored once.
    for name, again in (("classroom-0.1.0", "classroom-0.1.0-again"), ("classroom-0.2.0", "classroom-0.2.0-again"), ("main", "main-again")):
        assert evidence.published[again].created is False
        assert evidence.published[again].benchmark["benchmark_id"] == evidence.published[name].benchmark["benchmark_id"]
        assert evidence.published[again].benchmark["digest"] == evidence.published[name].benchmark["digest"]


def test_the_same_name_with_other_content_is_taken_and_stores_nothing(evidence: Evidence) -> None:
    for name in ("main-taken", "classroom-0.2.0-taken"):
        assert evidence.failures[name].returncode != 0 and "benchmark_name_taken" in output_of(evidence.failures[name])
    assert evidence.benchmark("main")["limits"]["max_model_calls"] == 7 and evidence.benchmark("classroom-0.2.0")["limits"]["max_model_calls"] != 9
    assert len([b for b in evidence.client.benchmarks(PLUGIN, "0.2.0") if b["name"] == "classroom"]) == 1


@pytest.mark.parametrize(
    ("name", "code"), [("too-many-calls", "limit_exceeds_worker"), ("nobody", "worker_unavailable"), ("unpriced", "unknown_model")]
)
def test_limits_above_the_worker_an_unknown_endpoint_and_an_unpriced_model_are_refused_and_store_nothing(name: str, code: str, evidence: Evidence) -> None:
    assert evidence.failures[name].returncode != 0 and code in output_of(evidence.failures[name])
    assert name not in {b["name"] for b in evidence.client.benchmarks()}


# -- the benchmark controls the run -----------------------------------------------------------------------------------------


def test_the_benchmark_not_the_runner_fixes_the_model_the_limits_and_the_cases(evidence: Evidence) -> None:
    benchmark = evidence.benchmark("main")
    assert benchmark["model"] == BENCHMARK_MODEL and {key: benchmark["limits"][key] for key in MAIN_LIMITS} == MAIN_LIMITS
    for name in ("tools-1", "tools-2", "coding", "bob"):
        run = evidence.run(name)
        # Step 2 was given the policy and the ZIP only (support.submit_args), so all of this is the benchmark's.
        assert run["benchmark"] == {"benchmark_id": benchmark["benchmark_id"], "name": "main"}
        assert run["model"] == BENCHMARK_MODEL and run["limits"] == benchmark["limits"] and run["endpoint_profile"] == benchmark["endpoint_profile"]
        assert run["selection"] == {"case_ids": [c["case_id"] for c in benchmark["cases"]]}
    # mockllm saw the benchmark's model on every request it served, and nothing it did not expect.
    calls = evidence.handle.ledger.main_calls
    assert len(calls) == 6 and {call.request.model for call in calls if call.request} == {BENCHMARK_MODEL} and not evidence.handle.ledger.violations


def test_coding_runs_the_benchmarks_template_rendered_per_case(evidence: Evidence) -> None:
    manifest = load_manifest(evidence.plugin_dirs["0.1.0"])
    for name, index in (("coding", 2), ("bob", 3)):
        run = evidence.run(name)
        assert run["prompt"]["source"] == "benchmark" and run["prompt"]["text"] == CODING_TEMPLATE
        [case] = run["cases"]
        expected = CODING_TEMPLATE.format(
            description=manifest.task("probe").description, arguments=json.dumps(case["arguments"], indent=2), workspace="/rush/workspace"
        )
        assert "{ok}" in expected and case["prompt"]["system"] is None and case["prompt"]["user"] == expected
        assert expected in sent(evidence, index, "user")


def test_task_tools_runs_the_benchmarks_instructions_rendered_per_case(evidence: Evidence) -> None:
    manifest = load_manifest(evidence.plugin_dirs["0.1.0"])
    task = type("Task", (), {"description": manifest.task("probe").description, "instructions": TASK_INSTRUCTIONS})()
    for name, index in (("tools-1", 0), ("tools-2", 1)):
        run = evidence.run(name)
        assert run["prompt"]["source"] == "benchmark" and run["prompt"]["text"] == TASK_INSTRUCTIONS
        [case] = run["cases"]
        system, user = task_prompt(manifest, task, case["arguments"])
        assert TASK_INSTRUCTIONS in system and case["prompt"]["system"] == system and case["prompt"]["user"] == user
        assert system in sent(evidence, index, "system") and user in sent(evidence, index, "user")


# -- harness identity -------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["no-name", "no-version"])
def test_a_manifest_without_a_name_or_a_version_is_refused_at_upload(name: str, evidence: Evidence) -> None:
    done = evidence.failures[name]
    assert done.returncode != 0 and "invalid_manifest" in output_of(done)


def test_the_same_zip_runs_again_as_a_new_run_and_the_run_names_the_manifests_harness(evidence: Evidence) -> None:
    first, second = evidence.run("tools-1"), evidence.run("tools-2")
    assert first["run_id"] != second["run_id"]
    assert first["source"]["sha256"] == second["source"]["sha256"] == evidence.sha("a-v1")
    assert first["harness"] == {"name": HARNESS, "version": "1", "dialects": ["chat_completions"]}
    assert evidence.run("coding")["harness"]["version"] == "2"


def test_other_bytes_under_a_taken_harness_version_are_refused_and_another_member_may_use_the_name_and_version(evidence: Evidence) -> None:
    done = evidence.failures["changed-v1"]
    assert done.returncode != 0 and "harness_version_taken" in output_of(done)
    # B's ZIP differs from A's and carries the same name@version: the harness is owned by whoever uploaded it.
    bob = evidence.run("bob")
    assert bob["harness"]["name"] == HARNESS and bob["harness"]["version"] == "1"
    assert evidence.sha("b-v1") != evidence.sha("a-v1")
    assert bob["source"]["sha256"] == evidence.sha("b-v1")


def test_a_call_in_a_dialect_the_manifest_does_not_declare_is_refused_by_the_gateway(evidence: Evidence) -> None:
    run = evidence.run("dialect")
    assert run["dialects"] == ["chat_completions"]
    [attempt] = [a for case in run["cases"] for a in case["attempts"]]
    events = evidence.client.events(attempt["attempt_id"]).events
    rejected = [e["data"] for e in events if e["kind"] == "model_call.rejected"]
    assert [r["code"] for r in rejected] == ["dialect_not_enabled"] and rejected[0]["http_status"] == 404
    assert not [e for e in events if e["kind"] == "model_call.dispatched"]
    # Nothing reached the upstream: the six calls it served are the six other runs'.
    assert len(evidence.handle.ledger.calls) == 6


# -- the case set view ------------------------------------------------------------------------------------------------------


def test_another_member_reads_the_published_case_set_in_order_and_no_private_reference(evidence: Evidence) -> None:
    benchmark_id = evidence.published["view"].benchmark["benchmark_id"]
    response = evidence.b.get(f"/benchmarks/{benchmark_id}")
    assert response.status_code == 200
    detail = response.json()["benchmark"]
    published = evidence.published["view"].publication
    assert detail["context"] == CONTEXT == published["context"]
    assert detail["task_id"] == "probe" and detail["task"]["kind"] == "agent" and detail["task"]["description"] == published["task"]["description"]
    expected = [
        {"kind": "answer", "arguments": {"token": "alpha", "wait_seconds": 0}, "expected_error": None},
        {"kind": "answer", "arguments": {"token": "beta", "wait_seconds": 0}, "expected_error": None},
        {"kind": "refuse", "arguments": {"token": "refuse-valid", "wait_seconds": 0}, "expected_error": "has no digest"},
    ]
    assert [{key: case[key] for key in ("kind", "arguments", "expected_error")} for case in detail["cases"]] == expected
    assert [case["position"] for case in detail["cases"]] == [0, 1, 2]
    assert [{key: case[key] for key in ("kind", "arguments", "expected_error")} for case in published["cases"]] == expected
    # No private reference (the digests the reference tool computes, or the private section) appears in any response about the benchmark.
    for text in (response.text, evidence.b.get("/benchmarks").text, evidence.b.get(f"/benchmarks/{benchmark_id}/results").text):
        assert support.REFERENCE not in text and hashlib.sha256(b"beta").hexdigest()[:12] not in text and "private" not in text.lower()


# -- stats and results ------------------------------------------------------------------------------------------------------


def test_a_benchmark_counts_every_members_runs_and_distinct_runners(evidence: Evidence) -> None:
    main = evidence.benchmark("main")
    assert (main["run_count"], main["runner_count"]) == (4, 2)
    listed = {b["benchmark_id"]: b for b in evidence.client.benchmarks(PLUGIN, "0.1.0")}
    assert (listed[main["benchmark_id"]]["run_count"], listed[main["benchmark_id"]]["runner_count"]) == (4, 2)
    assert (evidence.benchmark("view")["run_count"], evidence.benchmark("view")["runner_count"]) == (0, 0)


def test_all_results_group_by_member_and_harness_version_with_the_policies_apart(evidence: Evidence) -> None:
    results = evidence.results["all-main"]
    assert (
        results.scope == "all"
        and results.benchmark["name"] == "main"
        and (results.benchmark["run_count"], results.benchmark["runner_count"]) == (4, 2)
    )
    coding, tools = results.sections
    assert (coding.policy, tools.policy) == ("coding", "task_tools")
    assert {(g.user["id"], g.harness): [r["run_id"] for r in g.runs] for g in coding.groups} == {
        (evidence.rush.user_id, f"{HARNESS}@2"): [evidence.runs["coding"].run_id],
        (evidence.b.user_id, f"{HARNESS}@1"): [evidence.runs["bob"].run_id],
    }
    assert {(g.user["id"], g.harness): [r["run_id"] for r in g.runs] for g in tools.groups} == {
        (evidence.rush.user_id, f"{HARNESS}@1"): [evidence.runs["tools-2"].run_id, evidence.runs["tools-1"].run_id],
    }  # newest first
    assert {row["policy"] for group in coding.groups for row in group.runs} == {"coding"} and {
        row["policy"] for group in tools.groups for row in group.runs
    } == {"task_tools"}


def test_mine_lists_only_the_callers_runs(evidence: Evidence) -> None:
    mine_a, mine_b = evidence.results["mine-a"], evidence.results["mine-b"]
    assert mine_a.scope == "mine" and mine_a.benchmark is None
    own = {name: evidence.runs[name].run_id for name in ("tools-1", "tools-2", "coding", "classroom-0.2.0", "dialect", "classroom-0.1.0")}
    assert {row["run_id"] for row in rows(mine_a)} == set(own.values())
    assert {row["user"]["id"] for row in rows(mine_a)} == {evidence.rush.user_id}
    assert [row["run_id"] for row in rows(mine_b)] == [evidence.runs["bob"].run_id] and {row["user"]["id"] for row in rows(mine_b)} == {
        evidence.b.user_id
    }


def test_a_member_sees_the_other_members_row_but_nothing_behind_it(evidence: Evidence) -> None:
    bob_row = next(row for row in rows(evidence.results["all-main"]) if row["run_id"] == evidence.runs["bob"].run_id)
    mine = next(row for row in rows(evidence.results["all-main"]) if row["run_id"] == evidence.runs["coding"].run_id)
    assert set(bob_row) == set(mine) == SUMMARY_FIELDS
    assert bob_row["user"]["id"] == evidence.b.user_id and mine["user"]["id"] == evidence.rush.user_id
    assert bob_row["user"]["name"] and mine["user"]["name"] and bob_row["user"]["name"] != mine["user"]["name"]
    assert bob_row["harness"] == {"name": HARNESS, "version": "1"} and bob_row["plugin"]["id"] == PLUGIN and bob_row["plugin"]["version"] == "0.1.0"
    # No source sha256 in the rows, in the raw results, or in the listing, of anyone's ZIP.
    main_id = evidence.published["main"].benchmark["benchmark_id"]
    raw = evidence.a.get(f"/benchmarks/{main_id}/results").text + evidence.a.get("/runs").text
    assert not [name for name in ("a-v1", "a-v2", "b-v1") if evidence.sha(name) in raw]
    assert "source" not in bob_row
    # A's own view of B's run, attempts and events is 404, and so are the records' texts.
    bob_run = evidence.runs["bob"]
    attempt = bob_run.attempts[0].attempt_id
    for path in (f"/runs/{bob_run.run_id}", f"/attempts/{attempt}", f"/attempts/{attempt}/events", f"/attempts/{attempt}/accounting"):
        assert evidence.a.get(path).status_code == 404, path


# -- run summaries ----------------------------------------------------------------------------------------------------------


def test_total_tokens_are_the_scripted_usage_and_elapsed_time_is_positive(evidence: Evidence) -> None:
    for name, key in (("tools-1", "tools-1"), ("tools-2", "tools-2"), ("coding", "coding"), ("bob", "bob"), ("classroom-0.2.0", "classroom-0.2.0")):
        prompt, completion = USAGE[key]
        run = evidence.run(name)
        assert run["metrics"]["total_tokens"] == {"total": prompt + completion, "missing_attempts": 0}, name
        assert run["metrics"]["elapsed_ms"]["total"] > 0 and run["metrics"]["elapsed_ms"]["missing_attempts"] == 0
    row = next(row for row in rows(evidence.results["all-main"]) if row["run_id"] == evidence.runs["tools-1"].run_id)
    assert row["metrics"]["total_tokens"] == {"total": 320, "missing_attempts": 0} and row["metrics"]["elapsed_ms"]["total"] > 0
    assert row["status"] == "complete" and row["model"] == BENCHMARK_MODEL and row["policy"] == "task_tools"


def test_an_attempt_that_reported_no_usage_is_counted_missing_not_summed(evidence: Evidence) -> None:
    run = evidence.run("classroom-0.1.0")
    assert run["metrics"]["total_tokens"] == {"total": 0, "missing_attempts": 1}
    assert run["metrics"]["elapsed_ms"]["missing_attempts"] == 0
    row = next(row for row in rows(evidence.results["all-classroom-0.1.0"]) if row["run_id"] == evidence.runs["classroom-0.1.0"].run_id)
    assert row["metrics"]["total_tokens"] == {"total": 0, "missing_attempts": 1}


def test_list_rows_equal_the_run_detail(evidence: Evidence) -> None:
    listed = {row["run_id"]: row for row in evidence.client.list_runs(200)}
    assert set(listed) == {evidence.runs[name].run_id for name in evidence.runs if name != "bob"}
    for name in evidence.runs:
        if name == "bob":
            continue
        run, row = evidence.run(name), listed[evidence.runs[name].run_id]
        assert row["metrics"] == run["metrics"] and row["status"] == run["status"] and row["score"] == run["score"]
        assert (
            row["harness"] == {key: run["harness"][key] for key in ("name", "version")}
            and row["policy"] == run["policy"]
            and row["model"] == run["model"]
        )
    # step 5's rows are the same summaries.
    assert {row["run_id"]: row["metrics"] for row in rows(evidence.results["mine-a"])} == {run_id: row["metrics"] for run_id, row in listed.items()}


# -- plugin versions --------------------------------------------------------------------------------------------------------


def test_versions_separate_their_runs_and_counts(evidence: Evidence) -> None:
    old, new, main = (rows(evidence.results[name]) for name in ("all-classroom-0.1.0", "all-classroom-0.2.0", "all-main"))
    assert [row["run_id"] for row in old] == [evidence.runs["classroom-0.1.0"].run_id]
    assert {row["run_id"] for row in new} == {evidence.runs["classroom-0.2.0"].run_id, evidence.runs["dialect"].run_id}
    assert {row["plugin"]["version"] for row in old} == {"0.1.0"} and {row["plugin"]["version"] for row in new} == {"0.2.0"}
    assert not {row["run_id"] for row in old + new} & {row["run_id"] for row in main}
    assert (evidence.benchmark("classroom-0.1.0")["run_count"], evidence.benchmark("classroom-0.2.0")["run_count"]) == (1, 2)
    assert evidence.benchmark("classroom-0.2.0")["runner_count"] == evidence.benchmark("classroom-0.1.0")["runner_count"] == 1


def test_an_old_plugin_version_runs_from_its_stored_package_while_a_newer_one_is_installed(evidence: Evidence) -> None:
    latest = {b["plugin"]["version"] for b in evidence.client.benchmarks(PLUGIN)}
    assert latest == {"0.1.0", "0.2.0"}
    run = evidence.run("classroom-0.1.0")
    assert run["status"] == "complete" and run["case_set"]["plugin"]["version"] == "0.1.0"
    assert run["case_set"]["plugin"]["sha256"] == hashlib.sha256(evidence.packages["0.1.0"]).hexdigest()
    assert run["cases"][0]["attempts"][0]["execution"]["status"] != "build_failed"
    assert evidence.run("classroom-0.2.0")["case_set"]["plugin"]["sha256"] == hashlib.sha256(evidence.packages["0.2.0"]).hexdigest()


def test_compare_accepts_runs_of_one_benchmark_and_refuses_other_plugin_versions(evidence: Evidence) -> None:
    first, second = evidence.runs["tools-1"].run_id, evidence.runs["tools-2"].run_id
    evidence.cli.step("4", "compare", evidence.run_dir / "step4-same", f"run_a={first}", f"run_b={second}")
    comparison = load_layout(evidence.run_dir / "step4-same", step4_compare.CompareLayout).comparison.runs
    assert comparison is not None and not [item for item in comparison["config"] if item["differs"] and item["field"] == "benchmark_id"]
    across = evidence.runs["classroom-0.2.0"].run_id
    done = evidence.cli.step("4", "compare", evidence.run_dir / "step4-across", f"run_a={first}", f"run_b={across}", check=False)
    assert done.returncode != 0 and "not_same_verifier" in output_of(done)
    with pytest.raises(BenchmarkError) as error:
        evidence.client.compare_runs(first, across)
    assert (error.value.status, error.value.code) == (409, "not_same_verifier") and error.value.body["differing"] == ["package_sha256"]


# -- reference harnesses ----------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def references(evidence: Evidence) -> dict[str, Any]:
    """Step 2 with ``reference:`` twice, and with a plain upload named like a reference, on a benchmark of its own. The worker is stopped by
    now, so the two runs stay queued: a reference is built by the worker in the worker container only when it runs, and these gates check the upload and the
    preview. The capabilities are advertised again, as the worker's claims did before it stopped."""
    evidence.rush.advertise("mock", internet_access=False, models=(support.MODEL, BENCHMARK_MODEL))
    # The market's latest is 0.2.0 by now (the classroom runs published it), and step 1 publishes for the latest package.
    version = "0.2.0"
    gate.publish_benchmark(
        evidence.cli, evidence.run_dir / "step1-reference", name="reference-probe", cases=evidence.run_dir / "main.json", model=BENCHMARK_MODEL, plugin_version=version
    )

    def submit(name: str, key: str, **options: Any) -> Any:
        return gate.submit(
            evidence.cli, evidence.run_dir / f"step2-{name}", "reference-probe", plugin=PLUGIN, plugin_version=version, key=key, follow=False, policy="coding", **options
        )

    return {
        "reserved": submit("reserved", "pb-reserved", source=evidence.run_dir / "reserved", check=False),
        "ref-1": submit("ref-1", "pb-ref-1", source=None, reference="claude-code"),
        "ref-2": submit("ref-2", "pb-ref-2", source=None, reference="claude-code"),
    }


def test_an_upload_named_like_a_reference_harness_is_refused(references: dict[str, Any]) -> None:
    done = references["reserved"]
    assert done.returncode != 0 and "reserved_harness_name" in output_of(done)


def test_a_reference_is_uploaded_under_its_own_name_and_a_version_derived_from_its_content_each_time(references: dict[str, Any]) -> None:
    derived = yaml.safe_load(zipfile.ZipFile(io.BytesIO(build_reference("claude-code"))).read("harness.yaml"))["version"]
    first, second = references["ref-1"], references["ref-2"]
    assert first.harness == second.harness == {"name": "claude-code", "version": derived, "dialects": ["anthropic_messages"]}
    assert first.run_id != second.run_id
