"""The one place that runs the `docker` CLI: bounded capture, deadlines, and a fakeable seam."""

from __future__ import annotations

import subprocess
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

DEFAULT_CAPTURE_BYTES = 1 << 20


@dataclass(frozen=True, slots=True)
class DockerResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    timed_out: bool = False  # the CLI was killed at `timeout_s`; the container is the caller's to stop

    def text(self) -> str:
        return self.stdout.decode("utf-8", "replace").strip()

    def error_text(self) -> str:
        return self.stderr.decode("utf-8", "replace").strip()


class DockerRunner(Protocol):
    def run(
        self,
        args: Sequence[str],
        *,
        timeout_s: float | None = None,
        stdin: bytes | None = None,
        capture_bytes: int = DEFAULT_CAPTURE_BYTES,
    ) -> DockerResult: ...


class CliDockerRunner:
    """Runs `docker <args>`. Output past `capture_bytes` per stream is read and discarded, never buffered."""

    def __init__(self, docker: str = "docker") -> None:
        self._docker = docker

    def run(
        self,
        args: Sequence[str],
        *,
        timeout_s: float | None = None,
        stdin: bytes | None = None,
        capture_bytes: int = DEFAULT_CAPTURE_BYTES,
    ) -> DockerResult:
        process = subprocess.Popen(
            [self._docker, *args],
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        captured: list[tuple[bytearray, list[bool]]] = [(bytearray(), [False]), (bytearray(), [False])]

        def drain(stream, buffer: bytearray, truncated: list[bool]) -> None:
            while chunk := stream.read(1 << 16):
                room = capture_bytes - len(buffer)
                if room > 0:
                    buffer += chunk[:room]
                if len(chunk) > room:
                    truncated[0] = True

        readers = [
            threading.Thread(target=drain, args=(stream, *captured[i]), daemon=True)
            for i, stream in enumerate((process.stdout, process.stderr))
        ]
        for reader in readers:
            reader.start()
        if stdin is not None:
            writer = threading.Thread(target=self._feed, args=(process, stdin), daemon=True)
            writer.start()
        timed_out = False
        try:
            process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            process.wait()
        for reader in readers:
            reader.join()
        return DockerResult(
            process.returncode,
            bytes(captured[0][0]),
            bytes(captured[1][0]),
            captured[0][1][0],
            captured[1][1][0],
            timed_out,
        )

    @staticmethod
    def _feed(process: subprocess.Popen[bytes], data: bytes) -> None:
        try:
            process.stdin.write(data)  # type: ignore[union-attr]
            process.stdin.close()  # type: ignore[union-attr]
        except OSError:
            pass  # the CLI exited early; its exit status reports why
