FROM node:22-bookworm-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.22 /uv /uvx /bin/

# uv fetches git-sourced dependencies (slimconfig) with the git executable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates bubblewrap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python

COPY pyproject.toml README.md LICENSE ./
COPY src ./src

RUN uv python install 3.12 \
    && uv sync --python 3.12 --extra web --no-dev

COPY js/pi-runner/package.json js/pi-runner/package-lock.json ./js/pi-runner/
RUN cd js/pi-runner && npm ci --include=dev --ignore-scripts

COPY js/pi-runner ./js/pi-runner
RUN cd js/pi-runner \
    && npm run build \
    && npm prune --omit=dev

COPY deploy ./deploy

ENV PATH="/app/.venv/bin:${PATH}"
ENV PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:' + __import__('os').environ.get('PORT', '8787') + '/health', timeout=4)"

CMD ["sh", "-c", "exec python -m nanoagent web web_cfg=deploy/railway/nanoagent.yaml"]
