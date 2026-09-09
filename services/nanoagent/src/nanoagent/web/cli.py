"""Run NanoAgent as an internal HTTP/SSE service."""

from __future__ import annotations

import logging
import sys

from nanoagent.runtime.config import load_config_args
from nanoagent.web.config import WebConfig

_USAGE = "usage: nanoagent web web_cfg=<config.yaml> [dotted.key=value ...]"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    if not argv or argv[0] in {"-h", "--help"}:
        print(_USAGE)
        return 0 if argv else 2
    cfg = load_config_args(WebConfig, argv)
    try:
        import uvicorn
    except ImportError as error:
        raise SystemExit('nanoagent web requires `pip install "nanoagent[web]"`') from error

    # Prompts and tool output never belong in access logs. Runtime failures still carry a run id
    # through nanoagent.web.runtime's own logger.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    from nanoagent.web.app import create_app

    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
