"""Compatibility entrypoint for the Claude harness adapter."""

from nanoagent.harness.adapters.claude import main

if __name__ == "__main__":
    raise SystemExit(main())
