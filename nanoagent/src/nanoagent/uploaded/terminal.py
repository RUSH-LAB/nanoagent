"""The harness's terminals, between it and the member at a page on this computer: what each one's process writes to its PTY goes to
the page as it comes, over the session's local link, and to RUSH, which keeps it; what the member types at one (or a new size of
it, or that they opened or closed it) comes back over the link to its PTY. RUSH is on neither way of the link.

Terminal 0 is the harness's own; a free-form session's member opens more (1, 2, ...) in the same case (`CaseHandle.open_terminal`).
The case's sandbox hands each chunk of output to :meth:`Terminal.write` from its own thread; :meth:`Terminal.pump` sends what has
come to RUSH every :data:`SEND_S` until it is cancelled, and :meth:`Terminal.flush` sends the rest, then that each terminal that ended
did. What passes ``limit_bytes``, all terminals together, is kept from both: a last line in each says so instead.

:meth:`Terminal.serve` is the link: a TCP listener on 127.0.0.1 that RUSH Lab connects to for the page (RUSH tells the page its port
and :attr:`Terminal.token`, and only the session's member). Each side sends one JSON object a line. The link's first line is
``{"token"}``; then the page sends ``{"terminal", "data"}`` (base64 keystrokes), ``{"terminal", "rows", "cols"}`` (a size, which opens
a terminal not yet open), ``{"terminal", "close": true}``, ``{"reopen", "rows", "cols"}`` (a chat clicked on the Dashboard, or an
agent's CLI started, which opens in the next terminal of a free-form session: :meth:`Terminal._reopen`) or ``{"open": true, "rows",
"cols"}`` (a shell in the next terminal of a free-form session, whose id only this link is told, ``{"opened"}``, before its output:
``nanoagent harness`` joining a live session), and hears ``{"terminal", "data"}`` (everything that terminal wrote, from its first
byte, then as it comes) and ``{"terminal", "closed": true}`` once it ended, after its output. A link that sends anything else is
closed, with ``{"error"}`` why.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import re
import secrets
import threading
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any

import anyio
from anyio.abc import SocketAttribute, SocketStream
from anyio.streams.buffered import BufferedByteReceiveStream

from nanoagent.uploaded.resume import reopen_in, start_cli
from nanoagent.uploaded.rush_worker import ResumeOf, RushWorkerClient, chat_of

SEND_S = 0.05
MAX_SEND_BYTES = 256 * 1024  # one request's or link line's bytes of output at most
# What one attempt's terminals send at most, with room for the notes that they were cut (32 at most): RUSH keeps 4 MiB of it.
LIMIT_BYTES = 4 * 1024 * 1024 - 4096
MAX_TERMINALS = 32  # a free-form session's: ids 0 to 31
MAX_LINE = 1 << 20  # one line the page sends: a paste is 40 000 characters at most, as base64
CLOSE_S = 1.0  # how long a closing link has to send what is left
# What a reopened chat names, as RUSH checks them: the kept session's attempt id, its agent's CLI command and its conversation id.
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
CLI = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
CONVERSATION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}")


class LinkRefused(Exception):
    """What the page sent the link that it does not take."""


def _reply(replies: list[dict[str, Any]], wake: asyncio.Event, line: dict[str, Any]) -> None:
    """Tells one link ``line``, before the output it sends next."""
    replies.append(line)
    wake.set()


def _size(rows: object, cols: object) -> None:
    if not all(type(n) is int and 1 <= n <= 1000 for n in (rows, cols)):
        raise LinkRefused("a size is rows and cols, each 1 to 1000")


def _run(run: object) -> bool:
    """Whether ``run`` is a chat's run of a program: ``{argv, cwd}``, its command line (strings, at least one) and its folder or None."""
    return isinstance(run, dict) and set(run) == {"argv", "cwd"} and isinstance(run["argv"], list) and bool(run["argv"]) \
        and all(isinstance(arg, str) for arg in run["argv"]) and (run["cwd"] is None or isinstance(run["cwd"], str))  # fmt: skip


