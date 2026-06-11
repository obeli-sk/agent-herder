// obelisk-agent:tools/webapi.get-deployment:
//   func(deployment-id: string, component-type: option<string>,
//        offset: option<u32>, length: option<u32>,
//        max-bytes: option<u32>) -> result<string, string>
//
// Returns the deployment record with component sources stripped: each
// `location.content.content` becomes { file_name, source_bytes }. Stripping
// happens here (not in the workflow) so the durable child-execution result and
// the UI show exactly the compact record the model receives. Fetch full sources
// with webapi.get-component-source.
//
// Without a component selector, the complete record is returned when it fits.
// Oversized records retain component-array prefixes and gain pagination
// metadata describing how many entries were trimmed from each array. Selecting
// a component type returns only a page from that config array.
const MAX_RESULT_BYTES = 96 * 1024;

export default async function get_deployment(deploymentId, componentType, offset, length, maxBytes) {
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
        const componentTypes = Object.keys(config).filter((key) => Array.isArray(config[key]));
        for (const key of componentTypes) {
            const list = config[key];
            for (const item of list) {
                const content = item && item.location && item.location.content;
                if (content && typeof content.content === "string") {
                    item.location.content = { file_name: content.file_name, source_bytes: content.content.length };
                }
            }
        }

        const budget = byteBudget(maxBytes);
        const selectedType = typeof componentType === "string" ? componentType : "";
        const explicitPage = Boolean(selectedType) || offset > 0 || length > 0;
        const originalCounts = {};
        for (const key of componentTypes) originalCounts[key] = config[key].length;
        const offsets = {};
        for (const key of componentTypes) offsets[key] = 0;
        if (explicitPage && !selectedType) {
            throw "component-type is required when offset or length is specified";
        }
        if (selectedType && !componentTypes.includes(selectedType)) {
            throw `unknown component-type ${selectedType}`;
        }

        if (!explicitPage) {
            record.config_json = JSON.stringify(config);
            if (encodedBytes(record) <= budget) return JSON.stringify(record);
        } else {
            const off = clampOffset(offset, config[selectedType].length);
            offsets[selectedType] = off;
            const requested = positiveInt(length);
            const end = requested > 0
                ? Math.min(off + requested, config[selectedType].length)
                : config[selectedType].length;
            const selected = config[selectedType].slice(off, end);
            for (const key of componentTypes) config[key] = [];
            config[selectedType] = selected;
        }

        const pagedTypes = explicitPage ? [selectedType] : componentTypes;
        fitRecord(record, config, pagedTypes, offsets, originalCounts, budget, explicitPage ? selectedType : "");
    }
    return JSON.stringify(record);
}

function fitRecord(record, config, componentTypes, offsets, originalCounts, budget, selectedType) {
    while (true) {
        const components = {};
        let returnedItems = 0;
        let trimmedItems = 0;
        for (const key of componentTypes) {
            const returned = config[key].length;
            const trimmed = originalCounts[key] - offsets[key] - returned;
            returnedItems += returned;
            trimmedItems += trimmed;
            components[key] = {
                offset: offsets[key],
                returned,
                trimmed,
                next_offset: trimmed > 0 ? offsets[key] + returned : null,
            };
        }
        record.config_json = JSON.stringify(config);
        record.pagination = {
            component_type: selectedType || null,
            max_bytes: budget,
            returned_items: returnedItems,
            trimmed_items: trimmedItems,
            components,
        };
        if (encodedBytes(record) <= budget) return;

        let removed = false;
        for (let i = componentTypes.length - 1; i >= 0; i -= 1) {
            const key = componentTypes[i];
            if (config[key].length > 0) {
                config[key].pop();
                removed = true;
                break;
            }
        }
        if (!removed) throw `max-bytes ${budget} is too small for deployment metadata`;
    }
}

function encodedBytes(record) {
    return JSON.stringify(JSON.stringify(record)).length;
}

function byteBudget(value) {
    const requested = positiveInt(value);
    return requested > 0 ? Math.min(requested, MAX_RESULT_BYTES) : MAX_RESULT_BYTES;
}

function positiveInt(value) {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function clampOffset(value, total) {
    const off = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    return Math.min(off, total);
}
