#!/usr/bin/env node

// Long-running wrapper around `claude -p --input-format stream-json
// --output-format stream-json`. Exposes a Unix domain socket protocol so
// short-lived Obelisk activities can drive a single persistent claude
// process across many turns.
//
// Protocol: each socket connection is short-lived. The client writes one
// line of JSON, half-closes its write side, and reads one line of JSON
// back.
//
// Commands:
//   { "op": "send", "message": "..." }
//      Pushes a user message onto claude's stdin as one stream-json line.
//      Returns { "ok": true } once flushed.
//
//   { "op": "recv", "timeout_ms": 30000 }
//      Drains buffered stream-json events. Blocks up to timeout_ms waiting
//      for at least one event or until a "result" event appears. Returns
//      { "ok": true, "events": [...], "done": bool, "exited": bool }.
//      "done" is true once a "result" event has been observed for the
//      current turn. "exited" is true if the claude process has exited.
//
//   { "op": "status" }
//      Diagnostics: counts and exit info.
//
//   { "op": "shutdown" }
//      Best-effort graceful shutdown.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const SOCKET_PATH = process.argv[2];
if (!SOCKET_PATH) {
  console.error("usage: server.js <socket-path>");
  process.exit(2);
}

const BACKEND = process.env.AGENT_BACKEND || "claude";
const MODEL = process.env.AGENT_MODEL || "claude-opus-4-7";
const EXTRA = (process.env.AGENT_EXTRA_ARGS || "").trim();
const SYSTEM_PROMPT_PATH = process.env.AGENT_SYSTEM_PROMPT_PATH || "/app/system-prompt.md";

function spawnClaude() {
  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  // Claude keeps all its built-in tools. The system prompt tells it that
  // those tools belong to its internal loop; only the final reply needs to
  // come through the JSON envelope.
  //
  // We intentionally do NOT pass --json-schema: that injects a synthetic
  // StructuredOutput tool plus a stop hook that forces a second turn even
  // when the model has already produced the right JSON, doubling every
  // assistant message in the transcript.
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", MODEL,
    "--append-system-prompt", systemPrompt,
  ];
  if (EXTRA) args.push(...EXTRA.split(/\s+/));
  console.error(`[server] spawning ${BACKEND} (model=${MODEL}, ${systemPrompt.length}B prompt)`);
  return spawn(BACKEND, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

const child = spawnClaude();

// All stream-json events ever emitted by the child, in arrival order.
const events = [];
// Number of events already returned to a recv() caller.
let consumed = 0;
let exited = false;
let exitInfo = null;

let stdoutBuf = "";
child.stdout.setEncoding("utf-8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      parsed = { type: "_unparseable", raw: line, parse_error: e.message };
    }
    events.push(parsed);
  }
});

child.stderr.setEncoding("utf-8");
child.stderr.on("data", (chunk) => {
  process.stderr.write(`[${BACKEND} stderr] ${chunk}`);
});

child.on("exit", (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
  console.error(`[server] ${BACKEND} exited code=${code} signal=${signal}`);
});

child.on("error", (err) => {
  exited = true;
  exitInfo = { code: null, signal: null, error: err.message };
  console.error(`[server] ${BACKEND} spawn error: ${err.message}`);
});

function writeStdinLine(line) {
  return new Promise((resolve, reject) => {
    if (exited) return reject(new Error(`${BACKEND} has exited`));
    child.stdin.write(line + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

async function opSend({ message }) {
  if (typeof message !== "string") {
    return { ok: false, error: "message must be a string" };
  }
  const event = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: message }] },
  };
  try {
    await writeStdinLine(JSON.stringify(event));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function opRecv({ timeout_ms }) {
  const timeout = Number.isFinite(timeout_ms) && timeout_ms > 0 ? timeout_ms : 30000;
  const start = Date.now();
  const startConsumed = consumed;

  while (Date.now() - start < timeout) {
    const hasNew = events.length > consumed;
    const sawResult = hasNew &&
      events.slice(startConsumed).some((e) => e && e.type === "result");
    if (sawResult || exited) break;
    if (hasNew && Date.now() - start > 500) break;
    await sleep(100);
  }

  const slice = events.slice(consumed);
  consumed = events.length;
  const done = slice.some((e) => e && e.type === "result");
  return { ok: true, events: slice, done, exited };
}

function opStatus() {
  return {
    ok: true,
    backend: BACKEND,
    model: MODEL,
    events_total: events.length,
    consumed,
    exited,
    exit: exitInfo,
  };
}

let shuttingDown = false;
async function opShutdown() {
  if (shuttingDown) return { ok: true };
  shuttingDown = true;
  try { child.stdin.end(); } catch (_) {}
  try { child.kill("SIGTERM"); } catch (_) {}
  setTimeout(() => process.exit(0), 200).unref();
  return { ok: true };
}

async function dispatch(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch (e) {
    return { ok: false, error: `bad json: ${e.message}` };
  }
  switch (cmd.op) {
    case "send": return await opSend(cmd);
    case "recv": return await opRecv(cmd);
    case "status": return opStatus();
    case "shutdown": return await opShutdown();
    default: return { ok: false, error: `unknown op: ${cmd.op}` };
  }
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.on("error", () => {});
  let buf = "";
  socket.on("data", (chunk) => { buf += chunk; });
  socket.on("end", () => {
    const line = buf.trim();
    if (!line) { socket.destroy(); return; }
    dispatch(line)
      .then((res) => {
        if (!socket.destroyed) {
          socket.end(JSON.stringify(res) + "\n");
        }
      })
      .catch((err) => {
        if (!socket.destroyed) {
          socket.end(JSON.stringify({ ok: false, error: err.message }) + "\n");
        }
      });
  });
});

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}

server.listen(SOCKET_PATH, () => {
  try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (_) {}
  console.error(`[server] listening on ${SOCKET_PATH}`);
});

function shutdownAndExit(signal) {
  console.error(`[server] received ${signal}, shutting down`);
  opShutdown();
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
}
process.on("SIGTERM", () => shutdownAndExit("SIGTERM"));
process.on("SIGINT", () => shutdownAndExit("SIGINT"));
