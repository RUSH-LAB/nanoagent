"""The NanoAgent worker: claims uploaded-harness benchmark jobs from RUSH and runs them.

    python -m nanoagent.uploaded.worker config=configs/benchmark_worker.yaml [home=<run folder>]

Everything is validated before the first claim: the RUSH token and the OpenRouter key (`OPENROUTER_API_KEY`) must be in the environment, the
endpoint profile, prices and limits must be well formed, the plugin sandbox must work, the guest tools must be ready and the
tracer must pass its end-to-end self-test in every published toolchain's runtime image. A claim that returns nothing (204)
backs off up to `poll.max_idle_s`. Leftovers of a previous run (`rush-*` sandboxes) are reaped first, the advertised
capabilities come from this machine's CPUs and memory, and a RUSH that cannot be reached is waited out (capped exponential
backoff), never fatal.
"""

from __future__ import annotations

import ctypes
import json
import logging
import math
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from pathlib import Path

import anyio
from omegaconf import MISSING
from slimconfig import Config, Run

from nanoagent.plugin import sandbox
from nanoagent.uploaded.endpoint import EndpointProfile, parse_endpoint
from nanoagent.uploaded.plugin_package import isolate
from nanoagent.uploaded.reconcile import HttpxGenerationLookup, reconcile
from nanoagent.uploaded.relay import HostRelay
from nanoagent.uploaded.runner import AttemptRunner, RunnerConfig, SyncedPlugins
from nanoagent.uploaded.rush_worker import AttemptJob, RushUnavailable, RushWorkerClient
from nanoagent.uploaded.sandbox import Limits, MicrosandboxSupervisor
from nanoagent.uploaded.timing import DEFAULT_CLOCK_TOLERANCE_NS
from nanoagent.uploaded.toolchains import TOOLCHAINS

LOG = logging.getLogger(__name__)

# The one place the worker's OpenRouter key comes from: the worker's environment, set by RUSH Lab from the member's settings.
OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY"


class WorkerConfigError(ValueError):
    pass


class Toolchain(Enum):
    PYTHON_3 = "python-3"
    CPP_20 = "cpp-20"
    RUST_1 = "rust-1"
    GO_1 = "go-1"
    TYPESCRIPT_5 = "typescript-5"
    JAVASCRIPT_22 = "javascript-22"
    JAVA_21 = "java-21"
    SHELL_1 = "shell-1"


class Model(Enum):
    """The models a worker may be priced for: the production model and the acceptance mock's."""

    DEEPSEEK_V4_FLASH = "deepseek/deepseek-v4-flash-0731"
    TEST_MODEL = "test/model"


@dataclass
class Price(Config):
    # USD per token, upper bounds the gateway reserves spend with.
    input: float = MISSING
    output: float = MISSING


@dataclass
class RushConfig(Config):
    # The RUSH server origin, and the environment variable holding RUSH_WORKER_TOKEN.
    base_url: str = MISSING
    token_env: str = MISSING


@dataclass
class OpenRouterConfig(Config):
    # See nanoagent.uploaded.endpoint: where the gateway forwards. The credential is OPENROUTER_API_KEY in the environment.
    label: str = MISSING
    mode: str = MISSING
    upstream_base_url: str = MISSING
    mock_hosts: list[str] | None = None


@dataclass
class TimingConfig(Config):
    reference_tokens_per_second: float = 100.0
    clock_tolerance_ns: int = DEFAULT_CLOCK_TOLERANCE_NS


@dataclass
class SandboxConfig(Config):
    cpus: float = 1.0
    memory_bytes: int = 1 << 30
    pids: int = 256
    workspace_bytes: int = 256 << 20
    out_bytes: int = 4 << 20
    tmp_bytes: int = 64 << 20
    output_bytes: int = 1 << 20
    workspace_files: int = 20_000
    # The build's own bounds: its output volume is a tmpfs charged to the build's memory.
    build_memory_bytes: int = 3 << 30
    build_output_bytes: int = 1 << 30
    build_files: int = 100_000
    # The build's /tmp, also charged to the build's memory; the go-1 toolchain needs about 400 MiB of it.
    build_tmp_bytes: int = 512 << 20
    # The largest of each limit a run may ask for (see LimitsConfig for the rest): a run's limits set what one attempt gets.
    build_wall_s: float = 600.0
    drain_timeout_s: float = 10.0
    plugin_sync_timeout_s: float = 600.0


