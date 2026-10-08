from nanoagent.harness import (
    HarnessCapabilities,
    HarnessRequest,
    NanoAgentHarness,
    SubprocessHarness,
)
from nanoagent.runtime.harness import NanoAgentRunner, SubprocessRunner


def test_public_harness_api_names_existing_implementations() -> None:
    assert NanoAgentHarness is NanoAgentRunner
    assert SubprocessHarness is SubprocessRunner
    assert HarnessRequest(input="hello").input == "hello"
    assert HarnessCapabilities(tools=True).as_dict()["tools"] is True
