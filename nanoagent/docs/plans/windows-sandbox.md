# Plugin sandbox on Windows

## Why it is needed

`nanoagent.plugin.sandbox` confines every plugin process with `bwrap` (Linux) or `seatbelt`
(macOS). Windows has neither, so RUSH Lab's desktop app and `lab.mjs` refuse to start there.
`sandbox: none` is not an answer: a plugin is code anyone published.

## The sandbox: `appcontainer`

A Windows AppContainer is the kernel's own confinement for unprivileged processes. It needs no
administrator rights to create or to use. A process in one has a token that reaches only what an
ACL names for its package SID (or for `ALL APPLICATION PACKAGES`), no network, no other
process's memory or environment, and no registry beyond its own.

Spiked on Windows 11 (2026-10-16), launched through `CreateProcessW` with
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`:

- no network at all, and not the host's loopback either (that needs an administrator's
  `CheckNetIsolation LoopbackExempt`, which this design does not use);
- a process inside can use loopback among its own processes;
- files: only what was granted; a folder with a read ACE could not be written;
- the environment is only what the launcher passes, but the launch fails unless `APPDATA` or
  `LOCALAPPDATA` is in it, so both point at the run's own home folder.

## How it is built

`sandbox.launch` returns `(argv, env)` as it does for bwrap:

1. The host makes a package SID for this launch (`CreateAppContainerProfile`, deleted after).
2. It grants that SID write access to the run's `writable` folders and its home folder with
   `icacls`. The plugin's folder, the Python plugins run on and NanoAgent's code are granted once
   to `ALL APPLICATION PACKAGES` (read and execute), because a SID per launch would otherwise
   re-grant a whole Python installation every time. The grants stay on disk; they are for code,
   not for any run's files.
3. It serves the egress proxy on a loopback port of the host (`egress_port`, as for seatbelt),
   and a **named pipe** whose DACL allows only this launch's SID. Each pipe connection is passed
   to the proxy port.
4. `argv` is `nanoagent helper appcontainer`: outside the container it creates the process in
   the container (`CreateProcessW`), inside a job object that kills the tree when the helper
   dies (bwrap's `--die-with-parent`), and passes it only its standard streams
   (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`). The command it runs is `nanoagent helper egress-bridge`,
   which listens on an ephemeral loopback port inside the container, passes each connection to
   the pipe, sets `HTTPS_PROXY` to that port and runs the plugin's command. The environment the
   plugin gets travels in one variable of the helper's own environment, never on a command line.

`sandbox.check` proves it before a host serves anything, as for the other kinds.

## What else Windows needs

- A plugin has no shell script: its `run.sh` is gone from the contract. NanoAgent checks, in
  Python, that `uv` is installed, that every `.env` name is set, and that `uv.lock` matches
  `pyproject.toml` (`nanoagent.plugin.runtime.preflight`). Git's MSYS bash cannot start in an
  AppContainer, and busybox's `ash` is not bash, so no plugin may depend on a shell.
- `lab.mjs` and the desktop shell stop processes without POSIX signals, and use
  `%LOCALAPPDATA%` for data.
- The Windows bundle target is `x86_64-pc-windows-msvc`.
