from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from nanoagent.plugin import call_tool, load_manifest

_USAGE = """usage:
  nanoagent plugin inspect <path>
  nanoagent plugin run <path> <task> [key=value ...]"""


def _value(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    if len(argv) < 2 or argv[0] not in {"inspect", "run"}:
        print(_USAGE)
        return 2
    command, source = argv[:2]
    manifest = load_manifest(Path(source))
    if command == "inspect":
        print(json.dumps(manifest.public(), indent=2))
        return 0
    if len(argv) < 3:
        print(_USAGE)
        return 2
    task = manifest.task(argv[2])
    if len(task.tools) != 1:
        raise ValueError("direct plugin runs require a task with exactly one tool")
    arguments: dict[str, Any] = {}
    for token in argv[3:]:
        if "=" not in token:
            raise ValueError(f"task argument must be key=value: {token}")
        key, value = token.split("=", 1)
        arguments[key] = _value(value)
    try:
        response = call_tool(manifest, task.tools[0], arguments)
    except (ValueError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2))
        return 1
    print(json.dumps(response, indent=2))
    return 0 if response.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
