from nanoagent.harness import (
    HarnessCapabilities,
    HarnessRequest,
    NativeHarness,
    SubprocessHarness,
)
from nanoagent.runtime.harness import NativeRunner, SubprocessRunner


def test_public_harness_api_names_existing_implementations() -> None:
    assert NativeHarness is NativeRunner
    assert SubprocessHarness is SubprocessRunner
    assert HarnessRequest(input="hello").input == "hello"
    assert HarnessCapabilities(tools=True).as_dict()["tools"] is True
