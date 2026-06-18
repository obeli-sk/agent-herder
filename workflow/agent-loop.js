import * as session from "obelisk-agent:agent/session";
import * as webapi from "obelisk-agent:tools/webapi";
import * as askUser from "obelisk-agent:tools/input";
import * as deploy from "obelisk-agent:tools/deploy";

const RECV_TIMEOUT_MS = 30000;
const MAX_TURNS = 30;          // hard cap on agent loop turns
const MAX_CORRECTIONS = 3;     // re-prompts allowed per turn for a malformed reply
const MAX_TOOL_RESULT_BYTES = 96 * 1024;  // encoded-size cap per tool_result (argv-safe)
const INJECTION_FFQN = "obelisk-agent:agent/session.injection";

export default function agentLoop(prompt, socketPath) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    if (typeof socketPath !== "string" || !socketPath) {
        throw "socket path is required";
    }
    // agent-input variant: { prompt } for the first turn, then { tool_results }.
    let nextInput = { prompt };
    let finalAnswer = null;
    let injection = null;
    // Checked-out deployment working copy. The verbatim deployment.toml is split
    // into per-component blocks; the agent edits one component at a time and each
    // submit produces a new intermediate deployment (see the deployment_* tools).
    const deploymentDraft = {
        checkedOut: false,
        baseDeploymentId: null,
        activeDeploymentId: null,
        preamble: "",
        blocks: [],            // [{ section, id, location, digest, hasScript, text }]
        editedFiles: {},       // location -> edited source text (for the next submit)
        dirty: [],             // component keys changed since the base (max one)
    };

    try {
        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            console.log(`--- turn ${turn} ---`);
            const prepared = prepareInjection(injection);
            injection = prepared.injection;
            const reply = sendAndDrain(socketPath, nextInput, prepared.operatorMessages);

            if (typeof reply.final === "string") {
                finalAnswer = reply.final;
                console.log(`final after ${turn + 1} turns`);
                break;
            }
            if (typeof reply.error === "string") {
                console.log(`agent requested error after ${turn + 1} turns`);
                throw reply.error;
            }
            if (Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0) {
                // Explicit human gates own the input UI while blocked. Cancel the
                // generic injection offer before entering either stub activity.
                if (reply.tool_calls.some(isBlockingHumanTool)) {
                    closeInjection(injection);
                    injection = null;
                }
                console.log(`dispatching ${reply.tool_calls.length} tool call(s)`);
                const results = reply.tool_calls.map((call) => {
                    const result = dispatch(call, deploymentDraft);
                    console.log(`  ${call?.name}: ${"ok" in result.outcome ? "ok" : `err=${result.outcome.err}`}`);
                    return result;
                });
                // A hot redeploy (deployment_activate mode "apply") is terminal:
                // the switch runs out of process after this workflow finishes, so
                // we must not continue the loop past it.
                const applyIndex = reply.tool_calls.findIndex(isHotApplyPush);
                if (applyIndex !== -1) {
                    const applyResult = results[applyIndex];
                    if ("ok" in applyResult.outcome) {
                        finalAnswer = `Deployment hot reload approved and scheduled: ${applyResult.outcome.ok}`;
                    } else {
                        finalAnswer = `Deployment hot reload was not scheduled: ${applyResult.outcome.err}`;
                    }
                    console.log("deployment_activate(apply) is terminal; finishing workflow before switch");
                    break;
                }
                nextInput = { tool_results: results };
                continue;
            }
            throw `agent reply had no final answer and no tool calls: ${JSON.stringify(reply).slice(0, 500)}`;
        }
    } finally {
        closeInjection(injection);
    }

    if (finalAnswer === null) {
        throw `exceeded MAX_TURNS=${MAX_TURNS} without a final answer`;
    }
    return finalAnswer;
}