@dataclass
class LimitsConfig(Config):
    # The worker's maximum for the per-attempt limits `sandbox` does not bound; advertised with every claim.
    wall_time_ms: int = 3_600_000
    max_model_calls: int = 500
    max_output_tokens_per_call: int = 65_536
    max_cost_usd: float = 10.0
    # How many attempts the worker runs at once, at most the machine's CPUs.
    concurrency: int = 1
    # The advertised cpus and memory are the machine's; these only lower them.
    max_cpus: float | None = None
    max_memory_mb: int | None = None


@dataclass
class EgressConfig(Config):
    # Internet access for harness VMs (a run's `limits.internet_access`): public addresses only. The worker proves at
    # startup that such a VM still cannot reach this host, and refuses to start otherwise.
    enabled: bool = False


@dataclass
class DependenciesConfig(Config):
    # Toolchain id -> the index (a simple-API URL or a folder of wheels) its locked dependencies are fetched from.
    index_urls: dict[Toolchain, str] = field(default_factory=dict)


@dataclass
class PollConfig(Config):
    idle_s: float = 1.0
    max_idle_s: float = 15.0
    # While RUSH cannot be reached the claim is retried with a doubling wait, from idle_s up to this.
    max_outage_s: float = 60.0
    renew_interval_s: float = 15.0


@dataclass
class WorkerConfig(Config):
    rush: RushConfig = field(default_factory=RushConfig)
    worker_id: str = MISSING
    openrouter: OpenRouterConfig = field(default_factory=OpenRouterConfig)
    prices: dict[Model, Price] = MISSING
    timing: TimingConfig = field(default_factory=TimingConfig)
    sandbox: SandboxConfig = field(default_factory=SandboxConfig)
    limits: LimitsConfig = field(default_factory=LimitsConfig)
    egress: EgressConfig = field(default_factory=EgressConfig)
    dependencies: DependenciesConfig = field(default_factory=DependenciesConfig)
    poll: PollConfig = field(default_factory=PollConfig)
    scratch: str = MISSING


def prices_of(raw: dict[Model, Price]) -> dict[str, tuple[Decimal, Decimal]]:
    prices = {}
    for model, entry in raw.items():
        if not all(math.isfinite(v) and v > 0 for v in (entry.input, entry.output)):
            raise WorkerConfigError(f"prices.{model.value} must be positive finite USD per token")
        prices[model.value] = (Decimal(str(entry.input)), Decimal(str(entry.output)))
    if not prices:
        raise WorkerConfigError("prices must name at least one model")
    return prices


@dataclass(frozen=True)
class Machine:
    """What the worker has: this computer's CPUs and physical memory, which its sandboxes' VMs share."""

    cpus: int
    memory_bytes: int


def machine_of() -> Machine:
    if sys.platform == "win32":
        class _Status(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), *[(name, ctypes.c_ulonglong) for name in (
                "total_phys", "avail_phys", "total_page", "avail_page", "total_virtual", "avail_virtual", "avail_extended")]]

        status = _Status(length=ctypes.sizeof(_Status))
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]
            raise WorkerConfigError("GlobalMemoryStatusEx failed")
        memory = int(status.total_phys)
    else:
        memory = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    machine = Machine(os.cpu_count() or 0, memory)
    if machine.cpus < 1 or machine.memory_bytes < 1:
        raise WorkerConfigError(f"this machine reports {machine.cpus} CPUs and {machine.memory_bytes} bytes of memory")
    return machine


def endpoint_of(config: WorkerConfig, env: dict[str, str]) -> EndpointProfile:
    """The validated OpenRouter endpoint profile; raises before the worker starts any sandbox."""
    block = config.openrouter
    hosts = None if block.mock_hosts is None else list(block.mock_hosts)
    profile = {"label": block.label, "mode": block.mode, "upstream_base_url": block.upstream_base_url, "api_key_env": OPENROUTER_KEY_ENV}
    return parse_endpoint(profile | ({} if hosts is None else {"mock_hosts": hosts}), env)


