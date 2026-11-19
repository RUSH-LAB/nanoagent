"""The real worker with one test seam: after a case's workspace is snapshotted, it waits, reads the live workspace again and
logs whether anything changed, so the acceptance test can prove that nothing writes after the snapshot.

    python recovery_worker.py config=<yaml> home=<folder>

The log line is `SNAPSHOT_CHECK stable=<bool> files=<n> progress_bytes=<n>`.
"""

import time

from nanoagent.uploaded import sandbox, worker

stop_and_drain = sandbox._Case.stop_and_drain
SETTLE_S = 3.0


def checked_stop_and_drain(self: sandbox._Case) -> sandbox.WorkspaceSnapshot:
    snapshot = stop_and_drain(self)
    time.sleep(SETTLE_S)
    later, directory = self._s._copy_out(self.workspace, self.spec.limits, self.spec.workdir)
    print(f"SNAPSHOT_CHECK stable={later.files == snapshot.files} files={len(snapshot.files)} progress_bytes={(snapshot.directory / 'progress.bin').stat().st_size if (snapshot.directory / 'progress.bin').exists() else -1}", flush=True)
    return snapshot


sandbox._Case.stop_and_drain = checked_stop_and_drain  # type: ignore[method-assign]
worker.WorkerRun().run()
