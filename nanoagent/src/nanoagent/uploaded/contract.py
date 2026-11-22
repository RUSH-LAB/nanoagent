"""The wire-contract boundary of uploaded harnesses (docs/contracts/uploaded-harness-v1.md).

Everything here is pure and deterministic: strict JSON/YAML decoding, schema validation with
format checks that are really enforced, result-file reading, the first-prompt rule and the
managed-command argument checks. Every rejection raises a [ContractError] carrying a stable
machine-readable `code`.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

import yaml
from jsonschema import Draft202012Validator, ValidationError
from jsonschema.exceptions import best_match

DEFAULT_MAX_BYTES = 1 << 20

SHAPES = ("Manifest", "Request", "Result", "HarnessEvent", "ToolCall", "ToolResult", "ExecCall", "ExecResult")
DIALECTS = ("chat_completions", "responses", "anthropic_messages")


class ContractError(Exception):
    """A rejected wire value; `code` is stable and machine readable, the message is for people."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class HarnessManifest:
    name: str
    version: str
    dialects: tuple[str, ...]
    toolchain: str
    lockfiles: tuple[str, ...]
    build_argv: tuple[str, ...]
    build_outputs: tuple[str, ...]
    run_argv: tuple[str, ...]


# ---------------------------------------------------------------------------------------------
# Schema validators

_SCHEMA = json.loads(files("nanoagent.uploaded").joinpath("uploaded-harness-v1.schema.json").read_text(encoding="utf-8"))
_FORMATS = Draft202012Validator.FORMAT_CHECKER


def _require_formats() -> None:
    # jsonschema skips a format silently when its checker package is absent; the wire schema
    # depends on these two, so a missing one is an installation error, not a pass.
    missing = [name for name in ("uuid", "uri") if name not in _FORMATS.checkers]
    if missing:
        raise ImportError(f"jsonschema cannot check the {missing} formats; install rfc3986-validator")


def _build_validator(shape: str) -> Draft202012Validator:
    schema = {**_SCHEMA, "$ref": f"#/$defs/{shape}"}
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=_FORMATS)


_require_formats()
_VALIDATORS = {shape: _build_validator(shape) for shape in SHAPES}


def validate(shape: str, instance: Any) -> None:
    """Validate against one wire shape with format checks; raises `schema_violation`."""
    validator = _VALIDATORS.get(shape) or _unknown_shape(shape)
    error = best_match(validator.iter_errors(instance))
    if error is not None:
        raise ContractError("schema_violation", f"{shape}{_pointer(error)}: {error.message}")


def _unknown_shape(shape: str) -> Draft202012Validator:
    raise ContractError("unknown_shape", f"{shape!r} is not one of {SHAPES}")


def _pointer(error: ValidationError) -> str:
    return "".join(f"/{part}" for part in error.absolute_path)


# ---------------------------------------------------------------------------------------------
# Strict JSON

def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError("invalid_json", f"duplicate key {key!r}")
        result[key] = value
    return result


def _reject_constant(name: str) -> Any:
    raise ContractError("invalid_json", f"non-finite number {name}")


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ContractError("invalid_json", f"non-finite number {text}")
    return value


