"""Step 1: the plugins the benchmark runs, unpacked from the RUSH marketplace's packages in the local
RUSH database (helpinghands' `npm run local`, a copy of production's). Each is the version the
marketplace serves, its package checked against the SHA-256 the marketplace recorded for it."""

import base64
import hashlib
import io
import json
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, Workspace

# One line per plugin: version, SHA-256, repository (JSON) and package (base64), tab-separated.
# Postgres breaks base64 into lines of 76 characters: the package is joined back into one.
QUERY = """select v.version, v.sha256, v.repository::text, replace(encode(v.package, 'base64'), E'\n', '')
from market_plugin p join market_plugin_version v on v.plugin_id = p.id and v.version = p.version
where p.id = :'id'"""


@dataclass
class PluginsConfig(Config):
    # The local RUSH database, and the psql that reads it.
    database: str = MISSING
    psql: str = MISSING
    # The marketplace ids of the plugins to unpack.
    plugins: list[str] = MISSING


@dataclass
class Package(Output):
    id: str
    version: str
    sha256: str
    # Where the marketplace published it from: the GitHub owner, repository, path and commit.
    repository: dict[str, Any]


@dataclass
class Packages(Output):
    packages: list[Package]


@dataclass
class PluginsLayout(Layout):
    packages: Packages
    # One folder per plugin, named by its id, holding the package's files as they are.
    plugins: Workspace


def fetch(config: PluginsConfig, plugin: str) -> tuple[str, str, str, bytes]:
    """The marketplace's version, SHA-256, repository and package of ``plugin``."""
    found = subprocess.run(
        [config.psql, config.database, "--no-psqlrc", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-v", f"id={plugin}"],
        input=QUERY,
        capture_output=True,
        text=True,
    )
    if found.returncode != 0:
        raise RuntimeError(f"psql could not read {plugin} from {config.database}: {found.stderr.strip()}")
    rows = [line for line in found.stdout.splitlines() if line]
    if len(rows) != 1:
        raise RuntimeError(f"the marketplace has {len(rows)} packages of {plugin}, not one")
    version, sha256, repository, package = rows[0].split("\t")
    return version, sha256, repository, base64.b64decode(package)


def unpack(package: bytes, plugin: str, folder: Path) -> None:
    """Unpack ``package``, whose one top folder is ``plugin``, into ``folder``."""
    with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
        tops = {Path(member.name).parts[0] for member in archive.getmembers()}
        if tops != {plugin}:
            raise RuntimeError(f"{plugin}'s package holds {sorted(tops)}, not the one folder {plugin}")
        archive.extractall(folder, filter="data")


class Plugins(Run):
    """Unpack every plugin of the config from the marketplace's packages."""

    config: PluginsConfig
    layout: PluginsLayout

    def main(self) -> None:
        packages = []
        for plugin in self.config.plugins:
            version, sha256, repository, package = fetch(self.config, plugin)
            if hashlib.sha256(package).hexdigest() != sha256:
                raise RuntimeError(f"{plugin} {version}'s package does not match the SHA-256 the marketplace recorded")
            unpack(package, plugin, Path(self.layout.plugins))
            packages.append(Package(id=plugin, version=version, sha256=sha256, repository=json.loads(repository)))
            print(f"{plugin} {version}: unpacked, SHA-256 {sha256[:12]}… checked")
        self.layout.packages = Packages(packages=packages)


if __name__ == "__main__":
    Plugins().run()
