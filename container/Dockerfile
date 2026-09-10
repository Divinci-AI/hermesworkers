FROM docker.io/cloudflare/sandbox:0.12.4
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
        iptables nftables sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
# `rm -rf /var/lib/apt/lists/*` alone removes the package LISTS but leaves the
# downloaded .debs in /var/cache/apt/archives — measured at 323 MB in the live
# staging container on 2026-08-07. `apt-get clean` is what drops those.

# Non-root runtime user for the Hermes agent. The agent executes tools/shell
# commands on behalf of prompts, so it must not run as root even though the
# Sandbox provides an outer isolation boundary. UID/GID are fixed for
# reproducible snapshot ownership.
RUN groupadd --system --gid 10001 hermes \
    && useradd --system --uid 10001 --gid hermes --home-dir /home/hermes --shell /usr/sbin/nologin hermes

# SEPARATE, LESS-PRIVILEGED user for the virtual terminal (uid 10002).
#
# The terminal runs commands the model composes from untrusted input — a cloned
# repo's README is a prompt-injection vector. It therefore must NOT share the
# identity that owns the provider credentials: ~hermes/.hermes/ holds the Vertex
# service-account JSON, the Cloudflare API key, and any customer BYOK key, and
# `cat ~/.hermes/.env` is the first thing an injection reaches for once
# arbitrary commands are possible.
#
# uid 10002 is also the handle the network lockdown hangs off — setup-terminal.sh
# installs iptables owner-match rules against it so all egress from terminal
# commands must transit the allowlisting guard. Keep the uid stable; the rules,
# the workspace ownership, and the Worker's gosu wrapper all reference it.
RUN groupadd --system --gid 10002 hermes-term \
    && useradd --system --uid 10002 --gid hermes-term --home-dir /workspace --shell /bin/bash hermes-term \
    && mkdir -p /workspace \
    && chown hermes-term:hermes-term /workspace \
    && chmod 0750 /workspace

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

# Google Workspace CLI (`gws`) — one binary for Drive, Gmail, Calendar, Sheets,
# Docs, Chat and Admin, built dynamically from Google's Discovery Service, with
# structured JSON output. Available to the virtual terminal.
#
# PINNED for supply-chain safety, like Node and Hermes above: this binary is
# handed short-lived OAuth tokens for a customer's Google Workspace account, so
# an unpinned floating version is not acceptable. Bump deliberately.
#
# It is open source but explicitly NOT an officially supported Google product —
# worth remembering before promising customers a Google SLA on top of it.
#
# Auth is per-command via GOOGLE_WORKSPACE_CLI_TOKEN (first in the CLI's
# credential resolution order). No credential file is ever written into the
# image or the workspace: the token is injected for the duration of one command
# and never persisted. See buildWorkspaceCommand() in src/lib/terminal.ts.
# ⚠️ Install the MUSL artifact, not the npm package. `npm i -g
# @googleworkspace/cli` runs a postinstall that picks the artifact from
# `ldd --version`: glibc here, so it fetches the `-gnu` build, which is linked
# against GLIBC 2.39. This base image is jammy (GLIBC 2.35), so that build dies
# at `gws --version` with:
#   /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found
# It only ever "worked" off a warm layer cache — a cold build has always failed,
# and `docker image prune` after a deploy is enough to expose it.
#
# The `-musl` artifact of the SAME pinned release is statically linked and
# carries no libc floor. Fetching it directly keeps both guarantees the npm path
# gave us: the URL is version-pinned to the GitHub release, and the .sha256
# published alongside it is verified before the binary is installed.
ENV GWS_VERSION=0.22.5
ENV GWS_ARTIFACT=google-workspace-cli-x86_64-unknown-linux-musl.tar.gz
RUN set -eux; \
    base="https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}"; \
    curl -fsSL "${base}/${GWS_ARTIFACT}" -o /tmp/gws.tar.gz; \
    curl -fsSL "${base}/${GWS_ARTIFACT}.sha256" -o /tmp/gws.sha256; \
    echo "$(cut -d' ' -f1 /tmp/gws.sha256)  /tmp/gws.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gws.tar.gz -C /tmp; \
    install -m 0755 "$(find /tmp -maxdepth 2 -type f -name gws | head -n1)" /usr/local/bin/gws; \
    rm -rf /tmp/gws.tar.gz /tmp/gws.sha256; \
    gws --version

