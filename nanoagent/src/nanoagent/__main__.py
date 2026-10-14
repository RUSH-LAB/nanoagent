"""Module entry point: ``python -m nanoagent <command> [args...]``, and a compiled NanoAgent's.

All dispatch lives in :mod:`nanoagent.cli.main` — see its :func:`main` for the
``run`` / ``chat`` / ``browse`` subcommands — except ``helper``, which runs one of NanoAgent's
helpers (:mod:`nanoagent.helpers`) before the CLI loads.
"""

from __future__ import annotations

import sys

if __name__ == "__main__":
    if sys.argv[1:2] == ["helper"]:
        from nanoagent.helpers import main as helper

        raise SystemExit(helper(sys.argv[2:]))
    from nanoagent.cli.main import main

    raise SystemExit(main())
