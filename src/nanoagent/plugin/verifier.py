"""Standard semantic verification contract for plugin task inputs and outputs."""

from __future__ import annotations

import importlib.util
from dataclasses import asdict, dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Callable


@dataclass(frozen=True)
class Verification:
    valid: bool
    score: float
    message: str
    details: dict[str, Any]

    def __post_init__(self) -> None:
        if not isinstance(self.valid, bool):
            raise TypeError("verification valid must be a boolean")
        if not isinstance(self.score, (int, float)) or isinstance(self.score, bool):
            raise TypeError("verification score must be a number")
        if not 0 <= self.score <= 1:
            raise ValueError("verification score must be between 0 and 1")
        if not isinstance(self.message, str):
            raise TypeError("verification message must be a string")
        if not isinstance(self.details, dict):
            raise TypeError("verification details must be a mapping")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


Verifier = Callable[..., Verification | dict[str, Any]]


def verify_input(root: str | Path, value: dict[str, Any]) -> Verification:
    return _call(root, "verify_input", value)


def verify_output(
    root: str | Path,
    input_value: dict[str, Any],
    output_value: dict[str, Any],
) -> Verification:
    return _call(root, "verify_output", input_value, output_value)


def _call(root: str | Path, name: str, *arguments: dict[str, Any]) -> Verification:
    module = _load(Path(root).resolve() / "verifier.py")
    function = getattr(module, name, None)
    if not callable(function):
        raise ValueError(f"verifier.py must define {name}()")
    result = function(*arguments)
    if isinstance(result, Verification):
        return result
    if not isinstance(result, dict):
        raise TypeError(f"{name}() must return Verification or a mapping")
    try:
        return Verification(
            valid=result["valid"],
            score=result["score"],
            message=result["message"],
            details=result["details"],
        )
    except KeyError as error:
        raise ValueError(f"{name}() result is missing {error.args[0]!r}") from error


def _load(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        f"_nanoagent_plugin_verifier_{hash(path)}", path
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load plugin verifier: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
