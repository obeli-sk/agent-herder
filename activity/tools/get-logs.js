// obelisk-agent:tools/webapi.get-logs:
//   func(execution-id: string) -> result<string, string>
export default async function get_logs(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}/logs?show_derived=true`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
