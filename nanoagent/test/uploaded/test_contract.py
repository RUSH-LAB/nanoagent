"""The wire-contract boundary: strict decoding, validators, manifest, result, prompt and exec checks."""

from __future__ import annotations

import json
from typing import Any

import pytest

from nanoagent.uploaded import contract
from nanoagent.uploaded.contract import (
    ContractError,
    HarnessManifest,
    contains_first_prompt,
    decode_json_object,
    is_canonical_relative_path,
    parse_manifest,
    validate,
    validate_argv,
)

MANIFEST = b"protocol: rush.harness.v1\nname: h\nversion: '1'\ndialects: [chat_completions]\ntoolchain: go-1\nlockfiles: [go.mod]\nbuild:\n  argv: [go, build]\n  outputs: [harness]\nrun:\n  argv: [/harness/harness]\n"


def request() -> dict[str, Any]:
    return {
        "protocol": "rush.harness.v1",
        "attempt_id": "3f2b8c1e-8f0a-4f5e-9d3a-1b2c3d4e5f60",
        "task": {"id": "t", "kind": "agent", "description": "d", "plugin_name": "P"},
        "free_form": False,
        "case": {"case_id": "c1"},
        "prompt": {"system": None, "user": "hello", "sha256": "b" * 64},
        "harness": "claude",
        "workspace": "/rush/workspace",
        "openrouter": {"base_url": "https://gw.example/api/v1", "model": "a/b", "dialects": ["responses"]},
        "tools": {"url": "https://gw.example/tools", "available": []},
        "exec_url": "https://gw.example/exec",
        "events_url": "https://gw.example/events",
        "limits": {
            "wall_time_ms": 1000, "max_model_calls": 1, "max_output_tokens_per_call": 10, "max_cost_usd": 0.5, "internet_access": True,
            "cpus": 1, "memory_mb": 512, "pids": 64, "workspace_bytes": 1 << 20, "workspace_files": 100, "tmp_bytes": 1 << 20, "build_wall_ms": 1000,
            "build_memory_mb": 512, "build_output_bytes": 1 << 20, "build_files": 100, "build_tmp_bytes": 1 << 20,
        },
        "interactive": False,
    }


def test_uuid_and_uri_formats_are_enforced() -> None:
    validate("Request", request())
    for field, bad in (("attempt_id", "not-a-uuid"), ("exec_url", "no scheme here"), ("events_url", "relative/path")):
        broken = {**request(), field: bad}
        with pytest.raises(ContractError) as raised:
            validate("Request", broken)
        assert raised.value.code == "schema_violation"
        assert field in raised.value.message


def test_a_free_form_session_has_no_task_case_or_prompt_and_any_other_has_all_three() -> None:
    free = {**request(), "free_form": True, "task": None, "case": None, "prompt": None, "harness": None}
    validate("Request", free)
    for broken in ({**request(), "free_form": True}, {**request(), "case": None}, {**request(), "task": None}, {**free, "task": request()["task"]}):
        with pytest.raises(ContractError):
            validate("Request", broken)


def test_unknown_shape_is_rejected() -> None:
    with pytest.raises(ContractError) as raised:
        validate("Nope", {})
    assert raised.value.code == "unknown_shape"


@pytest.mark.parametrize(
    "raw",
    [b'{"a":1,"a":2}', b'{"o":{"a":1,"a":2}}', b'{"l":[{"a":1,"a":1}]}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}', b'{"a":1e999}',
     b'{"a":1} {"b":2}', b'{"a":1}x', b"[1]", b'"s"', b"", b"\xff\xfe{}", b'{"a":1', b"[" * 100000 + b"]" * 100000],
)
def test_decode_rejects_unsafe_json(raw: bytes) -> None:
    with pytest.raises(ContractError) as raised:
        decode_json_object(raw)
    assert raised.value.code == "invalid_json"


def test_decode_enforces_the_size_bound_and_accepts_plain_objects() -> None:
    assert decode_json_object(b'{"a":[1,2.5,null]}') == {"a": [1, 2.5, None]}
    with pytest.raises(ContractError) as raised:
        decode_json_object(b'{"a":1}', max_bytes=3)
    assert raised.value.code == "too_large"


def test_manifest_parses() -> None:
    assert parse_manifest(MANIFEST) == HarnessManifest("h", "1", ("chat_completions",), "go-1", ("go.mod",), ("go", "build"), ("harness",), ("/harness/harness",))