// Keep exactly one durable operator-input stub outstanding while the agent can
// accept generic steering. A completed response is consumed at a send boundary,
// included in that normal session.send call, and replaced with a fresh stub.
function prepareInjection(injection) {
    let current = injection || openInjection();
    const text = current.joinSet.joinNextTry();
    if (text === undefined) return { injection: current, operatorMessages: [] };
    if (typeof text !== "string" || !text.trim()) {
        throw "injection text must be a non-empty string";
    }
    console.log(`consumed operator injection from ${current.executionId}`);
    current.joinSet.close();
    current = openInjection();
    return { injection: current, operatorMessages: [text.trim()] };
}

function openInjection() {
    const joinSet = obelisk.createJoinSet();
    const executionId = joinSet.submit(INJECTION_FFQN, []);
    console.log(`opened operator injection ${executionId}`);
    return { joinSet, executionId };
}

function closeInjection(injection) {
    if (injection === null) return;
    try { injection.joinSet.close(); }
    catch (error) { console.log(`injection close failed: ${String(error)}`); }
}

function isBlockingHumanTool(call) {
    return call?.name === "input.ask_user" || isHotApplyPush(call);
}

// A deployment_activate requesting a hot redeploy: it parks on the confirm-apply
// human gate and is terminal, so it owns the input UI while blocked.
function isHotApplyPush(call) {
    if (call?.name !== "obelisk.deployment_activate") return false;
    try {
        const args = call.arguments_json ? JSON.parse(call.arguments_json) : {};
        return args && args.mode === "apply";
    } catch (_) {
        return false;
    }
}

// Send one agent-input and drain the turn into a typed agent-reply
// ({ final } | { error } | { tool_calls }). Two recoverable agent-errors are
// handled here:
//   - permanent-rate-limited: durably sleep until the limit resets, then re-send
//     the same input. The supervisor can cancel this whole workflow at any time.
//   - permanent-malformed-reply: the agent's reply didn't parse as the envelope.
//     Re-prompt it (up to MAX_CORRECTIONS) to re-emit a bare JSON envelope.
// Both arms are `permanent-` so Obelisk never auto-retries the recv activity;
// recovery is the workflow's job because it requires another send.
function sendAndDrain(socketPath, input, operatorMessages) {
    let pending = input;
    let pendingOperatorMessages = operatorMessages;
    let corrections = 0;
    while (true) {
        session.send(socketPath, pending, pendingOperatorMessages);
        pendingOperatorMessages = [];
        try {
            return drainTurn(socketPath);
        } catch (error) {
            const limit = rateLimited(error);
            if (limit) {
                const seconds = limit.retry_after_seconds > 0 ? limit.retry_after_seconds : 1;
                console.log(`session limit reached (${limit.message}); sleeping ${seconds}s until reset`);
                obelisk.sleep({ seconds });
                console.log("rate-limit sleep elapsed; retrying turn");
                // Loop: re-send the same input now that the limit should be lifted.
                continue;
            }
            const malformed = malformedReply(error);
            if (malformed && corrections < MAX_CORRECTIONS) {
                corrections += 1;
                console.log(`malformed reply (correction ${corrections}/${MAX_CORRECTIONS}): ${malformed}`);
                pending = { prompt: correctionPrompt(malformed) };
                continue;
            }
            throw error;
        }
    }
}

// Corrective user message after a reply whose tool-call JSON didn't parse.
function correctionPrompt(detail) {
    return [
        "Your previous reply looked like it requested tools but the JSON could",
        "not be parsed.",
        `Parse error: ${detail}`,
        'To call tools, include a valid JSON object {"tool_calls": [{"name":',
        '"<tool>", "args": { ... }}]} (a ```json block is fine). If you are not',
        'calling tools, reply with {"error":"<reason>"} to fail the execution,',
        "or just reply with your final answer as plain text.",
    ].join(" ");
}

// recv stays alive for the whole turn and returns { reply: agent-reply } once
// it completes. Failures are thrown as the agent-error variant payload.
function drainTurn(socketPath) {
    const outcome = session.recv(socketPath, RECV_TIMEOUT_MS);
    // turn-outcome::reply is now a record { reply: agent-reply, narration }; the
    // workflow only needs the agent-reply (narration is for the UI). Tolerate the
    // old bare-agent-reply shape from results persisted before this change.
    if (outcome && typeof outcome === "object" && outcome.reply) {
        const r = outcome.reply;
        return (r && typeof r === "object" && "reply" in r) ? r.reply : r;
    }
    throw `unexpected recv outcome: ${JSON.stringify(outcome)}`;
}

