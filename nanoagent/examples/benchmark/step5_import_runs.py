"""Step 5: step 3's runs kept in a local RUSH as scored runs of its reference harnesses, so every plugin page's Leaderboard ranks them.

Each run folder step 3 wrote (<plugin>/<task>/<case>/<harness>, step 2's layout) but those of a plugin step 1 marked as having a bug
goes to RUSH's POST benchmark/imports, in one of the member's workspaces, as the run of the reference harness RUSH builds under the
step's harness's name (`harnesses`): its case set's frame (the plugin, its task and the case file's context, as NanoAgent reads them
from the plugin the run used, which RUSH checks against the version it publishes), the case, how the run ended, whether the verifier
found it right and its word, its time, tokens and cost. Each reference harness's ZIP, built by this NanoAgent, is sent first as the
member's source of it (POST benchmark/sources/references/<name>). The runs are owned by the member signed in to RUSH Lab's connection,
as `nanoagent harness` signs in, and go only to the RUSH `site` names, a local one: a connection to another RUSH stops the step.
RUSH keeps a run once per plugin, task, case and harness, so the step runs again without keeping any twice. A plugin the run used that
breaks this NanoAgent's plugin rules (made under older ones) has no frame to keep its runs on: they are left out, and the plugin is
named with the rules it breaks in imported.json."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from omegaconf import MISSING
from slimconfig import Config, Layout, Metadata, Output, Run, load_output

from nanoagent.cli.harness import app_data, checked, connection, find_lab
from nanoagent.plugin import PluginError, load_manifest
from nanoagent.uploaded.case_sets import case_set_frame
from nanoagent.uploaded.reference import build_reference
from step1_make_cases import PluginBugs
from step2_single_run import Cases, Harness, logged

# The only RUSH the runs may go to.
LOCAL_SITES = ("http://localhost:3000", "http://127.0.0.1:3000")


@dataclass
class ImportConfig(Config):
    # Step 3's folder of runs, step 1's bugs file and its folder of cases files (step1_<name>_cases.json).
    runs: str = MISSING
    bugs: str = MISSING
    cases: str = MISSING
    # The name the runs' benchmark is kept under, and the endpoint profile they reached their model through.
    name: str = MISSING
    endpoint_profile: str = MISSING
    # The reference harness RUSH keeps each of step 2's harnesses' runs as.
    harnesses: dict[Harness, str] = MISSING
    # The slug of the member's workspace the runs are kept in.
    workspace: str = MISSING
    # RUSH Lab's data folder, which holds its one connection; null: whichever of RUSH Lab's and RUSH Lab Dev's is signed in.
    lab: str | None = MISSING


@dataclass
class Imported(Output):
    # The runs RUSH kept now, and those it had kept before.
    kept: int
    existing: int
    # Each plugin whose runs are left out, as its copy breaks this NanoAgent's plugin rules, with the rules it breaks.
    broken: dict[str, str]


@dataclass
class ImportLayout(Layout):
    imported: Imported


def execution(result: dict[str, Any]) -> str:
    """How the run ended, as RUSH records it: it answered, refused, or failed before either."""
    return "answered" if result["output"] is not None else "refused" if result["refused"] is not None else "execution_failed"


class ImportRuns(Run):
    """Keep every run of step 3 in the local RUSH, as the signed-in member's."""

    config: ImportConfig
    layout: ImportLayout

    def main(self) -> None:
        with logged():
            self.work()

    def work(self) -> None:
        config = self.config
        _, site, token = connection(find_lab(app_data()) if config.lab is None else Path(config.lab))
        if site not in LOCAL_SITES:
            raise SystemExit(f"import: RUSH Lab is signed in to {site}; the runs go only to a local RUSH ({', '.join(LOCAL_SITES)})")
        buggy = {bug["plugin"] for bug in load_output(config.bugs, PluginBugs).plugins}
        cases = {each.plugin: each for each in (load_output(path, Cases) for path in sorted(Path(config.cases).glob("step1_*_cases.json")))}
        kept = existing = 0
        with httpx.Client(base_url=site, headers={"Authorization": f"Bearer {token}", "Origin": site}, timeout=60.0) as rush:
            workspaces = [each for each in checked(rush.get("/api/workspaces"))["workspaces"] if each["slug"] == config.workspace]
            if len(workspaces) != 1:
                raise SystemExit(f"import: the member signed in to {site} is in no workspace {config.workspace!r}")
            prefix = f"/api/workspaces/{workspaces[0]['id']}/benchmark"
            sources = {
                harness: checked(rush.post(f"{prefix}/sources/references/{name}", content=build_reference(name), headers={"Content-Type": "application/zip"}))["source_sha256"]
                for harness, name in config.harnesses.items()
            }  # fmt: skip
            manifests = {}
            broken: dict[str, str] = {}
            for path in sorted(Path(config.runs).glob("*/*/*/*/result.json")):
                # The fields kept, read as JSON: step 2's SingleRun has changed since some batches were run.
                result = json.loads(path.read_text(encoding="utf-8"))
                plugin = result["plugin"]
                if plugin in buggy or plugin in broken:
                    continue
                if plugin not in manifests:
                    try:
                        manifests[plugin] = load_manifest(path.parent / "plugin" / plugin)
                    except PluginError as error:
                        broken[plugin] = str(error)
                        print(f"left out: {error}")
                        continue
                manifest = manifests[plugin]
                frame = case_set_frame(config.name, manifest, "", manifest.task(result["task"]), cases[plugin].context)
                del frame["package_sha256"]  # RUSH pins the package of the version it publishes
                body = {
                    "frame": frame | {"model": result["model"], "endpoint_profile": config.endpoint_profile},
                    "source_sha256": sources[Harness(result["harness"])],
                    "case_id": result["case"],
                    "kind": result["expected"],
                    "started_at": load_output(path.parent / "metadata.json", Metadata).started,
                    "execution": execution(result),
                    "correct": result["correct"],
                    "verdict": result["verdict"],
                    "elapsed_ms": round(result["latency_seconds"] * 1000),
                    "input_tokens": result["input_tokens"],
                    "output_tokens": result["output_tokens"],
                    "cost_usd": result["cost"],
                }
                if checked(rush.post(f"{prefix}/imports", json=body))["created"]:
                    kept += 1
                else:
                    existing += 1
        self.layout.imported = Imported(kept=kept, existing=existing, broken=broken)
        print(f"{kept} runs kept, {existing} kept before, in {config.workspace} on {site}; {len(broken)} plugins left out: {', '.join(broken)}")


if __name__ == "__main__":
    ImportRuns().run()
