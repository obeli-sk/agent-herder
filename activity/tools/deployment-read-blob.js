// obelisk-agent:tools/webapi.deployment-read-blob:
//   func(digest: string) -> result<string, string>
//
// Read a deployment file blob from the content-addressed store by its
// `sha256:...` digest and return it as text. The stored deployment_toml
// references owned script/exec sources by `location` + `content_digest`; this
// fetches the body so the workflow can show or edit it.
export default async function deployment_read_blob(digest) {
    if (typeof digest !== "string" || !digest.trim()) throw "digest is required";
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/files/${encodeURIComponent(digest.trim())}`);
    if (resp.status === 404) throw `no blob for digest ${digest}`;
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