def runner_config(config: WorkerConfig, env: dict[str, str], machine: Machine) -> RunnerConfig:
    """Validate the YAML and resolve what it names; raises before any work is accepted."""
    endpoint = endpoint_of(config, env)
    timing = config.timing
    if not (math.isfinite(timing.reference_tokens_per_second) and timing.reference_tokens_per_second > 0) or timing.clock_tolerance_ns < 0:
        raise WorkerConfigError("timing.reference_tokens_per_second must be positive and finite and clock_tolerance_ns non-negative")
    box = config.sandbox
    maxima = config.limits
    if not all(math.isfinite(v) and v > 0 for v in (maxima.max_cost_usd, box.cpus)) or min(maxima.wall_time_ms, maxima.max_model_calls, maxima.max_output_tokens_per_call, maxima.concurrency, box.pids, box.workspace_files, box.build_memory_bytes, box.build_output_bytes, box.build_files, box.build_tmp_bytes) < 1:
        raise WorkerConfigError("limits and sandbox maxima must be positive")
    if any(v is not None and v <= 0 for v in (maxima.max_cpus, maxima.max_memory_mb)):
        raise WorkerConfigError("limits.max_cpus and limits.max_memory_mb must be positive")
    machine_mb = machine.memory_bytes >> 20
    cpus = machine.cpus if maxima.max_cpus is None else min(machine.cpus, maxima.max_cpus)
    memory_mb = machine_mb if maxima.max_memory_mb is None else min(machine_mb, maxima.max_memory_mb)
    scratch = Path(config.scratch)
    scratch.mkdir(parents=True, exist_ok=True)
    prices = prices_of(config.prices)
    return RunnerConfig(
        worker_id=config.worker_id, endpoint=endpoint, prices=prices, scratch=scratch.resolve(),
        limits=Limits(box.cpus, box.memory_bytes, box.pids, box.workspace_bytes, box.out_bytes, box.tmp_bytes, box.output_bytes, workspace_files=box.workspace_files),
        capabilities={
            "wall_time_ms": maxima.wall_time_ms, "max_model_calls": maxima.max_model_calls, "max_output_tokens_per_call": maxima.max_output_tokens_per_call,
            "max_cost_usd": maxima.max_cost_usd, "concurrency": min(maxima.concurrency, machine.cpus), "cpus": cpus, "memory_mb": memory_mb, "pids": box.pids,
            "workspace_bytes": box.workspace_bytes, "workspace_files": box.workspace_files, "tmp_bytes": box.tmp_bytes,
            "build_wall_ms": int(box.build_wall_s * 1000), "build_memory_mb": min(box.build_memory_bytes >> 20, memory_mb), "build_output_bytes": box.build_output_bytes,
            "build_files": box.build_files, "build_tmp_bytes": box.build_tmp_bytes,
            "internet_access": config.egress.enabled, "models": sorted(prices),
        },
        index_urls={key.value: url for key, url in config.dependencies.index_urls.items()},
        reference_tokens_per_second=timing.reference_tokens_per_second, clock_tolerance_ns=timing.clock_tolerance_ns,
        drain_timeout_s=box.drain_timeout_s, plugin_sync_timeout_s=box.plugin_sync_timeout_s, renew_interval_s=config.poll.renew_interval_s,
    )