// When an activity returns its err arm, the workflow runtime throws a JS Error
// whose `message` is the JSON-encoded err value (workflow-js-runtime:
// `Error(err_json)`). Parse it back into the agent-error variant object so the
// arms below can inspect it; non-JSON errors (traps, etc.) yield null.
function errPayload(error) {
    const raw = (error && typeof error === "object" && typeof error.message === "string")
        ? error.message
        : (typeof error === "string" ? error : null);
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
        return null;
    }
}

// recv's permanent-rate-limited arm: { permanent_rate_limited: { retry_after_seconds, message } }.
function rateLimited(error) {
    const p = errPayload(error);
    if (p && p.permanent_rate_limited && typeof p.permanent_rate_limited === "object") {
        return p.permanent_rate_limited;
    }
    return null;
}

// recv's permanent-malformed-reply arm: { permanent_malformed_reply: "<parse error>" }.
function malformedReply(error) {
    const p = errPayload(error);
    if (p && typeof p.permanent_malformed_reply === "string") {
        return p.permanent_malformed_reply;
    }
    return null;
}

// Dispatch one tool-call ({ name, arguments_json }) to its Obelisk activity and
// return a typed tool-result ({ name, outcome: result<string, string> }). The
// ok arm carries the activity's JSON string verbatim; server.js parses it back
// into structured data for the agent.
function dispatch(call, draft) {
    const name = (call && typeof call.name === "string") ? call.name : "?";
    let args;
    try {
        args = call && call.arguments_json ? JSON.parse(call.arguments_json) : {};
    } catch (e) {
        return err(name, `invalid arguments_json: ${String(e)}`);
    }
    if (typeof args !== "object" || args === null) args = {};

    try {
        switch (name) {
            case "obelisk.list_functions":
                return ok(name, webapi.listFunctions(
                    String(args.ffqn_prefix || ""),
                    (args.length | 0) || 100,
                ));
            case "obelisk.get_function_wit":
                return ok(name, webapi.getFunctionWit(requireString(args.ffqn, "ffqn")));
            case "obelisk.list_executions": {
                const len = (args.length | 0) || 20;
                return ok(name, webapi.listExecutions(
                    String(args.ffqn_prefix || ""),
                    String(args.execution_id_prefix || ""),
                    Boolean(args.show_derived),
                    Boolean(args.hide_finished),
                    String(args.component_digest || ""),
                    String(args.deployment_id || ""),
                    String(args.cursor || ""),
                    paginationDirection(args.direction),
                    Boolean(args.including_cursor),
                    len,
                ));
            }
            case "obelisk.get_execution":
                return ok(name, webapi.getExecution(requireString(args.execution_id, "execution_id")));
            case "obelisk.get_logs":
                return ok(name, webapi.getLogs(
                    requireString(args.execution_id, "execution_id"),
                    args.show_derived === undefined ? true : Boolean(args.show_derived),
                    args.show_logs === undefined ? true : Boolean(args.show_logs),
                    args.show_streams === undefined ? true : Boolean(args.show_streams),
                    arrayArgOr(args.levels, []),
                    arrayArgOr(args.stream_types, []),
                    String(args.cursor || ""),
                    paginationDirection(args.direction),
                    Boolean(args.including_cursor),
                    (args.length | 0) || 200,
                ));
            case "obelisk.submit":
                return ok(name, webapi.submitJson(
                    requireString(args.ffqn, "ffqn"),
                    JSON.stringify(Array.isArray(args.params) ? args.params : []),
                ));
            case "obelisk.get_result":
                return ok(name, webapi.getResultJson(requireString(args.execution_id, "execution_id")));
            case "obelisk.list_deployments":
                return ok(name, webapi.listDeployments(
                    String(args.cursor_from || ""),
                    Boolean(args.including_cursor),
                    (args.length | 0) || 20,
                ));
            case "obelisk.get_deployment":
                // Returns the record with the verbatim deployment_toml (paged by
                // byte window server-side so the child result fits the budget).
                return ok(name, webapi.getDeployment(
                    requireString(args.deployment_id, "deployment_id"),
                    optionalString(args.component_type),
                    optionalU32(args.offset),
                    optionalU32(args.length),
                    optionalU32(args.max_bytes),
                ));
            case "obelisk.get_component_source":
                // Sliced server-side so the child result is just the requested page.
                return ok(name, webapi.getComponentSource(
                    requireString(args.deployment_id, "deployment_id"),
                    requireString(args.component, "component"),
                    args.offset | 0,
                    args.length | 0,
                ));
            case "obelisk.current_deployment_id":
                return ok(name, webapi.currentDeploymentId());
            case "obelisk.deployment_checkout":
                return deploymentCheckout(name, args, draft);
            case "obelisk.deployment_list_components":
                return deploymentListComponents(name, draft);
            case "obelisk.deployment_read_component":
                return deploymentReadComponent(name, args, draft);
            case "obelisk.deployment_put_component":
                return deploymentPutComponent(name, args, draft);
            case "obelisk.deployment_remove_component":
                return deploymentRemoveComponent(name, args, draft);
            case "obelisk.deployment_submit":
                return deploymentSubmit(name, args, draft);
            case "obelisk.deployment_activate":
                return deploymentActivate(name, args, draft);
            case "input.ask_user":
                return ok(name, JSON.stringify({ answer: askUser.askUser(requireString(args.question, "question")) }));
            default:
                return err(name, `unknown tool: ${name}`);
        }
    } catch (e) {
        return err(name, String(e));
    }
}

