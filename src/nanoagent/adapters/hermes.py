"""Compatibility entrypoint for the Hermes harness adapter."""

from nanoagent.harness.adapters.hermes import main

if __name__ == "__main__":
    raise SystemExit(main())
