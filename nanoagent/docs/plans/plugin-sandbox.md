# Plugin sandbox on the server

## Why it is needed

Anyone signed in to RUSH can publish a plugin to the marketplace, and NanoAgent runs every
plugin a workspace adds. Unconfined, a plugin's process can read NanoAgent's secrets
(`OPENROUTER_API_KEY`, `NANOAGENT_API_TOKEN`, through its environment or `/proc`), read and write
any file the server can, and reach any host, the private Railway network included.

## Where it stands

- `nanoagent.plugin.sandbox` launches every plugin process (the MCP server, the
  verifier, the `uv sync` that installs it) through one wrapper, `launch`.
- `sandbox: bwrap` confines it with bubblewrap: new namespaces, an empty environment, its own
  folder read-only, only the run's workspace to write, and no network but the egress proxy
  (`nanoagent.plugin.egress`), which reaches only the hosts the plugin declares, over HTTPS, at
  public addresses. `sandbox.check` proves this before the server serves anything. Its tests pass
  on Ubuntu (`test/test_sandbox.py`).
- **Production runs `sandbox: none`.** Inside a container bubblewrap cannot make namespaces:
  Docker's default seccomp profile allows `unshare`/`clone(CLONE_NEWUSER)` only with
  `CAP_SYS_ADMIN`, and Railway allows no privileged containers
  (station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b). CI's
  `docker run` of the production image failed with "No permissions to create new namespace".

Until this is done, only publish and add plugins you trust.

## What to build

Ranked, from the research on 2026-10-12:

1. **In the container, without namespaces.** Per plugin process: its own non-root UID (the
   container runs as root, so it can switch), an empty environment, `no_new_privs`, then
   - Landlock (unprivileged): read-only on its folder and the uv cache, read-write on the run's
     workspace, TCP connect only to the egress proxy's port (Landlock ABI 4, Linux 6.7+;
     it filters ports, not addresses, so the proxy listens on an unusual port);
   - seccomp-bpf: deny UDP, raw, netlink and packet sockets, `ptrace`, `unshare`, `mount`, `bpf`.

   Docker's default profile allows the `landlock_*` syscalls and `seccomp`. Railway's kernel
   version and whether it enables Landlock are not documented: first deploy a probe that logs
   `uname -r`, `/sys/kernel/security/lsm` and `landlock_create_ruleset(NULL, 0, 1)`. Add it as a
   third `sandbox` kind, proven by `sandbox.check` like bwrap. Shares the host kernel; about
   one to two days.
2. **A managed microVM per plugin session**, if the kernel cannot: Vercel Sandbox or E2B (both
   have hostname egress allowlists and Python SDKs), carrying the MCP stdio stream over their
   exec API. Strongest isolation; per-second cost, cold starts and a third-party dependency.
3. Railway Sandboxes: VMs off the private network, but no egress allowlist and no Python SDK.

Not viable on Railway: bubblewrap, nsjail and gVisor (`runsc`), which all need user namespaces
or `CAP_SYS_ADMIN`.
