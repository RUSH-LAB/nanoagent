"""The real worker with one test seam: each of the first three tool VMs it is asked to start fails to launch, as a hypervisor or image
fault would (a case's three attempts). Every later one starts normally.

    python fault_worker.py config=<yaml> home=<folder>

The seam logs `INJECTED_TOOL_LAUNCH_FAILURE attempt=<id>` for each.
"""

from nanoagent.uploaded import sandbox, worker
from nanoagent.uploaded.sandbox import SandboxError

start_tool = sandbox.MicrosandboxSupervisor._start_tool
FAILURES = 3
failures = []


async def failing_once(self, spec, workspace, tools, ports):  # type: ignore[no-untyped-def]
    if len(failures) < FAILURES:
        failures.append(spec.attempt_id)
        print(f"INJECTED_TOOL_LAUNCH_FAILURE attempt={spec.attempt_id}", flush=True)
        raise SandboxError("start_failed", "create tool container: injected launch failure")
    return await start_tool(self, spec, workspace, tools, ports)


sandbox.MicrosandboxSupervisor._start_tool = failing_once  # type: ignore[method-assign]
worker.WorkerRun().run()
