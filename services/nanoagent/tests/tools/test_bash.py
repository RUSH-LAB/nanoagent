"""Offline unit tests for the built-in :class:`~nanoagent.tools.bash.Bash` tool's execution.

``Bash`` is nanoagent's example tool ("Tools can be defined by using
the template provided in ``tool.py``"). The existing suite only touches ``Bash`` for discovery
*exclusion* (``test_tool.py``) and its OpenAI spec (``test_model.py``); its actual ``run`` is
untested. These tests pin ``Bash.run``'s documented contract: it shells out via
``subprocess.run(..., shell=True)`` and returns the string
``"<returncode>{rc}</returncode>\\n<output>\\n{stdout+stderr}</output>"``. Fully offline — only
tiny portable commands (``echo``/``false``/``exit``); no model, network, or GPU.

* success — ``run("echo hello")`` yields returncode 0 with the echoed text inside ``<output>``.
* combined streams — a command writing to BOTH stdout and stderr surfaces both (run concatenates
  ``proc.stdout + proc.stderr``).
* non-zero exit — a failing command yields the matching non-zero ``<returncode>`` and does NOT
  raise (``subprocess.run`` is called without ``check=True``).
* invoke path — ``await Bash().invoke(command=...)`` returns ``(text, False)`` with text identical
  to the sync ``run`` (the :meth:`~nanoagent.core.tool.Tool.invoke` wrapper around a sync ``run``).

Run (from the repo root)::

    python3 -m pytest tests/tools/test_bash.py -x -q
"""

from __future__ import annotations

import re

from nanoagent.tools.bash import Bash

# Validates the exact documented wrapper AND extracts the parts to assert on. re.fullmatch fails
# loudly if Bash.run ever stops emitting "<returncode>{rc}</returncode>\n<output>\n{body}</output>".
_FORMAT = re.compile(r"<returncode>(-?\d+)</returncode>\n<output>\n(.*)</output>", re.DOTALL)


def _parse(result: str) -> tuple[int, str]:
    """Split Bash.run's formatted string into ``(returncode, output_body)``."""
    match = _FORMAT.fullmatch(result)
    assert match is not None, f"unexpected Bash.run format: {result!r}"
    return int(match.group(1)), match.group(2)


def test_run_success_returncode_zero_and_output() -> None:
    returncode, body = _parse(Bash().run("echo hello"))
    assert returncode == 0
    assert "hello" in body  # echoed text lands inside the <output> block


def test_run_combines_stdout_and_stderr() -> None:
    # run() returns proc.stdout + proc.stderr, so both streams appear in <output>.
    returncode, body = _parse(Bash().run("echo out; echo err 1>&2"))
    assert returncode == 0
    assert "out" in body
    assert "err" in body


def test_run_nonzero_exit_code_does_not_raise() -> None:
    # subprocess.run is called without check=True: a failing command reports a non-zero
    # <returncode> instead of raising. ``exit 3`` pins an exact, non-default code...
    returncode, _ = _parse(Bash().run("exit 3"))
    assert returncode == 3
    # ...and ``false`` is the canonical exit-1 command.
    returncode_false, _ = _parse(Bash().run("false"))
    assert returncode_false == 1


async def test_invoke_returns_formatted_text_and_no_error() -> None:
    # Tool.invoke wraps the sync run: identical formatted text, is_error False (no exception).
    text, is_error = await Bash().invoke(command="echo hi")
    assert is_error is False
    assert text == Bash().run("echo hi")  # invoke surfaces run()'s output verbatim
    returncode, body = _parse(text)
    assert returncode == 0
    assert "hi" in body
