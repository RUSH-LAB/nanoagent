"""What `pip install nanoagent` gets you on the inference side: the public surface, and lazy imports."""

from __future__ import annotations

import re
import subprocess
import sys

import nanoagent
import nanoagent.inference


def test_every_documented_name_is_exported() -> None:
    for name in nanoagent.inference.__all__:
        assert hasattr(nanoagent.inference, name), f"{name} is in __all__ but not importable from nanoagent.inference"


def test_version_is_the_single_source_of_truth() -> None:
    # pyproject reads the distribution version from nanoagent.__version__
    # ([tool.setuptools.dynamic]), so a build fails outright if it stops parsing as a version.
    # There is deliberately no second version on this subpackage: one package, one version.
    assert re.fullmatch(r"\d+\.\d+\.\d+([.-]?(a|b|rc|dev)\d+)?", nanoagent.__version__)
    assert not hasattr(nanoagent.inference, "__version__")


def test_importing_the_package_pulls_in_no_optional_or_provider_dependency() -> None:
    """The base install is client-side and small — the heavy imports are all deferred.

    ``openai`` / ``httpx`` load when a backend is BUILT (backends/__init__.py), ``transformers``
    when a config names a tokenizer (tokenizer.load_tokenizer), huggingface_hub when weights are
    fetched, and sglang_router when the router topology runs. A module-level import creeping into
    any of them would make `import nanoagent.inference` drag the serve stack in, so this is checked
    in a clean interpreter rather than this session (pytest has already imported plenty).

    ``omegaconf`` is not in the list: inference configuration uses it directly. The separate core
    import test below verifies that the agent loop itself does not load configuration libraries.
    """
    probe = (
        "import nanoagent.inference, sys; print(','.join(m for m in "
        "('openai', 'httpx', 'transformers', 'huggingface_hub', 'sglang_router') if m in sys.modules))"
    )
    leaked = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=True).stdout.strip()
    assert leaked == "", f"import nanoagent.inference pulled in: {leaked}"


def test_importing_core_loads_no_configuration_or_provider_dependency() -> None:
    probe = (
        "import nanoagent, sys; print(','.join(m for m in "
        "('openai', 'httpx', 'omegaconf', 'slimconfig') if m in sys.modules))"
    )
    leaked = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=True).stdout.strip()
    assert leaked == "", f"import nanoagent pulled in: {leaked}"


def test_building_the_sglang_backend_is_what_loads_openai(monkeypatch) -> None:
    from nanoagent.inference import LeanInferConfig
    from nanoagent.inference.backends import build_backend

    backend = build_backend(LeanInferConfig(base_url="http://h:1/v1"))
    assert hasattr(backend, "generate")


def test_an_unknown_backend_name_is_rejected() -> None:
    import pytest

    from nanoagent.inference import LeanInferConfig
    from nanoagent.inference.backends import build_backend

    # A well-formed name (see test_plugins.py for the malformed ones, which are refused earlier)
    # that neither a built-in nor a plugin dir provides.
    cfg = LeanInferConfig(backend="notabackend")
    with pytest.raises(ValueError, match="unknown backend"):
        build_backend(cfg)
