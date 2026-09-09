"""A code-execution tool: the agent writes Python that runs in a subprocess sandbox.

One :class:`CodeExec` ``invoke`` runs a whole Python program in a single subprocess, so the
model can loop, fan out, filter, dedupe and aggregate across many operations with NO model
round-trip per operation. Only what the program PRINTS (its stdout, capped) is returned to
the model; every intermediate the program builds but does not print stays inside the sandbox
and never enters the model's context — the code itself decides what little re-enters context.

State persists across turns through the sandbox filesystem, not an in-memory REPL: the program
runs with its current directory set to a persistent per-task working directory, so a later
``invoke`` can read a file an earlier one wrote (explicit serde — write JSON, read it back).
:meth:`reset` wipes that directory so sandbox state never leaks across tasks; the agent loop
calls it once at the start of every run. The active directory is held PER asyncio context (in a
:class:`contextvars.ContextVar`), so the production fan-out path — ``batch.run_batch`` runs ONE
shared :class:`CodeExec` across concurrent rollouts via ``asyncio.gather`` — gives each rollout
its OWN dir instead of letting one rollout's ``reset`` clobber a peer's live dir.

Isolation gap: this mirrors the local-subprocess model of :class:`~nanoagent.core.tool.Bash` and is
NOT an isolation boundary. The executed code shares the host filesystem, environment and
network and runs as the same user; the only bounds are :attr:`TIMEOUT_SECONDS` (runaway code is
killed) and the stdout cap. A real isolation layer (container/jail) is deliberately out of
scope for this local sandbox.

Decoupling: this module imports only the Python standard library and
:class:`nanoagent.core.tool.Tool` — not nanoagent.inference, not the search/scoring/training packages
that use it, so nanoagent stays standalone and usable with nothing but the stdlib. Any in-sandbox
capability (e.g. a search helper) enters ONLY through the optional ``preamble`` injection
point — Python source prepended to the model's code before execution — which ships empty by
default.
"""

from __future__ import annotations

import contextvars
import subprocess
import sys
import tempfile
from pathlib import Path
from shutil import rmtree

from nanoagent.core.tool import Tool
from nanoagent.tools.process import communicate_or_kill


class CodeExecutionError(RuntimeError):
    """Sandboxed code exited non-zero; the message carries the captured stdout + stderr (capped).

    Raised by :meth:`CodeExec.run` so the base :meth:`~nanoagent.core.tool.Tool.invoke` turns it
    into a recoverable ``("Error: CodeExecutionError: <output>", is_error=True)`` pair — the
    partial stdout and the traceback are fed back to the model to recover from, instead of
    crashing the agent loop.
    """


# The active sandbox dir lives PER asyncio context, not in a shared instance attribute: the
# production fan-out path (batch.run_batch) runs ONE shared CodeExec across concurrent rollouts via
# asyncio.gather, so a plain attribute would let one rollout's reset() wipe a peer's live dir and
# hand every rollout the same /tmp dir. Mirrors how nanoagent.runtime.log_capture isolates each task's log
# buffer in a ContextVar. The holder is a mutable 1-element list (not the Path directly) so a dir
# created lazily DEEP in the call tree — even inside a child asyncio task, whose ContextVar.set()
# would not propagate back to its parent — is visible across the whole rollout: every context that
# copied this one shares the SAME list object, so MUTATING its slot is seen everywhere. None means
# no holder has been installed in this context yet.
_WORK_DIR: contextvars.ContextVar[list[Path | None] | None] = contextvars.ContextVar(
    "codetool_work_dir", default=None
)


def _work_dir_holder() -> list[Path | None]:
    """Return this asyncio context's 1-slot work-dir holder, installing a fresh one on first use."""
    holder = _WORK_DIR.get()
    if holder is None:
        fresh: list[Path | None] = [None]  # annotated: list is invariant, so [None] != list[Path|None]
        _WORK_DIR.set(fresh)
        return fresh
    return holder


