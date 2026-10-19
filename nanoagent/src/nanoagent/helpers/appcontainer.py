"""Windows: ``nanoagent helper appcontainer <name> <folder> -- <command...>``.

Runs the command in the AppContainer ``<name>`` (nanoagent.plugin.sandbox, ``appcontainer``):
a process with no network, no registry beyond its own and no files but those an ACL names for the
container's package SID. It runs in a job object that ends it when this process does, and gets
only this process's standard streams. Its environment is the JSON in ``NANOAGENT_APPCONTAINER_ENV``,
which is removed from this process's own. The exit status is the command's. Standard library only.
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
from ctypes import wintypes as wt
from pathlib import Path

ENV = "NANOAGENT_APPCONTAINER_ENV"
ALL_APPLICATION_PACKAGES = "S-1-15-2-1"
ALREADY_EXISTS = 0x800700B7

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
advapi = ctypes.WinDLL("advapi32", use_last_error=True)
userenv = ctypes.WinDLL("userenv", use_last_error=True)

PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
CREATE_SUSPENDED = 0x4
CREATE_UNICODE_ENVIRONMENT = 0x400
EXTENDED_STARTUPINFO_PRESENT = 0x80000
CREATE_NO_WINDOW = 0x08000000
STARTF_USESTDHANDLES = 0x100
HANDLE_FLAG_INHERIT = 1
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JobObjectExtendedLimitInformation = 9
INFINITE = 0xFFFFFFFF
STD_HANDLES = (-10, -11, -12)


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [("AppContainerSid", ctypes.c_void_p), ("Capabilities", ctypes.c_void_p),
                ("CapabilityCount", wt.DWORD), ("Reserved", wt.DWORD)]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR), ("lpTitle", wt.LPWSTR),
                ("dwX", wt.DWORD), ("dwY", wt.DWORD), ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD),
                ("dwXCountChars", wt.DWORD), ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD),
                ("dwFlags", wt.DWORD), ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE),
                ("hStdError", wt.HANDLE)]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE), ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wt.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wt.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wt.DWORD), ("SchedulingClass", wt.DWORD)]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


kernel.GetStdHandle.restype = wt.HANDLE
kernel.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wt.BOOL, wt.DWORD,
                                  ctypes.c_void_p, wt.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p]
kernel.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wt.DWORD, wt.DWORD, ctypes.c_void_p]
kernel.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wt.DWORD, ctypes.c_size_t, ctypes.c_void_p,
                                             ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
kernel.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wt.LPCWSTR]
kernel.CreateJobObjectW.restype = wt.HANDLE
kernel.SetInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
kernel.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
kernel.ResumeThread.argtypes = [wt.HANDLE]
kernel.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
kernel.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.c_void_p]
kernel.SetHandleInformation.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD]
kernel.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
kernel.CloseHandle.argtypes = [wt.HANDLE]
kernel.LocalFree.argtypes = [ctypes.c_void_p]
advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
userenv.CreateAppContainerProfile.restype = ctypes.c_long
userenv.CreateAppContainerProfile.argtypes = [wt.LPCWSTR, wt.LPCWSTR, wt.LPCWSTR, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p]
userenv.DeriveAppContainerSidFromAppContainerName.restype = ctypes.c_long
userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [wt.LPCWSTR, ctypes.c_void_p]
userenv.DeleteAppContainerProfile.restype = ctypes.c_long
userenv.DeleteAppContainerProfile.argtypes = [wt.LPCWSTR]


def _sid(name: str) -> ctypes.c_void_p:
    sid = ctypes.c_void_p()
    hr = userenv.DeriveAppContainerSidFromAppContainerName(name, ctypes.byref(sid))
    if hr != 0:
        raise OSError(f"no AppContainer {name!r}: {hr & 0xFFFFFFFF:#x}")
    return sid


def sid_string(sid: ctypes.c_void_p) -> str:
    text = wt.LPWSTR()
    if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return text.value
    finally:
        kernel.LocalFree(text)


def create(name: str) -> str:
    """Make the AppContainer ``name`` (new: raises if it exists); its package SID as text."""
    sid = ctypes.c_void_p()
    hr = userenv.CreateAppContainerProfile(name, name, name, None, 0, ctypes.byref(sid))
    if hr != 0:
        raise OSError(f"could not make AppContainer {name!r}: {hr & 0xFFFFFFFF:#x}")
    return sid_string(sid)


def delete(name: str) -> None:
    userenv.DeleteAppContainerProfile(name)


def homes() -> Path:
    """The folder the containers' homes are made in, directly under the system drive's root, for this user.

    A container may not read the attributes of any folder outside Windows and Program Files, and
    git, which uv runs to build a git dependency, looks at every folder on the way to a folder it
    creates, ``C:\\Users`` included, which only an administrator can change. A home that is the
    only folder on its path, besides this one, is the only place git can work in. This folder
    belongs to this user alone; the containers may only look at it, and each home grants its own
    container what it writes.
    """
    user = os.environ["USERNAME"]
    root = Path(os.environ["SystemDrive"] + "\\") / f"nanoagent-sandbox-{user}"
    if root.is_dir():
        return root
    root.mkdir()
    grants = [f"{os.environ['USERDOMAIN']}\\{user}:(OI)(CI)(F)", "*S-1-5-18:(OI)(CI)(F)", f"*{ALL_APPLICATION_PACKAGES}:(RA)"]
    completed = subprocess.run(["icacls", str(root), "/inheritance:r", "/grant:r", *grants, "/Q"], capture_output=True, text=True, check=False)
    if completed.returncode:
        shutil.rmtree(root)
        raise OSError(f"could not set who may use {root}: {(completed.stderr or completed.stdout).strip()}")
    return root


def grant(path: Path, sid: str, *, write: bool = False) -> None:
    """Let the package ``sid`` read and run ``path`` and everything under it, or also change it."""
    right = "F" if write else "RX"
    spec = f"(OI)(CI)({right})" if path.is_dir() else f"({right})"
    completed = subprocess.run(["icacls", str(path), "/grant", f"*{sid}:{spec}", "/Q"], capture_output=True, text=True, check=False)
    if completed.returncode:
        raise OSError(f"could not grant {sid} access to {path}: {(completed.stderr or completed.stdout).strip()}")


def revoke(path: Path, sid: str) -> None:
    subprocess.run(["icacls", str(path), "/remove:g", f"*{sid}", "/Q"], capture_output=True, check=False)


def granted(path: Path, sid: str) -> bool:
    completed = subprocess.run(["icacls", str(path)], capture_output=True, text=True, check=False)
    return completed.returncode == 0 and sid in completed.stdout


def _environment_block(env: dict[str, str]) -> ctypes.Array:
    # Sorted case-insensitively, as CreateProcess expects, and double-NUL terminated.
    block = "".join(f"{key}={value}\0" for key, value in sorted(env.items(), key=lambda item: item[0].upper())) + "\0"
    buffer = (ctypes.c_wchar * (len(block) + 1))()
    buffer[: len(block)] = block
    return buffer


def run(name: str, folder: str, command: list[str], env: dict[str, str]) -> int:
    """Run ``command`` in the AppContainer ``name`` with ``folder`` as its working folder; its exit status."""
    program = shutil.which(command[0], path=env.get("PATH"))
    if program is None:
        raise FileNotFoundError(f"{command[0]!r} is not on the sandbox's PATH ({env.get('PATH')})")
    sid = _sid(name)
    capabilities = SECURITY_CAPABILITIES(sid, None, 0, 0)
    std = [kernel.GetStdHandle(code) for code in STD_HANDLES]
    inherited = list(dict.fromkeys(handle for handle in std if handle not in (None, wt.HANDLE(-1).value)))
    for handle in inherited:
        kernel.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
    handles = (wt.HANDLE * max(len(inherited), 1))(*inherited)

    size = ctypes.c_size_t()
    kernel.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
    attributes = ctypes.create_string_buffer(size.value)
    if not kernel.InitializeProcThreadAttributeList(attributes, 2, 0, ctypes.byref(size)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                                ctypes.byref(capabilities), ctypes.sizeof(capabilities), None, None):
            raise ctypes.WinError(ctypes.get_last_error())
        if inherited and not kernel.UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles,
                                                              ctypes.sizeof(wt.HANDLE) * len(inherited), None, None):
            raise ctypes.WinError(ctypes.get_last_error())
        info = STARTUPINFOEXW()
        info.StartupInfo.cb = ctypes.sizeof(info)
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES
        info.StartupInfo.hStdInput, info.StartupInfo.hStdOutput, info.StartupInfo.hStdError = std
        info.lpAttributeList = ctypes.addressof(attributes)

        job = kernel.CreateJobObjectW(None, None)
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())

        process = PROCESS_INFORMATION()
        line = subprocess.list2cmdline([program, *command[1:]])
        flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
        if not kernel.CreateProcessW(None, ctypes.create_unicode_buffer(line), None, None, True, flags,
                                     _environment_block(env), folder, ctypes.byref(info), ctypes.byref(process)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, process.hProcess):
            error = ctypes.get_last_error()
            kernel.TerminateProcess(process.hProcess, 1)
            raise ctypes.WinError(error)
        kernel.ResumeThread(process.hThread)
        kernel.CloseHandle(process.hThread)
        kernel.WaitForSingleObject(process.hProcess, INFINITE)
        status = wt.DWORD()
        kernel.GetExitCodeProcess(process.hProcess, ctypes.byref(status))
        kernel.CloseHandle(process.hProcess)
        kernel.CloseHandle(job)
        return status.value
    finally:
        kernel.DeleteProcThreadAttributeList(attributes)


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[2] != "--":
        raise SystemExit("usage: nanoagent helper appcontainer <name> <folder> -- <command...>")
    env = json.loads(os.environ.pop(ENV))
    return run(argv[0], argv[1], argv[3:], env) & 0xFFFFFFFF


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
