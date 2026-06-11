// obelisk-agent:tools/webapi.current-deployment-id:
//   func() -> result<string, string>
export default async function current_deployment_id() {
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/deployment-id`, { headers: { accept: "application/json" } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
