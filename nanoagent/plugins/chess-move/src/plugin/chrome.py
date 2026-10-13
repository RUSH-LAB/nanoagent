"""A headless Chrome of the plugin's own, driven over the DevTools protocol: load, read, capture, mouse."""

from __future__ import annotations

import base64
import itertools
import json
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Self

from websockets.sync.client import connect

# Where Chrome installs itself on Linux and macOS, tried in order.
CHROMES = (
    "/usr/local/bin/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
START_TIMEOUT = 30.0


def installed() -> str | None:
    """The first Chrome in :data:`CHROMES` that is installed."""
    return next((path for path in CHROMES if Path(path).exists()), None)


class Chrome:
    """One headless Chrome on ``port`` with its profile in ``profile``, one tab, until :meth:`close`."""

    def __init__(self, port: int, size: tuple[int, int], profile: Path) -> None:
        binary = installed()
        if binary is None:
            raise RuntimeError(f"no Chrome installed: looked for {', '.join(CHROMES)}")
        self.proc = subprocess.Popen(
            [
                binary,
                "--headless=new",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={profile}",
                f"--window-size={size[0]},{size[1]}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
                "--hide-scrollbars",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self._ids = itertools.count(1)
        try:
            self.ws = connect(self._tab(port), max_size=None)
            # A screenshot's pixels are CSS pixels, so a point read off it is where the mouse goes.
            self.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": size[0], "height": size[1], "deviceScaleFactor": 1, "mobile": False},
            )
            self.call("Page.enable")
        except BaseException:
            self.proc.kill()
            raise

    def _tab(self, port: int) -> str:
        """The tab's DevTools URL, once Chrome lists it."""
        deadline = time.monotonic() + START_TIMEOUT
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
                    tabs = [tab for tab in json.load(response) if tab["type"] == "page"]
                if tabs:
                    return tabs[0]["webSocketDebuggerUrl"]
            except OSError:
                pass
            if self.proc.poll() is not None:
                raise RuntimeError(f"Chrome exited ({self.proc.returncode}) before it opened a tab")
            time.sleep(0.2)
        raise RuntimeError(f"Chrome opened no tab within {START_TIMEOUT:.0f}s")

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send one command and return its result, skipping the events that arrive before it."""
        ident = next(self._ids)
        self.ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == ident:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']['message']}")
                return message["result"]

    def eval(self, expression: str) -> Any:
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        if "exceptionDetails" in result:
            raise RuntimeError(f"{expression}: {result['exceptionDetails']['text']}")
        return result["result"].get("value")

    def wait_for(self, expression: str, timeout: float = 10.0) -> None:
        """Poll until a JavaScript expression is truthy."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.eval(f"!!({expression})"):
                return
            time.sleep(0.1)
        raise TimeoutError(f"still false after {timeout:.0f}s: {expression}")

    def navigate(self, url: str) -> None:
        self.call("Page.navigate", {"url": url})
        self.wait_for("document.readyState === 'complete'", 20.0)

    def rect(self, selector: str) -> dict[str, float]:
        """Where an element is on the page, in CSS pixels: x, y, width, height."""
        return self.eval(
            f"(() => {{ const r = document.querySelector({json.dumps(selector)}).getBoundingClientRect();"
            " return {x: r.x, y: r.y, width: r.width, height: r.height}; })()"
        )

    def shot(self, clip: dict[str, float]) -> bytes:
        """A PNG of ``clip``, at one image pixel per CSS pixel."""
        params = {"format": "png", "clip": {**clip, "scale": 1}}
        return base64.b64decode(self.call("Page.captureScreenshot", params)["data"])

    def _mouse(self, kind: str, x: float, y: float) -> None:
        pressed = kind != "mouseReleased"
        self.call(
            "Input.dispatchMouseEvent",
            {"type": kind, "x": x, "y": y, "button": "left", "buttons": int(pressed), "clickCount": 1},
        )

    def drag(self, points: list[tuple[float, float]], steps: int = 3) -> None:
        """Press at the first point, move through the rest, release at the last; one point is a click.

        The moves in between are what makes it a drag: chessground commits a dragged piece on
        release only once the pointer has moved, and listens only to trusted events, which these are.
        """
        self._mouse("mousePressed", *points[0])
        previous = points[0]
        for point in points[1:]:
            for step in range(1, steps + 1):
                self._mouse(
                    "mouseMoved",
                    previous[0] + (point[0] - previous[0]) * step / steps,
                    previous[1] + (point[1] - previous[1]) * step / steps,
                )
            previous = point
        self._mouse("mouseReleased", *points[-1])

    def close(self) -> None:
        try:
            self.ws.close()
        finally:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
