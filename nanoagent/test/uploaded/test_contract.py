"""The wire-contract boundary: strict decoding, validators, manifest, result, prompt and exec checks."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from jsonschema.exceptions import SchemaError

from nanoagent.uploaded import contract
from nanoagent.uploaded.contract import (
    Answered,
    ContractError,
    HarnessManifest,
    Refused,
    ResultError,
    contains_first_prompt,
    decode_json_object,
    is_canonical_relative_path,
    parse_manifest,
    read_result_file,
    validate,
    validate_argv,
    validate_result,
)

MANIFEST = b"protocol: rush.harness.v1\nname: h\nversion: '1'\ndialects: [chat_completions]\ntoolchain: go-1\nlockfiles: [go.mod]\nbuild:\n  argv: [go, build]\n  outputs: [harness]\nrun:\n  argv: [/harness/harness]\n"
OUTPUT_SCHEMA = {"type": "object", "required": ["sum"], "properties": {"sum": {"type": "integer"}}}


def result(**fields: Any) -> bytes:
    return json.dumps({"protocol": "rush.harness.v1", **fields}).encode()


def request() -> dict[str, Any]:
    return {
        "protocol": "rush.harness.v1",
        "attempt_id": "3f2b8c1e-8f0a-4f5e-9d3a-1b2c3d4e5f60",
        "policy": "coding",
        "task": {"id": "t", "kind": "agent", "description": "d", "instructions": "i", "plugin_name": "P"},
        "case_pending": False,
        "case": {"case_id": "c1", "arguments": {}, "context": "", "input_schema": {}, "output_schema": {}},
        "prompt": {"system": None, "user": "hello", "sha256": "b" * 64},
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


def test_a_pending_case_has_neither_case_nor_prompt_and_a_pinned_one_has_both() -> None:
    validate("Request", {**request(), "case_pending": True, "case": None, "prompt": None})
    for broken in ({**request(), "case_pending": True}, {**request(), "case": None}, {**request(), "case_pending": True, "case": None}):
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


def test_validate_result_returns_typed_outcomes() -> None:
    assert validate_result(result(status="answered", answer={"sum": 42}), OUTPUT_SCHEMA) == Answered({"sum": 42})
    assert validate_result(result(status="refused", reason="no data"), OUTPUT_SCHEMA) == Refused("no data")


@pytest.mark.parametrize(
    "raw",
    [
        result(status="answered", answer={"sum": "x"}),
        result(status="answered", answer={}),
        result(status="answered"),
        result(status="answered", answer=[1]),
        result(status="refused", reason="   "),
        result(status="refused", reason=""),
        result(status="refused"),
        result(status="answered", answer={"sum": 1}, extra=1),
        result(status="other"),
        b'{"protocol":"rush.harness.v1","status":"answered","answer":{"sum":1},"answer":{"sum":2}}',
        b'{"protocol":"rush.harness.v1","status":"answered","answer":{"sum":NaN}}',
        b"not json",
        b'{"status":"answered","answer":{"sum":1}}',
    ],
)
def test_validate_result_rejects_with_invalid_result(raw: bytes) -> None:
    with pytest.raises(ResultError) as raised:
        validate_result(raw, OUTPUT_SCHEMA)
    assert raised.value.code == "invalid_result"


def test_validate_result_enforces_the_size_bound_and_reports_a_bad_output_schema() -> None:
    with pytest.raises(ResultError) as raised:
        validate_result(result(status="refused", reason="x"), OUTPUT_SCHEMA, max_bytes=5)
    assert raised.value.code == "invalid_result"
    with pytest.raises(SchemaError):
        validate_result(result(status="answered", answer={}), {"type": 7})


def test_read_result_file_reads_a_regular_file(tmp_path: Path) -> None:
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "result.json").write_bytes(b"{}")
    assert read_result_file(tmp_path, "out/result.json", 10) == b"{}"


def test_read_result_file_missing(tmp_path: Path) -> None:
    for relative in ("result.json", "out/result.json"):
        with pytest.raises(ResultError) as raised:
            read_result_file(tmp_path, relative, 10)
        assert raised.value.code == "missing_result"


def test_read_result_file_rejects_links_directories_fifos_and_oversize(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "result.json").write_bytes(b"{}")
    root = tmp_path / "root"
    (root / "out").mkdir(parents=True)
    (root / "out" / "link.json").symlink_to(outside / "result.json")
    (root / "linkdir").symlink_to(outside)
    (root / "out" / "dir.json").mkdir()
    os.mkfifo(root / "out" / "fifo.json")
    (root / "out" / "big.json").write_bytes(b"x" * 11)
    for relative in ("out/link.json", "linkdir/result.json", "out/dir.json", "out/fifo.json", "out/big.json", "out/link.json/x"):
        with pytest.raises(ResultError) as raised:
            read_result_file(root, relative, 10)
        assert raised.value.code == "invalid_result", relative


@pytest.mark.parametrize("relative", ["../x", "/etc/passwd", "a//b", ""])
def test_read_result_file_rejects_non_canonical_paths(tmp_path: Path, relative: str) -> None:
    with pytest.raises(ContractError) as raised:
        read_result_file(tmp_path, relative, 10)
    assert raised.value.code == "invalid_path"


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


@pytest.mark.parametrize("changes", [{"policy": "task_tools"}, {"prompt__system": "s"}, {"prompt__user": None, "prompt__system": "s"}])
def test_the_request_accepts_both_policies_and_either_prompt_part(changes: dict[str, Any]) -> None:
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
