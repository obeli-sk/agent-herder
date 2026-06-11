// obelisk-agent:tools/webapi.list-executions:
//   func(ffqn-prefix: string, length: u32) -> result<string, string>
export default async function list_executions(ffqnPrefix, length) {
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const qs = new URLSearchParams();
    if (ffqnPrefix) qs.set("ffqn_prefix", ffqnPrefix);
    if (length > 0) qs.set("length", String(length));
    const resp = await fetch(`${base}/v1/executions?${qs}`, { headers: { accept: "application/json" } });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