def decode_json_object(data: bytes, max_bytes: int = DEFAULT_MAX_BYTES) -> dict[str, Any]:
    """Decode one UTF-8 JSON object: no duplicate keys, no NaN/Infinity, no trailing data."""
    if len(data) > max_bytes:
        raise ContractError("too_large", f"{len(data)} bytes exceeds the {max_bytes} byte limit")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ContractError("invalid_json", f"not UTF-8: {error}") from error
    try:
        value = json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_reject_constant, parse_float=_finite_float)
    except ValueError as error:
        raise ContractError("invalid_json", str(error)) from error
    except RecursionError as error:
        raise ContractError("invalid_json", "nesting is too deep") from error
    if not isinstance(value, dict):
        raise ContractError("invalid_json", f"top level is {type(value).__name__}, not an object")
    try:
        json.dumps(value, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError as error:  # an escaped lone surrogate (keys or values) cannot be sent on or journaled as UTF-8
        raise ContractError("invalid_json", f"not encodable as UTF-8: {error.reason}") from error
    return value


def decode_and_validate(shape: str, data: bytes, max_bytes: int = DEFAULT_MAX_BYTES) -> dict[str, Any]:
    value = decode_json_object(data, max_bytes)
    validate(shape, value)
    return value


# ---------------------------------------------------------------------------------------------
# Paths

_DRIVE = re.compile(r"^[A-Za-z]:")


def path_problem(path: str) -> str | None:
    """Why `path` is not a canonical relative POSIX path (`traversal` or `invalid_path`), else None."""
    if path.startswith("/") or "\\" in path or _DRIVE.match(path) or ".." in path.split("/"):
        return "traversal"
    if not path or "\0" in path or any(segment in ("", ".") for segment in path.split("/")):
        return "invalid_path"
    return None


def is_canonical_relative_path(path: str) -> bool:
    return path_problem(path) is None


# ---------------------------------------------------------------------------------------------
# Manifest

class _ManifestLoader(yaml.SafeLoader):
    """SafeLoader that only builds JSON-compatible values with string, unique keys."""

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(yaml.events.AliasEvent):
            raise ContractError("invalid_manifest", "YAML aliases are not allowed")
        return super().compose_node(parent, index)

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        self.flatten_mapping(node)
        seen: set[str] = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=True)
            if not isinstance(key, str):
                raise ContractError("invalid_manifest", f"key {key!r} is not a string")
            if key in seen:
                raise ContractError("invalid_manifest", f"duplicate key {key!r}")
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


def _reject_tag(tag: str) -> None:
    def construct(loader: yaml.SafeLoader, node: yaml.Node) -> Any:
        raise ContractError("invalid_manifest", f"{tag} values are not JSON-compatible")

    _ManifestLoader.add_constructor(tag, construct)


for _tag in ("timestamp", "binary", "set", "omap", "pairs"):
    _reject_tag(f"tag:yaml.org,2002:{_tag}")


def _json_compatible(value: Any, where: str = "") -> None:
    match value:
        case None | bool() | int() | str():
            return
        case float():
            if not math.isfinite(value):
                raise ContractError("invalid_manifest", f"non-finite number at {where or '/'}")
        case list():
            for index, item in enumerate(value):
                _json_compatible(item, f"{where}/{index}")
        case dict():
            for key, item in value.items():
                _json_compatible(item, f"{where}/{key}")
        case _:
            raise ContractError("invalid_manifest", f"{type(value).__name__} at {where or '/'} is not JSON-compatible")


def parse_manifest(data: bytes, max_bytes: int = DEFAULT_MAX_BYTES) -> HarnessManifest:
    """Parse `harness.yaml`: strict YAML mapping, schema-valid, with canonical relative paths."""
    if len(data) > max_bytes:
        raise ContractError("invalid_manifest", f"{len(data)} bytes exceeds the {max_bytes} byte limit")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ContractError("invalid_manifest", f"not UTF-8: {error}") from error
    try:
        value = yaml.load(text, Loader=_ManifestLoader)  # noqa: S506 - the loader derives from SafeLoader
    except yaml.YAMLError as error:
        raise ContractError("invalid_manifest", f"invalid YAML: {error}") from error
    except RecursionError as error:
        raise ContractError("invalid_manifest", "nesting is too deep") from error
    if not isinstance(value, dict):
        raise ContractError("invalid_manifest", "the document is not a mapping")
    _json_compatible(value)
    try:
        validate("Manifest", value)
    except ContractError as error:
        raise ContractError("invalid_manifest", error.message) from error
    for field, paths in (("lockfiles", value["lockfiles"]), ("build.outputs", value["build"]["outputs"])):
        for path in paths:
            if path_problem(path) is not None:
                raise ContractError("invalid_manifest", f"{field} entry {path!r} is not a canonical relative path")
    return HarnessManifest(
        name=value["name"],
        version=value["version"],
        dialects=tuple(value["dialects"]),
        toolchain=value["toolchain"],
        lockfiles=tuple(value["lockfiles"]),
        build_argv=tuple(value["build"]["argv"]),
        build_outputs=tuple(value["build"]["outputs"]),
        run_argv=tuple(value["run"]["argv"]),
    )


# ---------------------------------------------------------------------------------------------
# Prompt contract

def _is_text_part(part: Any, part_type: str, prompt: str) -> bool:
    return isinstance(part, dict) and part.get("type") == part_type and part.get("text") == prompt