@pytest.mark.parametrize(
    "raw",
    [
        b"\xff",
        b"- a\n- b\n",
        b"",
        MANIFEST + b"toolchain: dup\n",
        MANIFEST.replace(b"argv: [go, build]", b"argv: [go, build]\n  argv: [x]"),
        MANIFEST + b"extra: 2024-01-01\n",
        MANIFEST + b"extra: !!binary aGk=\n",
        MANIFEST + b"extra: !!set {a}\n",
        MANIFEST + b"extra: .nan\n",
        MANIFEST + b"extra: .inf\n",
        MANIFEST + b"1: a\n",
        b"a: &x [1]\nb: *x\n",
        MANIFEST + b"---\n" + MANIFEST,
        MANIFEST.replace(b"rush.harness.v1", b"rush.harness.v0"),
        MANIFEST.replace(b"outputs: [harness]", b"outputs: []"),
        MANIFEST.replace(b"name: h\n", b""),
        MANIFEST.replace(b"version: '1'\n", b""),
        MANIFEST.replace(b"dialects: [chat_completions]\n", b""),
        MANIFEST.replace(b"dialects: [chat_completions]", b"dialects: []"),
        MANIFEST.replace(b"dialects: [chat_completions]", b"dialects: [grpc]"),
        MANIFEST.replace(b"name: h", b"name: Bad Name"),
        MANIFEST.replace(b"lockfiles: [go.mod]", b"lockfiles: [go.mod, go.mod]"),
    ],
)
def test_manifest_rejects_invalid_documents(raw: bytes) -> None:
    with pytest.raises(ContractError) as raised:
        parse_manifest(raw)
    assert raised.value.code == "invalid_manifest"


@pytest.mark.parametrize("path", ["/abs", "../x", "a/../b", "a//b", "./a", "a/./b", "a\\b", "a/", "C:/x", "a\0b", ""])
def test_manifest_rejects_non_canonical_paths(path: str) -> None:
    for field in ("lockfiles: [go.mod]", "outputs: [harness]"):
        text = MANIFEST.decode().replace(field, field.split("[")[0] + "[" + json.dumps(path) + "]")
        with pytest.raises(ContractError) as raised:
            parse_manifest(text.encode())
        assert raised.value.code == "invalid_manifest"
        assert not is_canonical_relative_path(path)


def test_manifest_size_is_bounded() -> None:
    with pytest.raises(ContractError) as raised:
        parse_manifest(MANIFEST, max_bytes=10)
    assert raised.value.code == "invalid_manifest"


PROMPT = "Task\nx\n"


@pytest.mark.parametrize(
    "dialect, body",
    [
        ("responses", {"input": PROMPT}),
        ("responses", {"input": [{"role": "system", "content": "s"}, {"role": "user", "content": PROMPT}]}),
        ("responses", {"input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": PROMPT}]}]}),
        ("chat_completions", {"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": PROMPT}]}),
        ("chat_completions", {"messages": [{"role": "user", "content": [{"type": "text", "text": "a"}, {"type": "text", "text": PROMPT}]}]}),
        ("anthropic_messages", {"messages": [{"role": "user", "content": PROMPT}]}),
        ("anthropic_messages", {"messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT}]}]}),
    ],
)
def test_first_prompt_accepted(dialect: str, body: dict[str, Any]) -> None:
    assert contains_first_prompt(dialect, body, PROMPT)


