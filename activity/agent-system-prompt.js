const OBELISK_DOCS_URL = 'https://obeli.sk/docs/latest/llms.txt/';
const nl = String.fromCharCode(10);

function tool(name, purpose, args, notes = []) {
    return { name, purpose, args, notes };
}

const TOOL_SCHEMAS = [
    tool('obelisk.list_functions', 'Discover callable Obelisk FFQNs before submitting executions or reading WIT.', {
        ffqn_prefix: 'string, optional',
        length: 'u32, optional; default 100',
    }),
    tool('obelisk.get_function_wit', 'Return the WIT signature for one FFQN. Use it before obelisk.submit when parameter types are not already known.', {
        ffqn: 'string, required',
    }),
    tool('obelisk.list_executions', 'Page through executions, optionally filtered by function, execution id prefix, component digest, deployment, and state.', {
        ffqn_prefix: 'string, optional',
        execution_id_prefix: 'string, optional',
        show_derived: 'bool, optional',
        hide_finished: 'bool, optional',
        component_digest: 'string, optional',
        deployment_id: 'string, optional',
        cursor: 'string, optional',
        direction: 'enum string, optional; older or newer',
        including_cursor: 'bool, optional',
        length: 'u32, optional; default 20',
    }),
    tool('obelisk.get_execution', 'Read one execution record, including status, FFQN, timestamps, deployment id, and component metadata.', {
        execution_id: 'string, required',
    }),
    tool('obelisk.get_logs', 'Read paginated logs and stream events for an execution.', {
        execution_id: 'string, required',
        show_derived: 'bool, optional; default true',
        show_logs: 'bool, optional; default true',
        show_streams: 'bool, optional; default true',
        levels: 'list<string>, optional',
        stream_types: 'list<string>, optional',
        cursor: 'string, optional',
        direction: 'enum string, optional; older or newer',
        including_cursor: 'bool, optional',
        length: 'u32, optional; default 200',
    }),
    tool('obelisk.submit', 'Start a workflow or activity execution by FFQN with WIT-encoded positional parameters.', {
        ffqn: 'string, required',
        params_json: 'string, required; JSON array of positional parameters encoded from the target function WIT, for example "[123,\"name\"]"',
    }, [
        'Call obelisk.get_function_wit first unless the target WIT is already known.',
        'params_json is a string containing the JSON array, not an array value in args.',
    ]),
    tool('obelisk.get_result', 'Read the final result for a finished execution.', {
        execution_id: 'string, required',
    }),
    tool('obelisk.list_deployments', 'List deployments and their status counters.', {
        cursor_from: 'string, optional',
        including_cursor: 'bool, optional',
        length: 'u32, optional; default 20',
    }),
    tool('obelisk.current_deployment_id', 'Return the active deployment id.', {}),
    tool('obelisk.get_deployment', 'Read deployment metadata and a paginated window of deployment TOML.', {
        deployment_id: 'string, required',
        component_type: 'string, optional',
        offset: 'u32, optional',
        length: 'u32, optional',
        max_bytes: 'u32, optional',
    }),
    tool('obelisk.get_component_source', 'Read a paginated window of a component source file from a stored deployment.', {
        deployment_id: 'string, required',
        component: 'string, required; component identifier from the deployment',
        offset: 'u32, required',
        length: 'u32, required',
    }),
    tool('obelisk.deployment_checkout', 'Create an in-memory deployment working copy for editing. Call this before reading or changing components.', {
        deployment_id: 'string, optional; defaults to active deployment',
        from_scratch: 'bool, optional',
    }),
    tool('obelisk.deployment_list_components', 'List components in the checked-out working copy and any pending dirty component.', {}),
    tool('obelisk.deployment_read_component', 'Read one component from the checked-out working copy. Owned JS and exec components also return script.', {
        section: 'string, required; for example activity_js or workflow_js',
        id: 'string, required; component id shown by checkout/list_components',
    }),
    tool('obelisk.deployment_put_component', 'Add or replace exactly one component in the checked-out working copy.', {
        section: 'string, required',
        id: 'string, required',
        toml: 'string, required; exactly one complete component TOML block',
        script: 'string, optional; source body for deployment-owned JS or exec components',
    }, [
        'Read the component before replacing it.',
        'All component configuration belongs in the TOML block; source code belongs in script.',
        'After changing one component, call obelisk.deployment_submit before editing another component.',
    ]),
    tool('obelisk.deployment_remove_component', 'Remove exactly one component from the checked-out working copy.', {
        section: 'string, required',
        id: 'string, required',
    }),
    tool('obelisk.deployment_submit', 'Validate and store the checked-out working copy as a new inactive deployment.', {
        description: 'string, required',
        allow_missing_runtime_config: 'bool, optional; default false',
        deployment_id: 'string, optional',
    }),
    tool('obelisk.deployment_activate', 'Activate a submitted deployment on next restart or by hot redeploy after operator approval.', {
        deployment_id: 'string, optional; defaults to latest submitted/checked-out deployment when available',
        mode: 'enum string, required; enqueue or apply',
        allow_missing_runtime_config: 'bool, optional; only meaningful for enqueue',
        summary: 'string, optional; approval summary for apply',
    }, [
        'mode enqueue switches on next server restart.',
        'mode apply blocks for operator approval and is terminal for the current workflow turn after it returns.',
    ]),
    tool('input.ask_user', 'Pause the workflow and ask the operator for missing information or approval that cannot be inferred safely.', {
        question: 'string, required',
    }),
];