// --- Deployment working copy (checkout -> edit one component -> submit) -------
//
// The verbatim stored deployment.toml is the source of truth. The workflow
// splits it into top-level component blocks ([[activity_js]], [[workflow_wasm]],
// ...), each kept as exact text plus parsed metadata (section, id, owned script
// location/digest). The agent edits ONE component at a time (its TOML snippet
// and, for owned JS/exec components, its script body); each submit fills the
// content digests and stores a new intermediate, inactive deployment. After a
// successful submit the working copy rebases onto that new deployment, so a big
// change is chopped into many small, server-validated deployments.

function requireDraft(draft) {
    if (!draft || !draft.checkedOut) {
        throw "no deployment checked out; call deployment_checkout first";
    }
}

function componentKey(section, id) {
    return `${section}:${id}`;
}

// Split a deployment.toml into a (usually empty) preamble and one block per
// top-level [[section]]. Comment/blank lines lead the block that follows them;
// every source line is preserved so assembleToml reproduces the input verbatim.
function splitComponents(toml) {
    const lines = toml.split("\n");
    const blocks = [];
    let current = null;   // source lines for the open block
    let buffer = [];      // pending comment/blank lines (lead the next block)
    const isTopHeader = (line) => {
        const t = line.trim();
        return t.startsWith("[[") && t.endsWith("]]") && !t.slice(2, -2).includes(".");
    };
    const isCommentOrBlank = (line) => {
        const t = line.trim();
        return t === "" || t.startsWith("#");
    };
    for (const line of lines) {
        if (isTopHeader(line)) {
            if (current) blocks.push(current);
            current = [];
            for (const b of buffer) current.push(b);
            buffer = [];
            current.push(line);
        } else if (current === null) {
            buffer.push(line);                 // preamble, before any component
        } else if (isCommentOrBlank(line)) {
            buffer.push(line);                 // trailing of current or leading of next
        } else {
            for (const b of buffer) current.push(b);
            buffer = [];
            current.push(line);
        }
    }
    let preamble = "";
    if (current) {
        for (const b of buffer) current.push(b);   // trailing lines stay with the last block
        blocks.push(current);
    } else {
        preamble = buffer.join("\n");
    }
    return { preamble, blocks: blocks.map(blockFromLines) };
}