def _content_matches(message: Any, role: str, part_type: str, prompt: str, *, single: bool) -> bool:
    if not isinstance(message, dict) or message.get("role") != role:
        return False
    content = message.get("content")
    if content == prompt:
        return isinstance(content, str)
    if not isinstance(content, list):
        return False
    if single:
        return len(content) == 1 and _is_text_part(content[0], part_type, prompt)
    return any(_is_text_part(part, part_type, prompt) for part in content)


def _user_matches(dialect: str, body: dict[str, Any], prompt: str) -> bool:
    match dialect:
        case "responses":
            items = body.get("input")
            if isinstance(items, str):
                return items == prompt
            if not isinstance(items, list):
                return False
            return any(
                isinstance(item, dict) and item.get("type", "message") == "message" and _content_matches(item, "user", "input_text", prompt, single=True)
                for item in items
            )
        case "chat_completions" | "anthropic_messages":
            messages = body.get("messages")
            return isinstance(messages, list) and any(_content_matches(m, "user", "text", prompt, single=False) for m in messages)
        case _:
            raise ContractError("unknown_dialect", f"{dialect!r} is not one of {DIALECTS}")


def _system_matches(dialect: str, body: dict[str, Any], prompt: str) -> bool:
    match dialect:
        case "responses":
            # `instructions`, or a system message item of `input` (a string `input` is a user turn).
            if body.get("instructions") == prompt:
                return True
            items = body.get("input")
            return isinstance(items, list) and any(
                isinstance(item, dict) and item.get("type", "message") == "message" and _content_matches(item, "system", "input_text", prompt, single=True)
                for item in items
            )
        case "chat_completions":
            messages = body.get("messages")
            return isinstance(messages, list) and any(_content_matches(m, "system", "text", prompt, single=False) for m in messages)
        case "anthropic_messages":
            system = body.get("system")
            if system == prompt:
                return isinstance(system, str)
            return isinstance(system, list) and any(_is_text_part(part, "text", prompt) for part in system)
        case _:
            raise ContractError("unknown_dialect", f"{dialect!r} is not one of {DIALECTS}")


def contains_first_prompt(dialect: str, request_json: dict[str, Any], user: str | None, system: str | None = None) -> bool:
    """Whether the request carries the pinned rendered prompt byte-exact, with no normalization: ``user`` (when not None)
    as a user message and ``system`` (when not None) as the dialect's system prompt.

    User, Responses: the whole `input` string, or a user message item whose content is the string or a single
    `input_text` part. User, Chat Completions and Anthropic Messages: a `user` message whose content is the string or
    that has a standalone text part equal to it. System, Chat Completions: a `system` message (string or a standalone
    text part); Anthropic Messages: `system` as the string or a list with an equal text block; Responses:
    `instructions`, or a `system` message item.
    """
    if user is None and system is None:
        raise ContractError("invalid_prompt", "a prompt has a system part, a user part or both")
    return (user is None or _user_matches(dialect, request_json, user)) and (system is None or _system_matches(dialect, request_json, system))


def _first_user_texts(dialect: str, body: dict[str, Any]) -> list[str]:
    """The text parts of the conversation's first user message (its string content, or each text part), or [] when it has none."""
    if dialect == "responses" and isinstance(body.get("input"), str):
        return [body["input"]]
    messages = body.get("input") if dialect == "responses" else body.get("messages")
    first = next((m for m in messages if isinstance(m, dict) and m.get("role") == "user"), None) if isinstance(messages, list) else None
    if first is None:
        return []
    content = first.get("content")
    if isinstance(content, str):
        return [content]
    parts = content if isinstance(content, list) else []
    return [part["text"] for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)]


def rewrites_first_prompt(dialect: str, request_json: dict[str, Any], user: str) -> bool:
    """Whether the request is a rewritten case prompt: it does not carry ``user`` byte-exact (`contains_first_prompt`) but the
    conversation's first user message has a text part that contains it with something added or changed around it (a prefix, a
    suffix, a wrapper) or differs from it by surrounding whitespace only. A request whose first user message does not contain the prompt at all is a side request, not a rewrite."""
    if dialect not in DIALECTS:
        raise ContractError("unknown_dialect", f"{dialect!r} is not one of {DIALECTS}")
    return not _user_matches(dialect, request_json, user) and any(user in text or text.strip() == user.strip() for text in _first_user_texts(dialect, request_json))


# ---------------------------------------------------------------------------------------------
# Managed commands

def validate_argv(argv: list[str]) -> None:
    for argument in argv:
        if "\0" in argument:
            raise ContractError("invalid_argv", "an argument contains NUL")
