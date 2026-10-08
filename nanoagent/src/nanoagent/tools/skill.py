"""Skills — prompt material assembled at build time.

A **skill** is a folder ``<skills_dir>/<name>/SKILL.md`` whose YAML frontmatter carries a
``name`` and a ``description``. Only the descriptions go into the system prompt, one line each;
the body is fetched by calling the :class:`Skill` tool. That split is the whole point: twenty
skills cost twenty lines of context, and the one the agent actually needs costs its full text
only on the turn it needs it. Bundling all twenty bodies up front would spend the window on
nineteen documents that never get read.

The index is assembled once by :func:`~nanoagent.runtime.build.build_agent` (alongside the project
context files), so the batch driver, the benchmark runner and the REPL get the same prompt from
one place.
"""

from __future__ import annotations

from pathlib import Path

from nanoagent.core.tool import JsonSchema, Tool

SKILL_FILE = "SKILL.md"


def _frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split ``key: value`` YAML frontmatter from the body; ``({}, text)`` when there is none.

    Parsed by hand rather than through a YAML loader: frontmatter here is flat ``key: value``
    lines, and reading it with OmegaConf would let a skill file smuggle in interpolations that
    resolve against the run's config.
    """
    if not text.startswith("---\n"):
        return {}, text
    _, _, rest = text.partition("---\n")
    block, sep, body = rest.partition("\n---")
    if not sep:
        return {}, text
    meta = {}
    for line in block.splitlines():
        key, colon, value = line.partition(":")
        if colon:
            meta[key.strip()] = value.strip()
    return meta, body.lstrip("\n")


def discover(skills_dir: str | Path | None) -> dict[str, tuple[str, str]]:
    """``{name: (description, body)}`` for every skill under ``skills_dir`` (``{}`` if unset).

    The folder name is the skill's name; a ``name:`` in the frontmatter overrides it. A folder
    with no ``SKILL.md`` is skipped rather than raising — a skills dir is a place people drop
    things, not a manifest.
    """
    if skills_dir is None:
        return {}
    root = Path(skills_dir)
    found: dict[str, tuple[str, str]] = {}
    for path in sorted(root.glob(f"*/{SKILL_FILE}")):
        meta, body = _frontmatter(path.read_text(encoding="utf-8"))
        name = meta.get("name") or path.parent.name
        found[name] = (meta.get("description", ""), body)
    return found


def skill_index(skills: dict[str, tuple[str, str]]) -> str:
    """The system-prompt block listing what is available; ``""`` when there are no skills."""
    if not skills:
        return ""
    lines = "\n".join(f"- {name}: {desc}" for name, (desc, _body) in skills.items())
    return (
        "\n\nSkills available. Call the `skill` tool with a name to read its full "
        f"instructions before doing that kind of work:\n{lines}"
    )


class Skill(Tool):
    """Read a skill's full instructions by name. Call this before doing that kind of work."""

    NAME = "skill"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"name": {"type": "string", "description": "the skill to read"}},
        "required": ["name"],
    }

    def __init__(self, skills: dict[str, tuple[str, str]]) -> None:
        self._skills = skills

    def run(self, name: str) -> str:
        if name not in self._skills:
            raise KeyError(f"no skill {name!r}; available: {', '.join(sorted(self._skills))}")
        return self._skills[name][1]
