"""Python types built from JSON Schemas, so NanoAgent's `fill`, `values` and `check` run without the plugin package.

The decide dataflow (`nanoagent.plugin.dataflow`) reads dataclasses, Enums, lists, `Annotated` descriptions and `| None`.
A plugin's contract declares those; its JSON Schemas (slimconfig `output_schema`) carry the same facts, inlined with no
`$ref`: an object with every property required, an `enum`, an array, a scalar, and `anyOf [X, null]` for a nullable.

The dataflow matches types by identity, and the schemas have no class names, so two schemas have the same type when
their definitions are equal: the schema with its own top-level description removed (that description describes the
field using the type, not the type). A `SchemaTypes` interns by that key, so one instance shared by a task's schemas
gives a value copied from a tool's output the same type as the task output field it fits.
"""

from __future__ import annotations

import dataclasses
import enum
import json
import re
from collections.abc import Callable
from typing import Annotated, Any

from jsonschema import Draft202012Validator

_SCALARS = {"string": str, "integer": int, "number": float, "boolean": bool}
_NULL = {"type": "null"}


class SchemaError(ValueError):
    """A JSON Schema the dataflow cannot express."""


def _nullable(schema: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """The schema without its null branch, and whether it had one; the outer description is kept."""
    branches = schema.get("anyOf")
    if branches is not None:
        rest = [branch for branch in branches if branch != _NULL]
        if len(rest) == 1:
            return {**rest[0], **({"description": schema["description"]} if "description" in schema else {})}, len(rest) < len(branches)
        raise SchemaError(f"unsupported anyOf: {json.dumps(schema)}")
    kinds = schema.get("type")
    if isinstance(kinds, list):
        rest = [kind for kind in kinds if kind != "null"]
        if len(rest) == 1:
            return {**schema, "type": rest[0]}, len(rest) < len(kinds)
        raise SchemaError(f"unsupported type list: {json.dumps(schema)}")
    return schema, False


class SchemaTypes:
    """Builds and interns the types of JSON Schemas."""

    def __init__(self) -> None:
        self._known: dict[str, Any] = {}

    def build(self, schema: dict[str, Any], name: str) -> Any:
        """The type of ``schema``: a dataclass for an object, an Enum, ``list[T]`` or a scalar; ``name`` names new classes."""
        core, _ = _nullable(schema)
        core = {key: value for key, value in core.items() if key != "description"}
        key = json.dumps(core, sort_keys=True)
        if key not in self._known:
            self._known[key] = self._make(core, name)
        return self._known[key]

    def _make(self, schema: dict[str, Any], name: str) -> Any:
        if "enum" in schema:
            return enum.Enum(_identifier(name), [(f"V{index}", value) for index, value in enumerate(schema["enum"])])
        kind = schema.get("type")
        if kind in _SCALARS:
            return _SCALARS[kind]
        if kind == "array":
            return list[self.build(schema["items"], f"{name}_item")]
        if kind == "object":
            return self._dataclass(schema, name)
        raise SchemaError(f"{name}: unsupported schema {json.dumps(schema)}")

    def _dataclass(self, schema: dict[str, Any], name: str) -> type:
        properties = schema.get("properties", {})
        missing = [field for field in properties if field not in schema.get("required", [])]
        if missing:
            raise SchemaError(f"{name}: optional properties {missing} cannot be filled; a decide task needs every property required")
        fields = []
        for field, definition in properties.items():
            if not field.isidentifier():
                raise SchemaError(f"{name}: property {field!r} is not a Python identifier")
            inner, nullable = _nullable(definition)
            kind = self.build(definition, f"{name}_{field}")
            declared = kind | None if nullable else kind
            description = definition.get("description") or inner.get("description")
            fields.append((field, Annotated[declared, description] if description else declared))
        return dataclasses.make_dataclass(_identifier(name), fields)


def _identifier(name: str) -> str:
    return re.sub(r"\W", "_", name)


def validator(schema: dict[str, Any]) -> Callable[[Any], None]:
    """A function that raises ValueError naming the first way a value breaks ``schema``."""
    checker = Draft202012Validator(schema)

    def check(value: Any) -> None:
        error = next(iter(sorted(checker.iter_errors(value), key=lambda e: list(e.path))), None)
        if error is not None:
            where = "/".join(str(part) for part in error.path) or "the value"
            raise ValueError(f"{where}: {error.message}")

    return check
