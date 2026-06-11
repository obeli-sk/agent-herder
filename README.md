# obelisk-agent

An Obelisk app that runs an LLM CLI (`claude-code` today, `codex` planned) as a
long-running external resource and drives it from a durable workflow.

The structure follows `apps/fio`: each workflow execution spawns a docker
container that owns a Unix socket; short activities open the socket to send a
prompt, drain stream-json output, and finally stop the container.

## Layout

```
agent-server/        Docker image: node + claude-code + server.js (socket wrapper)
activity/
  agent-start.js     spawn the docker container, wait for the socket
  agent-send.js      write one user message to the LLM's stdin
  agent-recv.js      drain stream-json events until the next "result"
  agent-cleanup.js   shut the server down, docker rm
workflow/
  agent.js           start -> send(prompt) -> loop(recv until done) -> cleanup
deployment.toml      FFQNs, types, and lock_expiry per activity
```

## Why activities are short

The LLM lives inside the docker container as a persistent process; activities
just speak to it over a socket. `send` writes a single line and returns. `recv`
polls up to its `timeout-ms` and returns whatever events accumulated, with a
`done` flag set when claude emits the `result` event. The workflow loops `recv`
until `done`, so each activity invocation stays well inside its `lock_expiry`
and Obelisk gets a discrete log entry per turn-chunk.

## stream-json protocol

The server (`agent-server/server.js`) spawns:

```
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --model "$AGENT_MODEL" \
  --append-system-prompt "$(cat /app/system-prompt.md)" \
  --json-schema "$(cat /app/output-schema.json)" \
  --disallowed-tools Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,…
```

`--json-schema` forces every assistant reply to match the agent envelope
(`{"final": "..."}` or `{"tool_calls": [...]}`). All built-in tools are
disabled so claude cannot bypass the envelope. The system prompt explains the
protocol and lists the available tools.

## Agent loop (in the workflow)

The workflow, not claude, is the agent. Each turn:

1. `agent.send` writes the next message (initial prompt, or a JSON
   `{"tool_results": [...]}` from the previous turn).
2. `agent.recv` polls until a `result` event arrives.
3. The workflow parses the latest assistant text as JSON.
4. If `{"final": "..."}`, return it.
5. If `{"tool_calls": [...]}`, dispatch each call to its activity and send
   the aggregated results back as the next message.

Tools exposed to the LLM (each is a real Obelisk activity, fully durable and
inspectable):

| Tool                       | FFQN                                             |
|----------------------------|--------------------------------------------------|
| `obelisk.list_executions`  | `obelisk-agent:tools/webapi.list-executions`     |
| `obelisk.get_execution`    | `obelisk-agent:tools/webapi.get-execution`       |
| `obelisk.get_logs`         | `obelisk-agent:tools/webapi.get-logs`            |
| `obelisk.submit`           | `obelisk-agent:tools/webapi.submit-json`         |
| `obelisk.get_result`       | `obelisk-agent:tools/webapi.get-result-json`     |
| `http.get`                 | `obelisk-agent:tools/http.get`                   |
| `input.ask_user`           | `obelisk-agent:tools/input.ask-user` *(stub)*    |

`input.ask_user` is configured as `activity_stub`: it parks the workflow and
waits for an operator to PUT a response. The web UI surfaces pending asks on
the detail page with an inline form. To answer from the shell instead:

```sh
curl -X PUT http://127.0.0.1:5005/v1/executions/<child-id>/stub \
  -H content-type:application/json -d '{"ok": "the answer text"}'
```

Cancelling the stub child surfaces as an err tool_result; the LLM can react
or emit `{"final": "Cancelled by user."}`.

## Build the image

```sh
just build
```

Tags `ghcr.io/obeli-sk/obelisk-agent-server:latest`. The image name is wired
into `agent-start.js` through the `AGENT_IMAGE` env var (defaulted in
`deployment.toml`).

## Authenticate claude-code

The activity bind-mounts your host's claude-code config dir into the container,
so the container uses your existing Claude subscription. Log in once on the
host:

```sh
claude   # follow the OAuth flow
```

This populates `~/.claude/`. `agent-start.js` reads `AGENT_HOST_CLAUDE_DIR`
(defaults to `$HOME/.claude`) and mounts it at `/claude-config` with
`CLAUDE_CONFIG_DIR=/claude-config` inside the container. The mount is
read-write so claude can refresh tokens.

## Start the server

```sh
just serve
```

Optional env vars consumed by `agent-start.js`:

- `AGENT_IMAGE` - override the docker image tag
- `AGENT_BACKEND` - `claude` (default); `codex` reserved
- `AGENT_MODEL` - default `claude-opus-4-7`
- `AGENT_EXTRA_ARGS` - appended to the CLI invocation inside the container
- `AGENT_HOST_CLAUDE_DIR` - host path to mount as claude config, default `$HOME/.claude`

## Submit a one-shot prompt

From the CLI:

```sh
just run 'Summarise the latest commits on main.'
```

To submit paused:

```sh
OBELISK_SUBMIT_FLAGS=--paused just run 'prompt here'
```

Or use the web UI (see below).

## Web UI

`webhook/ui.js` is registered as `webhook_endpoint_js` and serves three routes
on whatever port the Obelisk server has configured for webhooks (default
`8080`):

- `GET  /`              list recent `workflow.run` executions, with a form to
                        submit a new prompt
- `POST /submit`        accepts the form, schedules a new run, redirects to
                        the detail page
- `GET  /e/<exec-id>`   shows one run: the prompt, every stream-json event
                        from claude (user, assistant, tool_use, tool_result,
                        result), and the final return value

The detail page reconstructs the conversation from `/v1/executions/<id>/responses`
by parsing the `events` JSON returned by each `agent.recv` child execution, so
no extra storage is needed.

## Inspecting a run

Each turn is a separate activity execution. Beyond the UI, you can use the
standard Obelisk WebAPI / CLI to inspect them: `agent.start`, `agent.send`,
multiple `agent.recv` invocations (one per polling chunk), and
`agent.cleanup`. The full stream-json event log is captured as the `recv`
activity results.

## Adding codex

`AGENT_BACKEND=codex` is reserved but not wired up. To add it:

1. Install codex in `agent-server/Dockerfile` (`npm i -g @openai/codex`).
2. Branch on `BACKEND` in `server.js` to use codex's stream-json equivalent
   (`codex exec --json` flags).
3. Mount the codex equivalent of `~/.claude` (or pass `OPENAI_API_KEY` if you
   prefer the API-key path for codex).
