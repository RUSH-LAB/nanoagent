from __future__ import annotations

import hashlib

import pytest
from slimconfig import build_output

import verifier
from contract import ProbeInput, ProbeOutput, WaitInput
from plugin.probe import digest, wait


def test_digests_the_token() -> None:
    assert digest(ProbeInput(token="alpha", wait_seconds=0.0)).digest == hashlib.sha256(b"alpha").hexdigest()[:12]


def test_refuses_a_refuse_token() -> None:
    with pytest.raises(ValueError, match="refuse-me"):
        digest(ProbeInput(token="refuse-me", wait_seconds=0.0))


def test_waits_as_asked() -> None:
    assert wait(WaitInput(wait_seconds=0.0)).waited == 0.0


def test_the_task_is_valid_exactly_when_the_digest_is_the_references() -> None:
    reference = build_output({"digest": "abc"}, ProbeOutput)
    arguments = {"token": "alpha", "wait_seconds": 0.0}
    assert verifier.verify_task("probe", arguments, build_output({"digest": "abc"}, ProbeOutput), reference, ".")["valid"] is True
    assert verifier.verify_task("probe", arguments, build_output({"digest": "abd"}, ProbeOutput), reference, ".")["valid"] is False
