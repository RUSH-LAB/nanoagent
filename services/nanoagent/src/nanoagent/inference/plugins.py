"""Resolve a transport by NAME — built-ins first, then a ``<name>.py`` dropped in a plugin dir.

WHY A PLUGIN LAYER AT ALL. nanoagent ships under MIT and its transports are generic
(``sglang`` is the OpenAI SDK pointed at a ``base_url``). The endpoints that actually answer
inside a company are not: a gateway host, a shared team key, an outbound-proxy allowlist. None
of that belongs in ``src/`` — it is neither useful nor usable outside that network, and a
published package should not carry it. So ``src/`` holds the generic transports and the site
puts its own in ``.meta/plugins/<name>.py``, loaded by name at run time.

WHY BY FILENAME AND NOT AN ENTRY POINT. ``importlib.metadata.entry_points()`` scans every
installed distribution. This package sits under agent rollouts and batch judges that build a
backend per process, so ``backend: mygateway`` loads exactly one file and scans nothing. Only
:func:`available_backends` — for error messages — ever lists a directory.

WRITING A PLUGIN. Drop ``<name>.py`` in a plugin directory and give it a module-level
``BACKEND`` naming a class with a ``from_config`` classmethod::

    from nanoagent.inference.backends.sglang import SglangBackend

    class MyBackend(SglangBackend):
        @classmethod
        def from_config(cls, cfg):
            return super().from_config(dataclasses.replace(cfg, base_url=cfg.base_url or "https://..."))

    BACKEND = MyBackend

Directories are searched in order: ``config.plugin_dirs``, then ``$NANOAGENT_PLUGINS``
(``os.pathsep``-separated), then ``<project root>/.meta/plugins``. A built-in of the same name
always wins, so a stray file cannot quietly become the transport a config names — a run whose
numbers came from a different endpoint than the config says is the kind of thing nobody notices
until the table is already written.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import re
import sys
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from types import ModuleType

#: ``os.pathsep``-separated plugin directories; replaces the default location when set.
PLUGIN_ENV = "NANOAGENT_PLUGINS"

#: The name this variable had while the inference side was a separate package (``leaninfer``),
#: read only when :data:`PLUGIN_ENV` is unset. A deployment that exports the old name in a shell
#: profile or a job spec keeps resolving its gateway plugin across the merge, which is the whole
#: point — the alternative is a rollout that silently falls back to the built-in transport.
LEGACY_PLUGIN_ENV = "LEANINFER_PLUGINS"

#: Where plugins live when neither variable is set — checked in beside the repo, outside
#: the package that gets published.
DEFAULT_PLUGIN_SUBDIR = os.path.join(".meta", "plugins")

# A backend name becomes both an importable module path and a filename, so it is restricted to
# the characters that are unambiguously safe in both. Without this, `backend: ../../evil` reads a
# file outside the plugin directory and `backend: os` imports the stdlib.
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# The attribute a plugin module must expose, and the constructor every backend class shares
# (built-in or not) — one contract, so build_backend has a single code path.
_BACKEND_ATTR = "BACKEND"
_FACTORY_METHOD = "from_config"


class BackendNotFound(ValueError):
    """No backend of that name could be found, or the file found isn't a backend.

    A subclass of :class:`ValueError` because that is what ``build_backend`` raised for an
    unknown backend before plugins existed — a caller that catches the old error still catches
    this one.
    """


def _project_root() -> str:
    """The repo root: four levels up from this file (``src/nanoagent/inference/plugins.py``).

    True for the editable install this repo is developed against. A wheel installed into
    site-packages has no ``.meta/`` above it, and for that case ``$NANOAGENT_PLUGINS`` — or
    ``config.plugin_dirs`` — is the answer; both are checked first.
    """
    here = os.path.abspath(__file__)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(here))))


def plugin_dirs(extra: tuple[str, ...] | list[str] = ()) -> list[str]:
    """Directories to search, in order: ``extra``, then ``$NANOAGENT_PLUGINS``, then the default.

    Missing directories stay in the list rather than being filtered out, so a "not found" error
    can say where it looked — the usual cause is a plugin dir that isn't where the caller thinks.
    """
    dirs = list(extra)
    raw = os.environ.get(PLUGIN_ENV) or os.environ.get(LEGACY_PLUGIN_ENV)
    if raw:
        dirs += [d for d in raw.split(os.pathsep) if d]
    else:
        dirs.append(os.path.join(_project_root(), DEFAULT_PLUGIN_SUBDIR))
    seen: set[str] = set()
    out: list[str] = []
    for d in dirs:
        full = os.path.abspath(os.path.expanduser(d))
        if full not in seen:
            seen.add(full)
            out.append(full)
    return out


def _builtin_module(name: str) -> ModuleType | None:
    """Import ``nanoagent.inference.backends.<name>``, or return None if there is no such built-in.

    ``ModuleNotFoundError`` is swallowed only for the module being looked up: a built-in that
    exists but fails on a missing dependency of its own (``openai`` absent, say) must surface as
    that error, not read as "no such backend".
    """
    target = f"nanoagent.inference.backends.{name}"
    try:
        return importlib.import_module(target)
    except ModuleNotFoundError as e:
        if e.name == target:
            return None
        raise


def _plugin_module(name: str, dirs: list[str]) -> ModuleType | None:
    """Load ``<dir>/<name>.py`` from the first directory that has it, or return None."""
    for directory in dirs:
        path = os.path.join(directory, f"{name}.py")
        if not os.path.isfile(path):
            continue
        # A private module name, so a plugin called e.g. `json.py` cannot shadow the stdlib for
        # anything imported after it. Registered in sys.modules BEFORE execution because a module
        # that later gets pickled or re-imported (a backend that forks workers) must resolve back
        # to this same object rather than being executed a second time.
        mod_name = f"_nanoagent_plugin_{name}"
        cached = sys.modules.get(mod_name)
        if cached is not None:
            return cached
        spec = importlib.util.spec_from_file_location(mod_name, path)
        if spec is None or spec.loader is None:
            raise BackendNotFound(f"cannot load plugin {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as e:
            del sys.modules[mod_name]
            raise BackendNotFound(f"plugin {path} failed to import: {e}") from e
        return module
    return None


def load_backend_class(name: str, extra_dirs: tuple[str, ...] | list[str] = ()) -> Any:
    """Resolve ``name`` to a backend class: built-ins first, then the plugin directories.

    The returned class is whatever the module named ``BACKEND``; it must carry a ``from_config``
    classmethod, which is the one constructor :func:`~nanoagent.inference.backends.build_backend` calls
    for every transport. Raises :class:`BackendNotFound` for an unusable name, a name nothing
    provides, or a file that doesn't hold up its end of the contract.
    """
    if not _NAME_RE.match(name or ""):
        raise BackendNotFound(
            f"invalid backend name {name!r}: expected lowercase [a-z][a-z0-9_]*"
        )
    dirs = plugin_dirs(extra_dirs)
    module = _builtin_module(name) or _plugin_module(name, dirs)
    if module is None:
        known = ", ".join(available_backends(extra_dirs)) or "none"
        raise BackendNotFound(
            f"unknown backend {name!r} (available: {known}; searched for {name}.py in {', '.join(dirs)})"
        )
    backend = getattr(module, _BACKEND_ATTR, None)
    if not isinstance(backend, type) or not callable(
        getattr(backend, _FACTORY_METHOD, None)
    ):
        raise BackendNotFound(
            f"{module.__name__} does not define {_BACKEND_ATTR} as a class with a "
            f"{_FACTORY_METHOD}(config) classmethod"
        )
    return backend


def available_backends(extra_dirs: tuple[str, ...] | list[str] = ()) -> list[str]:
    """Every backend name that could be loaded, built-ins first then plugins, deduped.

    The one path that scans directories. It exists for error messages, not for the hot path,
    which loads a single named module.
    """
    names: list[str] = []
    builtins_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backends")
    for directory in [builtins_dir, *plugin_dirs(extra_dirs)]:
        if not os.path.isdir(directory):
            continue
        names += sorted(
            f[:-3]
            for f in os.listdir(directory)
            if f.endswith(".py") and _NAME_RE.match(f[:-3])
        )
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


__all__ = [
    "LEGACY_PLUGIN_ENV",
    "PLUGIN_ENV",
    "BackendNotFound",
    "available_backends",
    "load_backend_class",
    "plugin_dirs",
]
