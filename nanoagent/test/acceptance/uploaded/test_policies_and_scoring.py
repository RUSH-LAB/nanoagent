"""CLI acceptance gate: benchmarks, prompts, both participant policies, verdicts, limits and digests.

One probe-behaviors harness (harnesses/probe_behaviors) does what each case's input token says and writes its result through
the policy's channel (`answer.json` under `coding`, `RUSH_RESULT` under `task_tools`), so the same pinned cases and the same
scripted outputs run through the real worker, sandbox, gateway, plugin verifier and server under each policy. Every call goes
through the CLI steps (1: publish a benchmark, 2: submit a run) plus the member API reads the web app does.

Covers (docs/plans/uploaded-harness-benchmarks.md, "End-to-end acceptance"): answer and refusal cases; refusal error mismatch, invalid input and
a case file with no cases at publication; a task with no reference; verifier rejection (a crashing verifier); harness failure;
timeout; the benchmark's cases in order; the exact rendered prompt of both policies (default and custom); broker
tools under task_tools and none under coding; `answer.json` reading (valid, refused, missing, invalid); identical references and
verdicts under both policies; gateway-only model accounting; default and explicit limits; package digests.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_policies_and_scoring.py -m uploaded_acceptance
"""

from __future__ import annotations

import hashlib
import json
import sys
import uuid
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
import step2_submit_run  # noqa: E402
import step4_compare  # noqa: E402
import support  # noqa: E402
from mockllm import MockProvider, RunHandle, load_scenario  # noqa: E402
from rush_server import RushServer, psql, rush_server, unavailable  # noqa: E402
from slimconfig import load_layout, output_schema  # noqa: E402
from support import Cli  # noqa: E402

from nanoagent.plugin import load_manifest  # noqa: E402
from nanoagent.plugin.package import pack  # noqa: E402
from nanoagent.plugin.tasks import task_prompt  # noqa: E402
from nanoagent.uploaded.client import BenchmarkClient, BenchmarkError  # noqa: E402

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

REF, NOREF, EGRESS = "probe-ref", "probe-noref", "probe-egress"
HOSTS = ("api.example.com", "data.example.org")
CONTEXT = "  Synthetic context: no data source.  "
TEMPLATE_YAML = NANOAGENT / "examples" / "benchmark" / "configs" / "step2_single_run.yaml"
TIMEOUT_MS = 15000

ANSWERS = ["correct-model", "wrong-answer", "invalid-answer", "decline-answerable", "zero-model", "missing-result", "malformed-result", "harness-failure", "verifier-crash"]
REFUSALS = ["refuse-valid", "refuse-answered"]
# (token, verdict, explanation code): identical under both policies, since the same scripted output is judged by the same verifier.
VERDICTS = {
    "correct-model": ("pass", None),
    "wrong-answer": ("fail", None),
    "invalid-answer": ("fail", "invalid_answer"),
    "decline-answerable": ("fail", "refused_answer_case"),
    "zero-model": ("pass", None),
    "missing-result": ("fail", "execution_failed"),
    "malformed-result": ("fail", "execution_failed"),
    "harness-failure": ("fail", "execution_failed"),
    "verifier-crash": (None, None),
    "refuse-valid": ("pass", None),
    "refuse-answered": ("fail", "answered_refusal_case"),
}
VARIANTS = ["blank-refusal", "array-result", "symlink-result"]  # answer.json shapes the reader refuses
DISK_LIMITS = {"tmp_bytes": 1 << 20, "workspace_bytes": 2 << 20, "workspace_files": 50, "build_tmp_bytes": 256 << 20, "build_wall_ms": 300_000}
CUSTOM_TEMPLATE = "Custom coding prompt for {description}.\nInput: {arguments}\nSchema: {output_schema}\nWrite {workspace}/answer.json; literal braces {{ok}}."
CUSTOM_INSTRUCTIONS = "Custom instructions: submit the digest of the token."


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:12]


@dataclass
class Evidence:
    rush: RushServer
    cli: Cli
    client: BenchmarkClient
    handle: RunHandle
    run_dir: Path
    source: Path
    packages: dict[str, bytes]
    published: dict[str, Any]  # benchmark name -> step 1's report
    ids: dict[str, list[str]]  # benchmark name -> its case ids
    reports: dict[str, Any]  # step 2 reports by run name
    runs: dict[str, dict[str, Any]]  # the member API's runs by name
    compares: dict[str, Any]  # step 4's run comparisons by name
    events: dict[str, list[dict[str, Any]]]  # attempt id -> events
    worker_log: str
    member_text: str
    private_rows: str

    def case(self, run: str, token: str) -> dict[str, Any]:
        [case] = [c for c in self.runs[run]["cases"] if c["arguments"]["token"] == token]
        return case

    def attempt(self, run: str, token: str) -> dict[str, Any]:
        return self.case(run, token)["attempts"][0]

    def harness_log(self, run: str, token: str, index: int = 0) -> dict[str, Any]:
        """What the harness reported: the ``index``th `log` event it emitted for the case (the first is what it was given)."""
        attempt_id = self.attempt(run, token)["attempt_id"]
        events = [e for e in self.events[attempt_id] if e["kind"] == "harness.event" and e["data"]["event"] == "log"]
        return json.loads(json.loads(self.client.payload(attempt_id, events[index]["data"]["event_sha256"]).data)["message"])


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        yield server


def member_text(client: BenchmarkClient, runs: list[dict[str, Any]], events: dict[str, list[dict[str, Any]]]) -> str:
    """Every member API response for these runs (defaults, benchmarks, runs, attempts, events, spans, accounting, payloads) as text."""
    parts = [json.dumps(client.defaults()), json.dumps(client.benchmarks()), json.dumps(client.list_runs())]
    for run in runs:
        parts.append(json.dumps(run))
        for case in run["cases"]:
            for attempt in case["attempts"]:
                attempt_id = attempt["attempt_id"]
                log = client.events(attempt_id)
                events[attempt_id] = log.events
                parts += [json.dumps(client.attempt(attempt_id)), json.dumps(log.events), json.dumps(client.spans(attempt_id)), json.dumps(client.accounting(attempt_id))]
                for sha in sorted({d for event in log.events for d in event.get("payload_sha256s", [])}):
                    parts.append(client.payload(attempt_id, sha).data.decode("utf-8", errors="replace"))
    return "\n".join(parts)


