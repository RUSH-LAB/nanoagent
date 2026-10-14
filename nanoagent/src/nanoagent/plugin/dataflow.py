"""Where a ``runner: decide`` task's values come from: chosen from a closed type, or copied.

A decide task's runner writes no value of its own. Every field of every tool input and of the
task's output is either *chosen*, an Enum member or a bool, or *copied*, a value of exactly its
type found in the task's input or in an earlier output of one of its tools (the sources). A
dataclass or list with no such value is built field by field or item by item. Enum and dataclass
types match by identity, and scalars only as the same type: an ``int`` is never a ``float`` or a
``bool``. :func:`unfillable` names every field that can be neither.

The runner reaches its choices through a :class:`Decider`, whatever model or code is behind it:
the state so far and a batch of :class:`Question` objects go in, one answer per question comes back.
:func:`answer_schema` is the JSON Schema a model's answer is held to, and :func:`check` refuses
any answer that is not exactly one of the options it was given. :func:`fill` asks those questions
for one value, a tool's input or the task's output, and builds it from the answers.
"""

from __future__ import annotations

import copy
import dataclasses
import enum
import types
import typing
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, Literal, Protocol

if TYPE_CHECKING:
    from nanoagent.core.agent import AgentResult


def strip(annotation: Any) -> tuple[Any, str | None]:
    """``annotation`` without ``Annotated`` and ``| None``, and its ``Annotated`` description."""
    description = None
    while True:
        if typing.get_origin(annotation) is typing.Annotated:
            annotation, *extras = typing.get_args(annotation)
            description = next((extra for extra in extras if isinstance(extra, str)), description)
            continue
        options = [option for option in typing.get_args(annotation) if option is not type(None)]
        if typing.get_origin(annotation) not in (typing.Union, types.UnionType) or len(options) != 1:
            return annotation, description
        [annotation] = options


def _fields(cls: type) -> list[tuple[str, Any]]:
    return [(item.name, strip(item.type)[0]) for item in dataclasses.fields(cls)]


def _item(annotation: Any) -> Any | None:
    """The item type of ``list[T]``, else None."""
    return typing.get_args(annotation)[0] if typing.get_origin(annotation) is list else None


def _closed(annotation: Any) -> bool:
    return annotation is bool or isinstance(annotation, type) and issubclass(annotation, enum.Enum)


def leaf_types(cls: type) -> list[Any]:
    """Every type a value of the dataclass ``cls`` holds a value of, ``cls`` itself included."""
    found: list[Any] = []

    def visit(annotation: Any) -> None:
        if annotation in found:
            return
        found.append(annotation)
        if dataclasses.is_dataclass(annotation):
            for _name, inner in _fields(annotation):
                visit(inner)
        elif _item(annotation) is not None:
            visit(_item(annotation))

    visit(cls)
    return found


def _name(annotation: Any) -> str:
    return annotation.__name__ if isinstance(annotation, type) else str(annotation)


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


class DecisionError(ValueError):
    """An answer that is not exactly one of the options its question gave."""


@dataclasses.dataclass(frozen=True)
class Question:
    """One choice: ``one`` picks a single option, ``some`` a duplicate-free subset of them."""

    id: str
    kind: Literal["one", "some"]
    text: str
    options: tuple[str, ...]


@dataclasses.dataclass(frozen=True)
class Answers:
    """One value per question id; ``probabilities`` only when a backend reports a distribution."""

    values: dict[str, str | list[str]]
    probabilities: dict[str, dict[str, float]] | None = None


class Decider(Protocol):
    """Answers a decide task's questions, and records what that cost."""

    async def decide(self, state: dict[str, Any], questions: list[Question]) -> Answers: ...

    def record(self) -> AgentResult | None:
        """The transcript and profile of every request so far; None when no model was asked."""
        ...


def answer_schema(questions: list[Question]) -> dict[str, Any]:
    """One flat strict object with a required property per question, its value one of the options."""

    def option(question: Question) -> dict[str, Any]:
        choice = {"type": "string", "enum": list(question.options)}
        if question.kind == "one":
            return {**choice, "description": question.text}
        return {"type": "array", "items": choice, "description": question.text}

    return {
        "type": "object",
        "properties": {question.id: option(question) for question in questions},
        "required": [question.id for question in questions],
        "additionalProperties": False,
    }


def check(questions: list[Question], answers: Answers) -> None:
    """Raise :class:`DecisionError` unless ``answers`` answers exactly ``questions`` from their options."""
    asked = [question.id for question in questions]
    if sorted(answers.values) != sorted(asked):
        raise DecisionError(f"answers for {sorted(answers.values)} do not match the questions {sorted(asked)}")
    for question in questions:
        value = answers.values[question.id]
        if question.kind == "one":
            if not isinstance(value, str) or value not in question.options:
                raise DecisionError(f"{question.id}: {value!r} is not one of {list(question.options)}")
            continue
        if not isinstance(value, list) or not all(isinstance(item, str) and item in question.options for item in value):
            raise DecisionError(f"{question.id}: {value!r} is not a list of {list(question.options)}")
        if len(set(value)) != len(value):
            raise DecisionError(f"{question.id}: {value!r} names an option twice")


