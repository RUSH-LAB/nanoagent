"""Which fields a v0001 ``runner: decide`` task can fill (rule 5): chosen from a closed type, or copied.

A decide task's runner writes no value of its own. Every field of every tool input and of the
task's output is either *chosen*, an Enum member or a bool, or *copied*, a value of exactly its
type found in the task's input or in an earlier output of one of its tools (the sources). A
dataclass or list with no such value is built field by field or item by item. Enum and dataclass
types match by identity, and scalars only as the same type: an ``int`` is never a ``float`` or a
``bool``. :func:`unfillable` names every field that can be neither; NanoAgent's runner
(:mod:`nanoagent.plugin.dataflow`) fills the rest.
"""

from __future__ import annotations

import dataclasses
import enum
import types
import typing
from typing import Any


def _strip(annotation: Any) -> Any:
    """``annotation`` without ``Annotated`` and ``| None``."""
    while True:
        if typing.get_origin(annotation) is typing.Annotated:
            annotation = typing.get_args(annotation)[0]
            continue
        options = [option for option in typing.get_args(annotation) if option is not type(None)]
        if typing.get_origin(annotation) not in (typing.Union, types.UnionType) or len(options) != 1:
            return annotation
        [annotation] = options


def _fields(cls: type) -> list[tuple[str, Any]]:
    return [(item.name, _strip(item.type)) for item in dataclasses.fields(cls)]


def _item(annotation: Any) -> Any | None:
    """The item type of ``list[T]``, else None."""
    return typing.get_args(annotation)[0] if typing.get_origin(annotation) is list else None


def _closed(annotation: Any) -> bool:
    return annotation is bool or isinstance(annotation, type) and issubclass(annotation, enum.Enum)


def _name(annotation: Any) -> str:
    return annotation.__name__ if isinstance(annotation, type) else str(annotation)


def leaf_types(cls: type) -> list[Any]:
    """Every type a value of the dataclass ``cls`` holds a value of, ``cls`` itself included."""
    found: list[Any] = []

    def visit(annotation: Any) -> None:
        if annotation in found:
            return
        found.append(annotation)
        if dataclasses.is_dataclass(annotation):
            for _, inner in _fields(annotation):
                visit(inner)
        elif _item(annotation) is not None:
            visit(_item(annotation))

    visit(cls)
    return found


def unfillable(targets: dict[str, type], sources: list[type]) -> list[str]:
    """Every field of the ``targets`` dataclasses, by label, that is neither chosen nor copied.

    Each is named as ``<label> .<path> (<type>)``; a list item's path ends in ``[]``.
    """
    available = [annotation for source in sources for annotation in leaf_types(source)]

    def problems(path: str, annotation: Any) -> list[str]:
        if _closed(annotation) or annotation in available:
            return []
        if dataclasses.is_dataclass(annotation):
            return [problem for name, inner in _fields(annotation) for problem in problems(f"{path}.{name}", inner)]
        if _item(annotation) is not None:
            return problems(f"{path}[]", _item(annotation))
        return [f"{path} ({_name(annotation)})"]

    return [
        f"{label} {problem}"
        for label, cls in targets.items()
        for name, annotation in _fields(cls)
        for problem in problems(f".{name}", annotation)
    ]
