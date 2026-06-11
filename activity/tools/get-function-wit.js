// obelisk-agent:tools/webapi.get-function-wit:
//   func(ffqn: string) -> result<string, string>
export default async function get_function_wit(ffqn) {
    if (!ffqn) throw "ffqn is required";
    const base = process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005";
    const resp = await fetch(
        `${base}/v1/functions/wit?ffqn=${encodeURIComponent(ffqn)}`,
        { headers: { accept: "text/plain" } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
