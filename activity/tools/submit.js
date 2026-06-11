// obelisk-agent:tools/webapi.submit-json:
//   func(ffqn: string, params-json: string) -> result<string, string>
export default async function submit_json(ffqn, paramsJson) {
    if (!ffqn) throw "ffqn is required";
    let params;
    try { params = JSON.parse(paramsJson || "[]"); }
    catch (e) { throw `params-json must be valid JSON: ${e.message}`; }
    if (!Array.isArray(params)) throw "params must be a JSON array";

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/executions`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ffqn, params }),
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
