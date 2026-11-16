"""Step 1: publish a benchmark for a plugin version, as any member.

A benchmark is a case set plus the run configuration every harness run on it gets: the model, the endpoint profile, the
limits (internet access included), the coding template and the task instructions. The case set is the task's cases file
(examples/benchmark's step1_<name>_cases.json) and the plugin's published package; every field of it is derived from them
(nanoagent.uploaded.case_sets.derive_case_set): the task's kind, description, instructions and schemas, the tools the task gives
an agent, the plugin's name, each case's kind and expected error, and the private references, pinned once each by the reference
tool (a refusal case by its error). The benchmark is tied to `plugin_version` and named `name`; a name is unique per plugin
version. Publishing it again unchanged answers `created: false`; the same name with other content is refused (409
`benchmark_name_taken`). `limits` holds overrides only and a null `coding_template` or `task_instructions` is the default.
The package is the published one, downloaded from the marketplace (`plugin_source: market`, the latest version), or the local
plugin folder packed with `nanoagent.plugin.package.pack`, whose SHA-256 must equal `sha256`, the published version's. A case file
the plugin cannot judge deterministically stops the step with what to change; nothing is published then. benchmark.json holds what
was published, never the private references."""

import hashlib
import io
import sys
import tarfile
import tempfile
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmark"))

from step2_single_run import Cases, isolate, logged, prepared_plugin  # noqa: E402

from nanoagent.plugin import load_manifest  # noqa: E402
from nanoagent.plugin.package import pack  # noqa: E402
from nanoagent.uploaded.case_sets import derive_case_set  # noqa: E402
from nanoagent.uploaded.client import BenchmarkClient, ServerConfig  # noqa: E402


class PluginSource(Enum):
    MARKET = "market"
    FOLDER = "folder"


@dataclass
class Limits(Config):
    # Overrides of the server's defaults; null takes the default. Every effective value is pinned with the benchmark.
    wall_time_ms: int | None = None
    max_model_calls: int | None = None
    max_output_tokens_per_call: int | None = None
    max_cost_usd: float | None = None
    internet_access: bool | None = None
    concurrency: int | None = None
    cpus: float | None = None
    memory_mb: int | None = None
    pids: int | None = None
    workspace_bytes: int | None = None
    workspace_files: int | None = None
    tmp_bytes: int | None = None
    build_wall_ms: int | None = None
    build_memory_mb: int | None = None
    build_output_bytes: int | None = None
    build_files: int | None = None
    build_tmp_bytes: int | None = None


@dataclass
class PublishConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    # The task's cases (examples/benchmark's step 1 file; it names the plugin and the task), the plugin version the
    # benchmark is tied to, and its name.
    cases: Cases = MISSING
    plugin_version: str = MISSING
    name: str = MISSING
    # What every run on the benchmark gets: the model, the endpoint profile only a worker advertising it serves, and the limits.
    model: str = MISSING
    endpoint_profile: str = MISSING
    limits: Limits = field(default_factory=Limits)
    # coding takes `coding_template` (str.format placeholders {description}, {context}, {arguments}, {input_schema},
    # {output_schema}, {workspace}); task_tools takes `task_instructions`. Null is the default of each.
    coding_template: str | None = None
    task_instructions: str | None = None
    # Where the package comes from: the marketplace, or `folder` packed locally and checked against `sha256`.
    plugin_source: PluginSource = MISSING
    folder: str | None = None
    sha256: str | None = None
    # Seconds the reference tool may take, and the plugin's Python environment may take to sync.
    timeout: float = MISSING
    sync_timeout: float = MISSING


@dataclass
class PublishedBenchmark(Output):
    """The public parts of what was published, and the server's answer."""

    created: bool
    benchmark: dict[str, Any]
    publication: dict[str, Any]


@dataclass
class PublishLayout(Layout):
    benchmark: PublishedBenchmark


def package_bytes(config: PublishConfig, client: BenchmarkClient) -> bytes:
    """The plugin's package, and for a local folder only if it is the published one."""
    match config.plugin_source:
        case PluginSource.MARKET:
            return client.download_package(config.cases.plugin)
        case PluginSource.FOLDER:
            if config.folder is None or config.sha256 is None:
                raise ValueError("plugin_source folder needs `folder` and the published version's `sha256`")
            data = pack(config.folder)
            actual = hashlib.sha256(data).hexdigest()
            if actual != config.sha256:
                raise RuntimeError(f"{config.folder} packs to {actual}, not the published version's {config.sha256}")
            return data


class PublishBenchmark(Run):
    config: PublishConfig
    layout: PublishLayout

    def main(self) -> None:
        with logged():
            self.work()

    def work(self) -> None:
        config = self.config
        cases = config.cases
        with config.server.client() as client:
            data = package_bytes(config, client)
            sha256 = hashlib.sha256(data).hexdigest()
            python = isolate()
            with tempfile.TemporaryDirectory(prefix="nanoagent-uploaded-benchmark-") as unpacked:
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                    archive.extractall(unpacked, filter="data")
                with prepared_plugin(Path(unpacked, cases.plugin), python, config.sync_timeout) as root:
                    manifest = load_manifest(root)
                    if manifest.version != config.plugin_version:
                        raise ValueError(f"the package is {cases.plugin} {manifest.version}, not plugin_version {config.plugin_version}")
                    publication = derive_case_set(config.name, cases, manifest, sha256, config.timeout)
            publication |= {
                "model": config.model,
                "endpoint_profile": config.endpoint_profile,
                "limits": {name: value for name, value in vars(config.limits).items() if value is not None and not name.startswith("_")},
                "coding_template": config.coding_template,
                "task_instructions": config.task_instructions,
            }
            created, benchmark = client.publish_benchmark(publication)
        print(f"{'published' if created else 'already published'} benchmark {benchmark['benchmark_id']} ({len(publication['cases'])} cases)")
        public = {key: value for key, value in publication.items() if key != "private"}
        self.layout.benchmark = PublishedBenchmark(created=created, benchmark=benchmark, publication=public)


if __name__ == "__main__":
    PublishBenchmark().run()
