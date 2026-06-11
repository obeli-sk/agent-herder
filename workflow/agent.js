import * as agent from "obelisk-agent:agent/agent";
import * as webapi from "obelisk-agent:tools/webapi";
import * as askUser from "obelisk-agent:tools/input";

const RECV_TIMEOUT_MS = 30000;
const MAX_RECV_PER_TURN = 60; // 60 * 30s = 30 min ceiling per claude turn
const MAX_TURNS = 30;          // hard cap on agent loop turns

export default function run(prompt) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    const sessionId = sanitize(obelisk.executionIdCurrent());
    const containerName = `obelisk-agent-${sessionId}`;
    const socketPath = `/tmp/obelisk-agent/${sessionId}.sock`;

    let workflowError = null;
    try {
        const startInfo = agent.start(containerName, socketPath);
        console.log(`Started ${startInfo.container} from ${startInfo.image}`);

        let nextMessage = prompt;
        let finalAnswer = null;

        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            console.log(`--- turn ${turn} (${nextMessage.length} chars in) ---`);
            agent.send(socketPath, nextMessage);
            const turnEvents = drainTurn(socketPath);
            const reply = parseAssistantJson(turnEvents);

            if (reply && typeof reply.final === "string") {
                finalAnswer = reply.final;
                console.log(`final after ${turn + 1} turns`);
                break;
            }
            if (reply && Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0) {
                console.log(`dispatching ${reply.tool_calls.length} tool call(s)`);
                const results = [];
                for (const call of reply.tool_calls) {
                    const result = dispatch(call);
                    results.push(result);
                    console.log(`  ${call?.name}: ${"ok" in result ? "ok" : `err=${result.err}`}`);
                }
                nextMessage = JSON.stringify({ tool_results: results });
                continue;
            }
            throw `LLM reply did not match envelope: ${JSON.stringify(reply).slice(0, 500)}`;
        }

        if (finalAnswer === null) {
            throw `exceeded MAX_TURNS=${MAX_TURNS} without a final answer`;
        }
        return finalAnswer;
    } catch (error) {
        workflowError = error;
        throw error;
    } finally {
        try {
            agent.cleanup(containerName, socketPath);
            console.log(`Cleaned up ${containerName}`);
        } catch (error) {
            console.log(`Cleanup failed for ${containerName}: ${String(error)}`);
            if (workflowError === null) throw error;
        }
    }
}

function drainTurn(socketPath) {
    const events = [];
    for (let attempt = 0; attempt < MAX_RECV_PER_TURN; attempt += 1) {
        const chunk = agent.recv(socketPath, RECV_TIMEOUT_MS);
        const batch = JSON.parse(chunk.events);
        for (const ev of batch) events.push(ev);
        if (chunk.done) return events;
        if (chunk.exited) {
            throw `agent exited unexpectedly after ${events.length} events`;
        }
    }
    throw `agent did not finish within ${MAX_RECV_PER_TURN} recv attempts`;
}

function dispatch(call) {
    const name = (call && typeof call.name === "string") ? call.name : "?";
    const args = (call && typeof call.args === "object" && call.args !== null) ? call.args : {};
    try {
        switch (name) {
            case "obelisk.list_executions": {
                const len = (args.length | 0) || 20;
                return ok(name, tryJson(webapi.listExecutions(String(args.ffqn_prefix || ""), len)));
            }
            case "obelisk.get_execution":
                return ok(name, tryJson(webapi.getExecution(requireString(args.execution_id, "execution_id"))));
            case "obelisk.get_logs":
                return ok(name, tryJson(webapi.getLogs(requireString(args.execution_id, "execution_id"))));
            case "obelisk.submit":
                return ok(name, tryJson(webapi.submitJson(
                    requireString(args.ffqn, "ffqn"),
                    JSON.stringify(Array.isArray(args.params) ? args.params : []),
                )));
            case "obelisk.get_result":
                return ok(name, tryJson(webapi.getResultJson(requireString(args.execution_id, "execution_id"))));
            case "obelisk.list_deployments":
                return ok(name, tryJson(webapi.listDeployments()));
            case "obelisk.get_deployment":
                return ok(name, tryJson(webapi.getDeployment(requireString(args.deployment_id, "deployment_id"))));
            case "obelisk.current_deployment_id":
                return ok(name, tryJson(webapi.currentDeploymentId()));
            case "obelisk.create_deployment":
                return ok(name, tryJson(webapi.createDeployment(
                    requireString(args.config_json, "config_json"),
                    Boolean(args.verify),
                )));
            case "obelisk.apply_deployment":
                return ok(name, tryJson(webapi.applyDeployment(requireString(args.deployment_id, "deployment_id"))));
            case "input.ask_user":
                return ok(name, { answer: askUser.askUser(requireString(args.question, "question")) });
            default:
                return err(name, `unknown tool: ${name}`);
        }
    } catch (e) {
        return err(name, String(e));
    }
}

function ok(name, value) { return { name, ok: value }; }
function err(name, message) { return { name, err: message }; }

function requireString(value, field) {
    if (typeof value !== "string" || !value) throw `${field} is required`;
    return value;
}

function tryJson(value) {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
}

function parseAssistantJson(events) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (!e || e.type !== "assistant") continue;
        const content = e.message && e.message.content;
        if (!Array.isArray(content)) continue;
        const text = content
            .filter(b => b && b.type === "text" && typeof b.text === "string")
            .map(b => b.text)
            .join("");
        if (!text) continue;
        const env = extractEnvelope(text);
        return env !== null ? env : { _unparseable: text };
    }
    return null;
}

// The model occasionally writes a prose preamble before the JSON envelope.
// We accept that, but ONLY if the envelope is the trailing content. This
// avoids treating things like `Planner emitted {"final": "..."}` (inside
// explanatory prose) as the actual reply.
function extractEnvelope(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        try { return JSON.parse(trimmed); } catch (_) {}
    }
    if (!trimmed.endsWith("}")) return null;
    for (const marker of ['{"final":', '{"tool_calls":']) {
        const start = trimmed.lastIndexOf(marker);
        if (start === -1) continue;
        const end = findMatchingBrace(trimmed, start);
        if (end === trimmed.length - 1) {
            try { return JSON.parse(trimmed.substring(start, end + 1)); }
            catch (_) {}
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

function sanitize(value) {
    return String(value).replace(/[^A-Za-z0-9_.-]/g, "-");
}
