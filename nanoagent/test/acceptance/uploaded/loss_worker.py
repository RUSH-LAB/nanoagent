"""The real worker with one test seam: a file appearing at $RUSH_LOSE_COLLECTOR_FILE kills the tracer of the running case, as a
crash of the tracer would, so the acceptance test can force a loss while a case is running.

    python loss_worker.py config=<yaml> home=<folder>
"""

import os
import threading
import time
from pathlib import Path

from nanoagent.uploaded import sandbox, worker

TRIGGER = Path(os.environ["RUSH_LOSE_COLLECTOR_FILE"])
launch = sandbox._Case.launch


def launch_and_watch(self: sandbox._Case) -> None:
    launch(self)

    def watch() -> None:
        while not TRIGGER.exists():
            time.sleep(0.05)
        self._run(self._sandbox.exec("sh", ["-c", "kill -KILL $(pidof strace)"], user="root", timeout=30))

    threading.Thread(target=watch, name="lose-tracer", daemon=True).start()


sandbox._Case.launch = launch_and_watch  # type: ignore[method-assign]
worker.WorkerRun().run()
