"""Entry point (rush.harness.v1): NanoAgent works the attempt's task with the task's tools."""

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "site"), HERE]

from taskharness import shims  # noqa: E402

shims.install()

from taskharness.run import attempt, write_result  # noqa: E402


def main() -> None:
    with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
        request = json.load(source)
    write_result(asyncio.run(attempt(request, os.environ["RUSH_ATTEMPT_TOKEN"])))


if __name__ == "__main__":
    main()
