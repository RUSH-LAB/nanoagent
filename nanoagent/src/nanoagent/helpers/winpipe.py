"""Windows named pipes with overlapped I/O, so one thread can read a pipe while another writes it.

A pipe handle opened without ``FILE_FLAG_OVERLAPPED`` serialises its reads and writes, and a pass-through
between a socket and a pipe would deadlock. Standard library only: it runs inside the sandbox.
"""

from __future__ import annotations

import ctypes
import threading
import time
from ctypes import wintypes as wt
from collections.abc import Callable

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
advapi = ctypes.WinDLL("advapi32", use_last_error=True)

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
PIPE_ACCESS_DUPLEX = 3
PIPE_TYPE_BYTE_WAIT_REJECT_REMOTE = 0x8
PIPE_UNLIMITED_INSTANCES = 255
ERROR_IO_PENDING = 997
ERROR_PIPE_CONNECTED = 535
ERROR_PIPE_BUSY = 231
ERROR_BROKEN_PIPE = 109
ERROR_OPERATION_ABORTED = 995
INFINITE = 0xFFFFFFFF
WAIT_OBJECT_0 = 0
INVALID_HANDLE = wt.HANDLE(-1).value
BUFFER = 65536


class OVERLAPPED(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_void_p), ("InternalHigh", ctypes.c_void_p), ("Offset", wt.DWORD),
                ("OffsetHigh", wt.DWORD), ("hEvent", wt.HANDLE)]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("nLength", wt.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p), ("bInheritHandle", wt.BOOL)]


kernel.CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p, wt.DWORD, wt.DWORD, wt.HANDLE]
kernel.CreateFileW.restype = wt.HANDLE
kernel.CreateNamedPipeW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, wt.DWORD, wt.DWORD, wt.DWORD, wt.DWORD, ctypes.c_void_p]
kernel.CreateNamedPipeW.restype = wt.HANDLE
kernel.CreateEventW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.BOOL, wt.LPCWSTR]
kernel.CreateEventW.restype = wt.HANDLE
kernel.ReadFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p, ctypes.c_void_p]
kernel.WriteFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p, ctypes.c_void_p]
kernel.ConnectNamedPipe.argtypes = [wt.HANDLE, ctypes.c_void_p]
kernel.GetOverlappedResult.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wt.BOOL]
kernel.WaitForMultipleObjects.argtypes = [wt.DWORD, ctypes.c_void_p, wt.BOOL, wt.DWORD]
kernel.CancelIoEx.argtypes = [wt.HANDLE, ctypes.c_void_p]
kernel.CloseHandle.argtypes = [wt.HANDLE]
kernel.SetEvent.argtypes = [wt.HANDLE]
kernel.WaitNamedPipeW.argtypes = [wt.LPCWSTR, wt.DWORD]
kernel.LocalFree.argtypes = [ctypes.c_void_p]
advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wt.LPCWSTR, wt.DWORD, ctypes.c_void_p, ctypes.c_void_p]


class Pipe:
    """One end of a connected named pipe; ``read`` and ``write`` may run in different threads."""

    def __init__(self, handle: int) -> None:
        self._handle = handle
        self._closed = False

    def read(self, size: int = BUFFER) -> bytes:
        """Up to ``size`` bytes, or ``b""`` once the other end has closed."""
        buffer = ctypes.create_string_buffer(size)
        done = self._wait(lambda overlapped, count: kernel.ReadFile(self._handle, buffer, size, None, overlapped))
        return buffer.raw[:done]

    def write(self, data: bytes) -> None:
        view = memoryview(data)
        while view:
            chunk = ctypes.create_string_buffer(bytes(view[:BUFFER]))
            length = min(len(view), BUFFER)
            done = self._wait(lambda overlapped, count: kernel.WriteFile(self._handle, chunk, length, None, overlapped))
            if done == 0:
                raise BrokenPipeError("the pipe closed")
            view = view[done:]

    def _wait(self, start: Callable[[ctypes.c_void_p, int], int]) -> int:
        event = kernel.CreateEventW(None, True, False, None)
        overlapped = OVERLAPPED()
        overlapped.hEvent = event
        try:
            if not start(ctypes.byref(overlapped), 0):
                error = ctypes.get_last_error()
                if error in (ERROR_BROKEN_PIPE, ERROR_OPERATION_ABORTED):
                    return 0
                if error != ERROR_IO_PENDING:
                    raise ctypes.WinError(error)
            count = wt.DWORD()
            if not kernel.GetOverlappedResult(self._handle, ctypes.byref(overlapped), ctypes.byref(count), True):
                error = ctypes.get_last_error()
                if error in (ERROR_BROKEN_PIPE, ERROR_OPERATION_ABORTED):
                    return 0
                raise ctypes.WinError(error)
            return count.value
        finally:
            kernel.CloseHandle(event)

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            kernel.CancelIoEx(self._handle, None)
            kernel.CloseHandle(self._handle)


