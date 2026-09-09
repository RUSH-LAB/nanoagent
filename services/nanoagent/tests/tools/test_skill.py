"""Offline tests for :mod:`nanoagent.tools.skill` and the prompt
:func:`~nanoagent.runtime.build.build_prompt_and_tools` assembles from it (plus that function's
sibling :func:`~nanoagent.runtime.build.context_text`, which folds in the project's own instructions).

The property that makes skills worth having is the DEFER: the prompt carries every skill's
one-line description and NO skill's body, and a body arrives only when the ``skill`` tool is
called for it. A version that inlined the bodies would pass a naive "the skill is available"
test and quietly spend the whole context window, so that is what these assert.

Also pinned: ``AGENTS.override.md`` REPLACES ``AGENTS.md`` (including replacing it with nothing,
which concatenation cannot express), and a config with ``skills: null`` / ``context_files: []``
gets its ``system_prompt`` back byte for byte.

Fully offline: tmp_path only.

Run (from the repo root)::

    python3 -m pytest tests/tools/test_skill.py -x -q
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nanoagent.runtime.build import build_prompt_and_tools, context_text
from nanoagent.runtime.config import AgentConfig
from nanoagent.tools.skill import discover, Skill

_BODY = "Step 1: do the thing.\nStep 2: do the other thing."


def _write_skill(root: Path, name: str, description: str, body: str = _BODY) -> None:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n")


def _cfg(**kwargs: object) -> AgentConfig:
    base = {
        "system_prompt": "BASE",
        "max_steps": 5,
        "cost_limit": None,
        "token_limit": None,
        "context_window": None,
        "hooks": [],
        "skills": None,
        "context_files": [],
        "events": None,
    }
    return AgentConfig(**{**base, **kwargs})  # type: ignore[arg-type]


def test_prompt_lists_descriptions_and_withholds_bodies(tmp_path: Path) -> None:
    _write_skill(tmp_path, "review", "review a diff for correctness")
    _write_skill(tmp_path, "release", "cut and publish a release")
    prompt, tools = build_prompt_and_tools(_cfg(skills=str(tmp_path)), [])

    assert "review a diff for correctness" in prompt
    assert "cut and publish a release" in prompt
    assert _BODY not in prompt  # the defer: bodies cost context only when fetched
    assert [t.name for t in tools] == ["skill"]


def test_skill_tool_returns_the_body_and_names_what_exists(tmp_path: Path) -> None:
    _write_skill(tmp_path, "review", "review a diff")
    tool = Skill(discover(tmp_path))
    assert tool.run("review").strip() == _BODY
    with pytest.raises(KeyError, match="no skill 'nope'; available: review"):
        tool.run("nope")


def test_override_replaces_a_context_file_including_with_nothing(tmp_path: Path) -> None:
    agents = tmp_path / "AGENTS.md"
    agents.write_text("committed instructions")
    assert "committed instructions" in context_text([agents])

    (tmp_path / "AGENTS.override.md").write_text("local instructions")
    text = context_text([agents])
    assert "local instructions" in text
    assert "committed instructions" not in text  # replaced, not appended

    (tmp_path / "AGENTS.override.md").write_text("")
    assert context_text([agents]).strip().endswith("# AGENTS.md")  # shadowed down to nothing


def test_context_files_are_appended_in_order_and_missing_ones_skipped(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("first")
    (tmp_path / "CLAUDE.md").write_text("second")
    prompt, _ = build_prompt_and_tools(
        _cfg(context_files=[str(tmp_path / "AGENTS.md"), str(tmp_path / "gone.md"), str(tmp_path / "CLAUDE.md")]),
        [],
    )
    assert prompt.index("first") < prompt.index("second")
    assert prompt.startswith("BASE")


def test_everything_off_returns_the_system_prompt_verbatim() -> None:
    prompt, tools = build_prompt_and_tools(_cfg(), [])
    assert prompt == "BASE"
    assert tools == []  # no `skill` tool advertised when there are no skills


def test_application_instructions_extend_the_resolved_prompt() -> None:
    prompt, _ = build_prompt_and_tools(_cfg(), [], prompt_suffix="Application instructions:\nWORKSPACE")
    assert prompt == "BASE\n\nApplication instructions:\nWORKSPACE"