// Build a block record from its source lines: section from the header and the
// main-table keys (ffqn/name/location/content_digest), stopping at the first
// sub-table so an [[activity_js.allowed_host]] key is never read as the id.
function blockFromLines(lines) {
    const text = lines.join("\n");
    let section = null;
    const meta = { ffqn: null, name: null, location: null, digest: null };
    let seenHeader = false;
    for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("[")) {
            if (!seenHeader && t.startsWith("[[")) {
                section = t.slice(2, t.indexOf("]"));
                seenHeader = true;
                continue;
            }
            break;                              // a sub-table ends the main table
        }
        if (!seenHeader) continue;
        for (const key of ["ffqn", "name", "location", "content_digest"]) {
            const value = keyStringValue(line, key);
            if (value !== null) meta[key === "content_digest" ? "digest" : key] = value;
        }
    }
    const id = meta.ffqn || meta.name || "?";
    return {
        section: section || "?",
        id,
        location: meta.location,
        digest: meta.digest,
        hasScript: Boolean(meta.location) && isOwnedPath(meta.location),
        text,
    };
}

// A deployment-owned (editable) path: relative or ${DEPLOYMENT_DIR}-anchored,
// not an oci:// reference.
function isOwnedPath(location) {
    return typeof location === "string" && !location.startsWith("oci://");
}

// Parse a `key = "value"` line, returning the string value when the key matches.
function keyStringValue(line, key) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) return null;
    const rest = trimmed.slice(key.length).trim();
    if (!rest.startsWith("=")) return null;
    const value = rest.slice(1).trim();
    if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return null;
    return value.slice(1, -1);
}

function assembleToml(draft) {
    const parts = draft.blocks.map((b) => b.text);
    if (draft.preamble) parts.unshift(draft.preamble);
    return parts.join("\n");
}

function componentSummary(draft) {
    return draft.blocks.map((b) => ({
        section: b.section,
        id: b.id,
        location: b.location || null,
        has_script: b.hasScript,
    }));
}

function resetDraft(draft, preamble, blocks, baseId, activeId) {
    draft.preamble = preamble;
    draft.blocks = blocks;
    draft.baseDeploymentId = baseId;
    draft.activeDeploymentId = activeId;
    draft.editedFiles = {};
    draft.dirty = [];
}

function deploymentCheckout(name, args, draft) {
    rejectUnknownArgs(args, ["deployment_id", "from_scratch"], "deployment_checkout");
    if (args.from_scratch) {
        resetDraft(draft, "", [], null, draft.activeDeploymentId);
        draft.checkedOut = true;
        return ok(name, JSON.stringify({
            base_deployment_id: null,
            active_deployment_id: draft.activeDeploymentId,
            components: [],
            note: "Empty working copy. Add components with deployment_put_component, then "
                + "deployment_submit. Each submit stores one intermediate deployment.",
        }));
    }
    const json = webapi.deploymentCheckout(optionalString(args.deployment_id));
    const res = JSON.parse(json);
    if (typeof res.deployment_toml !== "string") throw "checkout returned no deployment_toml";
    const split = splitComponents(res.deployment_toml);
    resetDraft(draft, split.preamble, split.blocks, res.deployment_id, res.active_deployment_id);
    draft.checkedOut = true;
    return ok(name, JSON.stringify({
        base_deployment_id: draft.baseDeploymentId,
        active_deployment_id: draft.activeDeploymentId,
        components: componentSummary(draft),
        note: "Read a component with deployment_read_component (returns its TOML and, for "
            + "owned JS/exec components, the script body). Change exactly one component with "
            + "deployment_put_component / deployment_remove_component, then deployment_submit "
            + "to store an intermediate deployment. Activate with deployment_activate.",
    }));
}

function deploymentListComponents(name, draft) {
    requireDraft(draft);
    return ok(name, JSON.stringify({
        base_deployment_id: draft.baseDeploymentId,
        components: componentSummary(draft),
        pending_changes: draft.dirty,
    }));
}

function findBlock(draft, section, id) {
    return draft.blocks.findIndex((b) => b.section === section && b.id === id);
}

