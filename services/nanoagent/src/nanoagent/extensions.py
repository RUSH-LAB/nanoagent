"""Load configured tools and hooks without coupling the core contracts to OmegaConf or imports."""

from __future__ import annotations

import importlib
import importlib.util
import inspect
from collections.abc import Iterable
from pathlib import Path
from types import ModuleType
from typing import Any, cast

from omegaconf import OmegaConf

from nanoagent.core.hooks import Hooks, TRIGGERS
from nanoagent.core.tool import Tool

PACKAGED_CONFIGS = Path(__file__).resolve().parent / "configs"


def get_tools(yaml_paths: Iterable[str | Path]) -> list[Tool]:
    """Load the concrete :class:`Tool` subclasses declared by YAML manifests."""
    tools: list[Tool] = []
    for yaml_path in yaml_paths:
        spec = OmegaConf.load(resolve_config(yaml_path))
        if "code" not in spec:
            raise FileNotFoundError(f"{yaml_path}: tool spec has no 'code' module path")
        code = str(spec.code)
        if code.endswith(".py") or "/" in code:
            path = Path(code)
            if not path.is_file():
                raise FileNotFoundError(f"{yaml_path}: code module {path} does not exist")
            module = load_module(path)
        else:
            module = importlib.import_module(code)
        config = {
            str(k): v
            for k, v in cast(dict, OmegaConf.to_container(spec, resolve=True)).items()
            if k != "code"
        }
        defined = [
            cls(**config)
            for _, cls in inspect.getmembers(module, inspect.isclass)
            if issubclass(cls, Tool)
            and cls is not Tool
            and cls.__module__ == module.__name__
            and getattr(cls, "NAME", None) is not None
        ]
        if not defined:
            raise ValueError(f"{code} defines no Tool subclass")
        tools.extend(defined)
    return tools


def get_hooks(yaml_paths: Iterable[str | Path]) -> Hooks | None:
    """Load configured lifecycle hook modules; return ``None`` when none are configured."""
    modules = []
    for yaml_path in yaml_paths:
        spec = OmegaConf.load(yaml_path)
        if "code" not in spec:
            raise FileNotFoundError(f"{yaml_path}: hook spec has no 'code' module path")
        code = Path(str(cast(Any, spec).code))
        if not code.is_file():
            raise FileNotFoundError(f"{yaml_path}: code module {code} does not exist")
        module = load_module(code)
        if not any(callable(getattr(module, trigger, None)) for trigger in TRIGGERS):
            expected = ", ".join(TRIGGERS)
            raise ValueError(f"{code} defines no hook function; expected one of {expected}")
        modules.append(module)
    return Hooks(modules) if modules else None


def resolve_config(path: str | Path) -> Path:
    """Resolve a path from the working directory, then from packaged defaults."""
    candidate = Path(path)
    if candidate.is_absolute() or candidate.is_file():
        return candidate
    packaged = PACKAGED_CONFIGS / candidate
    return packaged if packaged.is_file() else candidate


def load_module(path: Path) -> ModuleType:
    """Import a Python file under a synthetic, path-derived module name."""
    name = "nanoagent_tool_" + path.stem
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise FileNotFoundError(f"cannot import extension module at {path}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise ImportError(f"failed to import tool module at {path}: {error}") from error
    return module
