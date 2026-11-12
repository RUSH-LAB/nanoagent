"""Isolate a coding harness from other benchmark attempts and ambient credentials."""

import os
import shutil
import sys
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def coding_environment(
    workspace: Path, *, credential_names: set[str], protected: Sequence[Path] = ()
) -> Iterator[tuple[list[str], dict[str, str]]]:
    """Yield a sandbox command prefix and an environment for one coding harness.

    The benchmark outputs tree is hidden except for this attempt's workspace. The caller passes only
    the credential variables its API-key route needs.
    """
    workspace = workspace.resolve(strict=True)
    outputs = Path(__file__).resolve().parent / "outputs"
    outputs = outputs.resolve()
    paths = {path.resolve(strict=True) for path in (workspace.parent, *protected)}
    if outputs.is_dir():
        paths.add(outputs)
    paths.update((Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve()))
    # An ancestor masks its descendants, so mount only the outermost protected paths.
    paths = {path for path in paths if not any(path != other and path.is_relative_to(other) for other in paths)}
    if workspace in paths:
        raise ValueError("the workspace itself cannot be protected")
    user_home = Path.home().resolve()
    with tempfile.TemporaryDirectory(prefix="nanoagent-benchmark-") as directory:
        private = Path(directory).resolve()
        home = private / "home"
        temp = private / "tmp"
        home.mkdir()
        temp.mkdir()
        env = {name: os.environ[name] for name in credential_names}
        # Claude Code keeps its temporary files under CLAUDE_CODE_TMPDIR, not TMPDIR.
        env.update(
            PATH=os.environ["PATH"],
            HOME=str(home),
            TMPDIR=str(temp),
            TMP=str(temp),
            TEMP=str(temp),
            TMPPREFIX=str(temp / "zsh"),
            CLAUDE_CODE_TMPDIR=str(temp),
            XDG_CONFIG_HOME=str(home / ".config"),
            XDG_CACHE_HOME=str(home / ".cache"),
        )
        # Packages are fetched before the batch, under this cache, rather than during timing.
        npm_cache = Path(os.environ.get("npm_config_cache", str(user_home / ".npm"))).resolve()
        env["npm_config_cache"] = str(npm_cache)
        project = Path(__file__).resolve().parents[2]
        private_files = [project.parent / ".env", project / ".env", user_home / ".netrc", user_home / ".npmrc", user_home / ".claude.json"]
        private_dirs = [user_home / name for name in (".ssh", ".aws", ".config", ".claude", ".codex", ".hermes")]
        if sys.platform == "darwin":
            executable = shutil.which("sandbox-exec")
            if executable is None:
                raise RuntimeError("sandbox-exec is required for coding benchmark isolation")

            def quoted(path: Path) -> str:
                return '"' + str(path).replace("\\", "\\\\").replace('"', '\\"') + '"'

            profile = "(version 1) (allow default) (deny file-write*)"
            for path in paths:
                profile += f" (deny file-read* file-write* (subpath {quoted(path)}))"
            for path in (workspace, private, npm_cache):
                profile += f" (allow file-write* (subpath {quoted(path)}))"
            profile += f" (allow file-read* (subpath {quoted(workspace)}))"
            profile += f" (allow file-read* (subpath {quoted(private)}))"
            # realpath needs metadata for protected ancestors of the two visible directories.
            for path in sorted(set(workspace.parents) | set(private.parents)):
                profile += f" (allow file-read-metadata (literal {quoted(path)}))"
            profile += ' (allow file-write* (literal "/dev/null"))'
            for path in private_files:
                profile += f" (deny file-read* file-write* (literal {quoted(path)}))"
            for path in private_dirs:
                profile += f" (deny file-read* file-write* (subpath {quoted(path)}))"
            prefix = [executable, "-p", profile]
        elif sys.platform.startswith("linux"):
            executable = shutil.which("bwrap")
            if executable is None:
                raise RuntimeError("bwrap is required for coding benchmark isolation on Linux")
            prefix = [executable, "--die-with-parent", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc"]
            for path in sorted(paths):
                prefix += ["--tmpfs", str(path)]
                directories = set()
                for target in (workspace, private):
                    if target.is_relative_to(path):
                        current = path
                        for part in target.relative_to(path).parts[:-1]:
                            current /= part
                            directories.add(current)
                for directory in sorted(directories, key=lambda item: len(item.parts)):
                    prefix += ["--dir", str(directory)]
            for target in (private, workspace):
                if any(target.is_relative_to(path) for path in paths):
                    prefix += ["--dir", str(target)]
                prefix += ["--bind", str(target), str(target)]
            for path in private_dirs:
                if path.is_dir():
                    prefix += ["--tmpfs", str(path)]
            for path in private_files:
                if path.is_file():
                    prefix += ["--ro-bind", "/dev/null", str(path)]
            if npm_cache.is_dir():
                prefix += ["--bind", str(npm_cache), str(npm_cache)]
            prefix += ["--"]
        else:
            raise RuntimeError(f"coding benchmark isolation is unsupported on {sys.platform}")
        yield prefix, env