def connect(name: str, timeout: float = 10.0) -> Pipe:
    """Open the named pipe ``name`` (``\\\\.\\pipe\\...``), waiting up to ``timeout`` seconds while it is busy."""
    deadline = time.monotonic() + timeout
    while True:
        handle = kernel.CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
        if handle != INVALID_HANDLE:
            return Pipe(handle)
        error = ctypes.get_last_error()
        if error != ERROR_PIPE_BUSY or time.monotonic() > deadline:
            raise ctypes.WinError(error)
        kernel.WaitNamedPipeW(name, 500)


class Server:
    """Serves connections to ``name`` to ``handle`` (one thread each) while open.

    ``sddl`` is the pipe's DACL: who may connect. The first instance is created with
    ``FILE_FLAG_FIRST_PIPE_INSTANCE``, so another process cannot already own the name.
    """

    def __init__(self, name: str, sddl: str, handle: Callable[[Pipe], None]) -> None:
        self._name = name
        self._handle = handle
        self._stop = kernel.CreateEventW(None, True, False, None)
        descriptor = ctypes.c_void_p()
        if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        self._descriptor = descriptor
        self._attributes = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), descriptor, False)
        self._first = self._instance(first=True)
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def _instance(self, *, first: bool = False) -> int:
        flags = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (FILE_FLAG_FIRST_PIPE_INSTANCE if first else 0)
        handle = kernel.CreateNamedPipeW(self._name, flags, PIPE_TYPE_BYTE_WAIT_REJECT_REMOTE, PIPE_UNLIMITED_INSTANCES,
                                         BUFFER, BUFFER, 0, ctypes.byref(self._attributes))
        if handle == INVALID_HANDLE:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    def _accept(self) -> None:
        handle: int | None = self._first
        while True:
            if handle is None:
                try:
                    handle = self._instance()
                except OSError:
                    return
            event = kernel.CreateEventW(None, True, False, None)
            overlapped = OVERLAPPED()
            overlapped.hEvent = event
            connected = kernel.ConnectNamedPipe(handle, ctypes.byref(overlapped))
            error = 0 if connected else ctypes.get_last_error()
            if not connected and error == ERROR_IO_PENDING:
                waits = (wt.HANDLE * 2)(event, self._stop)
                if kernel.WaitForMultipleObjects(2, waits, False, INFINITE) != WAIT_OBJECT_0:
                    kernel.CancelIoEx(handle, None)
                    kernel.CloseHandle(event)
                    kernel.CloseHandle(handle)
                    return
            elif not connected and error != ERROR_PIPE_CONNECTED:
                kernel.CloseHandle(event)
                kernel.CloseHandle(handle)
                handle = None
                continue
            kernel.CloseHandle(event)
            threading.Thread(target=self._serve, args=(Pipe(handle),), daemon=True).start()
            handle = None

    def _serve(self, pipe: Pipe) -> None:
        try:
            self._handle(pipe)
        finally:
            pipe.close()

    def close(self) -> None:
        kernel.SetEvent(self._stop)
        self._thread.join(timeout=5)
        kernel.CloseHandle(self._stop)
        kernel.LocalFree(self._descriptor)
