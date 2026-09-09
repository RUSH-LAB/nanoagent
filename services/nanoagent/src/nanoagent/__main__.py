"""Module entry point: ``python -m nanoagent <command> [args...]``.

All dispatch lives in :mod:`nanoagent.cli.main` — see its :func:`main` for the
``run`` / ``chat`` / ``browse`` subcommands.
"""

from __future__ import annotations

from nanoagent.cli.main import main

if __name__ == "__main__":
    raise SystemExit(main())
