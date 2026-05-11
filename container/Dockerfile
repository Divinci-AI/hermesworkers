FROM docker.io/cloudflare/sandbox:0.7.20
LABEL org.opencontainers.image.title="hermesworkers"
LABEL org.opencontainers.image.description="Hermes Agent running inside Cloudflare Sandbox"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# System dependencies required by Hermes:
# - python 3.11+ (Hermes core), node 22 (Hermes install scripts), git
# - ripgrep (fast file search used by Hermes)
# - ffmpeg (audio/TTS features — optional, kept for parity with upstream install)
# - clang, make, pkg-config, libffi-dev, libssl-dev (native Python deps)
# - netcat-openbsd, iproute2 (port probes from the Worker)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils git \
        python3.11 python3.11-venv python3.11-dev python3-pip \
        clang make pkg-config libffi-dev libssl-dev \
        ripgrep ffmpeg \
        netcat-openbsd iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 — Hermes install scripts bootstrap Node, pre-installing avoids a download at build time.
ENV NODE_VERSION=22.16.0
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version

# Pin HOME so Cloudflare Sandbox snapshot/backup catches Hermes state under ~/.hermes.
ENV HOME=/home/hermes
RUN mkdir -p /home/hermes

# Install Hermes from source for pinned version control.
# v2026.4.30 includes the `hermes dashboard` command (web UI on port 9119) and the API server.
ENV HERMES_VERSION=v2026.4.30
WORKDIR /opt
RUN git clone --depth 1 --branch ${HERMES_VERSION} https://github.com/NousResearch/hermes-agent.git hermes-agent \
    || git clone --depth 1 https://github.com/NousResearch/hermes-agent.git hermes-agent

WORKDIR /opt/hermes-agent
RUN python3.11 -m venv /opt/hermes-venv \
    && /opt/hermes-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/hermes-venv/bin/pip install --no-cache-dir uv \
    && /opt/hermes-venv/bin/uv pip install --python /opt/hermes-venv/bin/python -e ".[all]"

# Install the web dashboard + pty extras (provides the native Hermes UI on port 9119).
# `web` ships the React dashboard, `pty` enables the embedded chat over WebSocket.
RUN /opt/hermes-venv/bin/uv pip install --python /opt/hermes-venv/bin/python -e ".[web,pty]" \
    || /opt/hermes-venv/bin/pip install --no-cache-dir 'hermes-agent[web,pty]' \
    || (echo "FATAL: failed to install [web,pty] extras — dashboard would be unavailable" && exit 1)

# Symlink the hermes CLI globally.
RUN ln -sf /opt/hermes-venv/bin/hermes /usr/local/bin/hermes

# Verify the dashboard subcommand is available (catches install regressions early).
RUN /opt/hermes-venv/bin/hermes dashboard --help > /dev/null 2>&1 \
    || (echo "FATAL: 'hermes dashboard' subcommand not found. Check [web,pty] extras + HERMES_VERSION." && exit 1)

# Copy startup script.
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN sed -i 's/\r$//' /usr/local/bin/start-hermes.sh && chmod +x /usr/local/bin/start-hermes.sh

# Backup-ready permissions on /home (so the Sandbox snapshot can read everything).
RUN chmod -R a+rX /home/hermes

WORKDIR /home/hermes

# Two ports are exposed:
#   18789 — Hermes API server (OpenAI-compatible /v1/chat/completions endpoint).
#   9119  — Hermes native dashboard (web UI + WebSocket).
EXPOSE 18789
EXPOSE 9119

# No CMD: the Worker starts the script through Sandbox SDK `startProcess()`.
