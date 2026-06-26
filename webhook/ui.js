export default async function handle(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/') {
        return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
    }

    const rawUrl = process.env['OBELISK_UI_URL'] || 'http://localhost:8080';
    const uiUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
    return new Response(HTML.replace('__OBELISK_UI_URL__', uiUrl), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    });
}

const HTML = `<!doctype html>
<html lang='en'>
<head>
<meta charset='utf-8'>
<title>obelisk-agent</title>
<style>
:root {
  --bg: #f7f7f8;
  --panel: #fff;
  --line: #dedee3;
  --muted: #6f7280;
  --text: #1d1f24;
  --accent: #2868c8;
  --accent-bg: #eef4ff;
  --ok: #2f7d3d;
  --ok-bg: #eef8f0;
  --err: #b32626;
  --err-bg: #fff0f0;
  --warn: #946200;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font: 14px/1.45 system-ui, -apple-system, sans-serif;
  color: var(--text);
  background: var(--bg);
  display: grid;
  grid-template-columns: 320px 1fr;
}
aside {
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
header { padding: 1rem; border-bottom: 1px solid var(--line); }
h1 { font-size: 1rem; margin: .1rem 0 .7rem; }
textarea, select, button { font: inherit; }
textarea {
  width: 100%;
  min-height: 4rem;
  resize: vertical;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: .45rem;
}
.row { display: flex; gap: .45rem; align-items: center; margin-top: .45rem; }
button {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 4px;
  padding: .42rem .75rem;
  cursor: pointer;
}
button.secondary { background: #fff; color: var(--accent); }
button.danger { background: #fff; color: var(--err); border-color: var(--err); }
button:disabled { opacity: .55; cursor: wait; }
.runs { overflow: auto; }
.run {
  display: block;
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid var(--line);
  padding: .75rem 1rem;
}
.run:hover { background: #f1f1f3; }
.run.active {
  background: var(--accent-bg);
  border-left: 3px solid var(--accent);
  padding-left: calc(1rem - 3px);
}
.preview {
  font-weight: 600;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  color: var(--muted);
  font-size: .82rem;
  margin-top: .2rem;
  display: flex;
  gap: .5rem;
  justify-content: space-between;
}
.status { font-weight: 700; }
.ok { color: var(--ok); }
.err { color: var(--err); }
.work { color: var(--warn); }
.await { color: var(--accent); }
main { padding: 1.4rem 2rem; overflow: auto; }
.empty { margin-top: 4rem; text-align: center; color: var(--muted); }
h2 { font-size: 1.05rem; margin: .1rem 0 .3rem; }
.bubble, .card {
  max-width: 900px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: .8rem 1rem;
  margin: .7rem 0;
}
.bubble.prompt { background: var(--accent-bg); border-color: #cdddf4; }
.bubble.final { background: var(--ok-bg); border-color: #c8e4ce; }
.bubble.error { background: var(--err-bg); border-color: #efc0c0; color: var(--err); }
.bubble.thinking { background: #faf7ff; border-color: #e0d6f0; color: #4a4458; }
.label {
  font-size: .75rem;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--muted);
  margin-bottom: .25rem;
}
pre {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  font: 13px/1.45 ui-monospace, Menlo, monospace;
}
.actions { display: flex; gap: .5rem; flex-wrap: wrap; margin: .7rem 0 1.1rem; }
.confirm { background: #fff8ed; border-color: #f0cf99; }
.dep { font: 12px ui-monospace, monospace; color: var(--muted); }
.turn { max-width: 920px; margin: 1rem 0; }
.turn-header { color: var(--muted); font-weight: 700; font-size: .86rem; margin-bottom: .35rem; }
.call { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); margin: .45rem 0; }
.call summary { padding: .55rem .75rem; cursor: pointer; display: flex; gap: .55rem; align-items: baseline; }
.call code { color: var(--accent); font-weight: 700; }
.call .pill { margin-left: auto; font-size: .8rem; padding: .08rem .5rem; border-radius: 4px; }
.call .pill.ok { background: var(--ok-bg); color: var(--ok); }
.call .pill.err { background: var(--err-bg); color: var(--err); }
.call .pill.pending { background: #f0f0f0; color: var(--muted); }
.call .body { padding: 0 .75rem .7rem; }
.call .key { color: var(--muted); font-size: .8rem; margin: .55rem 0 .2rem; }
.call pre { background: #f7f7f7; border-radius: 4px; padding: .55rem .65rem; max-height: 16rem; overflow: auto; }
.child-link { font: 11px ui-monospace, monospace; color: var(--muted); text-decoration: none; background: #f0f0f0; border-radius: 3px; padding: .12rem .35rem; }
a { color: var(--accent); }
@media (max-width: 760px) {
  body { display: block; }
  aside { min-height: 0; border-right: 0; border-bottom: 1px solid var(--line); }
  main { padding: 1rem; }
}
</style>
</head>
<body>
<aside>
  <header>
    <h1>obelisk-agent</h1>
    <form id='new-form'>
      <textarea id='new-prompt' placeholder='Ask the agent...' required></textarea>
      <div class='row'>
        <select id='new-backend'>
          <option value='claude'>claude</option>
          <option value='codex'>codex</option>
        </select>
        <button id='new-submit'>Send</button>
      </div>
    </form>
  </header>
  <div id='runs' class='runs'></div>
</aside>
<main id='detail'>
  <p class='empty'>Pick a run from the sidebar, or submit a new prompt.</p>
</main>
<script>
const UI = '__OBELISK_UI_URL__';
const state = { selected: null, runs: [], detail: null };

function byId(id) {
  return document.getElementById(id);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function button(text, className) {
  const element = node('button', className || '', text);
  element.type = 'button';
  return element;
}

function ago(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const seconds = Math.round((Date.now() - t) / 1000);
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
  return Math.round(seconds / 86400) + 'd ago';
}

function joinLabel(name) {
  if (name === 'ask-user') return 'awaiting reply';
  if (name === 'confirm-apply') return 'awaiting approval';
  if (name === 'recv') return 'thinking';
  return name ? name.replaceAll('-', ' ') : '';
}

function statusInfo(run) {
  if (!run) return { text: 'unknown', className: 'work' };
  if (run.status === 'blocked_by_join_set') {
    const awaiting = run.join_name === 'ask-user' || run.join_name === 'confirm-apply';
    return { text: joinLabel(run.join_name) || 'blocked', className: awaiting ? 'await' : 'work' };
  }
  if (run.status === 'finished') {
    const failed = run.result_kind === 'err'
      || (run.result_kind && typeof run.result_kind === 'object' && ('err' in run.result_kind || 'Err' in run.result_kind));
    return { text: failed ? 'err' : 'ok', className: failed ? 'err' : 'ok' };
  }
  const text = String(run.status || 'unknown').replaceAll('_', ' ');
  return { text, className: text.startsWith('permanently') ? 'err' : 'work' };
}

async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init && init.headers ? init.headers : {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || ('HTTP ' + response.status));
  return value;
}

function execLink(id) {
  return UI + '/execution/' + encodeURIComponent(id);
}

function shortId(id) {
  const dot = String(id || '').indexOf('.');
  return dot === -1 ? id : id.slice(dot + 1);
}

function setSelected(id) {
  state.selected = id;
  state.detail = null;
  const url = new URL(location.href);
  if (id) url.searchParams.set('run', id);
  else url.searchParams.delete('run');
  history.replaceState({}, '', url);
  renderRuns();
  loadDetail();
}

async function loadRuns() {
  try {
    state.runs = (await api('/api/runs')).runs || [];
    renderRuns();
  } catch (error) {
    byId('runs').replaceChildren(node('div', 'card', String(error)));
  }
}

function renderRuns() {
  const box = byId('runs');
  box.replaceChildren();
  if (!state.runs.length) {
    box.append(node('div', 'card', 'No runs yet.'));
    return;
  }
  for (const run of state.runs) {
    const link = node('a', 'run' + (run.id === state.selected ? ' active' : ''));
    link.href = '?run=' + encodeURIComponent(run.id);
    link.onclick = (event) => {
      event.preventDefault();
      setSelected(run.id);
    };
    link.append(node('div', 'preview', run.prompt_preview || '(no prompt)'));
    const meta = node('div', 'meta');
    const status = statusInfo(run);
    meta.append(node('span', 'status ' + status.className, status.text));
    meta.append(node('span', '', ago(run.created_at)));
    link.append(meta);
    box.append(link);
  }
}

async function loadDetail() {
  const main = byId('detail');
  if (!state.selected) {
    main.replaceChildren(node('p', 'empty', 'Pick a run from the sidebar, or submit a new prompt.'));
    return;
  }
  try {
    state.detail = await api('/api/runs/' + encodeURIComponent(state.selected));
    renderDetail();
  } catch (error) {
    main.replaceChildren(node('div', 'bubble error', String(error)));
  }
}

function addBubble(parent, className, label, text) {
  const box = node('div', 'bubble ' + className);
  box.append(node('div', 'label', label));
  box.append(node('pre', '', text));
  parent.append(box);
}

function renderDetail() {
  const run = state.detail;
  if (!run) return;

  const main = byId('detail');
  main.replaceChildren();
  const info = statusInfo(run);
  const terminal = run.status === 'finished' || String(run.status || '').startsWith('permanently');

  main.append(node('h2', '', (run.prompt || 'Run').slice(0, 120)));
  const meta = node('div', 'meta');
  const link = node('a', '', run.id);
  link.href = execLink(run.id);
  link.target = '_blank';
  link.rel = 'noopener';
  meta.append(link);
  meta.append(node('span', 'status ' + info.className, info.text));
  meta.append(node('span', '', ago(run.created_at)));
  main.append(meta);

  const actions = node('div', 'actions');
  if (!terminal) {
    const pause = button('Pause', 'secondary');
    pause.onclick = () => mutate('/api/pause/' + encodeURIComponent(run.id));
    actions.append(pause);
    const unpause = button('Unpause', 'secondary');
    unpause.onclick = () => mutate('/api/unpause/' + encodeURIComponent(run.id));
    actions.append(unpause);
  }
  if (!terminal && run.teardown_signal_id) {
    const cleanup = button('Tear down', 'danger');
    cleanup.onclick = () => {
      if (confirm('Tear down this running agent session?')) mutate('/api/cleanup/' + encodeURIComponent(run.id));
    };
    actions.append(cleanup);
  }
  main.append(actions);

  if (run.prompt) addBubble(main, 'prompt', 'prompt', run.prompt);
  for (const confirmation of run.pending_confirms || []) renderConfirm(main, confirmation);
  renderTranscript(main, run.transcript || {});
  for (const ask of run.pending_asks || []) renderAsk(main, ask);

  if (!hasFinalTurn(run.transcript) && run.final_result) {
    if (typeof run.final_result.ok === 'string') addBubble(main, 'final', 'final', run.final_result.ok);
    else {
      const card = node('div', 'card');
      card.append(node('div', 'label', 'result'));
      card.append(node('pre', '', JSON.stringify(run.final_result, null, 2)));
      main.append(card);
    }
  }

  if (terminal) renderFork(main, run.id);
  else if (run.pending_injection && !(run.pending_asks || []).length && !(run.pending_confirms || []).length) renderSay(main, run.id);
}

function hasFinalTurn(transcript) {
  return Boolean((transcript && transcript.replies || []).some((item) => item && item.reply && typeof item.reply.final === 'string'));
}

function renderTranscript(parent, transcript) {
  const replies = transcript.replies || [];
  const children = transcript.tool_children || [];
  const sent = transcript.sent_results || [];
  let childIndex = 0;
  let turnNumber = 0;

  for (const item of replies) {
    const reply = item && item.reply;
    renderDisplayBlocks(parent, item, reply);
    if (!reply || typeof reply !== 'object') continue;

    if (typeof reply.final === 'string') {
      if (!hasDisplayBlocks(item)) addBubble(parent, 'final', 'final', reply.final);
    } else if (typeof reply.error === 'string') {
      addBubble(parent, 'error', 'error', reply.error);
    } else if (Array.isArray(reply.tool_calls)) {
      turnNumber += 1;
      const turn = node('div', 'turn');
      turn.append(node('div', 'turn-header', 'Turn ' + turnNumber + ' · ' + reply.tool_calls.length + ' tool call' + (reply.tool_calls.length === 1 ? '' : 's')));
      for (const call of reply.tool_calls) {
        const child = children[childIndex] || null;
        const result = sent[childIndex] || (child && child.result) || null;
        childIndex += 1;
        turn.append(renderCall(call, child, result, turnNumber, childIndex));
      }
      parent.append(turn);
    }
  }

  for (const message of transcript.operator_messages || []) {
    if (message && message.text) addBubble(parent, 'prompt', 'operator', message.text);
  }
}

function hasDisplayBlocks(item) {
  return Boolean(item && ((Array.isArray(item.blocks) && item.blocks.length) || item.presentation || item.narration));
}

function renderDisplayBlocks(parent, item, reply) {
  if (!item) return;
  for (const block of item.blocks || []) {
    if (!block || !block.content) continue;
    addBubble(parent, block.kind === 'thinking' ? 'thinking' : '', block.kind || 'message', block.content);
  }
  if (item.presentation) addBubble(parent, '', 'message', item.presentation);
  if (item.narration) addBubble(parent, 'thinking', 'thinking', item.narration);
  if (!hasDisplayBlocks(item) && reply && typeof reply.final === 'string') {
    addBubble(parent, 'final', 'final', reply.final);
  }
}

function renderCall(call, child, result, turnNumber, callNumber) {
  const details = node('details', 'call');
  details.dataset.key = (child && child.id) || ('turn-' + turnNumber + '-call-' + callNumber);
  const summary = node('summary');
  summary.append(node('code', '', call && call.name ? call.name : '?'));
  if (child && child.id) {
    const link = node('a', 'child-link', shortId(child.id));
    link.href = execLink(child.id);
    link.target = '_blank';
    link.rel = 'noopener';
    summary.append(link);
  }
  const status = result && 'ok' in result ? 'ok' : (result && 'err' in result ? 'err' : 'pending');
  summary.append(node('span', 'pill ' + status, status));
  details.append(summary);

  const body = node('div', 'body');
  body.append(node('div', 'key', 'args'));
  body.append(node('pre', '', JSON.stringify(parseArgs(call && call.arguments_json), null, 2)));
  if (result && 'ok' in result) {
    body.append(node('div', 'key', 'ok'));
    body.append(node('pre', '', formatValue(result.ok)));
  } else if (result && 'err' in result) {
    body.append(node('div', 'key', 'err'));
    body.append(node('pre', '', String(result.err)));
  }
  details.append(body);
  return details;
}

function parseArgs(value) {
  if (typeof value !== 'string' || !value) return {};
  try { return JSON.parse(value); }
  catch (_) { return { raw: value }; }
}

function formatValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function renderAsk(parent, ask) {
  const form = node('form', 'card ask');
  form.append(node('div', 'label', 'operator input'));
  form.append(node('p', '', ask.question || '(no question)'));
  const textarea = node('textarea');
  textarea.required = true;
  form.append(textarea);
  const row = node('div', 'row');
  row.append(button('Answer'));
  form.append(row);
  form.onsubmit = async (event) => {
    event.preventDefault();
    await api('/api/answer/' + encodeURIComponent(ask.id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: textarea.value }),
    });
    await loadDetail();
  };
  parent.append(form);
}

function renderConfirm(parent, confirmation) {
  const card = node('div', 'card confirm');
  card.append(node('div', 'label', 'hot reload pending approval'));
  card.append(node('div', 'dep', confirmation.deployment_id || ''));
  card.append(node('p', '', confirmation.summary || 'Apply deployment?'));
  if (confirmation.diff) {
    const details = node('details');
    details.append(node('summary', '', 'Diff'));
    details.append(node('pre', '', JSON.stringify(confirmation.diff, null, 2)));
    card.append(details);
  }
  const row = node('div', 'row');
  const approve = button('OK');
  approve.onclick = () => confirmDeployment(confirmation.id, true);
  const reject = button('Cancel', 'danger');
  reject.onclick = () => confirmDeployment(confirmation.id, false);
  row.append(approve, reject);
  card.append(row);
  parent.append(card);
}

async function confirmDeployment(id, approve) {
  await api('/api/confirm/' + encodeURIComponent(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approve }),
  });
  await loadDetail();
}

function renderSay(parent, runId) {
  const form = node('form', 'card say');
  form.append(node('div', 'label', 'send to agent'));
  const textarea = node('textarea');
  textarea.required = true;
  textarea.placeholder = 'Steer or interrupt the agent...';
  form.append(textarea);
  const row = node('div', 'row');
  row.append(button('Send to agent'));
  form.append(row);
  form.onsubmit = async (event) => {
    event.preventDefault();
    await api('/api/say/' + encodeURIComponent(runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: textarea.value }),
    });
    await loadDetail();
  };
  parent.append(form);
}

function renderFork(parent, runId) {
  const form = node('form', 'card fork');
  form.append(node('div', 'label', 'fork to new session'));
  const textarea = node('textarea');
  textarea.placeholder = 'Continue from this run with...';
  form.append(textarea);
  const row = node('div', 'row');
  const backend = node('select');
  for (const value of ['claude', 'codex']) {
    const option = node('option', '', value);
    option.value = value;
    backend.append(option);
  }
  row.append(backend, button('Fork'));
  form.append(row);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const result = await api('/api/fork/' + encodeURIComponent(runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: textarea.value, backend: backend.value }),
    });
    await loadRuns();
    setSelected(result.execution_id);
  };
  parent.append(form);
}

async function mutate(path) {
  await api(path, { method: 'POST' });
  await loadDetail();
  await loadRuns();
}

byId('new-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = byId('new-submit');
  button.disabled = true;
  try {
    const result = await api('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: byId('new-prompt').value,
        backend: byId('new-backend').value,
      }),
    });
    byId('new-prompt').value = '';
    await loadRuns();
    setSelected(result.execution_id);
  } catch (error) {
    alert(String(error));
  } finally {
    button.disabled = false;
  }
};

const selected = location.search.match(/[?&]run=([^&]+)/);
state.selected = selected ? decodeURIComponent(selected[1]) : null;
loadRuns();
loadDetail();
setInterval(loadRuns, 10000);
setInterval(() => {
  if (state.selected) loadDetail();
}, 3000);
</script>
</body>
</html>`;
