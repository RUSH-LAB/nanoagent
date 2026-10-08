"""The agent writes its own tools.

:func:`~nanoagent.extensions.get_tools` already means a new tool is a new ``.py`` plus a new ``.yaml``
and no change to nanoagent — so an agent that can write those two files can extend itself, and
this module is only the plumbing that lets it: write, validate by loading it the same way a
configured tool is loaded, and register the result on the live agent so it is callable on the
very next turn. A broken module comes back as the import error, which the model reads as an
ordinary tool result and fixes.

Persistence needs no code at all: the files land in ``tools_dir``, and
:func:`~nanoagent.runtime.build.build_prompt_and_tools` globs that directory at startup, so a tool
written in one session is simply part of the toolset in the next.

Isolation: a tool the agent wrote is arbitrary Python executed in-process as the same user —
the boundary :class:`~nanoagent.tools.bash.Bash` and :class:`~nanoagent.tools.code.CodeExec` already
document. ``tools_dir: null``, the default in every config here, means this tool is not loaded.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from nanoagent.core.tool import JsonSchema, Tool
from nanoagent.extensions import get_tools

# A tool name has to be a usable Python module stem AND a usable OpenAI function name.
_NAME = re.compile(r"[a-z][a-z0-9_]*$")


class WriteTool(Tool):
    """Write a new tool for yourself and start using it immediately.

    `code` is a complete Python module defining one subclass of `nanoagent.core.tool.Tool`:

        from nanoagent.core.tool import Tool

        class Wordcount(Tool):
            \"\"\"Count the words in some text.\"\"\"   # the model sees this as the description
            NAME = "wordcount"
            PARAMETERS = {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            }
            def run(self, text: str) -> str:
                return str(len(text.split()))

    The class docstring becomes the tool's description and PARAMETERS is its JSON Schema, so
    write both for a reader who has never seen the code. The tool is loaded straight away: if
    the module does not import, or defines no Tool subclass, you get the error back and can fix
    it and call this again. Use it for work you will repeat — a one-off computation is cheaper
    through `python` or `bash`.
    """

    NAME = "write_tool"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "lower_snake_case tool name"},
            "code": {"type": "string", "description": "the complete module source"},
        },
        "required": ["name", "code"],
    }

    def __init__(self, tools_dir: str) -> None:
        self._dir = Path(tools_dir)
        self._agent: Any = None

    def bind(self, agent: Any) -> None:
        self._agent = agent

    def run(self, name: str, code: str) -> str:
        if not _NAME.match(name):
            raise ValueError(f"{name!r} must be lower_snake_case starting with a letter")
        self._dir.mkdir(parents=True, exist_ok=True)
        module = self._dir / f"{name}.py"
        spec = self._dir / f"{name}.yaml"
        module.write_text(code, encoding="utf-8")
        spec.write_text(f"code: {module}\n", encoding="utf-8")
        try:
            written = get_tools([spec])
            for tool in written:
                self._agent.add_tool(tool)
        except Exception:
            # Roll the files back on ANY failure, registration included. Both halves matter: a
            # module that won't import is obvious, but a tool whose NAME collides with an
            # existing one would be left on disk to be globbed at the next startup, where the
            # same collision fails build_tool_map and bricks the config. The model gets the
            # exception text back through Tool.invoke and can rename or rewrite.
            module.unlink()
            spec.unlink()
            raise
        return f"registered {', '.join(t.name for t in written)} — callable now"


def written_tool_specs(tools_dir: str | None) -> list[str]:
    """The tool YAMLs already in ``tools_dir``, for a run to start with what it wrote before."""
    return [] if tools_dir is None else sorted(str(p) for p in Path(tools_dir).glob("*.yaml"))