function renderToolSchema(t) {
    const lines = [
        '### ' + t.name,
        t.purpose,
        '',
        'Args schema:',
        '```json',
        JSON.stringify(t.args, null, 2),
        '```',
    ];
    if (t.notes.length > 0) {
        lines.push('Notes:');
        for (const note of t.notes) {
            lines.push('- ' + note);
        }
    }
    return lines.join(nl);
}

const TOOL_PROMPT = [
    '## Tool-Call Envelope',
    'When calling tools, emit a single JSON object and no surrounding prose:',
    '```json',
    '{"tool_calls":[{"name":"obelisk.get_execution","args":{"execution_id":"E_..."}}]}',
    '```',
    'Each call object uses exactly name and args. Do not use tool, arguments, input, params, or params_json as top-level call-object keys.',
    'Inside args, use the snake_case field names from the schema for that tool.',
    'Use workflow-visible tools only for durable, replayable actions that should appear in the Obelisk execution log.',
    'Use your own built-in tools freely inside a turn for non-durable investigation.',
    'If a tool error reports required or allowed arguments, retry with those exact names.',
    '',
    '## Workflow-Visible Tools',
    ...TOOL_SCHEMAS.map(renderToolSchema),
].join(nl + nl);

const WIT_JSON_MAPPING = [
    '## WIT to JSON Mapping',
    'Use obelisk.get_function_wit to inspect the target function signature before obelisk.submit when the parameters are not already known.',
    'Encode obelisk.submit params_json as a JSON array of positional arguments in WIT parameter order.',
    'WIT kebab-case identifiers become snake_case JSON keys and variant or enum values.',
    'bool maps to JSON true or false.',
    'Integers and floats map to JSON numbers; Obelisk rejects lossy numeric conversions instead of rounding.',
    'char and string map to JSON strings.',
    'option<T> maps to the JSON value for T or null for none.',
    'list<T> maps to a JSON array.',
    'tuple<T1, T2> maps to a JSON array in tuple order.',
    'record { field-name: T } maps to a JSON object such as {"field_name": value}.',
    'variant { case-name(T) } maps to a JSON string for no-payload cases or an object such as {"case_name": value} for payload cases.',
    'enum { case-name } maps to the JSON string "case_name".',
    'flags { flag-name } maps to an array of active flag strings such as ["flag_name"].',
    'result<T, E> maps to {"ok": value} or {"err": value}; result with no payload uses null.',
].join(nl);

const DEPLOYMENT_RULES = [
    '## Deployment Editing Rules',
    'Checkout first with obelisk.deployment_checkout.',
    'Read a component with obelisk.deployment_read_component before editing it.',
    'Change exactly one component with obelisk.deployment_put_component or obelisk.deployment_remove_component.',
    'Submit after each component change with obelisk.deployment_submit.',
    'Repeat the checkout/read/edit/submit cycle for larger changes.',
    'All component config lives in the TOML block; owned source code lives in the script field.',
    'Use obelisk.deployment_activate only when the operator requested activation or activation is necessary to complete the task.',
].join(nl);

const SYSTEM_PROMPT = [
    'You are the planner inside an Obelisk durable workflow.',
    'The workflow runs Obelisk-side tools that you request and returns their results.',
    'Your job is to investigate, plan, and decide which durable actions are needed.',
    'Reply with Markdown for presentation. Use fenced Mermaid blocks only for diagrams.',
    'To pause for operator input, call input.ask_user.',
    'Never invent execution IDs, FFQNs, deployment IDs, tools, or tool arguments. Discover them first.',
    'If a tool returns an error, decide whether to retry, use another tool, ask the operator, or finish with an error envelope.',
    TOOL_PROMPT,
    WIT_JSON_MAPPING,
    DEPLOYMENT_RULES,
].join(nl + nl);

export default async function load_system_prompt() {
    const response = await fetch(OBELISK_DOCS_URL, {
        headers: { accept: 'text/plain' },
    });
    if (!response.ok) {
        throw `failed to fetch Obelisk documentation: HTTP ${response.status}: ${await response.text()}`;
    }
    const docs = await response.text();
    return [
        SYSTEM_PROMPT,
        '',
        '# Obelisk documentation',
        'The following reference was fetched from ' + OBELISK_DOCS_URL + '.',
        '',
        docs,
    ].join(nl);
}
