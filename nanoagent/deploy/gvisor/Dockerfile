# The benchmark worker's golden image: a privileged container that runs its own dockerd with the `runsc-rush` runtime
# (gVisor + the collector socket), the egress packet filter, and the NanoAgent uploaded-harness worker.
# Build context is the nanoagent/ folder:
#   docker buildx build -f deploy/gvisor/Dockerfile -t rush-benchmark-worker:dev .
FROM ubuntu:26.04

# Must match the release in src/nanoagent/uploaded/seccheck/proto/GVISOR_COMMIT (checked below).
ARG GVISOR_RELEASE=20260914
ARG UV_VERSION=0.10.9
# The Python NanoAgent ships on (nanoagent-ci.yml, Dockerfile); uv installs it, not apt.
ARG PYTHON_VERSION=3.12

LABEL org.opencontainers.image.source=https://github.com/RUSH-LAB/nanoagent

# Every external binary the worker, its entrypoint and the gVisor tests call:
#   docker.io (dockerd, docker CLI), iptables (egress.sh, the tests), iproute2 (`ip` in the tests), bubblewrap (plugin
#   verifier sandbox), git (uv resolves git-sourced dependencies), sudo (egress.sh / iptables from the worker user),
#   curl + gnupg + ca-certificates (gVisor apt repo, uv installer), util-linux (runuser, flock) and findutils (xargs) come
#   with the base image but are named here so nothing relies on that.
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends \
      docker.io iptables iproute2 bubblewrap git sudo curl gnupg ca-certificates util-linux findutils \
 && rm -rf /var/lib/apt/lists/*

COPY src/nanoagent/uploaded/seccheck/proto/GVISOR_COMMIT /tmp/GVISOR_COMMIT
RUN grep -q "^tag: release-$GVISOR_RELEASE\." /tmp/GVISOR_COMMIT \
 && rm /tmp/GVISOR_COMMIT \
 && curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases $GVISOR_RELEASE main" \
    > /etc/apt/sources.list.d/gvisor.list \
 && apt-get update -q && apt-get install -y -q --no-install-recommends runsc \
 && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# The worker's user: in the docker group, with passwordless sudo (the worker and the tests call egress.sh and iptables).
RUN useradd -m rush && usermod -aG docker rush \
 && echo 'rush ALL=(root) NOPASSWD: ALL' > /etc/sudoers.d/rush \
 && mkdir -p /var/lib/rush-worker && chown rush:rush /var/lib/rush-worker

# uv's Python and caches live where the rush user can read them; the cache sits under the worker home (a volume).
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PROJECT_ENVIRONMENT=/opt/nanoagent/venv \
    UV_CACHE_DIR=/home/rush/rush-worker/uv-cache \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    RUSH_WORKER_HOME=/home/rush/rush-worker \
    PATH=/opt/nanoagent/venv/bin:$PATH

WORKDIR /opt/nanoagent
# The dependency layer: only the lock and the project file, so it caches across source changes.
COPY pyproject.toml uv.lock README.md LICENSE ./
# Built as root with a throwaway cache: a cache under the worker's home would be root's, which the worker (rush) cannot use.
RUN UV_CACHE_DIR=/tmp/uv-cache uv python install "$PYTHON_VERSION" \
 && UV_CACHE_DIR=/tmp/uv-cache uv sync --frozen --no-install-project --extra web --extra dev --python "$PYTHON_VERSION" \
 && rm -rf /tmp/uv-cache

COPY src ./src
COPY deploy/gvisor ./deploy/gvisor
COPY test ./test
# Plugin helpers run as `python -I -m nanoagent`, which ignores PYTHONPATH: a .pth file makes the source importable there too.
RUN python -c "import site, pathlib; pathlib.Path(site.getsitepackages()[0], 'nanoagent-src.pth').write_text('/opt/nanoagent/src' + chr(10))" \
 && chmod 0755 deploy/gvisor/container-entrypoint.sh

# The inner image cache and the worker's caches survive restarts when these are volumes.
VOLUME ["/var/lib/docker", "/home/rush/rush-worker"]

# Run with --privileged --cgroupns=private --init (dockerd, gVisor and the packet filter need it; --init reaps shims).
ENTRYPOINT ["/opt/nanoagent/deploy/gvisor/container-entrypoint.sh"]
# No command: the worker. Any other command (e.g. `pytest ...`) runs instead, as the rush user, once dockerd is up.
CMD []
