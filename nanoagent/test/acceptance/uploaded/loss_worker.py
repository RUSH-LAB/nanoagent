"""The real worker with one test seam: a file appearing at $RUSH_LOSE_COLLECTOR_FILE stops its process collector, as a
crash of the collector would, so the acceptance test can force a loss while a case is running.

    python loss_worker.py config=<yaml> home=<folder>
"""

import os
import threading
import time
from pathlib import Path

from nanoagent.uploaded import worker
from nanoagent.uploaded.collector import SeccheckCollector

TRIGGER = Path(os.environ["RUSH_LOSE_COLLECTOR_FILE"])
start = SeccheckCollector.start


def start_and_watch(self: SeccheckCollector) -> None:
    start(self)

    def watch() -> None:
        while not TRIGGER.exists():
            time.sleep(0.05)
        self.stop()

    threading.Thread(target=watch, name="lose-collector", daemon=True).start()


SeccheckCollector.start = start_and_watch  # type: ignore[method-assign]
worker.WorkerRun().run()
