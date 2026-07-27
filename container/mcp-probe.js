#!/usr/bin/env node
// Drive the MCP terminal server over stdio as Hermes would, and assert the
// security properties of the MCP path specifically (the boundary harness covers
// the direct path). Run AS THE `hermes` USER — the uid that owns the creds.
const { spawn } = require("node:child_process");
const srv = spawn("node", ["/usr/local/bin/mcp-terminal-server.js"], { stdio: ["pipe","pipe","inherit"] });
let buf = "", id = 0; const pending = new Map();
srv.stdout.on("data", d => {
  buf += d.toString(); const lines = buf.split("\n"); buf = lines.pop();
  for (const l of lines) { if (!l.trim()) continue;
    const m = JSON.parse(l); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } }
});
const call = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res);
  srv.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:i, method, params }) + "\n"); });
const txt = r => (r.result?.content||[]).map(c=>c.text).join("\n");
let pass=0, fail=0;
const ok=(m)=>{console.log("  PASS  "+m);pass++}; const bad=(m)=>{console.log("  FAIL  "+m);fail++};
(async () => {
  const init = await call("initialize", {});
  init.result?.serverInfo?.name === "divinci-terminal" ? ok("initialize handshake") : bad("initialize failed");
  const tools = await call("tools/list", {});
  const names = (tools.result?.tools||[]).map(t=>t.name);
  names.includes("terminal_exec") && names.includes("git_clone") ? ok(`tools/list: ${names.join(", ")}`) : bad("tools missing");

  console.log("\n== MCP path runs as the UNPRIVILEGED user ==");
  const who = await call("tools/call", { name:"terminal_exec", arguments:{ command:"id -u; id -un" } });
  /10002/.test(txt(who)) ? ok("terminal_exec runs as uid 10002, not 10001") : bad("wrong uid: "+txt(who).slice(0,80));

  console.log("\n== MCP path CANNOT reach provider credentials ==");
  const cred = await call("tools/call", { name:"terminal_exec", arguments:{ command:"cat /home/hermes/.hermes/.env" } });
  /FAKE-SENTINEL-VALUE/.test(txt(cred)) ? bad("MCP tool READ the credential file") : ok("credential file unreadable through MCP");
  const rf = await call("tools/call", { name:"read_file", arguments:{ path:"/home/hermes/.hermes/.env" } });
  /FAKE-SENTINEL-VALUE/.test(txt(rf)) ? bad("read_file escaped the workspace") : ok("read_file confined to /workspace");

  console.log("\n== MCP path respects the egress allowlist ==");
  const eg = await call("tools/call", { name:"terminal_exec", arguments:{ command:"curl -s --max-time 8 -o /dev/null -w '%{http_code}' --noproxy '*' https://example.com; echo" } });
  /^\s*(000)?\s*$/m.test(txt(eg)) || !/200/.test(txt(eg)) ? ok("direct egress blocked through MCP") : bad("MCP tool reached the open internet: "+txt(eg).slice(0,60));

  console.log("\n== write/list round-trip inside the workspace ==");
  await call("tools/call", { name:"write_file", arguments:{ path:"hello.txt", content:"hi from mcp" } });
  const back = await call("tools/call", { name:"read_file", arguments:{ path:"hello.txt" } });
  /hi from mcp/.test(txt(back)) ? ok("write_file + read_file round-trip") : bad("round-trip failed: "+txt(back).slice(0,80));

  console.log("\n== path traversal rejected ==");
  const tr = await call("tools/call", { name:"read_file", arguments:{ path:"../../etc/passwd" } });
  tr.result?.isError ? ok("traversal rejected as a tool error") : bad("traversal NOT rejected");

  console.log(`\nMCP RESULT: pass=${pass} fail=${fail}`);
  srv.kill(); process.exit(fail === 0 ? 0 : 1);
})();
