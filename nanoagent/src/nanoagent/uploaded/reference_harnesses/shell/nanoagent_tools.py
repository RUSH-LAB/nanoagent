"""The plugin's task tools for `nanoagent` and `mgen` in the RUSH terminal, the `code:` of the tool config rush.py writes: one tool
per tool the worker started for this process (``$RUSH_TOOLS``, which rush.py writes too), each call a call to the session's tool
broker, which records it, carrying the token only this process holds (``$RUSH_TOOLS_TOKEN``)."""

import json
import os
from pathlib import Path
from typing import Any

import httpx

from nanoagent.core.tool import Tool, ToolText

STARTED = json.loads(Path(os.environ["RUSH_TOOLS"]).read_text(encoding="utf-8"))  # {url, tools}


class BrokerTool(Tool):
    """One of the plugin's tools, run by the broker; its result is the output as JSON, any `images` going to the model as images."""

    async def run(self, **arguments: Any) -> str:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
            response = await client.post(
                STARTED["url"], json={"name": self.NAME, "arguments": arguments}, headers={"Authorization": f"Bearer {os.environ['RUSH_TOOLS_TOKEN']}"}
            )
        payload = response.json()
        if "output" not in payload:
            raise RuntimeError(f"tool {self.NAME} failed: {payload['error']['code']}: {payload['error']['message']}")
        output = payload["output"]
        images = output.pop("images", [])
        return ToolText(json.dumps(output), images=images)


for _spec in STARTED["tools"]:  # defined here, so NanoAgent's loader finds them as this module's own Tool classes
    globals()[f"Tool_{_spec['name']}"] = type(f"Tool_{_spec['name']}", (BrokerTool,), {"NAME": _spec["name"], "PARAMETERS": _spec["input_schema"], "__doc__": _spec["description"]})
