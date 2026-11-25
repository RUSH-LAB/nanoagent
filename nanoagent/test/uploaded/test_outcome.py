"""The outcome seam: a frozen workspace and its session record become the outcome the verifier judges."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from nanoagent.uploaded.contract import ContractError
from nanoagent.uploaded.outcome import answer_instructions, answer_skeleton, answer_text, outcome

SKELETON = {"digest": None}


def read(workspace: Path, skipped: dict[str, str] | None = None) -> dict[str, Any]:
    return outcome(workspace, {"skipped": skipped or {}})


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (b'{"digest": "abc"}', {"status": "answered", "answer": {"digest": "abc"}}),
        (b'{"refused": "no data"}', {"status": "refused", "reason": "no data"}),
        (b'{"refused": "  "}', {"status": "execution_failed", "reason": "invalid_result"}),
        (b"not json", {"status": "execution_failed", "reason": "invalid_result"}),
        (b"[1]", {"status": "execution_failed", "reason": "invalid_result"}),
        (None, {"status": "execution_failed", "reason": "missing_result"}),
    ],
)
def test_answer_json_of_the_frozen_workspace_is_the_outcome(tmp_path: Path, content: bytes | None, expected: dict[str, Any]) -> None:
    if content is not None:
        (tmp_path / "answer.json").write_bytes(content)
    assert read(tmp_path) == expected


def test_a_link_the_freeze_skipped_is_an_invalid_result_even_beside_a_real_answer(tmp_path: Path) -> None:
    (tmp_path / "answer.json").write_bytes(b'{"digest": "abc"}')
    assert read(tmp_path, {"answer.json": "symlink"}) == {"status": "execution_failed", "reason": "invalid_result"}


def test_a_directory_named_answer_json_is_an_invalid_result(tmp_path: Path) -> None:
    (tmp_path / "answer.json").mkdir()
    assert read(tmp_path) == {"status": "execution_failed", "reason": "invalid_result"}


TASK = {"output_schema": {"type": "object", "properties": {"b": {"type": "integer"}, "a": {"type": "string"}}, "required": ["a", "b"]}}


def test_the_answer_instructions_carry_the_output_schema_compactly_and_stably() -> None:
    text = answer_instructions(TASK)
    assert '{"properties":{"a":{"type":"string"},"b":{"type":"integer"}},"required":["a","b"],"type":"object"}' in text
    assert text == answer_instructions({"output_schema": dict(reversed(TASK["output_schema"].items()))})
    assert "answer.json" in text and '{"refused": "<why>"}' in text


def test_what_the_instructions_describe_is_what_the_seam_reads(tmp_path: Path) -> None:
    assert "answer.json" in answer_instructions(TASK)
    (tmp_path / "answer.json").write_text(json.dumps({"a": "x", "b": 1}))  # shape 1: the answer object itself
    assert read(tmp_path) == {"status": "answered", "answer": {"a": "x", "b": 1}}
    (tmp_path / "answer.json").write_text(json.dumps({"refused": "no rows"}))  # shape 2
    assert read(tmp_path) == {"status": "refused", "reason": "no rows"}


def test_an_answer_json_equal_to_the_seeded_skeleton_is_an_answer_like_any_other(tmp_path: Path) -> None:
    (tmp_path / "answer.json").write_bytes(answer_text(SKELETON))
    assert read(tmp_path) == {"status": "answered", "answer": SKELETON}  # the verifier fails it on its named check, or passes it if it is right


def test_the_instructions_name_the_seeded_file_and_the_refusal_shape() -> None:
    text = answer_instructions(TASK)
    assert "already in the workspace" in text and "do not add or remove fields" in text and '{"refused": "<why>"}' in text


def test_a_skeleton_has_every_object_property_null_per_scalar_and_empty_per_array() -> None:
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "n": {"type": "integer"},
            "rows": {"type": "array", "items": {"type": "object", "properties": {"x": {"type": "number"}}}},
            "nested": {"type": "object", "properties": {"ok": {"type": "boolean"}, "tags": {"type": "array"}}},
        },
    }
    assert answer_skeleton(schema) == {"name": None, "n": None, "rows": [], "nested": {"ok": None, "tags": []}}
    assert list(answer_skeleton(schema)) == ["name", "n", "rows", "nested"]


def test_a_skeleton_resolves_refs_and_defs() -> None:
    schema = {"type": "object", "properties": {"a": {"$ref": "#/$defs/pair"}, "b": {"$ref": "#/$defs/pair"}}, "$defs": {"pair": {"type": "object", "properties": {"l": {"type": "string"}}}}}
    assert answer_skeleton(schema) == {"a": {"l": None}, "b": {"l": None}}


def test_a_skeleton_of_a_union_with_null_is_null() -> None:
    schema = {
        "type": "object",
        "properties": {
            "a": {"anyOf": [{"type": "object", "properties": {"x": {"type": "string"}}}, {"type": "null"}]},
            "b": {"oneOf": [{"type": "string"}, {"type": "null"}]},
            "c": {"type": ["integer", "null"]},
        },
    }
    assert answer_skeleton(schema) == {"a": None, "b": None, "c": None}


def test_a_skeleton_of_an_enum_or_const_of_scalars_is_null() -> None:
    # What a plugin's Enum output field becomes (slimconfig writes the values with no `type`), e.g. a skill level.
    schema = {
        "type": "object",
        "properties": {
            "level": {"enum": ["beginner", "intermediate", "advanced"], "description": "The student's level"},
            "k": {"enum": [1, 5, 10]},
            "fixed": {"const": "v1"},
        },
    }
    assert answer_skeleton(schema) == {"level": None, "k": None, "fixed": None}


@pytest.mark.parametrize(
    ("schema", "path"),
    [
        ({"type": "object", "properties": {"a": {"anyOf": [{"type": "string"}, {"type": "integer"}]}}}, "$.a"),
        ({"type": "object", "properties": {"a": {"$ref": "#/$defs/missing"}}}, "$.a"),
        ({"type": "object", "properties": {"a": {"type": "object", "properties": {"b": {}}}}}, "$.a.b"),
        ({"type": "object", "properties": {"a": {"$ref": "#"}}}, "$.a.a"),
        ({"type": "string"}, "$"),
        ({"type": "object", "properties": {"a": {"enum": [{"x": 1}, {"x": 2}]}}}, "$.a"),
        ({"type": "object", "properties": {"a": {"enum": []}}}, "$.a"),
    ],
)
def test_a_schema_that_cannot_be_skeletoned_raises_naming_its_path(schema: dict[str, Any], path: str) -> None:
    with pytest.raises(ContractError, match=rf"{path.replace('$', chr(92) + '$')}:"):
        answer_skeleton(schema)