@pytest.fixture(scope="module")
def evidence(rush: RushServer) -> Iterator[Evidence]:
    run_dir = support.SCRATCH / f"policies-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True)
    cli = Cli(rush.base_url, rush.workspace_id, rush.token, support.FINAL / "policies-and-scoring" / run_dir.name, rush.user_id)
    client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
    packages = {}
    for plugin_id, options in ((REF, {"crash_token": True}), (NOREF, {"no_reference": True}), (EGRESS, {"hosts": HOSTS})):
        folder = plugins.variant(run_dir / f"plugin-{plugin_id}", plugin_id=plugin_id, **options)
        packages[plugin_id] = pack(folder)
        rush.seed_plugin(packages[plugin_id])
    ids = {
        "mix": gate.cases_file(run_dir / "mix.json", REF, ANSWERS, REFUSALS, CONTEXT),
        "mix-custom": gate.cases_file(run_dir / "mix-custom.json", REF, ANSWERS[:1], [], CONTEXT),
        "noref": gate.cases_file(run_dir / "noref.json", NOREF, ["correct-model", "wrong-answer"], [], CONTEXT),
        "kill": gate.cases_file(run_dir / "kill.json", REF, ["timeout"], [], CONTEXT),
        "egress": gate.cases_file(run_dir / "egress.json", EGRESS, ["correct-model"], [], CONTEXT),
        # The same two cases as mix's first two, in the other order: other case ids, the same content.
        "mix2": gate.cases_file(run_dir / "mix2.json", REF, ["wrong-answer", "correct-model"], [], CONTEXT),
        "net": gate.cases_file(run_dir / "net.json", REF, ["network"], [], CONTEXT),
        "calls": gate.cases_file(run_dir / "calls.json", REF, ["many-calls"], [], CONTEXT),
        "disk": gate.cases_file(run_dir / "disk.json", REF, ["fill-disk"], [], CONTEXT),
        "variants": gate.cases_file(run_dir / "variants.json", REF, VARIANTS, [], CONTEXT),
    }
    # A benchmark is one case set and one run configuration, so every configuration a run is held to is a benchmark of its own: the
    # same cases file published under another name and limits (or prompts). name -> (cases file, plugin, options)
    benchmarks: dict[str, tuple[str, str, dict[str, Any]]] = {
        "mix": ("mix", REF, {}),
        "mix-custom": ("mix-custom", REF, {"template": CUSTOM_TEMPLATE, "instructions": CUSTOM_INSTRUCTIONS}),
        "noref": ("noref", NOREF, {}),
        "kill": ("kill", REF, {"limits": {"wall_time_ms": TIMEOUT_MS}}),
        "egress": ("egress", EGRESS, {}),
        "egress-limits": (
            "egress", EGRESS, {"limits": {"wall_time_ms": 120_000, "max_model_calls": 7, "max_output_tokens_per_call": 123, "max_cost_usd": 0.5, "memory_mb": 512, "pids": 128}},
        ),
        "mix2": ("mix2", REF, {}),
        "calls": ("calls", REF, {"limits": {"max_model_calls": 2}}),
        # Volume overrides, applied to the harness's /tmp and workspace; a build wall time no build can meet.
        "disk": ("disk", REF, {"limits": DISK_LIMITS}),
        "build-limit": ("disk", REF, {"limits": {"build_wall_ms": 1}}),
        "variants": ("variants", REF, {}),
    }

    def publish(name: str) -> Any:
        cases, _, options = benchmarks[name]
        return gate.publish_benchmark(cli, run_dir / f"step1-{name}", name=name, cases=run_dir / f"{cases}.json", **options)

    published = {name: publish(name) for name in benchmarks}
    source = gate.behaviors_source(run_dir / "source")
    (run_dir / "registry").mkdir()
    with support.serve_directory(run_dir / "registry") as index, MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "side-calls-only.yaml"), harness="nanoagent", model=support.MODEL)
        worker = gate.start_worker("policies", rush.base_url, cli, run_dir, upstream=handle.base_url, index=index)
        reports: dict[str, Any] = {}
        try:
            plan = {
                "coding": ("mix", "coding"),
                "tools": ("mix", "task_tools"),
                "coding-custom": ("mix-custom", "coding"),
                "tools-custom": ("mix-custom", "task_tools"),
                "noref": ("noref", "coding"),
                "timeout": ("kill", "coding"),
                "limits": ("egress-limits", "task_tools"),
                "coding-egress": ("egress", "coding"),
                "calls": ("calls", "coding"),
                "disk": ("disk", "coding"),
                "build-limit": ("build-limit", "coding"),
                "variants": ("variants", "coding"),
            }
            for name, (benchmark, policy) in plan.items():
                reports[name] = gate.submit(cli, run_dir / f"step2-{name}", benchmark, plugin=benchmarks[benchmark][1], key=f"policies-{name}", source=source, policy=policy, follow_timeout=1500)
        finally:
            worker.stop()
        # A second worker with internet access for harnesses (its claim advertises it): the same harness on and off the internet.
        internet = gate.start_worker("policies-net", rush.base_url, cli, run_dir, upstream=handle.base_url, index=index, egress=True)
        try:
            internet.wait_for("/claim", 900)
            # Only now can a benchmark with internet access be published: the worker's capabilities say it can give it.
            benchmarks |= {"net-on": ("net", REF, {"limits": {"internet_access": True}}), "net-off": ("net", REF, {})}
            published |= {name: publish(name) for name in ("net-on", "net-off")}
            for name, (benchmark, policy) in {"reorder": ("mix2", "coding"), "net-on": ("net-on", "coding"), "net-off": ("net-off", "coding")}.items():
                reports[name] = gate.submit(cli, run_dir / f"step2-{name}", benchmark, plugin=REF, key=f"policies-{name}", source=source, policy=policy, follow_timeout=1500)
        finally:
            internet.stop()
        compares = {}
        for name, (a, b) in {"policies": ("coding", "tools"), "prompt": ("coding", "coding-custom"), "aligned": ("coding", "reorder"), "internet": ("net-on", "net-off")}.items():
            cli.step("4", "compare", run_dir / f"step4-{name}", f"run_a={reports[a].run_id}", f"run_b={reports[b].run_id}")
            compares[name] = load_layout(run_dir / f"step4-{name}", step4_compare.CompareLayout).comparison.runs
        runs = {name: client.run(report.run_id) for name, report in reports.items()}
        events: dict[str, list[dict[str, Any]]] = {}
        text = member_text(client, list(runs.values()), events)
        private = psql(rush.database, "select reference::text from benchmark_run_private")
        # Keep the stored evidence the assertions read, beside the step logs.
        kept = support.FINAL / "policies-and-scoring" / "evidence"
        kept.mkdir(parents=True, exist_ok=True)
        (kept / "runs.json").write_text(json.dumps(runs, indent=1))
        (kept / "run-comparisons.json").write_text(json.dumps(compares, indent=1))
        (kept / "attempt-events.json").write_text(json.dumps(events, indent=1))
        yield Evidence(rush, cli, client, handle, run_dir, source, packages, published, ids, reports, runs, compares, events, worker.text(), text, private)


