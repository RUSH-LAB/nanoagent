import shutil
from pathlib import Path

import pytest

from nanoagent.plugin import load_manifest
from nanoagent.plugin.verifier import EXECUTION_FAILURES, VerifierError, verify_task_verifier_case

PROBE = Path(__file__).parent / "plugins" / "acceptance-probe"
ALPHA = {"token": "alpha", "wait_seconds": 1.0}
ALPHA_DIGEST = "8ed3f6ad685b"
REFUSE = {"token": "refuse-me", "wait_seconds": 0}


def probe_copy(tmp_path: Path, hook: str) -> Path:
    """The probe plugin with ``verify_task`` replaced by ``hook``."""
    root = tmp_path / "probe"
    shutil.copytree(PROBE, root, ignore=shutil.ignore_patterns("__pycache__", ".venv", "node_modules"))
    init = root / "verifier" / "__init__.py"
    init.write_text(init.read_text() + "\n" + hook)
    return root


@pytest.fixture(scope="module")
def manifest():
    return load_manifest(PROBE)


@pytest.fixture
def workspace(tmp_path):
    return tmp_path


def answered(digest):
    return {"status": "answered", "answer": {"digest": digest}}


ANSWER_REFERENCE = {"digest": ALPHA_DIGEST}
REFUSAL_REFERENCE = "has no digest"


def tv_case(manifest, outcome, reference, workspace, arguments=ALPHA):
    return verify_task_verifier_case(manifest, "probe", arguments, outcome, reference, workspace)


@pytest.mark.parametrize(("digest", "verdict", "score"), [(ALPHA_DIGEST, "pass", 1.0), ("000000000000", "fail", 0.0)])
def test_task_verifier_checks_an_answer_with_verify_task(manifest, workspace, digest, verdict, score) -> None:
    result = tv_case(manifest, answered(digest), ANSWER_REFERENCE, workspace)
    assert (result.verdict, result.score, result.explanation) == (verdict, score, None)


@pytest.mark.parametrize("reason", ["has no digest", "I do not feel like it"])
def test_task_verifier_passes_any_refusal_of_a_refusal_case(manifest, workspace, reason) -> None:
    result = tv_case(manifest, {"status": "refused", "reason": reason}, REFUSAL_REFERENCE, workspace, arguments=REFUSE)
    assert (result.verdict, result.score, result.explanation) == ("pass", 1.0, None)


def test_task_verifier_fails_a_refusal_of_an_answer_case(manifest, workspace) -> None:
    result = tv_case(manifest, {"status": "refused", "reason": "has no digest"}, ANSWER_REFERENCE, workspace)
    assert (result.verdict, result.score, result.explanation) == ("fail", 0.0, "refused_answer_case")


def test_task_verifier_fails_an_answer_to_a_refusal_case(manifest, workspace) -> None:
    result = tv_case(manifest, answered(ALPHA_DIGEST), REFUSAL_REFERENCE, workspace, arguments=REFUSE)
    assert (result.verdict, result.score, result.explanation) == ("fail", 0.0, "answered_refusal_case")


def test_task_verifier_fails_an_answer_of_the_wrong_shape(manifest, workspace) -> None:
    outcome = {"status": "answered", "answer": {"digest": 5}}
    result = tv_case(manifest, outcome, ANSWER_REFERENCE, workspace)
    assert (result.verdict, result.explanation) == ("fail", "invalid_answer")


@pytest.mark.parametrize("reason", sorted(EXECUTION_FAILURES))
@pytest.mark.parametrize("reference", [ANSWER_REFERENCE, REFUSAL_REFERENCE])
def test_task_verifier_fails_every_execution_failure(manifest, workspace, reason, reference) -> None:
    result = tv_case(manifest, {"status": "execution_failed", "reason": reason}, reference, workspace)
    assert (result.verdict, result.score, result.explanation) == ("fail", 0.0, "execution_failed")


def test_a_verify_task_that_raises_leaves_the_case_unavailable(tmp_path) -> None:
    root = probe_copy(tmp_path, "def verify_task(task, arguments, output, reference, workspace):\n    raise KeyError('boom')\n")
    with pytest.raises(VerifierError, match="boom"):
        tv_case(load_manifest(root), answered(ALPHA_DIGEST), ANSWER_REFERENCE, tmp_path)


def test_a_nondeterministic_verify_task_leaves_the_case_unavailable(tmp_path) -> None:
    root = probe_copy(
        tmp_path,
        "CALLS = []\n"
        "def verify_task(task, arguments, output, reference, workspace):\n"
        "    CALLS.append(1)\n"
        "    return {'valid': True, 'score': len(CALLS) / 10, 'message': '', 'details': {}}\n",
    )
    with pytest.raises(VerifierError, match="not deterministic"):
        tv_case(load_manifest(root), answered(ALPHA_DIGEST), ANSWER_REFERENCE, tmp_path)




@pytest.mark.parametrize("reference", [3, ["digest"]])
def test_a_case_pins_a_reference_output_a_reference_error_or_nothing(manifest, workspace, reference) -> None:
    with pytest.raises(VerifierError, match="pins a reference"):
        tv_case(manifest, answered(ALPHA_DIGEST), reference, workspace)


NO_REFERENCE_VERIFIER = (
    "def verify_task(task, arguments, output, reference, workspace):\n"
    "    assert reference is None\n"
    "    return {'valid': output.digest == 'ok', 'score': 1.0, 'message': '', 'details': {}}\n"
)


@pytest.mark.parametrize(("digest", "verdict"), [("ok", "pass"), ("nope", "fail")])
def test_an_answer_case_without_a_reference_is_judged_by_the_plugins_verifier(tmp_path, digest, verdict) -> None:
    manifest = load_manifest(probe_copy(tmp_path, NO_REFERENCE_VERIFIER))
    result = tv_case(manifest, answered(digest), None, tmp_path)
    assert (result.verdict, result.score, result.explanation) == (verdict, 1.0 if verdict == "pass" else 0.0, None)


def test_a_verifier_that_needs_the_missing_reference_is_a_verifier_error_not_a_verdict(manifest, workspace) -> None:
    with pytest.raises(VerifierError, match="verify_task"):
        tv_case(manifest, answered(ALPHA_DIGEST), None, workspace)