async def serve(config: WorkerConfig, env: dict[str, str] | None = None) -> None:
    env = dict(os.environ if env is None else env)
    token = env.get(config.rush.token_env, "")
    if not token.strip():
        raise WorkerConfigError(f"environment variable {config.rush.token_env} is unset or empty")
    endpoint_of(config, env)
    machine = machine_of()
    LOG.info("machine: %d CPUs, %d MiB memory", machine.cpus, machine.memory_bytes >> 20)
    settings = runner_config(config, env, machine)
    isolate()
    # The plugin verifier scores every case in this sandbox. A host that refuses it (Ubuntu's AppArmor restriction on
    # unprivileged user namespaces, say) fails here, before a claim spends the member's key on runs nothing can score.
    with tempfile.TemporaryDirectory() as probe:
        sandbox.check(Path(probe))
    LOG.info("plugin sandbox verified")
    supervisor = MicrosandboxSupervisor(
        tools=settings.scratch / "guest-tools", clock=lambda: time.monotonic_ns() / 1e9, wall_clock_ns=time.time_ns, internet=config.egress.enabled,
    )
    worker = RushWorkerClient(config.rush.base_url, token)
    lookup = HttpxGenerationLookup(settings.endpoint)
    try:
        for name in await anyio.to_thread.run_sync(supervisor.reap):
            LOG.info("reaped a leftover sandbox: %s", name)  # a previous run quit mid-attempt
        LOG.info("leftover reaping passed")
        await anyio.to_thread.run_sync(supervisor.guest_tools)
        LOG.info("guest tools ready")
        for toolchain, profile in TOOLCHAINS.items():
            await anyio.to_thread.run_sync(supervisor.startup, profile)  # the tracer must observe a probe's exec and exit before member source runs
            LOG.info("tracer probe passed: %s", toolchain)
        if config.egress.enabled:
            await anyio.to_thread.run_sync(supervisor.verify_egress)  # internet access is only offered while this host stays unreachable
            LOG.info("egress fence verified")
        LOG.info("advertised capabilities: %s", json.dumps(settings.capabilities, sort_keys=True))
        runner = AttemptRunner(settings, supervisor=supervisor, worker=worker, relay=HostRelay(), plugins=SyncedPlugins())
        async with anyio.create_task_group() as background:
            await poll(config, settings, worker, runner, lookup, background)
    finally:
        await worker.aclose()
        await lookup.aclose()


async def poll(config: WorkerConfig, settings: RunnerConfig, worker: RushWorkerClient, runner: AttemptRunner, lookup: HttpxGenerationLookup, background: anyio.abc.TaskGroup) -> None:
    """Claim and run attempts, up to the advertised `concurrency` at once; a claimed attempt keeps the slot it was claimed in."""
    idle = config.poll.idle_s
    outage: float | None = None  # the current wait while RUSH is unreachable; None when it is reachable
    reached = False  # whether RUSH has answered a claim since startup or the last outage: the "claiming from" line is logged once per True
    slots = anyio.Semaphore(settings.capabilities["concurrency"])

    async def attempt(job: AttemptJob) -> None:
        try:
            result = await runner.run(job)
            LOG.info("attempt %s: %s %s", job.attempt_id, result.outcome, result.execution)
            if result.accounting:
                background.start_soon(reconciled, job.attempt_id, result.accounting)
        except Exception:  # one attempt's fault, never every other attempt's: the server expires it as interrupted
            LOG.exception("attempt %s: failed outside the runner's handling, left to expire as interrupted", job.attempt_id)
        finally:
            slots.release()

    async def reconciled(attempt_id: str, accounting: list) -> None:
        try:
            await reconcile(worker, attempt_id, accounting, lookup)
        except Exception:  # its accounting stays provisional, as for a generation that never appears
            LOG.exception("attempt %s: reconciling its accounting failed", attempt_id)

    while True:
        await slots.acquire()
        try:
            job = await worker.claim(settings.worker_id, settings.endpoint.label, settings.endpoint.mode, settings.capabilities)
        except RushUnavailable as error:
            slots.release()
            reached = False
            if outage is None:
                LOG.warning("RUSH is unreachable, retrying until it returns: %s", error)  # once per outage, not per retry
                outage = config.poll.idle_s
            await anyio.sleep(outage)
            outage = min(outage * 2, config.poll.max_outage_s)
            continue
        except BaseException:
            slots.release()
            raise
        if outage is not None:
            LOG.info("RUSH is reachable again")
            outage = None
        if not reached:
            LOG.info("claiming from RUSH: %s", settings.endpoint.label)  # the first answer, 204 or a job: RUSH Lab's health check reads it
            reached = True
        if job is None:
            slots.release()
            await anyio.sleep(idle)
            idle = min(idle * 2, config.poll.max_idle_s)
            continue
        idle = config.poll.idle_s
        background.start_soon(attempt, job)


class WorkerRun(Run):
    config: WorkerConfig

    def main(self) -> int:
        logging.basicConfig(level=logging.INFO)
        anyio.run(serve, self.config)
        return 0


if __name__ == "__main__":
    WorkerRun(home="worker-run").run()