KEPT = support.FINAL / "policies-and-scoring" / "evidence"


# -- the plugin's own view of a case, to compute the expected prompts independently of the server ------------------------


def manifest_of(evidence: Evidence, plugin_id: str) -> Any:
    return load_manifest(evidence.run_dir / f"plugin-{plugin_id}")


def expected_coding(evidence: Evidence, case: dict[str, Any], template: str | None = None) -> str:
    """The coding prompt as `other_work` of the local workflow formats it, with the workspace the harness sees."""
    task = manifest_of(evidence, REF).task("probe")
    template = template or yaml.safe_load(TEMPLATE_YAML.read_text())["prompt"]
    return template.format(
        description=task.description,
        context=CONTEXT.strip(),
        arguments=json.dumps(case["arguments"], indent=2),
        input_schema=json.dumps(output_schema(task.input_type), indent=2),
        output_schema=json.dumps(output_schema(task.output_type), indent=2),
        workspace="/rush/workspace",
    )


def expected_task_tools(evidence: Evidence, case: dict[str, Any], instructions: str | None = None) -> tuple[str, str]:
    manifest = manifest_of(evidence, REF)
    task = manifest.task("probe")
    if instructions is not None:
        task = type("Task", (), {"description": task.description, "instructions": instructions})()
    return task_prompt(manifest, task, case["arguments"])


