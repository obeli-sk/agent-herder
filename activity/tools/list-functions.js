// obelisk-agent:tools/webapi.list-functions:
//   func(ffqn-prefix: string, length: u32) -> result<string, string>
export default async function list_functions(ffqnPrefix, length) {
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(`${base}/v1/functions`, {
        headers: { accept: "application/json" },
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;

    const functions = await resp.json();
    if (!Array.isArray(functions)) throw "invalid functions response";
    const prefix = String(ffqnPrefix || "");
    const limit = length > 0 ? length : 100;
    return JSON.stringify(functions
        .filter((item) => item && typeof item.ffqn === "string" && item.ffqn.startsWith(prefix))
        .slice(0, limit));
}
