// obelisk-agent:tools/webapi.get-component-source:
//   func(deployment-id: string, kind: string, id: string,
//        offset: u32, length: u32) -> result<string, string>
//
// One component's source, sliced server-side and paginated by character offset
// (length 0 => default page). Doing the slice here keeps the durable
// child-execution result (and the UI) equal to the page the model receives,
// instead of the whole deployment. Returns
//   { kind, id, file_name, source_bytes, offset, length, next_offset, raw_body }
// where raw_body is the page; server.js renders it to the model verbatim.
const MAX_PAGE = 32 * 1024;

export default async function get_component_source(deploymentId, kind, id, offset, length) {
    if (!deploymentId) throw "deployment-id is required";
    if (!kind) throw "kind is required";
    if (!id) throw "id is required";
    const spec = {
        js_activity: { key: "activities_js", matches: (item) => item?.ffqn === id },
        js_workflow: { key: "workflows_js", matches: (item) => item?.ffqn === id },
        js_webhook: { key: "webhooks_js", matches: (item) => item?.name === id },
    }[kind];
    if (!spec) throw "kind must be js_activity, js_workflow, or js_webhook";

    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(
        `${base}/v1/deployments/${encodeURIComponent(deploymentId)}`,
        { headers: { accept: "application/json" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    const config = JSON.parse(JSON.parse(await resp.text()).config_json);
    const list = Array.isArray(config[spec.key]) ? config[spec.key] : [];
    const item = list.find(spec.matches);
    if (!item) throw `no ${kind} with id ${id} in ${deploymentId}`;
    const content = item.location && item.location.content && item.location.content.content;
    if (typeof content !== "string") throw `${kind} ${id} has no inline source`;

    const total = content.length;
    let off = Number.isFinite(offset) ? Math.trunc(offset) : 0;
    if (off < 0) off = 0;
    if (off > total) off = total;
    let len = Number.isFinite(length) && length > 0 ? Math.trunc(length) : MAX_PAGE;
    if (len > MAX_PAGE) len = MAX_PAGE;
    const slice = content.slice(off, off + len);
    const nextOffset = off + slice.length;
    return JSON.stringify({
        kind,
        id,
        file_name: item.location.content.file_name,
        source_bytes: total,
        offset: off,
        length: slice.length,
        next_offset: nextOffset < total ? nextOffset : null,
        raw_body: slice,
    });
}
