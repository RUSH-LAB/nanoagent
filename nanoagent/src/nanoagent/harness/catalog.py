"""The PI catalog: every provider PI reaches and every model it can run (js/pi-runner/src/models.ts)."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Sequence
from typing import Any

CATALOG_TIMEOUT = 30.0


def catalog_command(runner_command: Sequence[str]) -> list[str]:
    """The PI runner's command, running its catalog (models.js) instead of a run (index.js)."""
    command = list(runner_command)
    if not command or not command[-1].endswith("index.js"):
        raise ValueError("the PI runner's command must end with its index.js to list models")
    command[-1] = command[-1][: -len("index.js")] + "models.js"
    return command


async def load_catalog(command: Sequence[str], cwd: str | None) -> dict[str, Any]:
    """Run the catalog once: ``{providers: [...], models: [...]}``."""
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=os.environ.copy(),
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), CATALOG_TIMEOUT)
    if process.returncode:
        raise RuntimeError(f"the PI catalog failed: {stderr.decode(errors='replace').strip()[-500:]}")
    return json.loads(stdout)


def find_model(catalog: dict[str, Any], provider: str, model: str) -> dict[str, Any] | None:
    return next(
        (entry for entry in catalog["models"] if entry["provider"] == provider and entry["id"] == model),
        None,
    )
