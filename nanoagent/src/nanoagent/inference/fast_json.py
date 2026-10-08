"""JSON encode/decode that uses ``orjson`` when available, else the stdlib ``json``.

The tool-calling loop (:mod:`nanoagent.inference.loop`) encodes a tool result per call per turn — JSON work
that scales with conversation length × batch size, on the hot path of every agent rollout.
``orjson`` is a C-accelerated drop-in that is several times faster than stdlib ``json`` for these
payloads; when it is not installed we fall back to ``json`` so the import never hard-fails.

:func:`dumps` emits UTF-8 JSON: orjson is compact (no spaces after ``:`` or ``,``) while the
stdlib fallback keeps spaced separators — they differ only in that insignificant whitespace,
and both keep non-ASCII as raw UTF-8
(``ensure_ascii=False`` semantics), so the decoded value is identical and any consumer that
re-parses the JSON is unaffected. ``orjson.dumps`` returns ``bytes``; we decode to ``str``
to keep the same return type as the stdlib path.
"""

from __future__ import annotations

import json
from typing import Any

try:
    import orjson
except ImportError:  # pragma: no cover - orjson ships in the `fast` extra; stdlib json otherwise
    orjson = None


# Resolve the backend ONCE at import: ``orjson`` is bound a single time above and never
# changes, so binding ``dumps``/``loads`` here avoids re-taking the per-call branch on the
# tool-calling hot path (O(turns × tool-calls × batch) JSON ops). The chosen ``dumps`` body holds
# no ``orjson``-availability check.
if orjson is not None:

    def dumps(obj: Any) -> str:
        """Serialize ``obj`` to a compact UTF-8 JSON string via orjson."""
        return orjson.dumps(obj).decode("utf-8")

    loads = orjson.loads
else:  # pragma: no cover - stdlib fallback when orjson is not installed

    def dumps(obj: Any) -> str:
        """Serialize ``obj`` to a UTF-8 JSON string via the stdlib json (spaced separators)."""
        return json.dumps(obj, ensure_ascii=False)

    loads = json.loads
