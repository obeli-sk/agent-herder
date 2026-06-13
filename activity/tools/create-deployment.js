// obelisk-agent:tools/webapi.create-deployment:
//   func(config-json: string, verify: bool) -> result<string, string>
//
// Returns the new deployment id. The deployment is **inactive** until a
// separate PUT /v1/deployments/{id}/switch call activates it; we do not
// expose that step.
export default async function create_deployment(configJson, verify) {
    if (!configJson) throw "config-json is required";
    let config;
    try { config = JSON.parse(configJson); }
    catch (e) { throw `config-json must be valid JSON: ${e.message}`; }
    restoreCanonicalBacktraceMaps(config);
    configJson = JSON.stringify(config);

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/deployments`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ config_json: configJson, verify: Boolean(verify) }),
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}

function restoreCanonicalBacktraceMaps(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw "config-json must contain a JSON object";
    }
    for (const key of ["workflows_wasm", "webhooks_wasm"]) {
        const components = config[key];
        if (!Array.isArray(components)) continue;
        for (const component of components) {
            if (!component || typeof component !== "object" || Array.isArray(component)) continue;
            if (!component.backtrace || typeof component.backtrace !== "object"
                || Array.isArray(component.backtrace)) {
                component.backtrace = {};
            }
            if (!component.backtrace.frame_files_to_sources
                || typeof component.backtrace.frame_files_to_sources !== "object"
                || Array.isArray(component.backtrace.frame_files_to_sources)) {
                component.backtrace.frame_files_to_sources = {};
            }
        }
    }
}
