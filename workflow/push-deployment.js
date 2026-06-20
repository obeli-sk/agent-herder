import * as webapi from "obelisk-agent:tools/webapi";
import * as ghRepo from "agent-herder:github/repo";

const OWNER = "obeli-sk";
const REPO = "agent-herder";
const BASE_BRANCH = "main";

export default function pushDeployment(branchName, prTitle, prBody) {
    if (!branchName) throw "branch-name is required";
    if (!prTitle) throw "pr-title is required";
    const body = (typeof prBody === "string" && prBody) ? prBody : "";

    // 1. Discover the live deployment through the generic fetch tool.
    const deploymentId = fetchJson("/v1/deployment-id");
    if (typeof deploymentId !== "string" || !deploymentId) {
        throw "current deployment id was not a non-empty string";
    }
    console.log(`Exporting deployment ${deploymentId} to ${OWNER}/${REPO}@${branchName}`);

    // 2. Pull the manifest TOML.
    const depMeta = fetchJson(`/v1/deployments/${encodeURIComponent(deploymentId)}`);
    const deploymentToml = depMeta.deployment_toml;
    if (typeof deploymentToml !== "string" || !deploymentToml) {
        throw `deployment ${deploymentId} returned no deployment_toml`;
    }

    // 3. Parse (location, digest) tuples for every owned source.
    const sources = collectSources(deploymentToml);
    console.log(`Found ${sources.length} owned source file(s).`);

    // 4. Fetch each source body up front through the generic fetch tool.
    const sourceBodies = [];
    for (let i = 0; i < sources.length; i++) {
        const [location, digest] = sources[i];
        const text = fetchText(`/v1/files/${encodeURIComponent(digest)}`);
        sourceBodies.push([location, text]);
    }

    // 5. Create the branch.
    let head = ghRepo.createBranch(OWNER, REPO, BASE_BRANCH, branchName);
    console.log(`Created branch ${branchName} at ${head}`);

    // 6. First commit: deployment.toml.
    head = ghRepo.pushFile(
        OWNER, REPO, branchName, head,
        "deployment.toml",
        deploymentToml,
        `Export deployment.toml`,
        `From Obelisk deployment ${deploymentId}.`,
    );
    console.log(`Committed deployment.toml -> ${head}`);

    // 7. One commit per source file, chaining the head OID.
    for (let i = 0; i < sourceBodies.length; i++) {
        const [location, text] = sourceBodies[i];
        head = ghRepo.pushFile(
            OWNER, REPO, branchName, head,
            location,
            text,
            `Export ${location}`,
            `From Obelisk deployment ${deploymentId}.`,
        );
        console.log(`Committed ${location} -> ${head}`);
    }

    // 8. Open the PR.
    const prUrl = ghRepo.createPr(
        OWNER, REPO, branchName, BASE_BRANCH, prTitle,
        body || `Exported Obelisk deployment ${deploymentId} (${sourceBodies.length + 1} files).`,
    );
    console.log(`Opened PR: ${prUrl}`);
    return prUrl;
}

// Walk the manifest and pull out (location, content_digest) for every owned
// source. Dedupes by location because multiple components may share a file
// (claude.start and codex.start both point at agent-start.js).
function collectSources(toml) {
    const seen = new Set();
    const out = [];
    const blockRe = /\[\[(activity_js|activity_exec|workflow_js|webhook_endpoint_js)\]\]([\s\S]*?)(?=\n\[\[|$)/g;
    let m;
    while ((m = blockRe.exec(toml)) !== null) {
        const block = m[2];
        const locM = block.match(/^\s*location\s*=\s*"([^"]+)"/m);
        const digestM = block.match(/^\s*content_digest\s*=\s*"([^"]+)"/m);
        if (!locM || !digestM) continue;
        const location = locM[1];
        if (location.startsWith("oci://") || seen.has(location)) continue;
        seen.add(location);
        out.push([location, digestM[1]]);
    }
    return out;
}

function fetchJson(path) {
    const body = fetchText(path);
    try { return JSON.parse(body); }
    catch (e) { throw `${path} returned non-JSON body: ${e.message}`; }
}

function fetchText(path) {
    const raw = webapi.fetch("GET", path, null, null);
    let response;
    try { response = JSON.parse(raw); }
    catch (e) { throw `fetch wrapper returned non-JSON result for ${path}: ${e.message}`; }
    if (!response || typeof response !== "object") {
        throw `fetch wrapper returned invalid result for ${path}`;
    }
    if (!response.ok) {
        throw `${path}: HTTP ${response.status}: ${response.body || ""}`;
    }
    return typeof response.body === "string" ? response.body : "";
}
