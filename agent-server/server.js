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
// This server is the provider-specific normalizer: it spawns the backend
// (claude today) and translates its native stream-json into the common agent
// protocol below, so the host activities, the workflow, and the UI never parse
// LLM JSON. Adding codex means branching here on AGENT_BACKEND.
//
// Commands:
//   { "op": "send", "input": { "prompt": "..." } }
//   { "op": "send", "input": { "tool_results": [{ "name", "outcome": {ok|err} }] } }
//      Renders the common agent-input into one claude user-message line and
//      marks the start of a new turn. Returns { "ok": true } once flushed.
//
//   { "op": "recv", "timeout_ms": 30000 }
//      Polls the current turn. Returns { "ok": true, "outcome": ..., "raw": [...] }
//      where outcome is one of:
//        "working"                                  turn still streaming
//        "reply",      reply: {final}|{tool_calls}  turn complete, parsed reply
//        "rate_limited", rate_limit: {retry_after_seconds, message}
//        "exited",     error: string                backend died mid-turn
//        "error",      error: string                reply did not match envelope
//      "raw" carries the stream-json events seen since the last poll, for the
//      activity to echo to its stderr (debugging only; not in the typed return).
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
// Number of events already returned to a recv() caller (for the raw stderr echo).
let consumed = 0;
// Index in `events` where the current turn's events begin. Set on each send so
// recv can locate the turn's terminating `result` event and parse the reply.
let turnStart = 0;
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

// Render the common `agent-input` into the claude user-message text. `prompt`
// is sent verbatim; `tool_results` is serialized into the JSON envelope the
// system prompt instructs claude to expect.
function renderUserText(input) {
  if (input && typeof input.prompt === "string") {
    return input.prompt;
  }
  if (input && Array.isArray(input.tool_results)) {
    const results = input.tool_results.map((tr) => {
      const outcome = tr && tr.outcome;
      if (outcome && "ok" in outcome) {
        return { name: tr.name, ok: tryParse(outcome.ok) };
      }
      return { name: tr.name, err: outcome ? outcome.err : "error" };
    });
    return JSON.stringify({ tool_results: results });
  }
  return null;
}

async function opSend({ input }) {
  const text = renderUserText(input);
  if (text === null) {
    return { ok: false, error: "input must be { prompt } or { tool_results }" };
  }
  const event = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  try {
    // A new turn begins: claude's response events accumulate from here.
    turnStart = events.length;
    await writeStdinLine(JSON.stringify(event));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Index of the `result` event that terminates the current turn, or -1.
function findTurnResult() {
  for (let i = turnStart; i < events.length; i += 1) {
    if (events[i] && events[i].type === "result") return i;
  }
  return -1;
}

async function opRecv({ timeout_ms }) {
  const timeout = Number.isFinite(timeout_ms) && timeout_ms > 0 ? timeout_ms : 30000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const hasNew = events.length > consumed;
    if (findTurnResult() !== -1 || exited) break;
    if (hasNew && Date.now() - start > 500) break;
    await sleep(100);
  }

  // Raw events since the last poll, for the activity to echo to stderr.
  const raw = events.slice(consumed);
  consumed = events.length;

  const resultIdx = findTurnResult();
  if (resultIdx !== -1) {
    const resultEv = events[resultIdx];
    const turnSlice = events.slice(turnStart, resultIdx + 1);
    // Advance so the next turn parses from a fresh window.
    turnStart = resultIdx + 1;

    if (resultEv.is_error === true && resultEv.api_error_status === 429) {
      const message = typeof resultEv.result === "string" && resultEv.result
        ? resultEv.result
        : "session limit reached";
      return {
        ok: true,
        outcome: "rate_limited",
        rate_limit: { retry_after_seconds: secondsUntilReset(message), message },
        raw,
      };
    }

    const reply = extractReply(turnSlice, resultEv);
    if (reply === null) {
      const text = typeof resultEv.result === "string" ? resultEv.result : lastAssistantText(turnSlice);
      return { ok: true, outcome: "error", error: `reply did not match envelope: ${text.slice(0, 500)}`, raw };
    }
    return { ok: true, outcome: "reply", reply, raw };
  }

  if (exited) {
    const detail = exitInfo ? JSON.stringify(exitInfo) : "unknown";
    return { ok: true, outcome: "exited", error: `agent process exited mid-turn: ${detail}`, raw };
  }
  return { ok: true, outcome: "working", raw };
}

function tryParse(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

// Concatenated text of the last assistant message in a turn slice.
function lastAssistantText(turnSlice) {
  for (let i = turnSlice.length - 1; i >= 0; i -= 1) {
    const e = turnSlice[i];
    if (!e || e.type !== "assistant") continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (text) return text;
  }
  return "";
}

// Parse claude's final reply text into the common agent-reply shape:
//   { final: string } | { tool_calls: [{ name, arguments_json }] }
// Returns null if the text is not a recognizable envelope.
function extractReply(turnSlice, resultEv) {
  let text = typeof resultEv.result === "string" ? resultEv.result : "";
  if (!text) text = lastAssistantText(turnSlice);
  const env = extractEnvelope(text);
  if (!env) return null;
  if (typeof env.final === "string") return { final: env.final };
  if (Array.isArray(env.tool_calls)) {
    return {
      tool_calls: env.tool_calls.map((c) => ({
        name: c && typeof c.name === "string" ? c.name : "",
        arguments_json: JSON.stringify(c && typeof c.args === "object" && c.args !== null ? c.args : {}),
      })),
    };
  }
  return null;
}

// The model occasionally writes a prose preamble before the JSON envelope. We
// accept that, but only if the envelope is the trailing content, to avoid
// treating `{"final": ...}` quoted inside explanatory prose as the reply.
function extractEnvelope(text) {
  const trimmed = (text || "").trim();
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch (_) {}
  }
  if (!trimmed.endsWith("}")) return null;
  for (const marker of ['{"final":', '{"tool_calls":']) {
    const startIdx = trimmed.lastIndexOf(marker);
    if (startIdx === -1) continue;
    const endIdx = findMatchingBrace(trimmed, startIdx);
    if (endIdx === trimmed.length - 1) {
      try { return JSON.parse(trimmed.substring(startIdx, endIdx + 1)); } catch (_) {}
    }
  }
  return null;
}

function findMatchingBrace(s, start) {
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parse "... resets 3:50pm (UTC)" into seconds from now until that UTC time.
// Falls back to one hour when the reset time is missing or unparseable.
const DEFAULT_RETRY_AFTER_SECONDS = 3600;
const RESET_BUFFER_SECONDS = 30;

function secondsUntilReset(message) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*\(?\s*UTC\s*\)?/i.exec(message || "");
  if (!m) return DEFAULT_RETRY_AFTER_SECONDS;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return DEFAULT_RETRY_AFTER_SECONDS;

  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0,
  ));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  const seconds = Math.ceil((target.getTime() - now.getTime()) / 1000) + RESET_BUFFER_SECONDS;
  return seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
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
