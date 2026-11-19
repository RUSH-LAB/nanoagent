"""`nanoagent export`: every trace run in RUSH Lab, as JSON Lines, one line per run or chat.

    rushlab nanoagent export out=traces.jsonl                                          # all of yours
    rushlab nanoagent export plugin=city-weather member=all since=2026-11-01 out=class.jsonl

A line is a run (a Harness tab Terminal session under any CLI, a Harness tab or `nanoagent harness` session, a scored run: its
member, plugin, harness by its CLI command, model, times, outcome and score, and each attempt's model calls with their request and
response bodies, accounting, events, spans and terminal transcripts, and for a Terminal session `workspace.url`, where on RUSH to
download its files as a tar.zst, signed in as the export is) or a NanoAgent chat of a plugin page (its turns, each with its
ATIF trajectory, and its calls). `member` is whose: yours by default; a member's id, or `all`, only for a platform administrator.

It reads GET /api/traces/export from the RUSH that RUSH Lab on this computer is connected to, signed in with RUSH Lab's connection,
as `nanoagent harness` is. The file is written whole or not at all: a transfer that breaks leaves no `out`.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import httpx
from omegaconf import MISSING
from slimconfig import Config

from nanoagent.cli.harness import app_data, connection, find_lab
from nanoagent.extensions import PACKAGED_CONFIGS
from nanoagent.runtime.config import load_config_args

DEFAULT_CONFIG = str(PACKAGED_CONFIGS / "export.yaml")
PATH = "/api/traces/export"


@dataclass
class ExportCommandConfig(Config):
    # The JSON Lines file to write.
    out: str = MISSING
    # Only this plugin's runs and chats; null: every plugin's.
    plugin: str | None = MISSING
    # Whose: null, yours; a member's id, or `all` for every member (platform administrators only).
    member: str | None = MISSING
    # Only what was created at or after this time (2026-11-01, or 2026-11-01T09:00:00Z); null: from the first.
    since: str | None = MISSING
    # Only what was created before this time; null: up to now.
    until: str | None = MISSING
    # RUSH Lab's data folder, which holds its one connection; null: whichever of RUSH Lab's and RUSH Lab Dev's is signed in.
    lab: str | None = MISSING


def params(cfg: ExportCommandConfig) -> dict[str, str]:
    """The export's query: each filter the config sets."""
    return {name: value for name in ("plugin", "member", "since", "until") if (value := getattr(cfg, name)) is not None}


def download(rush: httpx.Client, query: dict[str, str], out: Path) -> int:
    """Stream the export into ``out`` (through ``out``.part, renamed once it is whole): the number of lines."""
    part = out.with_name(f"{out.name}.part")
    lines = 0
    with rush.stream("GET", PATH, params=query) as response:
        if not response.is_success:
            response.read()
            try:
                message = response.json().get("error")
            except ValueError:
                message = response.text[:200]
            raise SystemExit(f"export: GET {PATH}: {response.status_code} {message}")
        try:
            with part.open("wb") as file:
                for chunk in response.iter_bytes():
                    file.write(chunk)
                    lines += chunk.count(b"\n")
        except BaseException:
            part.unlink(missing_ok=True)
            raise
    part.replace(out)
    return lines


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    cfg = load_config_args(ExportCommandConfig, [f"export_cfg={DEFAULT_CONFIG}", *argv])
    out = Path(cfg.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    _, site, token = connection(find_lab(app_data()) if cfg.lab is None else Path(cfg.lab))
    with httpx.Client(base_url=site, headers={"Authorization": f"Bearer {token}", "Origin": site}, timeout=httpx.Timeout(60.0, read=300.0)) as rush:
        lines = download(rush, params(cfg), out)
    print(f"export: {lines} line(s) -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
