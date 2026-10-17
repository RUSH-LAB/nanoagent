"""Removes the run folders RUSH Lab cloud's runner is left with (docs/infra/aws-deployment.md).

Mochi removes a run's folder once it has written what the run did back to the member's agent
folder. A folder whose run Mochi could not finish stays: one Mochi was doing when it restarted, or
one whose write-back found the runner unreachable. NanoAgent ends every run within its
request_timeout (180 s in nanoagent/deploy/railway/nanoagent.yaml), so a folder its run has not
touched for a day is no run's any more. Every hour, this removes each such folder.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

FOLDERS = Path("/data/nanoagent-workspaces")
AGE_SECONDS = 24 * 60 * 60
EVERY_SECONDS = 60 * 60


def sweep(folders: Path, now: float) -> list[str]:
    """Remove each folder in `folders` untouched for AGE_SECONDS before `now`; the names removed."""
    removed = []
    for folder in sorted(folders.iterdir()):
        if folder.is_dir() and not folder.is_symlink() and now - folder.stat().st_mtime > AGE_SECONDS:
            shutil.rmtree(folder)
            removed.append(folder.name)
    return removed


if __name__ == "__main__":
    while True:
        if FOLDERS.is_dir():
            for name in sweep(FOLDERS, time.time()):
                print(f"removed the run folder {name}, untouched for a day", flush=True)
        time.sleep(EVERY_SECONDS)
