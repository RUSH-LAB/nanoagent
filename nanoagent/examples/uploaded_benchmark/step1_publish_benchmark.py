"""Step 1: publish a benchmark for a plugin version, as any member.

A benchmark is a case set plus the run configuration every harness run on it gets: the limits (internet access included; the
model and endpoint are the server's one, pinned on every benchmark). The case set is the task's case file (a YAML file: `plugin`, `task`, `cases` and `refuse`,
each case a `prompt`, its `arguments` and optionally a `fixtures` folder beside the file) and the plugin's published package;
every field of it is derived from them (nanoagent.uploaded.case_sets.derive_case_set): the task's kind, description and schemas,
the tools the task gives an agent, the plugin's name, each case's kind, prompt, fixtures archive and expected error, and the
private references, pinned once each by the reference tool (a refusal case by its error) on the case's staged fixtures. The benchmark is tied to `plugin_version` and named `name`; a name is unique per plugin
version. Publishing it again unchanged answers `created: false`; the same name with other content is refused (409
`benchmark_name_taken`). `limits` holds overrides only.
The package is the published one, downloaded from the marketplace (`plugin_source: market`, the latest version), or the local
plugin folder packed with `nanoagent.plugin.package.pack`, whose SHA-256 must equal `sha256`, the published version's. A case file
the plugin cannot judge deterministically stops the step with what to change; nothing is published then. benchmark.json holds what
was published, never the private references."""

import hashlib
import io
import tarfile
import tempfile
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

from nanoagent.plugin import load_manifest
from nanoagent.plugin.package import pack
from nanoagent.uploaded.case_sets import derive_case_set, parse_case_file
from nanoagent.uploaded.client import BenchmarkClient, ServerConfig
from nanoagent.uploaded.preparation import isolate, logged, prepared_plugin


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
    # The case file (YAML; it names the plugin and the task; a case's fixtures folder is relative to the file's folder), the plugin
    # version the benchmark is tied to, and its name.
    cases: str = MISSING
    plugin_version: str = MISSING
    name: str = MISSING
    # What every run on the benchmark gets besides the server's one model and endpoint: the limits.
    limits: Limits = field(default_factory=Limits)
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


def package_bytes(config: PublishConfig, client: BenchmarkClient, plugin: str) -> bytes:
    """The plugin's package, and for a local folder only if it is the published one."""
    match config.plugin_source:
        case PluginSource.MARKET:
            return client.download_package(plugin)
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
        case_file = Path(config.cases)
        if case_file.suffix not in (".yaml", ".yml"):
            raise ValueError(f"the case file {case_file} must be a YAML file (.yaml or .yml)")
        cases = parse_case_file(case_file.read_text(encoding="utf-8"))
        with config.server.client() as client:
            data = package_bytes(config, client, cases.plugin)
            sha256 = hashlib.sha256(data).hexdigest()
            python = isolate()
            with tempfile.TemporaryDirectory(prefix="nanoagent-uploaded-benchmark-") as unpacked:
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                    archive.extractall(unpacked, filter="data")
                with prepared_plugin(Path(unpacked, cases.plugin), python, config.sync_timeout) as root:
                    manifest = load_manifest(root)
                    if manifest.version != config.plugin_version:
                        raise ValueError(f"the package is {cases.plugin} {manifest.version}, not plugin_version {config.plugin_version}")
                    publication = derive_case_set(config.name, cases, manifest, sha256, config.timeout, case_file.parent)
            publication |= {
                "limits": {name: value for name, value in vars(config.limits).items() if value is not None and not name.startswith("_")},
            }
            created, benchmark = client.publish_benchmark(publication)
        print(f"{'published' if created else 'already published'} benchmark {benchmark['benchmark_id']} ({len(publication['cases'])} cases)")
        public = {key: value for key, value in publication.items() if key != "private"}
        # The archives stay out of benchmark.json: their digests and files lists say what they hold.
        public["cases"] = [{**case, "fixtures": case["fixtures"] and {**case["fixtures"], "archive": None}} for case in public["cases"]]
        self.layout.benchmark = PublishedBenchmark(created=created, benchmark=benchmark, publication=public)


if __name__ == "__main__":
    PublishBenchmark().run()
