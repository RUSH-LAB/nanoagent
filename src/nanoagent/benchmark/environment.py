"""Per-task benchmark environment lifecycle."""

from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from nanoagent.benchmark.task import BenchmarkTask


@dataclass(frozen=True)
class EnvironmentDescriptor:
    name: str
    version: str
    isolated: bool

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "version": self.version, "isolated": self.isolated}


@dataclass(frozen=True)
class EnvironmentSession:
    workspace: Path | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EnvironmentOutcome:
    submission: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)


class BenchmarkEnvironment(Protocol):
    descriptor: EnvironmentDescriptor

    def availability(self) -> tuple[bool, str | None]: ...

    async def start(self, task: BenchmarkTask) -> EnvironmentSession: ...

    async def capture(
        self, task: BenchmarkTask, session: EnvironmentSession
    ) -> EnvironmentOutcome: ...

    async def close(self, task: BenchmarkTask, session: EnvironmentSession) -> None: ...


class LocalEnvironment:
    """No-op environment for question/answer benchmarks."""

    descriptor = EnvironmentDescriptor(name="local", version="1", isolated=False)

    def availability(self) -> tuple[bool, str | None]:
        return True, None

    async def start(self, task: BenchmarkTask) -> EnvironmentSession:
        return EnvironmentSession()

    async def capture(
        self, task: BenchmarkTask, session: EnvironmentSession
    ) -> EnvironmentOutcome:
        return EnvironmentOutcome()

    async def close(self, task: BenchmarkTask, session: EnvironmentSession) -> None:
        return None


async def _command(*argv: str, cwd: Path | None = None) -> str:
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode:
        detail = stderr.decode(errors="replace").strip()[-4000:]
        raise RuntimeError(f"{' '.join(argv)} failed ({process.returncode}): {detail}")
    return stdout.decode(errors="replace")


class GitCheckoutEnvironment:
    """A disposable checkout at the task's exact commit; the submission is its Git patch."""

    descriptor = EnvironmentDescriptor(name="git-checkout", version="1", isolated=False)
    _locks: dict[str, asyncio.Lock] = {}

    def __init__(
        self,
        *,
        cache_dir: str | Path | None = None,
        work_dir: str | Path | None = None,
        keep: bool = False,
        repo_url_template: str = "https://github.com/{repo}.git",
    ) -> None:
        self.cache_dir = Path(cache_dir or "~/.cache/nanoagent/benchmark/repos").expanduser()
        self.work_dir = None if work_dir is None else Path(work_dir).expanduser()
        self.keep = keep
        self.repo_url_template = repo_url_template

    def availability(self) -> tuple[bool, str | None]:
        return (
            (True, None)
            if shutil.which("git")
            else (False, "Git is required for the git-checkout benchmark environment")
        )

    @staticmethod
    def _repository(task: BenchmarkTask) -> tuple[str, str]:
        repo = task.environment.config.get("repo")
        commit = task.environment.config.get("base_commit")
        if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
            raise ValueError(f"task {task.id!r} has an invalid environment repo")
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9A-Fa-f]{7,64}", commit):
            raise ValueError(f"task {task.id!r} has an invalid base_commit")
        return repo, commit

    async def start(self, task: BenchmarkTask) -> EnvironmentSession:
        repo, commit = self._repository(task)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        if self.work_dir is not None:
            self.work_dir.mkdir(parents=True, exist_ok=True)
        cache = self.cache_dir / f"{repo.replace('/', '__')}.git"
        lock = self._locks.setdefault(str(cache), asyncio.Lock())
        async with lock:
            if not cache.is_dir():
                await _command("git", "clone", "--quiet", "--mirror", self.repo_url_template.format(repo=repo), str(cache))
            try:
                await _command("git", "--git-dir", str(cache), "cat-file", "-e", f"{commit}^{{commit}}")
            except RuntimeError:
                await _command("git", "--git-dir", str(cache), "fetch", "--quiet", "origin", commit)
        safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", task.id).strip("-.")[:80] or "task"
        workspace = Path(tempfile.mkdtemp(prefix=f"nanoagent-{safe_id}-", dir=self.work_dir))
        try:
            await _command("git", "clone", "--quiet", "--shared", str(cache), str(workspace))
            await _command("git", "checkout", "--quiet", "--detach", commit, cwd=workspace)
            await _command("git", "config", "core.hooksPath", "/dev/null", cwd=workspace)
        except BaseException:
            shutil.rmtree(workspace, ignore_errors=True)
            raise
        return EnvironmentSession(
            workspace=workspace,
            metadata={"repo": repo, "base_commit": commit},
        )

    async def capture(
        self, task: BenchmarkTask, session: EnvironmentSession
    ) -> EnvironmentOutcome:
        if session.workspace is None:
            raise ValueError("git environment has no workspace")
        await _command("git", "add", "-A", cwd=session.workspace)
        patch = await _command(
            "git", "diff", "--cached", "--binary", "--full-index", cwd=session.workspace
        )
        return EnvironmentOutcome(
            submission=patch,
            metadata={**session.metadata, "patch_bytes": len(patch.encode())},
        )

    async def close(self, task: BenchmarkTask, session: EnvironmentSession) -> None:
        if session.workspace is not None and not self.keep:
            shutil.rmtree(session.workspace, ignore_errors=True)