@pytest.mark.parametrize(
    "dialect, body",
    [
        ("responses", {"input": PROMPT + " "}),
        ("responses", {"input": [{"role": "assistant", "content": PROMPT}]}),
        ("responses", {"input": [{"role": "user", "content": [{"type": "input_text", "text": "a"}, {"type": "input_text", "text": PROMPT}]}]}),
        ("responses", {"input": [{"role": "user", "content": [{"type": "text", "text": PROMPT}]}]}),
        ("responses", {"input": [{"type": "function_call_output", "role": "user", "content": PROMPT}]}),
        ("responses", {"messages": [{"role": "user", "content": PROMPT}]}),
        ("chat_completions", {"messages": [{"role": "user", "content": PROMPT.replace("\n", "\r\n")}]}),
        ("chat_completions", {"messages": [{"role": "user", "content": PROMPT.strip()}]}),
        ("chat_completions", {"messages": [{"role": "system", "content": PROMPT}]}),
        ("chat_completions", {"messages": [{"role": "user", "content": [{"type": "image_url", "text": PROMPT}]}]}),
        ("chat_completions", {"messages": [{"role": "user", "content": "x" + PROMPT}]}),
        ("anthropic_messages", {"system": PROMPT, "messages": []}),
        ("anthropic_messages", {"messages": [{"role": "assistant", "content": [{"type": "text", "text": PROMPT}]}]}),
        ("anthropic_messages", {"messages": "nope"}),
        ("anthropic_messages", {"messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT + "x"}]}]}),
    ],
)
def test_first_prompt_rejected(dialect: str, body: dict[str, Any]) -> None:
    assert not contains_first_prompt(dialect, body, PROMPT)


def test_first_prompt_unknown_dialect() -> None:
    with pytest.raises(ContractError) as raised:
        contains_first_prompt("gemini", {}, PROMPT)
    assert raised.value.code == "unknown_dialect"


def test_argv_rejects_nul() -> None:
    validate_argv(["ls", "-l"])
    with pytest.raises(ContractError) as raised:
        validate_argv(["ls", "a\0b"])
    assert raised.value.code == "invalid_argv"


def test_format_guard_names_the_missing_package(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(contract._FORMATS, "checkers", {})
    with pytest.raises(ImportError, match="rfc3986-validator"):
        contract._require_formats()


def broken(**changes: Any) -> dict[str, Any]:
    value = request()
    for path, replacement in changes.items():
        *parents, leaf = path.split("__")
        target = value
        for key in parents:
            target = target[key]
        if replacement is KeyError:
            del target[leaf]
        else:
            target[leaf] = replacement
    return value


@pytest.mark.parametrize(
    "changes",
    [
        {"policy": "agentic"},
        {"protocol": "rush.harness.v0"},
        {"budgets": {}},  # a field the request does not have
        {"workspace": "/elsewhere"},
        {"prompt__system": None, "prompt__user": None},  # a prompt has a part
        {"prompt__user": 3},
        {"prompt__system": KeyError},
        {"task__kind": "other"},
        {"task__extra": 1},
        {"case__kind": "answer"},  # the worker keeps case.kind to itself
        {"case__context": None},
        {"limits__internet_access": "yes"},
        {"limits__pids": KeyError},
        {"limits__memory_mb": 0},
    ],
)
def test_the_request_is_closed_and_complete(changes: dict[str, Any]) -> None:
    with pytest.raises(ContractError) as raised:
        validate("Request", broken(**changes))
    assert raised.value.code == "schema_violation"


@pytest.mark.parametrize("changes", [{"harness": "rush aider --yes"}, {"prompt__system": "s"}, {"prompt__user": None, "prompt__system": "s"}])
def test_the_request_accepts_a_members_own_harness_and_either_prompt_part(changes: dict[str, Any]) -> None:
    validate("Request", broken(**changes))


SYSTEM = "You are exact.\n"


@pytest.mark.parametrize(
    "dialect, body",
    [
        ("chat_completions", {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": PROMPT}]}),
        ("chat_completions", {"messages": [{"role": "system", "content": [{"type": "text", "text": SYSTEM}]}, {"role": "user", "content": PROMPT}]}),
        ("anthropic_messages", {"system": SYSTEM, "messages": [{"role": "user", "content": PROMPT}]}),
        ("anthropic_messages", {"system": [{"type": "text", "text": SYSTEM}], "messages": [{"role": "user", "content": PROMPT}]}),
        ("responses", {"instructions": SYSTEM, "input": PROMPT}),
        ("responses", {"input": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": PROMPT}]}),
        ("responses", {"input": [{"role": "system", "content": [{"type": "input_text", "text": SYSTEM}]}, {"role": "user", "content": PROMPT}]}),
    ],
)
def test_first_prompt_with_a_system_part_accepted(dialect: str, body: dict[str, Any]) -> None:
    assert contains_first_prompt(dialect, body, PROMPT, SYSTEM)
    assert not contains_first_prompt(dialect, body, PROMPT, SYSTEM + " ")


@pytest.mark.parametrize(
    "dialect, body",
    [
        ("chat_completions", {"messages": [{"role": "user", "content": PROMPT}]}),
        ("chat_completions", {"messages": [{"role": "user", "content": SYSTEM}, {"role": "user", "content": PROMPT}]}),
        ("chat_completions", {"messages": [{"role": "system", "content": SYSTEM + "more"}, {"role": "user", "content": PROMPT}]}),
        ("anthropic_messages", {"system": SYSTEM.strip(), "messages": [{"role": "user", "content": PROMPT}]}),
        ("anthropic_messages", {"messages": [{"role": "user", "content": PROMPT}]}),
        ("responses", {"instructions": SYSTEM + "x", "input": PROMPT}),
        ("responses", {"input": PROMPT}),
    ],
)
def test_first_prompt_with_a_system_part_rejected_when_the_system_part_differs(dialect: str, body: dict[str, Any]) -> None:
    assert not contains_first_prompt(dialect, body, PROMPT, SYSTEM)


def test_a_decide_prompt_has_only_a_system_part() -> None:
    body = {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "whatever the harness asks"}]}
    assert contains_first_prompt("chat_completions", body, None, SYSTEM)
    assert not contains_first_prompt("chat_completions", body, "other", SYSTEM)


def test_a_prompt_needs_a_part() -> None:
    with pytest.raises(ContractError) as raised:
        contains_first_prompt("chat_completions", {}, None, None)
    assert raised.value.code == "invalid_prompt"


def test_lone_surrogates_are_refused_in_values_and_keys() -> None:
    for raw in (b'{"a": "\\udc80"}', b'{"\\udc80": 1}', b'{"a": ["x", {"b": "\\ud800"}]}'):
        with pytest.raises(ContractError) as caught:
            decode_json_object(raw)
        assert caught.value.code == "invalid_json", raw
    assert decode_json_object('{"a": "\\ud83d\\ude00"}'.encode()) == {"a": "\U0001f600"}
