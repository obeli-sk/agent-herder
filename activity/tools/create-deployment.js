// obelisk-agent:tools/webapi.create-deployment:
//   func(config-json: string, verify: bool) -> result<string, string>
//
// Returns the new deployment id. The deployment is **inactive** until a
// separate PUT /v1/deployments/{id}/switch call activates it; we do not
// expose that step.
export default async function create_deployment(configJson, verify) {
    if (!configJson) throw "config-json is required";
    // Validate the input is JSON before sending to the server.
    try { JSON.parse(configJson); }
    catch (e) { throw `config-json must be valid JSON: ${e.message}`; }

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/deployments`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ config_json: configJson, verify: Boolean(verify) }),
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
