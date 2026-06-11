// obelisk-agent:tools/webapi.get-deployment:
//   func(deployment-id: string) -> result<string, string>
//
// Returns the deployment record with component sources stripped: each
// `location.content.content` becomes { file_name, source_bytes }. Stripping
// happens here (not in the workflow) so the durable child-execution result and
// the UI show exactly the compact record the model receives. Fetch full sources
// with webapi.get-component-source.
export default async function get_deployment(deploymentId) {
    if (!deploymentId) throw "deployment-id is required";
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    const record = JSON.parse(await resp.text());
    if (typeof record.config_json === "string") {
        const config = JSON.parse(record.config_json);
        for (const key of Object.keys(config)) {
            const list = config[key];
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                const content = item && item.location && item.location.content;
                if (content && typeof content.content === "string") {
                    item.location.content = { file_name: content.file_name, source_bytes: content.content.length };
                }
            }
        }
        record.config_json = JSON.stringify(config);
    }
    return JSON.stringify(record);
}
