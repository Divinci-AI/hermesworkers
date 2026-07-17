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
# - gosu (drop root for the long-running Hermes process; see start-hermes.sh)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils git gosu \
        python3.11 python3.11-venv python3.11-dev python3-pip \
        clang make pkg-config libffi-dev libssl-dev \
        ripgrep ffmpeg \
        netcat-openbsd iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user for the Hermes agent. The agent executes tools/shell
# commands on behalf of prompts, so it must not run as root even though the
# Sandbox provides an outer isolation boundary. UID/GID are fixed for
# reproducible snapshot ownership.
RUN groupadd --system --gid 10001 hermes \
    && useradd --system --uid 10001 --gid hermes --home-dir /home/hermes --shell /usr/sbin/nologin hermes

# Node.js 22 — Hermes install scripts bootstrap Node, pre-installing avoids a
# download at build time. The tarball is fetched over TLS *with* certificate
# verification (no -k) and its SHA-256 is checked against a pinned digest, so a
# substituted binary from an on-path attacker or bad mirror fails the build.
ENV NODE_VERSION=22.16.0
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64";   NODE_SHA256="f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e" ;; \
         arm64) NODE_ARCH="arm64"; NODE_SHA256="eab80cb88f8fda1e65f5e8d0420c9809bdb320b03fd34976ab7161b6e703b910" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version

# Pin HOME so Cloudflare Sandbox snapshot/backup catches Hermes state under ~/.hermes.
ENV HOME=/home/hermes
RUN mkdir -p /home/hermes

# Install Hermes from source, pinned for reproducibility.
# Pinned to NousResearch/hermes-agent v2026.7.7.2 (has `hermes gateway`,
# `hermes dashboard`, and the API server). HERMES_COMMIT defaults to that tag's
# immutable commit SHA for supply-chain safety (git tags are mutable; a moved
# tag would silently change what you ship). The clone FAILS HARD on a bad tag —
# no silent fallback to an unpinned default branch. Override both to bump.
ENV HERMES_VERSION=v2026.7.7.2
ARG HERMES_COMMIT="b7751df34688835a108e0d630f3495fc11f3df79"
WORKDIR /opt
RUN git clone --depth 1 --branch "${HERMES_VERSION}" https://github.com/NousResearch/hermes-agent.git hermes-agent \
    && if [ -n "${HERMES_COMMIT}" ]; then \
         cd hermes-agent \
         && git fetch --depth 1 origin "${HERMES_COMMIT}" \
         && git checkout --detach "${HERMES_COMMIT}"; \
       fi

WORKDIR /opt/hermes-agent
RUN python3.11 -m venv /opt/hermes-venv \
    && /opt/hermes-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/hermes-venv/bin/pip install --no-cache-dir uv \
    && /opt/hermes-venv/bin/uv pip install --python /opt/hermes-venv/bin/python -e ".[all]"

# Install the web dashboard + pty extras from the SAME pinned source tree
# (provides the native Hermes UI on port 9119). No PyPI fallback — a fallback to
# an unpinned `hermes-agent[web,pty]` would defeat the pinning above.
RUN /opt/hermes-venv/bin/uv pip install --python /opt/hermes-venv/bin/python -e ".[web,pty]"

# Symlink the hermes CLI globally.
RUN ln -sf /opt/hermes-venv/bin/hermes /usr/local/bin/hermes

# Verify the dashboard subcommand is available (catches install regressions early).
RUN /opt/hermes-venv/bin/hermes dashboard --help > /dev/null 2>&1 \
    || (echo "FATAL: 'hermes dashboard' subcommand not found. Check [web,pty] extras + HERMES_VERSION." && exit 1)

# Copy startup script.
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN sed -i 's/\r$//' /usr/local/bin/start-hermes.sh && chmod 0755 /usr/local/bin/start-hermes.sh

# Hand the Hermes state + install trees to the non-root user. The a+rX keeps the
# (non-secret) install tree readable for the Sandbox snapshot; runtime secrets
# under ~/.hermes are created 0700 by start-hermes.sh, so no secret is ever
# world-readable.
RUN chown -R hermes:hermes /home/hermes /opt/hermes-agent /opt/hermes-venv \
    && chmod -R a+rX /opt/hermes-agent /opt/hermes-venv

WORKDIR /home/hermes

# Two ports are exposed:
#   18789 — Hermes API server (OpenAI-compatible /v1/chat/completions endpoint).
#   9119  — Hermes native dashboard (web UI + WebSocket).
EXPOSE 18789
EXPOSE 9119

# No CMD: the Worker starts the script through Sandbox SDK `startProcess()`.
# The script itself drops to the `hermes` user (via gosu) for the long-running
# gateway/dashboard processes — see container/start-hermes.sh.
