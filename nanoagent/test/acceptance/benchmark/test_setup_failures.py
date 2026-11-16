"""Step 2's setup failures and pinning, driven through the fake psql with no LLM behind the provider."""

from __future__ import annotations

import hashlib
import json
import socket
from collections.abc import Callable
from pathlib import Path


from conftest import API_KEY, PROBE_CASES, run_step2


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:12]


def closed_port_url() -> str:
    """A loopback URL nothing listens on."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}/api/v1"


def overrides(psql: str, case: str, *, cases: Path | None = None) -> list[str]:
    return [
        f"psql={psql}",
        f"case={case}",
        "harness=nanoagent",
        f"openrouter.base_url={closed_port_url()}",
        # No retries: the provider is down, and the run records that at once.
        "nanoagent.max_attempts=1",
        *([f"cases={cases}"] if cases else []),
    ]


def result_of(home: Path) -> dict:
    return json.loads((home / "result.json").read_text())


def test_unpacks_pins_the_reference_and_records_the_provider_failure(tmp_path: Path, fake_psql: Callable[..., str]) -> None:
    home = tmp_path / "run"
    done = run_step2(home, overrides(fake_psql(), "acceptance-probe-01"))
    assert done.returncode == 1, done.stdout + done.stderr
    result = result_of(home)
    assert result["plugin"] == "acceptance-probe"
    assert result["plugin_version"] == "0.1.0"
    assert result["expected"] == "answer"
    assert result["reference"] == {"digest": digest("alpha")}
    assert result["correct"] is False
    assert result["error"]
    assert result["output"] is None
    assert API_KEY not in (home / "result.json").read_text()


def test_bad_sha_fails_the_run_before_any_result(tmp_path: Path, fake_psql: Callable[..., str]) -> None:
    home = tmp_path / "run"
    done = run_step2(home, overrides(fake_psql(sha256="0" * 64), "acceptance-probe-01"))
    assert done.returncode != 0
    assert "does not match the SHA-256" in done.stdout + done.stderr + (home / "run.log").read_text()
    assert not (home / "result.json").exists()


def test_a_case_to_answer_that_the_reference_cannot_answer_fails_before_the_harness(tmp_path: Path, fake_psql: Callable[..., str]) -> None:
    cases = json.loads(PROBE_CASES.read_text())
    cases["answer"] = [{"token": "refuse-me", "wait_seconds": 0}]
    cases["refuse"] = []
    cases_file = tmp_path / "cases.json"
    cases_file.write_text(json.dumps(cases))
    home = tmp_path / "run"
    done = run_step2(home, overrides(fake_psql(), "acceptance-probe-01", cases=cases_file))
    assert done.returncode != 0
    assert "could not answer" in done.stdout + done.stderr + (home / "run.log").read_text()
    assert not (home / "result.json").exists()


def test_a_rejection_without_the_named_text_is_no_refusal(tmp_path: Path, fake_psql: Callable[..., str]) -> None:
    # The probe rejects refuse-me for having no digest; any other reason (an outage, say) must not pass.
    cases = json.loads(PROBE_CASES.read_text())
    cases["refuse"][0]["reference_error"] = "upstream unavailable"
    cases_file = tmp_path / "cases.json"
    cases_file.write_text(json.dumps(cases))
    home = tmp_path / "run"
    done = run_step2(home, overrides(fake_psql(), "acceptance-probe-03", cases=cases_file))
    assert done.returncode != 0
    assert "without 'upstream unavailable'" in done.stdout + done.stderr + (home / "run.log").read_text()
    assert not (home / "result.json").exists()


def test_a_case_to_refuse_pins_no_reference(tmp_path: Path, fake_psql: Callable[..., str]) -> None:
    home = tmp_path / "run"
    done = run_step2(home, overrides(fake_psql(), "acceptance-probe-03"))
    assert done.returncode == 1, done.stdout + done.stderr
    result = result_of(home)
    assert result["expected"] == "refuse"
    assert result["reference"] is None
    assert result["correct"] is False
    assert result["error"]
