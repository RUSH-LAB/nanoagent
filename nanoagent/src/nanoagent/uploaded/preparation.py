"""What preparing a plugin for a benchmark step needs: its package unpacked from the local marketplace, the sandbox its tools run in,
the plugin's environment synced outside the checkout, and a step's log."""

import base64
import hashlib
import io
import logging
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import traceback
from collections.abc import Iterator
from contextlib import contextmanager, redirect_stderr
from pathlib import Path

from nanoagent.plugin import sandbox
from nanoagent.plugin.install import INSTALL_HOSTS, SYNC
from nanoagent.plugin.python import PluginPython, plugin_python
from nanoagent.uploaded.case_sets import reference_tool as uploaded_reference_tool

# The marketplace's package of a plugin, one tab-separated line: version, SHA-256, package (base64,
# which Postgres breaks into lines of 76 characters, joined back here).
PACKAGE_QUERY = """select v.version, v.sha256, replace(encode(v.package, 'base64'), E'\\n', '')
from market_plugin p join market_plugin_version v on v.plugin_id = p.id and v.version = p.version
where p.id = :'id'"""


def reference_tool(task) -> str | None:
    """The uploaded benchmark's `reference_tool`, except that the local plugin benchmark pins every case and so
    refuses a decide task without a reference tool, as it always has."""
    if task.runner == "decide" and task.reference is None:
        raise ValueError(f"task {task.id!r}: the benchmark cannot pin a decide task without a reference tool")
    return uploaded_reference_tool(task)


def unpack(database: str, psql: str, plugin: str, folder: Path) -> str:
    """Unpack the marketplace package of ``plugin`` into ``folder`` after checking its SHA-256."""
    found = subprocess.run(
        [psql, database, "--no-psqlrc", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-v", f"id={plugin}"],
        input=PACKAGE_QUERY,
        capture_output=True,
        text=True,
    )
    if found.returncode != 0:
        raise RuntimeError(f"psql could not read {plugin} from {database}: {found.stderr.strip()}")
    rows = [line for line in found.stdout.splitlines() if line]
    if len(rows) != 1:
        raise RuntimeError(f"the marketplace has {len(rows)} packages of {plugin}, not one")
    version, sha256, encoded = rows[0].split("\t")
    package = base64.b64decode(encoded)
    if hashlib.sha256(package).hexdigest() != sha256:
        raise RuntimeError(f"{plugin} {version}'s package does not match the SHA-256 the marketplace recorded")
    with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
        tops = {Path(member.name).parts[0] for member in archive.getmembers()}
        if tops != {plugin}:
            raise RuntimeError(f"{plugin}'s package holds {sorted(tops)}, not the one folder {plugin}")
        archive.extractall(folder, filter="data")
    return version


def isolate() -> PluginPython:
    """Configure the sandbox plugin tools run in, on this platform; the Python they run on."""
    kind = {"darwin": "seatbelt", "linux": "bwrap"}.get(sys.platform)
    if kind is None:
        raise RuntimeError(f"benchmark isolation is unsupported on {sys.platform}")
    python = plugin_python(sys.executable)
    if kind == "bwrap" and Path(sys._base_executable).parent.parent.is_symlink() and "UV_PYTHON_INSTALL_DIR" not in os.environ:
        # uv-managed venvs may use a version alias as well as the resolved runtime prefix.
        managed = Path(subprocess.check_output(["uv", "python", "dir"], text=True).strip())
        if python.prefix.is_relative_to(managed):
            os.environ["UV_PYTHON_INSTALL_DIR"] = str(managed)
    sandbox.configure(kind, python)
    return python


@contextmanager
def prepared_plugin(source: Path, python: PluginPython, timeout: float) -> Iterator[Path]:
    """Install outside the checkout so uv cannot discover the benchmark's parent project."""
    with tempfile.TemporaryDirectory(prefix="nanoagent-benchmark-plugin-") as directory:
        root = Path(directory).resolve() / source.name
        shutil.copytree(source, root, symlinks=True)
        sync = [*SYNC, "--python", str(python.executable), "--quiet"]
        with sandbox.launch(sync, root=root, env={}, writable=[root], hosts=INSTALL_HOSTS) as (argv, env):
            subprocess.run(argv, cwd=root, env=env, check=True, timeout=timeout)
        yield root


@contextmanager
def logged():
    """Everything a step writes into its run.log, as slimconfig puts its stdout there: stderr, every
    logged warning and, when the step fails, its traceback."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)
    try:
        with redirect_stderr(sys.stdout):
            try:
                yield
            except BaseException:
                traceback.print_exc()
                raise
    finally:
        logging.getLogger().removeHandler(handler)