# Google Cloud CLI (`gcloud`) — pinned tarball + SHA-256, same supply-chain
# posture as Node and gws. Available to the virtual terminal for GCP dogfood
# (Cloud Run, Artifact Registry, logs). Credentials are NEVER baked in: the
# agent authenticates at runtime (short-lived token / ADC inject); without a
# token the binary is present but API calls fail closed.
#
# Image size cost is real (~90 MB compressed / ~400 MB unpacked). Acceptable for
# standard-1 sandbox instances; bump deliberately and re-verify the digest.
# Cloudflare Containers currently run linux/amd64 — refuse other arches rather
# than silently install a mismatched binary.
ENV GCLOUD_VERSION=579.0.0
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    case "${ARCH}" in \
      amd64) GCLOUD_ARCH="x86_64"; GCLOUD_SHA256="a9a7fbe51cda37cf6142b1bbcff12227550e60a6c67e8cf84644fb301371c4de" ;; \
      *) echo "gcloud: unsupported architecture ${ARCH} (Cloudflare Containers are amd64)" >&2; exit 1 ;; \
    esac; \
    url="https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_VERSION}-linux-${GCLOUD_ARCH}.tar.gz"; \
    curl -fsSL "${url}" -o /tmp/gcloud.tgz; \
    echo "${GCLOUD_SHA256}  /tmp/gcloud.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gcloud.tgz -C /opt; \
    rm /tmp/gcloud.tgz; \
    CLOUDSDK_CORE_DISABLE_PROMPTS=1 /opt/google-cloud-sdk/install.sh \
      --quiet \
      --usage-reporting false \
      --path-update false \
      --command-completion false; \
    ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud; \
    ln -sf /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil; \
    ln -sf /opt/google-cloud-sdk/bin/bq /usr/local/bin/bq; \
    # Drop install backups / pyc so the snapshot stays leaner.
    rm -rf /opt/google-cloud-sdk/.install/.backup \
           /opt/google-cloud-sdk/platform/gsutil/third_party \
           /root/.config/gcloud; \
    gcloud --version