def sha_of_prompt(system: str | None, user: str | None) -> str:
    return hashlib.sha256(json.dumps({"system": system, "user": user}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def first_user_messages(evidence: Evidence) -> list[tuple[str | None, str | None]]:
    out = []
    for call in evidence.handle.ledger.calls:
        if call.request is None:
            continue
        system = [m["content"] for m in call.request.messages if m["role"] == "system"]
        user = [m["content"] for m in call.request.messages if m["role"] == "user"]
        out.append((system[0] if system else None, user[0] if user else None))
    return out


# -- publication ------------------------------------------------------------------------------------------------------------


def benchmark_of(evidence: Evidence, name: str) -> dict[str, Any]:
    """The member API's view of a published benchmark, its case set included."""
    return evidence.client.benchmark(evidence.published[name].benchmark["benchmark_id"])


def test_a_published_benchmark_is_derived_from_the_package_and_the_cases(evidence: Evidence) -> None:
    mix = benchmark_of(evidence, "mix")
    assert mix["plugin"]["id"] == REF and mix["task_id"] == "probe" and mix["task"]["kind"] == "agent"
    assert [(c["case_id"], c["kind"]) for c in mix["cases"]] == [(i, "answer") for i in evidence.ids["mix"][: len(ANSWERS)]] + [(i, "refuse") for i in evidence.ids["mix"][len(ANSWERS) :]]
    assert [c["expected_error"] for c in mix["cases"][len(ANSWERS) :]] == ["has no digest"] * len(REFUSALS)
    # The agent's tools are the task's, the reference tool (digest) excluded; the plugin declares no hosts.
    assert [tool["name"] for tool in mix["task"]["tools"]] == ["wait"] and mix["task"]["egress_hosts"] == []
    assert mix["context"] == CONTEXT
    # The run configuration is the benchmark's: the model, the endpoint and every limit pinned with internet access off.
    assert (mix["model"], mix["endpoint_profile"]) == (support.MODEL, "mock") and mix["limits"]["internet_access"] is False
    # Private references appear in no member response.
    assert "private" not in json.dumps(mix) and digest("correct-model") not in json.dumps(mix)
    assert evidence.published["mix"].created is True
    assert evidence.published["egress"].benchmark["name"] == "egress"
    assert benchmark_of(evidence, "egress")["task"]["egress_hosts"] == sorted(HOSTS)


def test_the_package_digest_is_the_published_plugins_everywhere(evidence: Evidence) -> None:
    for name, plugin_id in (("mix", REF), ("noref", NOREF), ("egress", EGRESS)):
        expected = hashlib.sha256(evidence.packages[plugin_id]).hexdigest()
        benchmark = benchmark_of(evidence, name)
        assert benchmark["plugin"]["sha256"] == expected
        run = evidence.runs[{"mix": "coding", "noref": "noref", "egress": "coding-egress"}[name]]
        assert run["case_set"]["plugin"]["sha256"] == expected and run["case_set"]["digest"] == benchmark["case_set_digest"]
    # The uploaded source is identified by the digest of its bytes, and every run of it records the same one.
    source_sha = hashlib.sha256(step2_submit_run.zip_source(str(evidence.source))).hexdigest()
    assert {run["source"]["sha256"] for run in evidence.runs.values()} == {source_sha}


def test_republishing_the_same_benchmark_is_not_a_new_one_and_a_name_with_other_content_is_taken(evidence: Evidence) -> None:
    again = gate.publish_benchmark(evidence.cli, evidence.run_dir / "step1-mix-again", name="mix", cases=evidence.run_dir / "mix.json")
    assert again.created is False
    assert again.benchmark["benchmark_id"] == evidence.published["mix"].benchmark["benchmark_id"] and again.benchmark["digest"] == evidence.published["mix"].benchmark["digest"]
    taken = gate.publish_benchmark(evidence.cli, evidence.run_dir / "step1-mix-taken", name="mix", cases=evidence.run_dir / "mix.json", limits={"max_model_calls": 3}, check=False)
    assert taken.returncode != 0 and "benchmark_name_taken" in taken.stdout + taken.stderr


@pytest.mark.parametrize(
    ("name", "cases", "message"),
    [
        ("refusal-mismatch", {"refuse": [{"arguments": {"token": "refuse-x", "wait_seconds": 0}, "reference_error": "some other error"}]}, "rejected"),
        ("invalid-input", {"answer": [{"token": 5, "wait_seconds": 0}]}, "do not fit the input"),
        ("no-cases", {"answer": [], "refuse": []}, "has no cases"),
        ("refuses-an-answerable-case", {"refuse": [{"arguments": {"token": "alpha", "wait_seconds": 0}, "reference_error": "has no digest"}]}, "a case to refuse"),
    ],
)
def test_a_case_file_the_plugin_cannot_judge_is_refused_before_anything_is_published(name: str, cases: dict[str, Any], message: str, evidence: Evidence) -> None:
    path = evidence.run_dir / f"{name}.json"
    path.write_text(json.dumps({"_": "step2_single_run.Cases", "plugin": REF, "task": "probe", "context": "x", "answer": [], "refuse": [], **cases}))
    done = gate.publish_benchmark(evidence.cli, evidence.run_dir / f"step1-{name}", name=f"bad-{name}", cases=path, check=False)
    assert done.returncode != 0 and message in done.stdout + done.stderr, done.stdout + done.stderr
    assert f"bad-{name}" not in {b["name"] for b in evidence.client.benchmarks()}


def test_a_task_without_a_reference_tool_cannot_pin_a_case_to_refuse(evidence: Evidence) -> None:
    path = evidence.run_dir / "noref-refuse.json"
    gate.cases_file(path, NOREF, [], ["refuse-valid"], CONTEXT)
    done = gate.publish_benchmark(evidence.cli, evidence.run_dir / "step1-noref-refuse", name="noref-refuse", cases=path, check=False)
    assert done.returncode != 0 and "has no reference tool" in done.stdout + done.stderr
    # The no-reference answer cases pin no reference at all: the server holds null for each.
    published = benchmark_of(evidence, "noref")
    assert [c["kind"] for c in published["cases"]] == ["answer", "answer"]


# -- cases --------------------------------------------------------------------------------------------------------------------


def test_a_run_has_every_case_of_its_benchmark_in_the_benchmarks_order(evidence: Evidence) -> None:
    coding, tools = evidence.runs["coding"], evidence.runs["tools"]
    assert coding["selection"] == {"case_ids": evidence.ids["mix"]} == tools["selection"]
    assert [c["case_id"] for c in coding["cases"]] == [c["case_id"] for c in tools["cases"]] == evidence.ids["mix"]
    assert [c["kind"] for c in coding["cases"]] == ["answer"] * len(ANSWERS) + ["refuse"] * len(REFUSALS)
    assert [c["case_id"] for c in evidence.runs["coding-custom"]["cases"]] == evidence.ids["mix-custom"] == evidence.ids["mix"][:1]
    assert {c["content_digest"] for c in coding["cases"]} == {c["content_digest"] for c in tools["cases"]}
    # The benchmark's case set view lists the same cases in the same order, and a run's step 2 wrote it beside its report.
    assert [c["case_id"] for c in benchmark_of(evidence, "mix")["cases"]] == evidence.ids["mix"]
    case_set = load_layout(evidence.run_dir / "step2-coding", step2_submit_run.RunLayout).case_set
    assert [c["case_id"] for c in case_set.cases] == evidence.ids["mix"] and case_set.name == "mix" and case_set.context == CONTEXT


def test_a_preview_of_an_unknown_benchmark_is_rejected(evidence: Evidence) -> None:
    with pytest.raises(BenchmarkError) as error:
        evidence.client.preview("00000000-0000-4000-8000-000000000000", "coding")
    assert (error.value.status, error.value.code) == (404, "unknown_benchmark")


# -- prompts ------------------------------------------------------------------------------------------------------------------


def test_the_coding_default_template_renders_exactly_and_the_harness_sent_it(evidence: Evidence) -> None:
    run = evidence.runs["coding"]
    assert run["prompt"]["source"] == "benchmark" and run["prompt"]["text"] == yaml.safe_load(TEMPLATE_YAML.read_text())["prompt"]
    for case in run["cases"]:
        expected = expected_coding(evidence, case)
        assert case["prompt"] == {"system": None, "user": expected, "sha256": sha_of_prompt(None, expected)}, case["case_id"]
    # The model saw exactly these texts: one user message, no system message, byte for byte.
    sent = first_user_messages(evidence)
    for case in run["cases"]:
        if case["arguments"]["token"] != "zero-model":
            assert (None, case["prompt"]["user"]) in sent, case["case_id"]


def test_a_custom_coding_template_is_rendered_with_str_format_semantics(evidence: Evidence) -> None:
    run = evidence.runs["coding-custom"]
    assert run["prompt"]["source"] == "benchmark" and run["prompt"]["text"] == CUSTOM_TEMPLATE
    [case] = run["cases"]
    expected = expected_coding(evidence, case, CUSTOM_TEMPLATE)
    assert "{ok}" in expected and case["prompt"]["user"] == expected and case["prompt"]["system"] is None
    assert (None, expected) in first_user_messages(evidence)


def test_the_task_tools_default_instructions_render_the_agent_prompt_exactly(evidence: Evidence) -> None:
    run = evidence.runs["tools"]
    assert run["prompt"]["source"] == "benchmark"
    for case in run["cases"]:
        system, user = expected_task_tools(evidence, case)
        assert case["prompt"] == {"system": system, "user": user, "sha256": sha_of_prompt(system, user)}, case["case_id"]
        if case["arguments"]["token"] != "zero-model":
            assert (system, user) in first_user_messages(evidence), case["case_id"]
    assert run["prompt"]["text"] == manifest_of(evidence, REF).task("probe").instructions


def test_custom_task_tools_instructions_replace_the_tasks(evidence: Evidence) -> None:
    run = evidence.runs["tools-custom"]
    assert run["prompt"]["source"] == "benchmark" and run["prompt"]["text"] == CUSTOM_INSTRUCTIONS
    [case] = run["cases"]
    system, user = expected_task_tools(evidence, case, CUSTOM_INSTRUCTIONS)
    assert CUSTOM_INSTRUCTIONS in system and case["prompt"]["system"] == system and case["prompt"]["user"] == user
    assert (system, user) in first_user_messages(evidence)


def test_the_two_policies_pin_the_same_cases_with_different_prompts(evidence: Evidence) -> None:
    coding, tools = evidence.runs["coding"], evidence.runs["tools"]
    assert [c["content_digest"] for c in coding["cases"]] == [c["content_digest"] for c in tools["cases"]]
    assert all(a["prompt"]["sha256"] != b["prompt"]["sha256"] for a, b in zip(coding["cases"], tools["cases"], strict=True))


# -- broker tools -------------------------------------------------------------------------------------------------------------


def test_broker_tools_are_given_under_task_tools_and_absent_under_coding(evidence: Evidence) -> None:
    assert evidence.harness_log("tools", "correct-model")["tools"] == ["wait"]
    assert evidence.harness_log("coding", "correct-model")["tools"] == []
    for token in ("correct-model", "wrong-answer"):
        for name, expected in (("tools", True), ("coding", False)):
            attempt = evidence.attempt(name, token)
            sources = set(evidence.events[attempt["attempt_id"]][0]["data"].get("expected_sources", []))
            kinds = {e["source"] for e in evidence.events[attempt["attempt_id"]]}
            assert ("tool_broker" in sources) is expected, (name, sources)
            assert "tool_broker" not in kinds or expected
    # No tool container ran under coding: the run shows no egress hosts at all (not applicable), and under task_tools the plugin's.
    assert evidence.runs["coding"]["egress_hosts"] is None and evidence.runs["tools"]["egress_hosts"] == []
    # The worker's record agrees with the run: null (omitted from the event) under coding, the plugin's hosts under task_tools.
    started = lambda run: evidence.events[evidence.attempt(run, "correct-model")["attempt_id"]][0]["data"]  # noqa: E731
    assert "egress_hosts" not in started("coding") and started("tools")["egress_hosts"] == []
    assert evidence.runs["limits"]["egress_hosts"] == sorted(HOSTS) and evidence.runs["coding-egress"]["egress_hosts"] is None


# -- verdicts, answer.json and the policies' parity ------------------------------------------------------------------------


@pytest.mark.parametrize("run", ["coding", "tools"])
@pytest.mark.parametrize("token", list(VERDICTS))
def test_each_outcome_gets_the_verifiers_verdict_under_both_policies(run: str, token: str, evidence: Evidence) -> None:
    verdict, code = VERDICTS[token]
    if run == "tools" and token == "invalid-answer":
        code = "execution_failed"  # the same bytes fail the result schema in the worker before any verifier sees them
    attempt = evidence.attempt(run, token)
    assert attempt["state"] == "final" and attempt["sealed"] is True
    assert attempt["verdict"] == verdict, (run, token, attempt["execution"], attempt["verifier_error"])
    if token == "verifier-crash":
        # The harness answered; the verifier raised: no verdict is invented, and no diagnostic reaches the member.
        assert attempt["execution"]["status"] == "answered" and attempt["verifier_error"] is not None
    # The verdict and the explanation code are stored on the attempt only (the trace has no verifier phase or events); a verifier error has none.
    assert not [e for e in evidence.events[attempt["attempt_id"]] if e["kind"].startswith("verifier.")]
    assert attempt["explanation"] == code


def test_answer_json_is_read_valid_refused_missing_and_invalid(evidence: Evidence) -> None:
    status = lambda token: (evidence.attempt("coding", token)["execution"]["status"], evidence.attempt("coding", token)["execution"].get("reason"))  # noqa: E731
    assert status("correct-model") == ("answered", None) and evidence.attempt("coding", "correct-model")["verdict"] == "pass"
    assert status("refuse-valid") == ("refused", None) and evidence.attempt("coding", "refuse-valid")["verdict"] == "pass"
    assert status("missing-result") == ("execution_failed", "missing_result")
    assert status("malformed-result") == ("execution_failed", "invalid_result")
    # Valid JSON that is not the task's output shape is an answer the verifier fails as invalid; the same bytes under task_tools
    # fail the result schema in the worker.
    assert status("invalid-answer") == ("answered", None)
    assert evidence.attempt("coding", "invalid-answer")["verdict"] == "fail"
    assert evidence.attempt("tools", "invalid-answer")["execution"]["status"] == "execution_failed"
    # Under task_tools the worker reads RUSH_RESULT and never answer.json.
    assert evidence.attempt("tools", "missing-result")["execution"]["reason"] in {"missing_result", "invalid_result"}


def test_identical_scripted_outputs_give_identical_references_and_verdicts_under_both_policies(evidence: Evidence) -> None:
    coding, tools = evidence.runs["coding"], evidence.runs["tools"]
    assert [(c["case_id"], c["kind"], c["content_digest"]) for c in coding["cases"]] == [(c["case_id"], c["kind"], c["content_digest"]) for c in tools["cases"]]
    assert [c["attempts"][0]["verdict"] for c in coding["cases"]] == [c["attempts"][0]["verdict"] for c in tools["cases"]]
    assert coding["score"] == tools["score"]
    # 3 pass of 10 scored (the crashing verifier case is unscored).
    assert (coding["score"]["passed"], coding["score"]["scored"], coding["score"]["unscored"], coding["score"]["verifier_errors"]) == (3, 10, 1, 1)
    assert coding["score"]["value"] == pytest.approx(0.3) and coding["score"]["complete"] is True
    # One pinned reference per case, the same rows for both runs; the references are not in any member response.
    assert evidence.private_rows.count(digest("correct-model")) >= 1


def test_a_harness_failure_and_a_timeout_are_execution_failures(evidence: Evidence) -> None:
    failed = evidence.attempt("coding", "harness-failure")["execution"]
    assert failed == {"status": "execution_failed", "reason": "nonzero_exit"}
    timed_out = evidence.attempt("timeout", "timeout")
    assert timed_out["execution"] == {"status": "execution_failed", "reason": "timed_out"}
    assert timed_out["verdict"] == "fail" and evidence.runs["timeout"]["score"]["value"] == 0
    termination = next(e for e in evidence.events[timed_out["attempt_id"]] if e["kind"] == "case.exited")["data"]["termination"]
    assert termination["status"] == "timed_out"


def test_a_task_with_no_reference_is_judged_by_the_verifier_from_the_input(evidence: Evidence) -> None:
    run = evidence.runs["noref"]
    assert [(c["arguments"]["token"], c["attempts"][0]["verdict"]) for c in run["cases"]] == [("correct-model", "pass"), ("wrong-answer", "fail")]
    assert run["score"]["value"] == pytest.approx(0.5)


# -- accounting, limits ------------------------------------------------------------------------------------------------------


def test_model_accounting_is_the_gateways_and_reconciles_with_the_upstream(evidence: Evidence) -> None:
    # An attempt that never built (the build-limit run) made no request.
    modelled = [
        (c["arguments"]["token"], a) for run in evidence.runs.values() for c in run["cases"] for a in c["attempts"]
        if c["arguments"]["token"] != "zero-model" and a["execution"]["status"] != "build_failed"
    ]
    ledger = evidence.handle.ledger
    # One request per attempt, but the many-calls case's two admitted ones (its third was refused before dispatch).
    assert len(ledger.calls) == len(modelled) + 1 and not ledger.violations
    total = 0
    for token, attempt in modelled:
        accounting = evidence.client.accounting(attempt["attempt_id"])
        expected = 2 if token == "many-calls" else 1
        assert accounting["totals"]["calls"] == expected, attempt["attempt_id"]
        total += accounting["totals"]["calls"]
        calls = [e for e in evidence.events[attempt["attempt_id"]] if e["kind"] == "model_call.response"]
        assert len(calls) == expected and all(c["data"]["usage"]["input"] == 120 and c["data"]["usage"]["output"] == 4 for c in calls)
    assert total == len(ledger.calls)
    zero = evidence.attempt("coding", "zero-model")
    assert zero["metrics"]["model_calls"] == 0 and evidence.client.accounting(zero["attempt_id"])["totals"]["calls"] == 0
    metrics = evidence.runs["noref"]["metrics"]
    assert metrics["input_tokens"] == {"total": 240, "missing_attempts": 0} and metrics["output_tokens"] == {"total": 8, "missing_attempts": 0}


def test_default_limits_are_pinned_and_shown(evidence: Evidence) -> None:
    defaults = evidence.client.defaults()["limits"]
    # The documented defaults, today's values; the server may list more limits (the worker-level sandbox ones), all pinned.
    assert {
        "wall_time_ms": 600000, "max_model_calls": 50, "max_output_tokens_per_call": 4096, "max_cost_usd": 1.5, "cpus": 1, "memory_mb": 1024,
        "pids": 256, "workspace_bytes": 268435456, "tmp_bytes": 67108864, "build_wall_ms": 600000, "internet_access": True,
    }.items() <= defaults.items()  # fmt: skip
    coding = evidence.runs["coding"]["limits"]
    # A benchmark that overrides nothing but internet access (off, for the plain worker) pins every default, and its runs show them all.
    assert coding == {**defaults, "internet_access": False}
    assert evidence.reports["coding"].limits == coding
    # What the harness was given is the pinned set.
    given = evidence.harness_log("coding", "correct-model")["limits"]
    assert coding.items() <= given.items()


def test_explicit_limits_override_the_defaults_and_reach_the_harness(evidence: Evidence) -> None:
    run = evidence.runs["limits"]
    assert benchmark_of(evidence, "egress-limits")["limits"] == run["limits"]
    explicit = {"wall_time_ms": 120_000, "max_model_calls": 7, "max_output_tokens_per_call": 123, "max_cost_usd": 0.5, "memory_mb": 512, "pids": 128}
    assert {key: run["limits"][key] for key in explicit} == explicit
    assert run["limits"]["internet_access"] is False and run["limits"]["cpus"] == evidence.client.defaults()["limits"]["cpus"]
    given = evidence.harness_log("limits", "correct-model")["limits"]  # the probe echoes request.limits as it received them
    assert {key: given[key] for key in explicit} == explicit
    assert run["limits"].items() <= given.items()
    # The gateway enforces the pinned output cap on the request it forwards.
    request = evidence.handle.ledger.calls[-1].request
    assert request is not None


def test_a_benchmark_asking_for_more_than_the_worker_offers_is_refused_and_stores_nothing(evidence: Evidence) -> None:
    for name, options, code in (
        ("too-many-calls", {"limits": {"max_model_calls": 10_000_000}}, "limit_exceeds_worker"),
        ("nobody", {"endpoint": "nobody"}, "worker_unavailable"),
    ):
        done = gate.publish_benchmark(evidence.cli, evidence.run_dir / f"step1-{name}", name=name, cases=evidence.run_dir / "mix.json", check=False, **options)
        assert done.returncode != 0 and code in done.stdout + done.stderr, done.stdout + done.stderr
        assert name not in {b["name"] for b in evidence.client.benchmarks()}


def test_private_references_and_verifier_diagnostics_are_in_no_member_response(evidence: Evidence) -> None:
    needles = [digest(token) for token in ("wrong-answer", "missing-result", "malformed-result", "verifier-crash")] + [plugins.CRASH_DETAIL]
    for needle in needles[:4]:
        assert needle in evidence.private_rows, needle
    assert plugins.CRASH_DETAIL in evidence.worker_log
    assert len(evidence.member_text) > 100_000
    assert [needle for needle in needles if needle in evidence.member_text] == []
    assert "RuntimeError" not in evidence.member_text and "Traceback" not in evidence.member_text


# -- harness network ----------------------------------------------------------------------------------------------------------


def test_the_harness_reaches_the_public_internet_only_when_the_run_allows_it(evidence: Evidence) -> None:
    on, off = evidence.harness_log("net-on", "network"), evidence.harness_log("net-off", "network")
    assert on["limits"]["internet_access"] is True and off["limits"]["internet_access"] is False
    # Internet on: a public address answers; the attempt's own relay does either way; cloud metadata and private ranges never.
    assert on["probes"] == {"public": True, "relay": True, "metadata": False, "private": False}
    assert off["probes"] == {"public": False, "relay": True, "metadata": False, "private": False}
    # The host filter, and the tool container's declared-host egress, are proven by the worker's own gVisor tests (see the report).
    assert evidence.runs["net-on"]["unverified_egress"] is True and evidence.runs["net-off"]["unverified_egress"] is False


# -- run-level comparison -----------------------------------------------------------------------------------------------------


def differing(comparison: dict[str, Any]) -> set[str]:
    return {item["field"] for item in comparison["config"] if item["differs"]}


def test_runs_under_both_policies_differ_in_policy_and_prompt_and_share_every_case(evidence: Evidence) -> None:
    comparison = evidence.compares["policies"]
    assert comparison["verifier"] == {"package_sha256": evidence.runs["coding"]["case_set"]["plugin"]["sha256"], "task_id": "probe"}
    assert differing(comparison) == {"policy", "egress_hosts"} == set(comparison["differences"])
    assert (comparison["prompt_diff"]["a_kind"], comparison["prompt_diff"]["b_kind"]) == ("template", "instructions")
    assert len(comparison["shared"]) == len(ANSWERS) + len(REFUSALS) and comparison["only_a"] == comparison["only_b"] == []
    assert len(comparison["prompt_diff"]["rendered"]) == len(comparison["shared"]) and not any(r["identical"] for r in comparison["prompt_diff"]["rendered"])
    # Each shared case lines up by content, and the two policies reached the same verdict for it.
    for shared in comparison["shared"]:
        assert shared["a"]["verdict"] == shared["b"]["verdict"]
        # The mock reports no cost: an unknown cost is null, never the reserved spending bound (which is not a cost).
        # An attempt that dispatched no model call at all spent nothing: a known zero (the contract records zero, never unknown).
        for side in ("a", "b"):
            calls = evidence.client.accounting(shared[side]["attempt_id"])["totals"]["calls"]
            assert shared[side]["cost_usd"] == (0 if calls == 0 else None), shared
            assert calls > 0 or shared[side]["uncertain_cost"] is False, shared
        if shared["a"]["case_id"] != evidence.case("coding", "invalid-answer")["case_id"]:
            # (invalid-answer is the one case the policies fail differently: the verifier's invalid_answer, or the worker's schema check)
            assert shared["a"]["explanation"] == shared["b"]["explanation"]
    assert comparison["unverified_egress"] == {"a": False, "b": False}


def test_runs_of_benchmarks_with_different_cases_and_prompts_show_what_differs(evidence: Evidence) -> None:
    comparison = evidence.compares["prompt"]
    assert {"benchmark_id", "case_set_digest", "selection"} <= differing(comparison) and "policy" not in differing(comparison)
    assert len(comparison["shared"]) == 1 and len(comparison["only_a"]) == len(ANSWERS) + len(REFUSALS) - 1 and comparison["only_b"] == []
    [rendered] = comparison["prompt_diff"]["rendered"]
    assert rendered["identical"] is False
    added = "\n".join(part["text"] for part in comparison["prompt_diff"]["text"] if part["type"] == "added")
    assert "Custom coding prompt for" in added


def test_cases_are_aligned_by_content_not_by_id(evidence: Evidence) -> None:
    comparison = evidence.compares["aligned"]
    assert {"benchmark_id", "case_set_id", "case_set_digest"} <= differing(comparison)
    assert len(comparison["shared"]) == 2
    by_digest = {shared["content_digest"]: shared for shared in comparison["shared"]}
    # correct-model is mix's case 1 and mix2's case 2, wrong-answer the other way round: the ids differ, the content aligns them.
    first = evidence.case("coding", "correct-model")
    aligned = by_digest[first["content_digest"]]
    assert aligned["a"]["case_id"] == first["case_id"] and aligned["b"]["case_id"] == evidence.case("reorder", "correct-model")["case_id"]
    assert aligned["a"]["case_id"] != aligned["b"]["case_id"]
    assert len(comparison["only_a"]) == len(ANSWERS) + len(REFUSALS) - 2 and comparison["only_b"] == []


def test_a_comparison_shows_which_runs_had_unverified_egress(evidence: Evidence) -> None:
    comparison = evidence.compares["internet"]
    assert comparison["unverified_egress"] == {"a": True, "b": False}
    assert differing(comparison) == {"benchmark_id", "limits.internet_access"}


def test_runs_of_another_verifier_are_not_comparable(evidence: Evidence) -> None:
    with pytest.raises(BenchmarkError) as error:
        evidence.client.compare_runs(evidence.reports["coding"].run_id, evidence.reports["noref"].run_id)
    assert (error.value.status, error.value.code) == (409, "not_same_verifier")
    # The 409's body is kept with the other run comparisons; it names what differs and shows nothing of either run.
    (KEPT / "not-same-verifier.json").write_text(json.dumps({"status": error.value.status, "code": error.value.code, "body": error.value.body}, indent=1))
    assert error.value.body["differing"] == ["package_sha256"]
    # The same refusal for the CLI's step 4, which never writes a comparison for them.
    done = evidence.cli.step("4", "compare", evidence.run_dir / "step4-other-verifier", f"run_a={evidence.reports['coding'].run_id}", f"run_b={evidence.reports['noref'].run_id}", check=False)
    assert done.returncode != 0 and "not_same_verifier" in done.stdout + done.stderr


# -- budgets ------------------------------------------------------------------------------------------------------------------


def test_requests_past_the_pinned_model_call_limit_are_refused_by_the_gateway(evidence: Evidence) -> None:
    statuses = evidence.harness_log("calls", "many-calls", 1)["statuses"]
    assert statuses[:2] == [200, 200] and statuses[2] != 200
    attempt = evidence.attempt("calls", "many-calls")
    assert evidence.client.accounting(attempt["attempt_id"])["totals"]["calls"] == 2 and attempt["metrics"]["model_calls"] == 2
    assert evidence.runs["calls"]["limits"]["max_model_calls"] == 2


# -- the first upstream request, byte for byte ---------------------------------------------------------------------------------


def first_upstream_request(evidence: Evidence, run: str, token: str) -> dict[str, Any]:
    """The first request of the attempt that reached the mock: the body the gateway recorded as effective for the attempt's first
    admitted call, matched against the mock ledger's own copy of what it received."""
    attempt_id = evidence.attempt(run, token)["attempt_id"]
    admitted = next(e for e in evidence.events[attempt_id] if e["kind"] == "model_call.admitted")
    effective = evidence.client.payload(attempt_id, admitted["data"]["effective_request_sha256"]).data
    assert hashlib.sha256(effective).hexdigest() == admitted["data"]["effective_request_sha256"]
    received = [call.request.body for call in evidence.handle.ledger.calls if call.request is not None and call.request.body == json.loads(effective)]
    assert received, "the mock never received the request the gateway recorded as sent"
    return received[0]


@pytest.mark.parametrize("run", ["coding", "coding-custom", "tools", "tools-custom"])
def test_the_first_upstream_request_carries_exactly_the_pinned_prompt(run: str, evidence: Evidence) -> None:
    case = evidence.case(run, "correct-model")
    body = first_upstream_request(evidence, run, "correct-model")
    # Kept as evidence: the whole first request body the mock received.
    (KEPT / "first-requests").mkdir(exist_ok=True)
    (KEPT / "first-requests" / f"{run}.json").write_text(json.dumps(body, indent=1))
    pinned = case["prompt"]
    # The messages are the pinned parts and nothing else: a system message only when the prompt has system text, a user message only
    # when it has user text, each equal to the pinned text byte for byte (compared as UTF-8 bytes, not just as strings).
    expected = [{"role": role, "content": pinned[role]} for role in ("system", "user") if pinned[role] is not None]
    assert body["messages"] == expected
    assert [m["content"].encode() for m in body["messages"]] == [pinned[m["role"]].encode() for m in expected]
    assert sha_of_prompt(pinned["system"], pinned["user"]) == pinned["sha256"]
    # And they are the prompts the plugin renders itself, independently of the server.
    if run.startswith("coding"):
        assert pinned["system"] is None and pinned["user"] == expected_coding(evidence, case, CUSTOM_TEMPLATE if run == "coding-custom" else None)
    else:
        assert (pinned["system"], pinned["user"]) == expected_task_tools(evidence, case, CUSTOM_INSTRUCTIONS if run == "tools-custom" else None)


# -- limits that are applied, not only pinned ---------------------------------------------------------------------------------


def test_volume_overrides_are_pinned_given_to_the_harness_and_enforced(evidence: Evidence) -> None:
    run = evidence.runs["disk"]
    assert {key: run["limits"][key] for key in DISK_LIMITS} == DISK_LIMITS
    assert run["limits"]["pids"] == evidence.client.defaults()["limits"]["pids"] and run["limits"]["build_files"] == evidence.client.defaults()["limits"]["build_files"]
    # The harness was handed every override, the build ones included.
    given = evidence.harness_log("disk", "fill-disk")["limits"]
    assert {key: given[key] for key in DISK_LIMITS} == DISK_LIMITS
    # And the volumes refuse at the pinned size: /tmp at one MiB, the workspace at two.
    filled = evidence.harness_log("disk", "fill-disk", 1)
    (KEPT / "volume-fill.json").write_text(json.dumps(filled, indent=1))
    assert filled["tmp"]["error"] == "ENOSPC" and 0 < filled["tmp"]["written"] <= DISK_LIMITS["tmp_bytes"]
    assert filled["workspace"]["error"] == "ENOSPC" and 0 < filled["workspace"]["written"] <= DISK_LIMITS["workspace_bytes"]
    # The same harness under the defaults was never limited that way: the answer was still written and read.
    assert evidence.attempt("disk", "fill-disk")["execution"]["status"] == "answered" and evidence.attempt("disk", "fill-disk")["verdict"] == "pass"


def test_a_build_limit_override_is_pinned_and_fails_a_build_that_exceeds_it(evidence: Evidence) -> None:
    run = evidence.runs["build-limit"]
    assert run["limits"]["build_wall_ms"] == 1
    [attempt] = [c["attempts"][0] for c in run["cases"]]
    assert attempt["execution"] == {"status": "build_failed", "reason": "build_timeout"}, attempt["execution"]
    (KEPT / "build-limit.json").write_text(json.dumps({"limits": run["limits"], "execution": attempt["execution"]}, indent=1))
    # The same source built under the default limit (every other run), no verdict was invented, and the cause is shown as the reason
    # every timing figure is unknown for.
    assert attempt["verdict"] is None and evidence.attempt("disk", "fill-disk")["execution"]["status"] == "answered"
    assert attempt["metrics"]["estimated_ns"] is None and attempt["metrics"]["estimated_ns_unknown"] == "the source did not build, so no case ran"
    assert attempt["metrics"]["elapsed_ns_unknown"] == "the source did not build, so no case ran"
    assert "verifier_ns" not in attempt["metrics"] and "build_ns" not in attempt["metrics"]


# -- preview and run -------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("run", ["coding", "tools", "coding-custom", "tools-custom"])
def test_a_preview_of_the_same_benchmark_and_policy_matches_the_run_it_became(run: str, evidence: Evidence) -> None:
    view = evidence.runs[run]
    preview = evidence.client.preview(view["benchmark"]["benchmark_id"], view["policy"])
    (KEPT / "previews").mkdir(exist_ok=True)
    (KEPT / "previews" / f"{run}.json").write_text(json.dumps(preview, indent=1))
    # Resolved cases, their content digests and the rendered prompts (with their digests) are the run's, case for case.
    assert [(c["case_id"], c["kind"], c["content_digest"], c["prompt"]) for c in preview["cases"]] == [(c["case_id"], c["kind"], c["content_digest"], c["prompt"]) for c in view["cases"]]
    assert preview["limits"]["effective"] == view["limits"] and preview["prompt"]["source"] == view["prompt"]["source"] and preview["prompt"]["text"] == view["prompt"]["text"]
    assert (preview["policy"], preview["egress_hosts"], preview["renderer_version"]) == (view["policy"], view["egress_hosts"], view["prompt"]["renderer_version"])
    assert preview["benchmark"]["case_set_digest"] == view["case_set"]["digest"]


# -- answer.json variants ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("token", VARIANTS)
def test_an_answer_json_the_reader_refuses_is_an_execution_failure_with_an_explained_fail(token: str, evidence: Evidence) -> None:
    attempt = evidence.attempt("variants", token)
    # A blank refusal reason, a JSON array and a symlink (even to a valid answer) are not results: the harness failed to give one.
    # The worker's snapshot drops links, so it reports a link at answer.json as invalid (what the local read_answer says: not a regular file).
    reason = "invalid_result"
    assert attempt["execution"] == {"status": "execution_failed", "reason": reason}, attempt["execution"]
    assert (attempt["verdict"], attempt["explanation"]) == ("fail", "execution_failed")
    assert attempt["sealed"] is True and attempt["coverage"]["status"] == "complete"
    [read] = [e for e in evidence.events[attempt["attempt_id"]] if e["kind"] == "result.read"]
    assert read["data"]["outcome"] == {"status": "execution_failed", "reason": reason}


def test_a_single_call_trace_has_a_known_estimate(evidence: Evidence) -> None:
    # Regression: the graph of a harness whose agent span closed before its call used to disagree with the measured window.
    for run in ("coding", "tools"):
        metrics = evidence.attempt(run, "correct-model")["metrics"]
        assert isinstance(metrics["estimated_ns"], int) and "estimated_ns_unknown" not in metrics, metrics.get("estimated_ns_unknown")


def test_the_quiescence_record_follows_the_exit_record(evidence: Evidence) -> None:
    for run in ("coding", "tools"):
        events = evidence.events[evidence.attempt(run, "correct-model")["attempt_id"]]
        [exited], [quiesced] = ([e for e in events if e["kind"] == kind] for kind in ("case.exited", "case.quiesced"))
        assert exited["cursor"] < quiesced["cursor"] and exited["data"]["exit_ns"] <= quiesced["data"]["quiesced_ns"]