function deploymentReadComponent(name, args, draft) {
    requireDraft(draft);
    rejectUnknownArgs(args, ["section", "id"], "deployment_read_component");
    const section = requireString(args.section, "section");
    const id = requireString(args.id, "id");
    const index = findBlock(draft, section, id);
    if (index === -1) throw `no ${section} component with id ${id}; list with deployment_list_components`;
    const block = draft.blocks[index];
    const result = { section, id, location: block.location || null, toml: block.text };
    if (block.hasScript) {
        result.script = readScript(draft, block);
        result.content_digest = block.digest || null;
    }
    return ok(name, JSON.stringify(result));
}

// Return the owned script body for a block: a pending edit if present, else the
// CAS blob named by its content_digest.
function readScript(draft, block) {
    if (block.location in draft.editedFiles) return draft.editedFiles[block.location];
    if (!block.digest) return "";   // newly added, no digest yet
    return webapi.deploymentReadBlob(block.digest);
}

function deploymentPutComponent(name, args, draft) {
    requireDraft(draft);
    rejectUnknownArgs(args, ["section", "id", "toml", "script"], "deployment_put_component");
    const section = requireString(args.section, "section");
    const id = requireString(args.id, "id");
    const tomlText = requireString(args.toml, "toml");

    const parsed = splitComponents(tomlText);
    if (parsed.blocks.length !== 1 || parsed.preamble.trim()) {
        throw "toml must contain exactly one [[section]] component block";
    }
    const block = parsed.blocks[0];
    if (block.section !== section) throw `toml section [[${block.section}]] does not match section ${section}`;
    if (block.id !== id) throw `toml component id ${block.id} does not match id ${id}`;

    const hasScript = typeof args.script === "string";
    if (hasScript) {
        if (!block.location) throw 'toml must set location = "<path>" to attach a script';
        if (!isOwnedPath(block.location)) throw `location ${block.location} is not a deployment-owned path`;
    }

    const key = componentKey(section, id);
    guardSingleChange(draft, key);

    const index = findBlock(draft, section, id);
    const action = index === -1 ? "added" : "replaced";
    if (index === -1) draft.blocks.push(block);
    else draft.blocks[index] = block;
    if (hasScript) draft.editedFiles[block.location] = args.script;
    markDirty(draft, key);

    return ok(name, JSON.stringify({
        action, section, id, location: block.location || null,
        script_attached: hasScript, pending_changes: draft.dirty,
    }));
}

function deploymentRemoveComponent(name, args, draft) {
    requireDraft(draft);
    rejectUnknownArgs(args, ["section", "id"], "deployment_remove_component");
    const section = requireString(args.section, "section");
    const id = requireString(args.id, "id");
    const index = findBlock(draft, section, id);
    if (index === -1) return ok(name, JSON.stringify({ action: "already_absent", section, id }));
    const key = componentKey(section, id);
    guardSingleChange(draft, key);
    const [removed] = draft.blocks.splice(index, 1);
    if (removed.location) delete draft.editedFiles[removed.location];
    markDirty(draft, key);
    return ok(name, JSON.stringify({ action: "removed", section, id, pending_changes: draft.dirty }));
}

// Enforce one component changed per intermediate deployment, so the server
// validates a small diff. Repeated edits to the same component are allowed.
function guardSingleChange(draft, key) {
    if (draft.dirty.length > 0 && !draft.dirty.includes(key)) {
        throw `only one component may change per deployment; submit the pending change to ${draft.dirty[0]} first, then edit ${key}`;
    }
}

function markDirty(draft, key) {
    if (!draft.dirty.includes(key)) draft.dirty.push(key);
}

