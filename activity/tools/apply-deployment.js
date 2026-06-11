// obelisk-agent:tools/webapi.apply-deployment:
//   func(deployment-id: string) -> result<string, string>
//
// Hot-redeploys an existing deployment via PUT /v1/deployments/{id}/switch
// with {"hot_redeploy": true}. Returns "switched" on success.
export default async function apply_deployment(deploymentId) {
    if (!deploymentId) throw "deployment-id is required";
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}/switch`,
        {
            method: "PUT",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ hot_redeploy: true }),
        },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
