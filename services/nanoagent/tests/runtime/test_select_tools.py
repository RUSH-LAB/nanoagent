"""Offline pins for :func:`nanoagent.runtime.build.select_tools` — the ``allowed_tools`` narrowing.

``tools`` says which modules to load; ``allowed_tools`` says which of the tools they defined this
run may use. The two are not the same knob because one YAML can define several tools (``files.yaml``
is read + write + edit), so "the usual harness, read-only" is unsayable as a path list.

What matters is the failure mode: a name that matches nothing must raise. An agent silently
missing the tool the run was about does not look like a config error, it looks like a bad model.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_select_tools.py -q
"""

from __future__ import annotations

import pytest

from nanoagent.core.tool import Tool
from nanoagent.runtime.build import select_tools
from nanoagent.tools.bash import Bash
from nanoagent.tools.code import CodeExec


def _toolset() -> list[Tool]:
    return [Bash(), CodeExec()]


def test_narrowing_keeps_only_the_named_tools() -> None:
    assert [t.name for t in select_tools(_toolset(), ["bash"])] == ["bash"]


def test_the_configured_order_is_kept_not_the_flags() -> None:
    """So `--allowedTools python,bash` and `bash,python` build the identical agent."""
    assert [t.name for t in select_tools(_toolset(), ["python", "bash"])] == ["bash", "python"]


def test_an_empty_allow_list_disarms_the_agent() -> None:
    """`[]` is a real answer (a pure-reasoning run), distinct from null (= everything)."""
    assert select_tools(_toolset(), []) == []


def test_a_name_that_matches_nothing_raises_and_lists_what_there_is() -> None:
    with pytest.raises(ValueError, match=r"no such tool: raed.*toolset has bash, python"):
        select_tools(_toolset(), ["bash", "raed"])
