"""The real worker with one test seam: the first tool container it is asked to start fails to launch, as a Docker or
runtime fault would. Every later one starts normally.

    python fault_worker.py config=<yaml> home=<folder>

The seam logs `INJECTED_TOOL_LAUNCH_FAILURE attempt=<id>`.
"""

from nanoagent.uploaded import sandbox, worker
from nanoagent.uploaded.sandbox import SandboxError

start_tool = sandbox.DockerSandboxSupervisor._start_tool
failures = []


def failing_once(self: sandbox.DockerSandboxSupervisor, spec: sandbox.CaseSpec, ws_volume: str, network: str) -> str:
    if not failures:
        failures.append(spec.attempt_id)
        print(f"INJECTED_TOOL_LAUNCH_FAILURE attempt={spec.attempt_id}", flush=True)
        raise SandboxError("start_failed", "create tool container: injected launch failure")
    return start_tool(self, spec, ws_volume, network)


sandbox.DockerSandboxSupervisor._start_tool = failing_once  # type: ignore[method-assign]
worker.WorkerRun().run()
