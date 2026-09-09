"""Backend lookup: a name in a config must resolve to the transport that name promises.

The failure this guards against is silent. A backend is chosen by a string in a yaml, and every
number a run produces came from whichever endpoint that string resolved to — so a plugin file
that shadows a built-in, or a name that escapes the plugin directory, is not a crash, it is a
table of results attributed to the wrong model. Hence the shadowing, path-escape and
stdlib-shadowing tests below, which are about what must NOT resolve.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from nanoagent.inference import LeanInferConfig
from nanoagent.inference import plugins as plugins_mod
from nanoagent.inference.backends import build_backend
from nanoagent.inference.plugins import (
    BackendNotFound,
    available_backends,
    load_backend_class,
    plugin_dirs,
)

# A minimal plugin: the whole contract is a module-level BACKEND with a from_config classmethod.
_PLUGIN = """
class Fake:
    def __init__(self, cfg):
        self.cfg = cfg

    @classmethod
    def from_config(cls, cfg):
        return cls(cfg)

BACKEND = Fake
"""


@pytest.fixture(autouse=True)
def isolated_plugins(monkeypatch, tmp_path):
    """Point the search at an empty tmp dir, so a test never sees the repo's real .meta/plugins.

    Also drops any module this package cached under its private prefix: the loader memoizes in
    sys.modules (a plugin must not be executed twice), which would otherwise leak one test's
    plugin file into the next test's lookup of the same name.
    """
    monkeypatch.setenv(plugins_mod.PLUGIN_ENV, str(tmp_path / "empty"))
    for name in [n for n in sys.modules if n.startswith("_nanoagent_plugin_")]:
        monkeypatch.delitem(sys.modules, name)
    return tmp_path


def _write_plugin(directory: Path, name: str, body: str = _PLUGIN) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.py"
    path.write_text(body)
    return path


def test_a_builtin_resolves_without_touching_the_filesystem() -> None:
    from nanoagent.inference.backends.sglang import SglangBackend

    assert load_backend_class("sglang") is SglangBackend


def test_a_plugin_file_is_loaded_by_name(isolated_plugins) -> None:
    _write_plugin(isolated_plugins / "p", "acme")
    cls = load_backend_class("acme", [str(isolated_plugins / "p")])
    assert cls.__name__ == "Fake"


def test_build_backend_constructs_a_plugin_through_from_config(isolated_plugins) -> None:
    """The one constructor every transport shares — a plugin is not a special case in the factory."""
    _write_plugin(isolated_plugins / "p", "acme")
    cfg = LeanInferConfig(backend="acme", plugin_dirs=[str(isolated_plugins / "p")])
    backend = build_backend(cfg)
    assert backend.cfg is cfg


def test_a_plugin_may_not_take_over_a_builtin_name(isolated_plugins) -> None:
    """A stray file that quietly became the `sglang` transport would mean a run's numbers came
    from an endpoint the config never named — the built-in wins, always."""
    from nanoagent.inference.backends.sglang import SglangBackend

    _write_plugin(isolated_plugins / "p", "sglang")
    assert load_backend_class("sglang", [str(isolated_plugins / "p")]) is SglangBackend


@pytest.mark.parametrize("name", ["../../evil", "/etc/passwd", "Acme", "1st", "", "a-b"])
def test_a_name_that_is_not_a_plain_identifier_is_refused(name: str) -> None:
    """The name becomes both an import path and a filename: `../../evil` would read outside the
    plugin directory and `os` would import the stdlib."""
    with pytest.raises(BackendNotFound, match="invalid backend name"):
        load_backend_class(name)


def test_a_stdlib_name_is_not_mistaken_for_a_backend() -> None:
    """`os` is importable and matches the name pattern, but `nanoagent.inference.backends.os` is not — the
    lookup must be for OUR module, not for anything on sys.path."""
    with pytest.raises(BackendNotFound, match="unknown backend 'os'"):
        load_backend_class("os")


def test_a_plugin_module_cannot_shadow_the_stdlib_for_later_imports(
    isolated_plugins,
) -> None:
    """Registered under a private name, so a plugin called json.py does not become `import json`."""
    _write_plugin(isolated_plugins / "p", "json")
    load_backend_class("json", [str(isolated_plugins / "p")])
    import json

    assert json.dumps({"a": 1}) == '{"a": 1}'


def test_an_unknown_name_says_where_it_looked(isolated_plugins) -> None:
    """The usual cause is a plugin dir that isn't where the caller thinks, so the error has to
    name the directories rather than just the missing backend."""
    searched = str(isolated_plugins / "nowhere")
    with pytest.raises(BackendNotFound, match=searched):
        load_backend_class("acme", [searched])


def test_a_plugin_without_the_contract_says_what_is_missing(isolated_plugins) -> None:
    _write_plugin(isolated_plugins / "p", "acme", "BACKEND = 'not a class'\n")
    with pytest.raises(BackendNotFound, match="from_config"):
        load_backend_class("acme", [str(isolated_plugins / "p")])


def test_a_plugin_that_raises_on_import_is_reported_as_such(isolated_plugins) -> None:
    """Distinguishable from "no such backend": a typo in the plugin and a missing plugin are
    different problems with different fixes."""
    _write_plugin(isolated_plugins / "p", "acme", "raise RuntimeError('boom')\n")
    with pytest.raises(BackendNotFound, match="failed to import: boom"):
        load_backend_class("acme", [str(isolated_plugins / "p")])
    # And it left nothing half-executed behind for the next lookup to find.
    assert "_nanoagent_plugin_acme" not in sys.modules


def test_a_builtins_own_missing_dependency_is_not_reported_as_a_missing_backend(
    monkeypatch,
) -> None:
    """`openai` absent must read as `openai` absent. Swallowing it as "unknown backend 'sglang'"
    would send someone hunting for a typo in a name that was correct."""
    monkeypatch.delitem(sys.modules, "nanoagent.inference.backends.sglang", raising=False)
    monkeypatch.setitem(sys.modules, "openai", None)  # `import x` with a None entry -> ImportError
    with pytest.raises(ImportError):
        load_backend_class("sglang")


# ─── search order ────────────────────────────────────────────────────────────────────────────


def test_the_search_order_is_explicit_dirs_then_the_environment(monkeypatch) -> None:
    monkeypatch.setenv(plugins_mod.PLUGIN_ENV, os.pathsep.join(["/env/one", "/env/two"]))
    assert plugin_dirs(["/explicit"]) == ["/explicit", "/env/one", "/env/two"]


def test_the_default_location_sits_beside_the_repo(monkeypatch) -> None:
    """No env, no explicit dirs: `.meta/plugins` at the project root, which is where a checked-in
    internal transport lives."""
    monkeypatch.delenv(plugins_mod.PLUGIN_ENV, raising=False)
    (only,) = plugin_dirs()
    assert only.endswith(os.path.join(".meta", "plugins"))


def test_a_missing_directory_stays_in_the_list(isolated_plugins) -> None:
    """Filtering it out would make the "searched in ..." error omit the very directory the caller
    got wrong."""
    missing = str(isolated_plugins / "nope")
    assert missing in plugin_dirs([missing])


def test_the_first_directory_holding_the_file_wins(isolated_plugins) -> None:
    _write_plugin(isolated_plugins / "second", "acme", "BACKEND = 'wrong one'\n")
    _write_plugin(isolated_plugins / "first", "acme")
    cls = load_backend_class(
        "acme", [str(isolated_plugins / "first"), str(isolated_plugins / "second")]
    )
    assert cls.__name__ == "Fake"


def test_listing_reports_builtins_first_and_deduplicates(isolated_plugins) -> None:
    _write_plugin(isolated_plugins / "p", "acme")
    _write_plugin(isolated_plugins / "p", "sglang")  # shadowed, so it must not appear twice
    names = available_backends([str(isolated_plugins / "p")])
    assert names.index("sglang") < names.index("acme")
    assert names.count("sglang") == 1