# Cloudflare Wrangler — pinned npm version. Postinstall pulls the matching
# workerd binary for the host arch (expected at image build). No CF account
# token is stored; `wrangler whoami` / deploy need a short-lived token at runtime
# (or CLOUDFLARE_API_TOKEN injected for one command — never persisted under
# /workspace). registry.npmjs.org is already on the default egress allowlist so
# component fetches at build time succeed.
ENV WRANGLER_VERSION=4.120.0
RUN set -eux; \
    npm install -g "wrangler@${WRANGLER_VERSION}"; \
    wrangler --version; \
    npm cache clean --force; \
    rm -rf /root/.npm /tmp/*

# Pin HOME so Cloudflare Sandbox snapshot/backup catches Hermes state under ~/.hermes.
ENV HOME=/home/hermes
RUN mkdir -p /home/hermes

# Install Hermes from source, pinned for reproducibility.
# Pinned to NousResearch/hermes-agent v2026.7.7.2 (has `hermes gateway`,
# `hermes dashboard`, and the API server). HERMES_COMMIT defaults to that tag's
# immutable ANNOTATED TAG OBJECT sha for supply-chain safety (git tags are
# mutable; a moved tag would silently change what you ship — but a tag object's
# sha is content-addressed over the commit it names, so moving the tag yields a
# DIFFERENT sha and the fetch fails). git prints `is not a commit!` and then
# resolves it to commit 9de9c25f; that warning is expected, not a defect. The
# clone FAILS HARD on a bad tag — no silent fallback to an unpinned default
# branch. Override both to bump.
ENV HERMES_VERSION=v2026.9.7
ARG HERMES_COMMIT="9949d0d324a3a06ac238e01dd1c2103dbca09900"
WORKDIR /opt
RUN git clone --depth 1 --branch "${HERMES_VERSION}" https://github.com/NousResearch/hermes-agent.git hermes-agent \
    && if [ -n "${HERMES_COMMIT}" ]; then \
         cd hermes-agent \
         && git fetch --depth 1 origin "${HERMES_COMMIT}" \
         && git checkout --detach "${HERMES_COMMIT}"; \
       fi

# ── Local patches against the pinned upstream ──────────────────────────────
# Applied BEFORE the editable install, so the venv imports patched source.
#
# ⚠️ A FAILED PATCH MUST FAIL THE BUILD. `git apply` is deliberately not
# `|| true`: a patch that stops applying after a HERMES_COMMIT bump means the
# defect it fixes is either back or restructured, and both need a human. A
# silently-skipped patch would ship the old behaviour under a version string
# that claims otherwise — the exact "a success line is not an outcome" trap
# that cost the 2026-08-25 night shift.
#
# 0001 (REMOVED 2026-09-01): `_summarize_api_error` crashed on an unread
#       streaming response, so the error REPORTER replaced the error it
#       reports. Upstream v2026.8.31 fixed this natively: the response-text
#       access is now wrapped in try/except Exception (catches
#       httpx.ResponseNotRead, a RuntimeError that getattr's default cannot
#       absorb) — byte-for-byte the patch's behaviour. Removing the patch was
#       verified against the v2026.8.31 tree before the bump; keep the
#       `[ -e "$p" ] || continue` guard (POSIX — /bin/sh here is dash, which
#       has NO shopt/nullglob) so an EMPTY patch set still builds, and any NEW
#       patch still fails hard. (The `COPY patches/` line was removed with the
#       patch; re-add it — and the patches dir — when a new patch lands.)
WORKDIR /opt/hermes-agent
RUN set -eu; \
    for p in /opt/hermes-patches/*.patch; do \
      [ -e "$p" ] || continue; \
      echo "applying $(basename "$p")"; \
      git apply --verbose "$p"; \
    done; \
    python3.11 -c "import ast,sys; ast.parse(open('/opt/hermes-agent/run_agent.py').read())"

WORKDIR /opt/hermes-agent
RUN python3.11 -m venv /opt/hermes-venv \
    && /opt/hermes-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/hermes-venv/bin/pip install --no-cache-dir uv \
    && /opt/hermes-venv/bin/uv pip install --python /opt/hermes-venv/bin/python -e ".[all]"
# uv keeps its own wheel cache under ~/.cache/uv and, unlike the pip calls
# above, has no --no-cache-dir on it — 240 MB of it shipped in the image
# (measured in the live container 2026-08-07). Cleaned after the LAST uv call
# below rather than here, so the second install still gets cache hits.

# Install the web dashboard + pty extras from the SAME pinned source tree
# (provides the native Hermes UI on port 9119). No PyPI fallback — a fallback to
# an unpinned `hermes-agent[web,pty]` would defeat the pinning above.
RUN /opt/hermes-venv/bin/uv pip install --python /opt/hermes-venv/bin/python -e ".[web,pty]" \
    && /opt/hermes-venv/bin/uv cache clean \
    && rm -rf /root/.cache/uv /home/hermes/.cache/uv

# Symlink the hermes CLI globally.
RUN ln -sf /opt/hermes-venv/bin/hermes /usr/local/bin/hermes

# Verify the dashboard subcommand is available (catches install regressions early).
RUN /opt/hermes-venv/bin/hermes dashboard --help > /dev/null 2>&1 \
    || (echo "FATAL: 'hermes dashboard' subcommand not found. Check [web,pty] extras + HERMES_VERSION." && exit 1)

# Copy startup script.
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN sed -i 's/\r$//' /usr/local/bin/start-hermes.sh && chmod 0755 /usr/local/bin/start-hermes.sh

# Virtual-terminal boundary: the allowlisting egress proxy and the boot-time
# lockdown script that makes it unbypassable. Both are root-owned and
# non-writable by either runtime user — the terminal user must not be able to
# edit the thing that contains it.
# The bounded terminal, exposed to the Hermes agent as an MCP server.
#
# The sudoers grant is deliberately narrow: the `hermes` user may run exactly
# ONE program as `hermes-term`, by absolute path. That is "run this program",
# not "become that user". Both the helper and the MCP server are root-owned and
# not writable by either runtime user, so the thing being granted cannot be
# swapped out by the thing receiving the grant.
#
# The escalation runs DOWNWARD (uid 10001 -> 10002, dropping the ability to read
# ~/.hermes/), which is what makes it safe: `hermes` gains nothing it did not
# already have, and everything it runs through the helper is confined by the
# terminal boundary rather than by its own uid.
COPY hermes-term-exec /usr/local/bin/hermes-term-exec
COPY mcp-terminal-server.js /usr/local/bin/mcp-terminal-server.js
RUN sed -i 's/\r$//' /usr/local/bin/hermes-term-exec \
    && chmod 0755 /usr/local/bin/hermes-term-exec /usr/local/bin/mcp-terminal-server.js \
    && chown root:root /usr/local/bin/hermes-term-exec /usr/local/bin/mcp-terminal-server.js \
    && printf 'hermes ALL=(hermes-term) NOPASSWD: /usr/local/bin/hermes-term-exec\n' > /etc/sudoers.d/hermes-term \
    && chmod 0440 /etc/sudoers.d/hermes-term \
    && visudo -cf /etc/sudoers.d/hermes-term

# ── Unattended-turn tool guard (divinci_email_guard) ───────────────────────
#
# Staged read-only under /usr/local/share; start-hermes.sh installs it into
# ~hermes/.hermes/plugins/ at boot and enables it in `plugins.enabled`.
#
# Owned root:root and 0755/0644 so the `hermes` uid — the one an injected
# agent runs as — cannot rewrite the guard that constrains it. The copy under
# ~/.hermes IS writable by hermes; that is unavoidable (the plugin loader
# only reads from there) and is why Hermes' own shell is disabled via
# command_allowlist=[] and the bounded terminal runs as hermes-term, which
# cannot write ~hermes/.hermes/ at all. The staged original is the reference
# copy, re-installed on every boot.
COPY plugins/divinci_email_guard /usr/local/share/divinci-hermes-plugins/divinci_email_guard
RUN chown -R root:root /usr/local/share/divinci-hermes-plugins \
    && find /usr/local/share/divinci-hermes-plugins -type d -exec chmod 0755 {} + \
    && find /usr/local/share/divinci-hermes-plugins -type f -exec chmod 0644 {} +

COPY egress-guard.js /usr/local/bin/egress-guard.js
COPY setup-terminal.sh /usr/local/bin/setup-terminal.sh
RUN sed -i 's/\r$//' /usr/local/bin/setup-terminal.sh \
    && chmod 0755 /usr/local/bin/setup-terminal.sh /usr/local/bin/egress-guard.js \
    && chown root:root /usr/local/bin/setup-terminal.sh /usr/local/bin/egress-guard.js
RUN mkdir -p /var/log && touch /var/log/hermes-egress.log \
    && chown hermes:hermes /var/log/hermes-egress.log \
    && chmod 0640 /var/log/hermes-egress.log

# Hand the Hermes state + install trees to the non-root user. The a+rX keeps the
# (non-secret) install tree readable for the Sandbox snapshot; runtime secrets
# under ~/.hermes are created 0700 by start-hermes.sh, so no secret is ever
# world-readable.
RUN chown -R hermes:hermes /home/hermes /opt/hermes-agent /opt/hermes-venv \
    && chmod -R a+rX /opt/hermes-agent /opt/hermes-venv \
    # 0711 lets the terminal user traverse into world-readable subpaths without
    # being able to LIST /home/hermes — combined with 0700 on ~/.hermes (set by
    # start-hermes.sh and re-asserted by setup-terminal.sh), the credential
    # directory is neither listable nor readable from uid 10002.
    && chmod 0711 /home/hermes

WORKDIR /home/hermes

# Two ports are exposed:
#   18789 — Hermes API server (OpenAI-compatible /v1/chat/completions endpoint).
#   9119  — Hermes native dashboard (web UI + WebSocket).
EXPOSE 18789
EXPOSE 9119

# No CMD: the Worker starts the script through Sandbox SDK `startProcess()`.
# The script itself drops to the `hermes` user (via gosu) for the long-running
# gateway/dashboard processes — see container/start-hermes.sh.
