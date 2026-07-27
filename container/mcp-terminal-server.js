#!/usr/bin/env node
/**
 * MCP server exposing the BOUNDED virtual terminal to the Hermes agent.
 *
 * WHY THIS EXISTS
 * Hermes ships its own command-execution tools, but they run as `hermes` — the
 * uid that owns ~/.hermes/ and therefore every provider credential. That is a
 * verified credential-exfiltration path (a chat message asking the agent to
 * `base64 ~/.hermes/.env` returned real platform keys), so those tools are
 * disabled. This server is the replacement: the same capability, routed through
 * the terminal boundary instead of around it.
 *
 * Every tool here shells out via `sudo -u hermes-term hermes-term-exec`, so all
 * work happens as uid 10002 — a user that cannot read the credentials, starts
 * from an empty environment, and whose egress is REJECTed by iptables except
 * through the allowlisting guard. This process itself runs as `hermes` and CAN
 * read those credentials, which is precisely why its tool surface is a fixed,
 * small set of operations rather than anything resembling "run this as me".
 *
 * Transport is stdio JSON-RPC 2.0 (Hermes `mcp_servers.<name>.command`).
 * Implemented against the protocol directly rather than pulling in the MCP SDK:
 * this process sits inside the security boundary's trust chain, and a
 * dependency-free implementation keeps that chain short and auditable.
 */
"use strict";

const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "divinci-terminal";
const WORKSPACE_ROOT = "/workspace";
const EXEC_HELPER = "/usr/local/bin/hermes-term-exec";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 60_000;

/** Keep the TAIL: errors, stack traces and test summaries live at the end. */
function truncate(s) {
  const v = s || "";
  return v.length <= MAX_OUTPUT_CHARS
    ? { text: v, truncated: false }
    : { text: v.slice(v.length - MAX_OUTPUT_CHARS), truncated: true };
}

/** POSIX single-quote quoting — safe for arbitrary content including quotes. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a caller-supplied path against the workspace and verify containment.
 * Normalizes BEFORE checking — checking the raw string for ".." first is the
 * classic ordering bug, and `/workspace-evil` must not pass a naive prefix test.
 */
function resolveWorkspacePath(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("path is required");
  if (raw.includes("\0")) throw new Error("path contains a NUL byte");
  const joined = raw.startsWith("/") ? raw : `${WORKSPACE_ROOT}/${raw}`;
  const parts = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) throw new Error("path escapes the workspace");
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = `/${parts.join("/")}`;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`path escapes the workspace (${WORKSPACE_ROOT})`);
  }
  return resolved;
}

/**
 * Run a command as the terminal user. Arguments are passed as an ARRAY to
 * spawn — no intermediate shell — so the only place shell semantics apply is
 * inside `bash -lc` within the helper, which is the intended surface.
 */
function runAsTerminalUser(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const child = spawn(
      "sudo",
      ["-n", "-u", "hermes-term", EXEC_HELPER, command, cwd || WORKSPACE_ROOT],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr: `${stderr}\n[timed out after ${timeout}ms]`, exitCode: 124 });
    }, timeout);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: `failed to start: ${err.message}`, exitCode: 127 });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

function textResult(result, extra) {
  const out = truncate(result.stdout);
  const err = truncate(result.stderr);
  const parts = [];
  if (extra) parts.push(extra);
  if (out.text) parts.push(out.text);
  if (err.text) parts.push(`[stderr]\n${err.text}`);
  if (out.truncated || err.truncated) parts.push("[output truncated — showing the tail]");
  if (result.exitCode !== 0) parts.push(`[exit ${result.exitCode}]`);
  if (parts.length === 0) parts.push("(no output)");
  return { content: [{ type: "text", text: parts.join("\n") }], isError: result.exitCode !== 0 };
}

