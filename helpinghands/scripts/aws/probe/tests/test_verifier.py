import json

from contract import ForksInput, ForksOutput, HogInput, HogOutput, ProbeInput, ProbeOutput, SwarmInput, SwarmOutput
from verifier import verify_task

HELD = {
    "environment": ["HOME", "HTTPS_PROXY", "PATH"],
    "direct": "refused: [Errno 101] Network is unreachable",
    "declared": "reached 200",
    "undeclared": "refused: Tunnel connection failed: 403",
    "private": "refused: Tunnel connection failed: 403",
    "metadata": "refused: Tunnel connection failed: 403",
    "plugin_folder": "refused: Read-only file system",
    "workspace": "written",
    "installs": ["a1"],
    "own_install": "a1",
    "workspaces": ["w1"],
    "own_workspace": "w1",
    "processes": 3,
    "first_process_secrets": False,
    "user_namespace": "refused: OSError: [Errno 28] No space left on device",
    "oom_score_adj": "1000",
}
HOSTS = ProbeInput(declared="pypi.org", undeclared="example.com", private="localtest.me")


def test_holds_when_every_check_holds():
    verdict = verify_task("probe", HOSTS, ProbeOutput(report=json.dumps(HELD)), None, None)
    assert verdict["valid"] is True


def test_names_what_did_not_hold():
    leaked = {**HELD, "environment": ["NANOAGENT_API_TOKEN"], "direct": "connected", "workspaces": ["w1", "w2"], "user_namespace": "made", "oom_score_adj": "0"}
    verdict = verify_task("probe", HOSTS, ProbeOutput(report=json.dumps(leaked)), None, None)
    assert verdict["valid"] is False
    assert "no secret in its environment" in verdict["message"]
    assert "no network of its own" in verdict["message"]
    assert "no other run's folder" in verdict["message"]
    assert "no user namespace of its own" in verdict["message"]
    assert "the first stopped when memory runs out" in verdict["message"]


def test_limits_hold_below_what_was_asked():
    assert verify_task("hog", HogInput(megabytes=4096), HogOutput(held=1024), None, None)["valid"] is True
    assert verify_task("forks", ForksInput(count=2000, hold_seconds=0), ForksOutput(started=2000), None, None)["valid"] is False
    assert verify_task("forks", ForksInput(count=2000, hold_seconds=5), ForksOutput(started=900), None, None)["valid"] is True


def test_a_swarm_holds_once_the_kernel_stopped_some_of_it():
    assert verify_task("swarm", SwarmInput(count=100, megabytes=40), SwarmOutput(started=100, killed=37), None, None)["valid"] is True
    assert verify_task("swarm", SwarmInput(count=100, megabytes=40), SwarmOutput(started=100, killed=0), None, None)["valid"] is False