class CodeExec(Tool):
    """Execute Python in a sandbox and return only what it prints.

    Write a complete program and do many operations in one call (loops, fan-out, filtering,
    deduping, aggregation) — it runs in a single subprocess, so there is no model round-trip per
    operation. Files written to the working directory persist across calls, so an earlier call
    can save state a later one reads back.

    Args:
        code: Python source to run. PRINT only the small result you want returned; unprinted
            values stay in the sandbox and never fill your context.

    Returns:
        The program's stdout (truncated if large); its stderr/traceback on failure.
    """

    NAME = "python"
    TIMEOUT_SECONDS = 30.0
    MAX_OUTPUT_CHARS = 10_000
    PARAMETERS = {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": (
                    "Python source to run. Do many operations here and print ONLY the small "
                    "result you want returned; unprinted values stay in the sandbox. Write "
                    "files to the working directory to persist state for later calls."
                ),
            },
        },
        "required": ["code"],
    }

    def __init__(
        self,
        *,
        work_dir: str | Path | None = None,
        timeout: float | None = None,
        max_output_chars: int | None = None,
        preamble: str = "",
    ) -> None:
        # An explicit base dir (tests / demos) vs a lazily-created temp dir (the default).
        self._explicit_work_dir = Path(work_dir) if work_dir is not None else None
        # The active per-task dir is held PER asyncio context (see _WORK_DIR), exposed via the
        # _work_dir property below. Reset THIS context's slot so a freshly-built tool starts with
        # no active dir; concurrent rollouts sharing this instance still each get their own dir.
        self._work_dir = None
        self._timeout = self.TIMEOUT_SECONDS if timeout is None else timeout
        self._max_output_chars = self.MAX_OUTPUT_CHARS if max_output_chars is None else max_output_chars
        # The optional injection point: source prepended to the model's code. Ships empty.
        self._preamble = preamble

    @property
    def _work_dir(self) -> Path | None:
        """The active per-task sandbox dir for the CURRENT asyncio context (None until created).

        Backed by a per-context holder (see :data:`_WORK_DIR`) rather than a plain instance
        attribute, so concurrent rollouts sharing one :class:`CodeExec` each see their own dir.
        Exposed under the original ``_work_dir`` name so callers reading it keep working unchanged.
        """
        return _work_dir_holder()[0]

    @_work_dir.setter
    def _work_dir(self, value: Path | None) -> None:
        _work_dir_holder()[0] = value

    def _ensure_work_dir(self) -> Path:
        """Return the per-task working dir, creating it on first use."""
        # Resolve through a local so the type checker narrows the return to Path (the _work_dir
        # property getter is Path | None and is not narrowed across the assignment below).
        work_dir = self._work_dir
        if work_dir is None:
            if self._explicit_work_dir is not None:
                self._explicit_work_dir.mkdir(parents=True, exist_ok=True)
                work_dir = self._explicit_work_dir
            else:
                work_dir = Path(tempfile.mkdtemp(prefix="nanoagent-codetool-"))
            self._work_dir = work_dir
        return work_dir

    def reset(self) -> None:
        """Wipe this context's per-task working dir, then re-isolate the context with a fresh holder.

        Wipes the dir held for the CURRENT asyncio context so sandbox state never leaks across a
        task, then installs a FRESH holder for this context. The agent loop calls reset once at the
        start of every rollout; since concurrent rollouts each run in their own asyncio context,
        replacing the holder (not merely blanking its slot) is what gives each rollout its OWN dir —
        mutating one holder shared via the copied context would instead let peers clobber it.
        """
        current = self._work_dir
        if current is not None:
            rmtree(current, ignore_errors=True)
        _WORK_DIR.set([None])

    def cleanup(self) -> None:
        """Remove this context's sandbox dir now that the run is over (post-run cleanup).

        Delegates to :meth:`reset`, which ``rmtree``s the current context's dir. The agent loop
        calls this in a ``finally`` after every run, so a fanned-out rollout — which runs once in
        its own asyncio context and so never reaches a *next* run's start-of-run reset — frees the
        ``mkdtemp`` sandbox dir it created instead of leaking it.
        """
        self.reset()

    def run(self, code: str) -> str:
        """Run ``code`` in a subprocess (cwd = the per-task dir); return its stdout (capped).

        On a non-zero exit raise :class:`CodeExecutionError` carrying the captured stdout (the
        partial printed results) and stderr, so :meth:`~nanoagent.core.tool.Tool.invoke` feeds them
        back to the model. A
        :class:`subprocess.TimeoutExpired` (runaway code past :attr:`TIMEOUT_SECONDS`)
        propagates the same way — caught by ``invoke`` into a recoverable error string.
        """
        source = f"{self._preamble}\n{code}" if self._preamble else code
        # start_new_session=True puts the python -c child in its OWN process group so a timeout
        # can reap the WHOLE tree (the child plus anything it spawned), not just the direct
        # child — otherwise overrunning grandchildren outlive the cap as orphans.
        proc = subprocess.Popen(
            [sys.executable, "-c", source],
            cwd=self._ensure_work_dir(),
            # errors="replace": a stray non-UTF-8 byte from the sandboxed code (or a child it
            # spawns) becomes U+FFFD instead of raising UnicodeDecodeError out of communicate()
            # and discarding ALL captured output; valid UTF-8 decodes byte-identically to strict.
            text=True,
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        out, err = communicate_or_kill(proc, self._timeout)
        if proc.returncode != 0:
            err = self._cap(err) if err.strip() else f"exited with code {proc.returncode}"
            out = self._cap(out)
            raise CodeExecutionError(f"{out}\n{err}" if out else err)
        return self._cap(out)

    def _cap(self, text: str) -> str:
        """Bound returned text to ``max_output_chars`` so a runaway print can't flood context."""
        if len(text) <= self._max_output_chars:
            return text
        return text[: self._max_output_chars] + f"\n... [output truncated to {self._max_output_chars} chars]"