const TOOLS = [
  {
    name: "terminal_exec",
    description:
      "Run a shell command in your isolated workspace container. Runs as an " +
      "unprivileged user with network access restricted to an allowlist " +
      "(package registries and code forges). Use for builds, tests, and file " +
      "inspection.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        cwd: { type: "string", description: "Working directory, relative to /workspace." },
        timeoutMs: { type: "number", description: "Timeout in ms (default 120000, max 600000)." },
      },
      required: ["command"],
    },
  },
  {
    name: "git_clone",
    description:
      "Clone a PUBLIC git repository over https into the workspace. " +
      "Private repositories and embedded credentials are not supported.",
    inputSchema: {
      type: "object",
      properties: {
        repoUrl: { type: "string", description: "https:// URL of a public repository." },
        branch: { type: "string" },
        targetDir: { type: "string", description: "Directory name under /workspace." },
        depth: { type: "number", description: "Clone depth (default 1)." },
      },
      required: ["repoUrl"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number", description: "Default 200000." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a file in the workspace, creating parent directories.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List a directory in the workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case "terminal_exec": {
      const command = String(a.command ?? "").trim();
      if (!command) throw new Error("command is required");
      const cwd = a.cwd ? resolveWorkspacePath(a.cwd) : WORKSPACE_ROOT;
      return textResult(await runAsTerminalUser(command, cwd, a.timeoutMs));
    }
    case "git_clone": {
      const repoUrl = String(a.repoUrl ?? "").trim();
      let parsed;
      try {
        parsed = new URL(repoUrl);
      } catch {
        throw new Error("repoUrl must be a valid URL");
      }
      // https only: git:// and ssh:// are unauthenticated or key-bearing, and
      // file:// would read the container's own filesystem through git. The
      // egress guard independently enforces the host allowlist.
      if (parsed.protocol !== "https:") {
        throw new Error("repoUrl must be https:// (git://, ssh:// and file:// are not permitted)");
      }
      if (parsed.username || parsed.password) {
        throw new Error("repoUrl must not embed credentials; only public repositories are supported");
      }
      const branch = String(a.branch ?? "").trim();
      if (branch && !/^[\w.\-/]{1,255}$/.test(branch)) throw new Error("branch contains invalid characters");
      const depth = Number.isInteger(a.depth) && a.depth > 0 ? Math.min(a.depth, 1000) : 1;
      const nameFromPath =
        (parsed.pathname.split("/").filter(Boolean).pop() || "repo").replace(/\.git$/i, "").replace(/[^\w.\-]/g, "") ||
        "repo";
      const target = resolveWorkspacePath(String(a.targetDir ?? "").trim() || nameFromPath);
      const cmd =
        `git clone --depth ${depth}` +
        (branch ? ` --branch ${shellQuote(branch)}` : "") +
        ` -- ${shellQuote(repoUrl)} ${shellQuote(target)}`;
      const r = await runAsTerminalUser(cmd, WORKSPACE_ROOT, 300_000);
      const denied = /egress denied/i.test(`${r.stdout}${r.stderr}`);
      return textResult(
        r,
        denied
          ? `Clone blocked by the egress allowlist — ${parsed.hostname} is not reachable from this workspace.`
          : `Cloning into ${target}`,
      );
    }
    case "read_file": {
      const p = resolveWorkspacePath(a.path);
      const maxBytes = Math.min(Math.max(Number(a.maxBytes) || 200_000, 1), 2_000_000);
      return textResult(await runAsTerminalUser(`head -c ${maxBytes} -- ${shellQuote(p)}`, WORKSPACE_ROOT));
    }
    case "write_file": {
      const p = resolveWorkspacePath(a.path);
      const content = String(a.content ?? "");
      // Base64 so arbitrary bytes survive the shell round-trip without any
      // quoting cleverness to get wrong.
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const cmd =
        `mkdir -p -- "$(dirname ${shellQuote(p)})" && ` +
        `printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(p)}`;
      const r = await runAsTerminalUser(cmd, WORKSPACE_ROOT);
      return textResult(r, r.exitCode === 0 ? `Wrote ${content.length} bytes to ${p}` : undefined);
    }
    case "list_files": {
      const p = a.path ? resolveWorkspacePath(a.path) : WORKSPACE_ROOT;
      return textResult(await runAsTerminalUser(`ls -lAh --color=never -- ${shellQuote(p)}`, WORKSPACE_ROOT));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── stdio JSON-RPC 2.0 ─────────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) are fire-and-forget; never reply to them.
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize":
        if (!isNotification) {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: "1.0.0" },
            },
          });
        }
        return;
      case "notifications/initialized":
        return;
      case "tools/list":
        if (!isNotification) send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      case "tools/call": {
        const result = await callTool(params?.name, params?.arguments);
        if (!isNotification) send({ jsonrpc: "2.0", id, result });
        return;
      }
      case "ping":
        if (!isNotification) send({ jsonrpc: "2.0", id, result: {} });
        return;
      default:
        if (!isNotification) {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isNotification) {
      // Report tool failures as a tool RESULT with isError, not a protocol
      // error: a rejected path or a blocked clone is information the agent
      // should reason about and route around, not a transport fault.
      if (method === "tools/call") {
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true },
        });
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
      }
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // ignore malformed frames rather than dying mid-session
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

module.exports = { resolveWorkspacePath, shellQuote, truncate, TOOLS, callTool };
