from nanoagent.core.agent import AgentResult, StopReason
from nanoagent.trajectory import ATIF_VERSION, to_atif


def test_converts_native_result_to_atif() -> None:
    result = AgentResult(
        answer="saved",
        messages=[
            {"role": "system", "content": "help"},
            {"role": "user", "content": "download"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "download_source", "arguments": '{"arxiv_id":"x"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call-1", "content": '{"ok":true}'},
            {"role": "assistant", "content": "saved"},
        ],
        tool_calls=[
            {
                "id": "call-1",
                "name": "download_source",
                "arguments": {"arxiv_id": "x"},
                "output": '{"ok":true}',
                "is_error": False,
            }
        ],
        steps=2,
        stop_reason=StopReason.ANSWER,
        usage={"prompt_tokens": 10, "completion_tokens": 3},
    )
    trajectory = to_atif(
        result,
        session_id="session-1",
        harness="native",
        harness_version="1",
        model="model",
    )
    assert trajectory["schema_version"] == ATIF_VERSION
    assert trajectory["steps"][2]["tool_calls"][0]["function_name"] == "download_source"
    assert trajectory["steps"][2]["observation"]["results"][0]["source_call_id"] == "call-1"
    assert trajectory["final_metrics"]["total_prompt_tokens"] == 10
