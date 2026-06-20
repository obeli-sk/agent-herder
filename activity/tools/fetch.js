// obelisk-agent:tools/webapi.fetch:
//   func(method: string, path: string, body: option<string>,
//        headers-json: option<string>) -> result<string, string>
//
// Generic Obelisk API fetch wrapper. `path` may be a /v1/... path or an
// absolute URL under OBELISK_API_URL. Returns JSON text:
//   { status, ok, headers, body }
const MAX_BODY_BYTES = 96 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export default async function fetch_tool(method, path, body, headersJson) {
    const verb = String(method || "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(verb)) {
        throw `method must be one of ${Array.from(ALLOWED_METHODS).join(", ")}`;
    }
    const url = resolveUrl(path);
    const headers = parseHeaders(headersJson);
    if (!headers.has("accept")) headers.set("accept", "application/json");

    const init = { method: verb, headers };
    if (body !== null && body !== undefined) {
        if (verb === "GET") throw "GET requests cannot include a body";
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
        init.body = String(body);
    }

    const resp = await fetch(url, init);
    const text = await resp.text();
    return JSON.stringify({
        status: resp.status,
        ok: resp.ok,
        headers: responseHeaders(resp.headers),
        body: trimBody(text),
    });
}

function resolveUrl(path) {
    if (typeof path !== "string" || !path.trim()) throw "path is required";
    const base = (process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005").replace(/\/$/, "");
    const raw = path.trim();
    if (raw.startsWith("/")) return `${base}${raw}`;

    let url;
    try { url = new URL(raw); }
    catch (_) { throw "path must be a /v1/... path or an absolute Obelisk API URL"; }

    const allowed = new URL(base);
    if (url.origin !== allowed.origin) {
        throw `absolute URL origin ${url.origin} is not allowed`;
    }
    return url.toString();
}

function parseHeaders(headersJson) {
    const headers = new Headers();
    if (headersJson === null || headersJson === undefined || headersJson === "") return headers;
    let parsed;
    try { parsed = JSON.parse(headersJson); }
    catch (e) { throw `headers-json must be a JSON object: ${e.message}`; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw "headers-json must be a JSON object";
    }
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") throw `header ${key} must have a string value`;
        headers.set(key, value);
    }
    return headers;
}

function responseHeaders(headers) {
    const out = {};
    for (const [key, value] of headers.entries()) out[key] = value;
    return out;
}

function trimBody(text) {
    const body = typeof text === "string" ? text : "";
    const encoded = JSON.stringify(body).length;
    if (encoded <= MAX_BODY_BYTES) return body;
    return body.slice(0, MAX_BODY_BYTES) + `\n...[truncated at ${MAX_BODY_BYTES} chars]`;
}
