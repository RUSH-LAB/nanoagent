"""The httpx distribution the INSTALLED OpenAI SDK builds on, resolved off the SDK itself.

openai 1.x/2.x builds on ``httpx``, openai >=3 on the renamed ``httpx2`` fork. Anything handed to
an ``AsyncOpenAI`` client — ``Limits``, ``Timeout`` — must be that module's classes, and mixing
them is not a clean failure: ``Limits`` duck-types and appears to work, while ``Timeout`` dies deep
in the connection pool as "unsupported operand type(s) for +: 'float' and 'Timeout'", surfacing as
a bare ``APIConnectionError`` on EVERY request, which reads like an unreachable endpoint rather
than a type mismatch. So resolve the module from the SDK's own client class instead of importing a
name and hoping the two agree. This is also why nanoagent declares no direct ``httpx`` dependency:
whichever one openai pins is by definition the right one.

Both transports import it from here — the ``/v1`` one for the client it configures, the native
``/generate`` one for a plain async client of its own — so the resolution exists once. Importing
this module imports ``openai``; only a backend does, which is what keeps
``import nanoagent.inference`` SDK-free.
"""

from __future__ import annotations

import importlib
from typing import Any

from openai import DefaultAsyncHttpxClient

httpx: Any = importlib.import_module(
    DefaultAsyncHttpxClient.__mro__[1].__module__.partition(".")[0]
)
