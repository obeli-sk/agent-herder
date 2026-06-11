// obelisk-agent:tools/webapi.list-deployments:
//   func() -> result<string, string>
export default async function list_deployments() {
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/deployments`, { headers: { accept: "application/json" } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
