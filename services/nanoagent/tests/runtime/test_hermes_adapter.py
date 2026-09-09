from __future__ import annotations

import pytest

from nanoagent.adapters.hermes import _command, _done, _prompt


def test_hermes_prompt_keeps_server_instructions() -> None:
    assert _prompt({"input": "do it", "messages": [], "instructions": "stay scoped"}) == (
        "Application instructions:\nstay scoped\n\nCurrent user request:\ndo it"
    )


def test_hermes_oneshot_includes_conversation_history() -> None:
    assert _prompt({
        "input": "next",
        "messages": [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
        ],
    }) == "Conversation history:\n\nUser:\nfirst\n\nAssistant:\nreply\n\nCurrent user request:\nnext"


def test_hermes_oneshot_rejects_unsupported_history_roles() -> None:
    with pytest.raises(ValueError, match="user or assistant"):
        _prompt({"input": "next", "messages": [{"role": "tool", "content": "result"}]})


def test_hermes_command_is_an_argv_not_a_shell_string() -> None:
    assert _command(
        "/bin/hermes",
        "answer this",
        "/tmp/usage.json",
        {"model": "model", "provider": "openrouter", "toolsets": ["web", "terminal"]},
    ) == [
        "/bin/hermes",
        "-z",
        "answer this",
        "--usage-file",
        "/tmp/usage.json",
        "--model",
        "model",
        "--provider",
        "openrouter",
        "--toolsets",
        "web,terminal",
    ]


def test_hermes_usage_maps_to_normalized_done_event() -> None:
    assert _done(
        "answer",
        {
            "input_tokens": 2,
            "output_tokens": 3,
            "total_tokens": 5,
            "estimated_cost_usd": 0.01,
            "api_calls": 2,
        },
    ) == {
        "type": "done",
        "answer": "answer",
        "stop_reason": "answer",
        "steps": 2,
        "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
        "cost": 0.01,
        "error": None,
    }
