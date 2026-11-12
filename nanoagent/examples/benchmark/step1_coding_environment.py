"""Give a coding harness its own workspace, home, and route credentials."""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
SYSTEM = ("/usr", "/bin", "/sbin", "/lib", "/lib64")
LINUX_CONFIG = (
    "/etc/alternatives",
    "/etc/ca-certificates",
    "/etc/group",
    "/etc/hosts",
    "/etc/ld.so.cache",
    "/etc/localtime",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/resolv.conf",
    "/etc/ssl",
)
MACOS_SYSTEM = (
    "/System",
    "/Library",
    "/private/etc",
    "/private/var/db/timezone",
    "/dev",
    "/opt/homebrew/Cellar",
    "/opt/homebrew/bin",
    "/opt/homebrew/etc/ca-certificates",
    # Node reads the openssl.cnf of the OpenSSL it links: @3, or @4 since Homebrew moved node to it.
    "/opt/homebrew/etc/openssl@3",
    "/opt/homebrew/etc/openssl@4",
    "/opt/homebrew/lib",
    "/opt/homebrew/opt",
    "/opt/homebrew/share",
)


def _runtime(bin_folder: Path) -> tuple[list[Path], str]:
    """The benchmark checkout's runners and their installed runtimes."""
    paths = {
        Path(sys.base_prefix),
        Path(sys.prefix),
        Path(sys._base_executable).parent.parent,
        PROJECT / "src",
        PROJECT / "js/pi-runner/dist",
        PROJECT / "js/pi-runner/node_modules",
        PROJECT / "js/pi-runner/package.json",
    }
    search = [bin_folder, Path(sys.executable).parent, Path(sys.base_prefix) / "bin"]
    node = shutil.which("node")
    if node:
        executable = Path(node).resolve(strict=True)
        node_bin = executable.parent
        search.insert(1, node_bin)
        # A user-installed Node distribution (e.g. nvm) carries npm alongside Node.
        if node_bin.name == "bin" and (node_bin.parent / "lib/node_modules/npm").is_dir():
            paths.add(node_bin.parent)
        else:
            paths.add(executable)
    claude = shutil.which("claude")
    if claude:
        executable = Path(claude).resolve(strict=True)
        paths.add(executable)
        (bin_folder / "claude").symlink_to(executable)
    search.extend(map(Path, ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")))
    return sorted(path for path in paths if path.exists()), os.pathsep.join(map(str, dict.fromkeys(search)))


def _quoted(path: Path) -> str:
    return '"' + str(path).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _seatbelt(executable: str, readable: list[Path], writable: list[Path]) -> list[str]:
    reads = sorted({path.resolve() for path in [*readable, *writable, *map(Path, (*SYSTEM, *MACOS_SYSTEM))]})
    profile = [
        "(version 1)",
        "(allow default)",
        "(deny file-read-data file-write* process-info* signal)",
        "(allow process-info* (target self))",
        "(allow signal (target same-sandbox))",
        '(allow file-read-data (literal "/") ' + " ".join(f"(subpath {_quoted(path)})" for path in reads) + ")",
        '(allow file-write* (literal "/dev/null") ' + " ".join(f"(subpath {_quoted(path)})" for path in writable) + ")",
    ]
    return [executable, "-p", "\n".join(profile)]


def _bwrap(executable: str, readable: list[Path], writable: list[Path]) -> list[str]:
    args = [
        # Keep the runner as the namespace's main process so wait() accounts for its CPU time.
        executable, "--unshare-all", "--share-net", "--as-pid-1", "--die-with-parent", "--new-session",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ]
    # Mount system aliases in place so absolute interpreter paths and symlinks still work.
    for path in (*SYSTEM, *LINUX_CONFIG):
        args += ["--ro-bind-try", path, path]
    # Ubuntu may link resolv.conf to a generated file under /run.
    for path in sorted({*readable, *(Path(path).resolve() for path in LINUX_CONFIG if Path(path).is_symlink())}):
        if not any(path.is_relative_to(root) for root in map(Path, SYSTEM)):
            args += ["--ro-bind", str(path.resolve()), str(path)]
    for path in writable:
        args += ["--bind", str(path), str(path)]
    return [*args, "--"]


@contextmanager
def coding_environment(
    workspace: Path, *, credential_names: set[str], npm_cache: Path | None = None
) -> Iterator[tuple[list[str], dict[str, str]]]:
    """Expose the workspace and runtimes, with no access to other runs or the caller's home."""
    workspace = workspace.resolve(strict=True)
    with (
        tempfile.TemporaryDirectory(prefix="nanoagent-benchmark-") as directory,
        tempfile.TemporaryDirectory(prefix=".npm-", dir=workspace.parent) as cache_directory,
    ):
        private = Path(directory).resolve()
        home, temp, bin_folder = (private / name for name in ("home", "tmp", "bin"))
        for folder in (home, temp, bin_folder):
            folder.mkdir()
        readable, search = _runtime(bin_folder)
        cache = Path(cache_directory).resolve() / "npm"
        if npm_cache is not None:
            shutil.copytree(npm_cache, cache, symlinks=True)
        env = {name: os.environ[name] for name in credential_names}
        env.update(
            PATH=search,
            HOME=str(home),
            TMPDIR=str(temp),
            TMP=str(temp),
            TEMP=str(temp),
            TMPPREFIX=str(temp / "zsh"),
            CLAUDE_CODE_TMPDIR=str(temp),
            XDG_CONFIG_HOME=str(home / ".config"),
            XDG_CACHE_HOME=str(home / ".cache"),
            npm_config_audit="false",
            npm_config_cache=str(cache),
            npm_config_fund="false",
            npm_config_update_notifier="false",
        )
        writable = [workspace, private, cache.parent]
        if sys.platform == "darwin":
            executable = shutil.which("sandbox-exec")
            if executable is None:
                raise RuntimeError("sandbox-exec is required for coding benchmark isolation")
            yield _seatbelt(executable, readable, writable), env
        elif sys.platform.startswith("linux"):
            executable = shutil.which("bwrap")
            if executable is None:
                raise RuntimeError("bwrap is required for coding benchmark isolation on Linux")
            yield _bwrap(executable, readable, writable), env
        else:
            raise RuntimeError(f"coding benchmark isolation is unsupported on {sys.platform}")


def npm_package_cache(root: Path, package: str) -> Path:
    return root / ".npm-cache" / hashlib.sha256(package.encode()).hexdigest()


def fetch_npm(package: str, prefix: list[str], env: dict[str, str], *, cwd: Path) -> None:
    """Warm the pinned package before the harness's clock starts."""
    print(f"fetching {package}")
    completed = subprocess.run(
        [*prefix, "npx", "-y", package, "--version"], cwd=cwd, env=env, capture_output=True, text=True, timeout=120
    )
    if completed.returncode:
        raise RuntimeError(f"fetching {package} exited with status {completed.returncode}: {completed.stderr.strip()}")