class Terminal:
    def __init__(
        self, worker: RushWorkerClient, attempt_id: str, fence: int, *, terminals: int = 1, scratch: Path | None = None, limit_bytes: int = LIMIT_BYTES
    ) -> None:
        self._worker = worker
        self._attempt_id = attempt_id
        self._fence = fence
        self._terminals = terminals  # the ids the member may use: 0 alone, or all a free-form session opens
        self._scratch = scratch  # a free-form session's: where this computer keeps ended sessions, whose chats it reopens (resume)
        self._limit = limit_bytes
        self.token = secrets.token_urlsafe(32)
        self._loop = asyncio.get_running_loop()
        self._lock = threading.Lock()
        self._pending: dict[int, bytearray] = {}  # what RUSH has yet to get
        self._screens: dict[int, bytearray] = {}  # everything each terminal wrote, which a link sends from its first byte
        self._taken = 0  # bytes accepted, at most the limit
        self._cut: set[int] = set()
        self._sent: dict[int, int] = {}
        self._opened = {0}
        self._closed: set[int] = set()  # the terminals RUSH was told ended
        self._failed: set[int] = set()  # the terminals that could not open
        self._sending = anyio.Lock()
        self._links: set[asyncio.Event] = set()  # each open link's wake-up
        self._ended = False

    def write(self, terminal: int, data: bytes) -> None:
        with self._lock:
            room = self._limit - self._taken
            if terminal in self._cut:
                return
            if len(data) > room:
                self._cut.add(terminal)
                data = (
                    data[: max(room, 0)]
                    + f"\r\n\x1b[0m[RUSH: the terminals' output passed its {self._limit} byte bound; the rest is not shown]\r\n".encode()
                )
                self._taken = self._limit
            else:
                self._taken += len(data)
            self._pending.setdefault(terminal, bytearray()).extend(data)
            self._screens.setdefault(terminal, bytearray()).extend(data)
        self._loop.call_soon_threadsafe(self._wake)

    def _wake(self) -> None:
        for wake in self._links:
            wake.set()

    async def flush(self, case: Any) -> None:
        """Sends RUSH what every terminal wrote, then that each terminal of ``case`` (a `CaseHandle`) that ended did, after its output."""
        async with self._sending:
            ended = case.ended_terminals() | self._failed  # before the output: a terminal writes nothing after it ended
            for terminal in list(self._pending):
                while True:
                    with self._lock:
                        chunk = bytes(self._pending[terminal][:MAX_SEND_BYTES])
                    if not chunk:
                        break
                    sent = self._sent.get(terminal, 0)
                    await self._worker.terminal(self._attempt_id, self._fence, terminal, sent, chunk)
                    with self._lock:
                        del self._pending[terminal][: len(chunk)]
                    self._sent[terminal] = sent + len(chunk)
            for terminal in sorted(ended - self._closed):
                await self._worker.terminal_closed(self._attempt_id, self._fence, terminal)
                self._closed.add(terminal)

    async def pump(self, case: Any) -> None:
        while True:
            await anyio.sleep(SEND_S)
            await self.flush(case)

    async def serve(self, case: Any, *, task_status: anyio.abc.TaskStatus[int] = anyio.TASK_STATUS_IGNORED) -> None:
        """The session's link to the page, for ``case`` (a `CaseHandle`), until cancelled: its port is the task's start value."""
        listener = await anyio.create_tcp_listener(local_host="127.0.0.1", local_port=0)
        async with listener:
            task_status.started(listener.extra(SocketAttribute.local_port))
            await listener.serve(partial(self._link, case))

    async def close(self) -> None:
        """Ends every link once it has sent what is left: the session is over."""
        self._ended = True
        self._wake()
        with anyio.move_on_after(CLOSE_S):
            while self._links:
                await anyio.sleep(0.01)

    async def _link(self, case: Any, stream: SocketStream) -> None:
        wake = asyncio.Event()
        lines = BufferedByteReceiveStream(stream)
        refused: list[LinkRefused] = []
        async with stream:
            try:
                hello = await self._read(lines)
                if not secrets.compare_digest(str(hello.get("token", "")).encode(), self.token.encode()):
                    raise LinkRefused("the link's token is not this session's")
            except LinkRefused as error:
                refused.append(error)
            except anyio.EndOfStream:
                return
            if not refused:
                self._links.add(wake)
                try:
                    replies: list[dict[str, Any]] = []  # what only this link is told
                    async with anyio.create_task_group() as group:
                        group.start_soon(self._receive, case, lines, group.cancel_scope, refused, partial(_reply, replies, wake))
                        await self._send(case, stream, wake, replies)
                        group.cancel_scope.cancel()
                finally:
                    self._links.discard(wake)
            if refused:
                with anyio.move_on_after(CLOSE_S), contextlib.suppress(anyio.BrokenResourceError, anyio.ClosedResourceError):
                    await stream.send(json.dumps({"error": str(refused[0])}).encode() + b"\n")

    async def _read(self, lines: BufferedByteReceiveStream) -> dict[str, Any]:
        try:
            line = await lines.receive_until(b"\n", MAX_LINE)
        except anyio.DelimiterNotFound as error:
            raise LinkRefused(f"a line passed {MAX_LINE} bytes") from error
        except anyio.IncompleteRead as error:
            raise anyio.EndOfStream from error
        try:
            item = json.loads(line)
        except ValueError as error:
            raise LinkRefused(f"a line is not JSON: {error}") from error
        if not isinstance(item, dict):
            raise LinkRefused("a line is not a JSON object")
        return item

    async def _send(self, case: Any, stream: SocketStream, wake: asyncio.Event, replies: list[dict[str, Any]]) -> None:
        """Sends the page each terminal's output from its first byte, then as it comes, and that a terminal ended after its output;
        returns once the session is over and all of it is sent."""
        shown: dict[int, int] = {}
        told: set[int] = set()
        while True:
            wake.clear()
            ended = self._ended
            closed = case.ended_terminals() | self._failed  # before the output: a terminal writes nothing after it ended
            lines = replies[:]  # before the output: a terminal a reply names writes only after it
            del replies[:]
            with self._lock:
                for terminal, screen in self._screens.items():
                    while len(screen) > shown.get(terminal, 0):
                        start = shown.get(terminal, 0)
                        chunk = bytes(screen[start : start + MAX_SEND_BYTES])
                        lines.append({"terminal": terminal, "data": base64.b64encode(chunk).decode("ascii")})
                        shown[terminal] = start + len(chunk)
            lines += [{"terminal": terminal, "closed": True} for terminal in sorted(closed - told)]
            told |= closed
            if lines:
                try:
                    await stream.send(b"".join(json.dumps(line).encode() + b"\n" for line in lines))
                except (anyio.BrokenResourceError, anyio.ClosedResourceError):
                    return  # the page went away
            if ended:
                return
            with anyio.move_on_after(SEND_S):  # a terminal that ended says nothing: it is looked for this often
                await wake.wait()

    async def _receive(
        self, case: Any, lines: BufferedByteReceiveStream, scope: anyio.CancelScope, refused: list[LinkRefused], reply: Callable[[dict[str, Any]], None]
    ) -> None:
        """Passes what the page sends to ``case``'s terminals, in order, until it goes away or sends what the link does not take: a
        size for a terminal not yet open opens it, and one that cannot open ends with why printed in it."""
        try:
            while True:
                await self._apply(case, await self._read(lines), reply)
        except LinkRefused as error:
            refused.append(error)
        except (anyio.EndOfStream, anyio.BrokenResourceError):
            pass  # the page went away
        scope.cancel()

    async def _apply(self, case: Any, item: dict[str, Any], reply: Callable[[dict[str, Any]], None]) -> None:
        if "reopen" in item:
            await self._reopen(case, item)
            return
        if "open" in item:
            await self._open_next(case, item, reply)
            return
        terminal = item.get("terminal")
        if type(terminal) is not int or not 0 <= terminal < self._terminals:
            raise LinkRefused(f"terminal is a terminal's id, 0 to {self._terminals - 1}")
        rows, cols, data = item.get("rows"), item.get("cols"), item.get("data")
        if item.get("close") is True:
            await anyio.to_thread.run_sync(case.close_terminal, terminal)
            return
        if data is None:
            _size(rows, cols)
        else:
            try:
                data = base64.b64decode(data, validate=True)
            except (TypeError, binascii.Error) as error:
                raise LinkRefused("data is what was typed, in base64") from error
            rows = cols = None
        if terminal not in self._opened:
            if data is not None:
                return  # typed at a terminal not yet open: its size opens it
            await self._open(case, terminal, rows, cols)
            return
        await anyio.to_thread.run_sync(case.terminal_input, terminal, data, rows, cols)

    async def _open(self, case: Any, terminal: int, rows: int, cols: int, prepare: Callable[[], object] | None = None) -> None:
        """Opens ``terminal``, after ``prepare`` (what it says and runs as it starts); one that cannot open ends with why in it."""
        self._opened.add(terminal)
        try:
            if prepare is not None:
                await anyio.to_thread.run_sync(prepare)
            await anyio.to_thread.run_sync(case.open_terminal, terminal, rows, cols, partial(self.write, terminal))
        except Exception as error:  # noqa: BLE001 - it ends this terminal, with why, not the session
            self.write(terminal, f"\x1b[0m[RUSH: this terminal could not open: {type(error).__name__}: {error}]\r\n".encode())
            self._failed.add(terminal)

    async def _open_next(self, case: Any, item: dict[str, Any], reply: Callable[[dict[str, Any]], None]) -> None:
        """A shell in the next terminal of this free-form session, ``rows`` by ``cols``, whose id only the link that asked is told."""
        if set(item) != {"open", "rows", "cols"} or item["open"] is not True:
            raise LinkRefused("open is {open: true, rows, cols}")
        _size(item["rows"], item["cols"])
        if self._scratch is None:
            raise LinkRefused("only a free-form session opens a terminal this way")
        terminal = max(self._opened) + 1
        if terminal >= self._terminals:
            raise LinkRefused(f"this session opened its {self._terminals} terminals: leave the shell (exit) of one, then try again")
        reply({"opened": terminal})
        await self._open(case, terminal, item["rows"], item["cols"])

    async def _reopen(self, case: Any, item: dict[str, Any]) -> None:
        """A chat the member clicked on the Dashboard, or an agent's CLI they started, opened in a new terminal of this live session (the
        next id), ``rows`` by ``cols``: ``{"resume": attempt id, "chat": {agent, id, run}}`` reopens a chat from the session this computer
        kept (resume.reopen_in); ``{"start": agent}`` runs the agent's CLI there; ``{"start": agent, "line": why}``, a chat that cannot be
        reopened, starts its agent anew, saying why."""
        spec, rows, cols = item["reopen"], item.get("rows"), item.get("cols")
        _size(rows, cols)
        if self._scratch is None:
            raise LinkRefused("only a free-form session reopens a chat")
        if not isinstance(spec, dict):
            raise LinkRefused("reopen is {resume, chat}, {start} or {start, line}")
        chat = spec.get("chat")
        if set(spec) == {"resume", "chat"} and isinstance(spec["resume"], str) and UUID.fullmatch(spec["resume"]) and isinstance(chat, dict) \
                and set(chat) == {"agent", "id", "run"} and isinstance(chat["agent"], str) and CLI.fullmatch(chat["agent"]) \
                and ((isinstance(chat["id"], str) and CONVERSATION.fullmatch(chat["id"]) and chat["run"] is None) or (chat["id"] is None and _run(chat["run"]))):  # fmt: skip
            of = ResumeOf(spec["resume"], "", chat_of(chat))
            prepare = lambda: reopen_in(self._scratch, of, case.workspace, terminal)  # noqa: E731
        elif set(spec) in ({"start"}, {"start", "line"}) and isinstance(spec["start"], str) and CLI.fullmatch(spec["start"]) \
                and ("line" not in spec or (isinstance(spec["line"], str) and 0 < len(spec["line"]) <= 500)):  # fmt: skip
            prepare = lambda: start_cli(case.workspace, spec["start"], terminal, spec.get("line"))  # noqa: E731
        else:
            raise LinkRefused("reopen is {resume: a session's id, chat: {agent, id, run}}, {start: an agent's CLI command} or {start, line: why}")
        terminal = max(self._opened) + 1
        if terminal >= self._terminals:
            shown = self._opened - case.ended_terminals() - self._failed
            self.write(max(shown, default=0), f"\r\n\x1b[0m[RUSH: this session opened its {self._terminals} terminals: leave its shell (exit), then click the session again]\r\n".encode())
            return
        await self._open(case, terminal, rows, cols, prepare)
