"""A shell tool: the agent runs one command in a subprocess and gets its output back.

Its own module rather than a class in :mod:`nanoagent.core.tool` because :func:`~nanoagent.extensions.get_tools`
instantiates every :class:`Tool` subclass *defined* in a tool module with the same YAML config
block — a tool sharing a module with another gets that module's kwargs too.

Isolation gap: like :class:`~nanoagent.tools.code.CodeExec` this is a local subprocess, NOT an
isolation boundary — the command shares the host filesystem, environment and network and runs
as the same user. The only bound is :attr:`Bash.TIMEOUT_SECONDS`.
"""

from __future__ import annotations

import subprocess

from nanoagent.core.tool import JsonSchema, Tool
from nanoagent.tools.process import communicate_or_kill


class Bash(Tool):
    """Run a shell command and return its combined stdout/stderr and exit code."""

    NAME = "bash"
    TIMEOUT_SECONDS = 30.0
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "a shell command to run",
            },
        },
        "required": ["command"],
    }

    def run(self, command: str) -> str:
        # start_new_session=True puts the shell in its OWN process group so a timeout can
        # reap the WHOLE tree (the shell plus anything it backgrounded), not just the direct
        # /bin/sh child — otherwise overrunning grandchildren outlive the cap as orphans.
        proc = subprocess.Popen(
            command,
            shell=True,
            # errors="replace": a stray non-UTF-8 byte from the command (or a child it spawns)
            # becomes U+FFFD instead of raising UnicodeDecodeError out of communicate() and
            # discarding ALL captured output; valid UTF-8 decodes byte-identically to strict.
            text=True,
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        out, err = communicate_or_kill(proc, self.TIMEOUT_SECONDS)
        output = out + err
        return f"<returncode>{proc.returncode}</returncode>\n<output>\n{output}</output>"
