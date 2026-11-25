"""The outcome seam: what a case's session left, as the outcome the verifier judges.

The runner calls [outcome] once, in the worker, between the workspace's freeze and the verifier, after the harness has exited, with nothing
of it inside the VM. Until the final reader lands, `answer.json` in the frozen workspace stands in for it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from nanoagent.uploaded.answer import ANSWER, read_answer
from nanoagent.uploaded.contract import ContractError

MISSING_ANSWER = f"wrote no {ANSWER}"  # read_answer's failure for an absent file


SCALARS = frozenset({"string", "number", "integer", "boolean", "null"})


def answer_skeleton(output_schema: Mapping[str, Any]) -> dict[str, Any]:
    """The task's output schema as an unfilled answer: every object property present, `null` per scalar, `[]` per array, `$ref` resolved.

    A union with `null` (`anyOf`/`oneOf`, or a `type` list) is `null`, and so is an `enum` or `const` of scalar values (an Enum field). A schema it cannot skeleton raises a [ContractError] naming its path.
    """
    skeleton = _skeleton(output_schema, output_schema, "$", ())
    if not isinstance(skeleton, dict):
        raise ContractError("output_schema_unsupported", "$: the output schema must describe an object")
    return skeleton


def _skeleton(schema: Any, root: Mapping[str, Any], path: str, refs: tuple[str, ...]) -> Any:
    if not isinstance(schema, Mapping):
        raise ContractError("output_schema_unsupported", f"{path}: a schema must be an object")
    if "$ref" in schema:
        ref = schema["$ref"]
        if ref in refs:
            raise ContractError("output_schema_unsupported", f"{path}: {ref} refers to itself")
        target: Any = root
        for part in ref[2:].split("/") if isinstance(ref, str) and ref.startswith("#/") else ():
            target = target.get(part.replace("~1", "/").replace("~0", "~")) if isinstance(target, Mapping) else None
        if not isinstance(target, Mapping):
            raise ContractError("output_schema_unsupported", f"{path}: cannot resolve {ref!r}")
        return _skeleton(target, root, path, (*refs, ref))
    for union in ("anyOf", "oneOf"):
        if union in schema:
            if any(isinstance(branch, Mapping) and branch.get("type") == "null" for branch in schema[union]):
                return None
            raise ContractError("output_schema_unsupported", f"{path}: {union} without a null branch has no skeleton")
    kind = schema.get("type")
    if kind is None and ("enum" in schema or "const" in schema):
        # A choice among fixed values: the schema a plugin's Enum output field gets (slimconfig writes `{"enum": [...]}` with no
        # `type`). Its values are scalars, so it is one scalar: `null`, like any other.
        values = schema["enum"] if "enum" in schema else [schema["const"]]
        if isinstance(values, list) and values and all(value is None or isinstance(value, (str, int, float, bool)) for value in values):
            return None
        raise ContractError("output_schema_unsupported", f"{path}: an enum or const of non-scalar values has no skeleton")
    if isinstance(kind, list):
        if "null" in kind:
            return None
        raise ContractError("output_schema_unsupported", f"{path}: the type list {kind} has no skeleton")
    if kind == "object" or (kind is None and "properties" in schema):
        return {name: _skeleton(sub, root, f"{path}.{name}", refs) for name, sub in schema.get("properties", {}).items()}
    if kind == "array":
        return []
    if kind in SCALARS:
        return None
    raise ContractError("output_schema_unsupported", f"{path}: the schema's type {kind!r} has no skeleton")


def answer_text(skeleton: Mapping[str, Any]) -> bytes:
    """The bytes the worker seeds `answer.json` with, in one stable format."""
    return (json.dumps(skeleton, indent=2, ensure_ascii=False) + "\n").encode()


def answer_instructions(task: Mapping[str, Any]) -> str:
    """The system prompt every model request of a case session carries: how to fill the answer `outcome` reads, and the shape it must have.

    One fixed text for every case, then the task's public `output_schema`. Replacing the seam in [outcome] replaces this with it.
    """
    schema = json.dumps(task["output_schema"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return (
        "The file answer.json is already in the workspace. It holds every field of the answer, each present and unfilled.\n"
        "Fill in every field of answer.json once you have the result, as the last thing you do, then stop. Keep its shape: do not add or remove fields.\n"
        'Only when the inputs are ones the task cannot answer, replace the whole file with {"refused": "<why>"}.\n'
        f"Answer schema:\n{schema}"
    )


def outcome(frozen_workspace: Path, session_record: Mapping[str, Any]) -> dict[str, Any]:
    """`{status: answered, answer} | {status: refused, reason} | {status: execution_failed, reason}` of the frozen workspace.

    ``session_record`` is what the session recorded (``{skipped}``: the paths the freeze could not copy, with why). An `answer.json` the harness left as seeded is an answer like any other: the verifier judges it.
    """
    if ANSWER in session_record["skipped"]:  # the freeze never materializes links, which read_answer refuses as not a regular file
        return {"status": "execution_failed", "reason": "invalid_result"}
    answer, refusal, failure = read_answer(frozen_workspace)
    if failure is not None:
        return {"status": "execution_failed", "reason": "missing_result" if failure == MISSING_ANSWER else "invalid_result"}
    if refusal is not None:
        return {"status": "refused", "reason": refusal}
    return {"status": "answered", "answer": answer}