NULL = "null"  # the option that sets a nullable field to null
BUILD = "build"  # the option that builds a dataclass field by field, or a list item by item
ADD, DONE = "add", "done"

Ask = Callable[[list[Question], dict[str, str]], Awaitable[dict[str, str | list[str]]]]


def _nullable(annotation: Any) -> bool:
    if typing.get_origin(annotation) is typing.Annotated:
        annotation = typing.get_args(annotation)[0]
    return typing.get_origin(annotation) in (typing.Union, types.UnionType) and type(None) in typing.get_args(annotation)


def values(value: Any, annotation: Any, path: str) -> list[tuple[Any, str, Any]]:
    """Every non-null value inside ``value``, a JSON value of type ``annotation``, as ``(type, path, value)``.

    A path names the value in the decide state, e.g. ``calls[0].output.entries[2].key``.
    """
    if value is None:
        return []
    annotation = strip(annotation)[0]
    found = [(annotation, path, value)]
    if dataclasses.is_dataclass(annotation):
        for item in dataclasses.fields(annotation):
            found += values(value[item.name], item.type, f"{path}.{item.name}")
    elif _item(annotation) is not None:
        for index, item in enumerate(value):
            found += values(item, _item(annotation), f"{path}[{index}]")
    return found


async def fill(cls: type, path: str, pool: list[tuple[Any, str, Any]], ask: Ask) -> dict[str, Any]:
    """A JSON value of the dataclass ``cls`` with every field chosen or copied from ``pool``.

    Each dataclass level asks its fields' questions in one call of ``ask(questions, forced)``,
    then builds its composite fields. A field with exactly one option that is not null takes it
    with no question, and is passed in ``forced`` as ``{path: option}``. A field with no option but
    null raises :class:`DecisionError`: null is never a stand-in for a missing value.
    """
    slots = [(item.name, f"{path}.{item.name}", item.type) for item in dataclasses.fields(cls)]
    return await _level(slots, pool, ask)


async def _level(slots: list[tuple[str, str, Any]], pool: list[tuple[Any, str, Any]], ask: Ask) -> dict[str, Any]:
    questions: list[Question] = []
    forced: dict[str, str] = {}
    picked: dict[str, str | list[str]] = {}
    copies: dict[str, Any] = {}
    for slot, path, declared in slots:
        annotation, description = strip(declared)
        text = f"{path} ({_name(annotation)})" + (f": {description}" if description else "")
        nullable = [NULL] if _nullable(declared) else []
        item = _item(annotation)
        if item is not None and _closed(item) and item is not bool and not nullable:
            questions.append(Question(slot, "some", text, tuple(str(member.value) for member in item)))
            continue
        if annotation is bool:
            options = ["true", "false"]
        elif _closed(annotation):
            options = [str(member.value) for member in annotation]
        else:
            # One option per distinct value, named by where it first appears.
            options, seen = [], []
            for kind, source, value in pool:
                if kind == annotation and value not in seen:
                    options.append(source)
                    seen.append(value)
                    copies[source] = value
            if not options and (dataclasses.is_dataclass(annotation) or item is not None):
                options = [BUILD]
        if not options:
            raise DecisionError(f"{path} ({_name(annotation)}): no value of its type is in the state")
        options += nullable
        if len(options) == 1:
            forced[path] = picked[slot] = options[0]
        else:
            questions.append(Question(slot, "one", text, tuple(options)))
    if questions or forced:
        picked.update(await ask(questions, forced))
    filled: dict[str, Any] = {}
    for slot, path, declared in slots:
        annotation = strip(declared)[0]
        option = picked[slot]
        if isinstance(option, list):
            # The chosen members in declaration order, whatever order the answer named them in.
            filled[slot] = [member.value for member in _item(annotation) if str(member.value) in option]
        elif option == NULL:
            filled[slot] = None
        elif option == BUILD:
            filled[slot] = await _build(annotation, path, pool, ask)
        elif annotation is bool:
            filled[slot] = option == "true"
        elif _closed(annotation):
            filled[slot] = {str(member.value): member.value for member in annotation}[option]
        else:
            filled[slot] = copy.deepcopy(copies[option])
    return filled


async def _build(annotation: Any, path: str, pool: list[tuple[Any, str, Any]], ask: Ask) -> Any:
    if dataclasses.is_dataclass(annotation):
        return await fill(annotation, path, pool, ask)
    if _closed(_item(annotation)) and _item(annotation) is not bool:
        # A nullable list of choices, not null: its choice of several.
        return (await _level([("value", path, annotation)], pool, ask))["value"]
    items: list[Any] = []
    while True:
        more = Question(ADD, "one", f"{path}: add item {len(items)} ({_name(_item(annotation))}), or done", (ADD, DONE))
        if (await ask([more], {}))[ADD] == DONE:
            return items
        items.append((await _level([("item", f"{path}[{len(items)}]", _item(annotation))], pool, ask))["item"])