function deploymentSubmit(name, args, draft) {
    requireDraft(draft);
    rejectUnknownArgs(args, ["description", "allow_missing_runtime_config", "deployment_id"], "deployment_submit");
    const description = requireString(args.description, "description");
    const allowMissing = Boolean(args.allow_missing_runtime_config);
    const requestedId = optionalString(args.deployment_id) || "";

    const toml = assembleToml(draft);
    // Only ship blobs for files still referenced by a block.
    const locations = new Set(draft.blocks.map((b) => b.location).filter(Boolean));
    const editedFiles = Object.entries(draft.editedFiles)
        .filter(([path]) => locations.has(path))
        .map(([path, content]) => ({ path, content }));

    const resJson = webapi.deploymentSubmit(
        toml, JSON.stringify(editedFiles), description, allowMissing, requestedId,
    );
    const res = JSON.parse(resJson);
    const deploymentId = res.deployment_id;

    // Rebase the working copy onto the stored deployment so editing continues
    // from the just-submitted state (digests filled, blobs now in the CAS).
    if (typeof res.deployment_toml === "string") {
        const split = splitComponents(res.deployment_toml);
        resetDraft(draft, split.preamble, split.blocks, deploymentId, draft.activeDeploymentId);
    } else {
        resetDraft(draft, draft.preamble, draft.blocks, deploymentId, draft.activeDeploymentId);
    }
    return ok(name, JSON.stringify({ deployment_id: deploymentId, status: "submitted (inactive)" }));
}

function deploymentActivate(name, args, draft) {
    rejectUnknownArgs(args, ["deployment_id", "mode", "allow_missing_runtime_config", "summary"], "deployment_activate");
    const mode = requireString(args.mode, "mode");
    if (!["enqueue", "apply"].includes(mode)) throw "mode must be enqueue or apply";
    const deploymentId = optionalString(args.deployment_id) || draft.baseDeploymentId;
    if (!deploymentId) throw "deployment_id is required (or submit a deployment first)";
    const allowMissing = Boolean(args.allow_missing_runtime_config);

    if (mode === "enqueue") {
        const sw = webapi.deploymentSwitch(deploymentId, allowMissing);
        return ok(name, JSON.stringify({ deployment_id: deploymentId, mode, status: "enqueued for next restart", switch: sw }));
    }
    // apply: durable human gate, then schedule the hot switch out of process (a
    // synchronous switch from inside this activity would deadlock the executor).
    // A hot redeploy is always strict, so allow_missing_runtime_config is ignored.
    const summary = optionalString(args.summary) || `hot redeploy ${deploymentId}`;
    deploy.confirmApply(deploymentId, summary);
    const applied = webapi.applyDeployment(deploymentId);
    return ok(name, JSON.stringify({ deployment_id: deploymentId, mode, status: "hot reload scheduled", apply: applied }));
}

// Reject argument keys the tool does not consume, so a misnamed or unsupported
// field surfaces as an error instead of being silently dropped.
function rejectUnknownArgs(args, allowed, tool) {
    if (!args || typeof args !== "object") return;
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) {
        throw `${tool}: unknown argument(s) ${extra.join(", ")}; allowed: ${allowed.join(", ")}`;
    }
}

function arrayArgOr(value, fallback) {
    return Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []);
}

function paginationDirection(value) {
    if (value === undefined || value === null || value === "") return "";
    if (value !== "older" && value !== "newer") {
        throw "direction must be older or newer";
    }
    return value;
}

function ok(name, jsonString) {
    const s = typeof jsonString === "string" ? jsonString : JSON.stringify(jsonString);
    // The result rides back inside session.send's single argv param, which is
    // JSON-encoded (escaping can roughly double it). Bound the encoded size so a
    // tool_result cannot exceed the OS argv limit (MAX_ARG_STRLEN, 128 KiB) and
    // crash send with E2BIG. Oversized results become an err the model can act on.
    const encoded = JSON.stringify(s).length;
    if (encoded > MAX_TOOL_RESULT_BYTES) {
        return err(name, `result too large (~${encoded} encoded bytes); narrow the request with pagination or a more specific selector`);
    }
    return { name, outcome: { ok: s } };
}
function err(name, message) { return { name, outcome: { err: message } }; }

function requireString(value, field) {
    if (typeof value !== "string" || !value) throw `${field} is required`;
    return value;
}

function optionalString(value) {
    return typeof value === "string" && value ? value : null;
}

function optionalU32(value) {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}
