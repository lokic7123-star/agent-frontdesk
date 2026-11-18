import { test, type TestContext } from 'node:test';
import { EngineEvents } from '../src/server/types.js';
import { at, dig, fake, must, noRuns, required } from './support.js';
import { errorField, get } from '../src/shared/guards.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CodexDesktopIpc } from '../src/server/codex-desktop.js';
import type { DesktopAutomation } from '../src/server/core/desktop-automation.js';
import type { ApprovalRequest, DictationHandlers, EngineCompleted, EngineEmitter, Engine, History, UnifiedSession, UnifiedTurn } from '../src/shared/contract.js';
import type { HubMessage } from '../src/server/core/event-hub.js';
// What a fetch the code under test makes answers: only what it reads (ok, status, json).
const answer = (body: unknown, { ok = true, status = 200 } = {}): Response => fake<Response>({ ok, status, json: async () => body });
// The JSON body a fetch was given.
const bodyOf = (options: RequestInit | undefined): unknown => JSON.parse(String(options?.body));
import { CodexBridge, CodexRun } from '../src/server/codex-bridge.js';
import { bindEvents } from '../src/server/core/presentation.js';
import { SessionObserver } from '../src/server/services/session-observer.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { EventHub } from '../src/server/core/event-hub.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import __node_sqlite from 'node:sqlite';
import * as __services_sqlite_reader from '../src/server/services/sqlite-reader.js';
import * as __antigravity_bridge from '../src/server/antigravity-bridge.js';
import * as __core_presentation from '../src/server/core/presentation.js';
import __node_url from 'node:url';
import * as __claude_bridge from '../src/server/claude-bridge.js';
import * as __services_dictation from '../src/server/services/dictation.js';

// A fake Codex: the console's app-server answers reads and queue calls; the desktop runs the turn.
function fakeCodex({ model = 'gpt-a', effort = 'medium' } = {}) {
  const bridge = new CodexBridge({ codexBin: 'codex' }), calls: Array<[string, unknown]> = [];
  const thread: { id: string; name: string; path: string; model: string; reasoningEffort: string; turns: unknown[] } = { id: 'th', name: 'Plan the trip', path: '/x.jsonl', model, reasoningEffort: effort, turns: [{ id: 't1', status: 'completed', completedAt: 2, items: [] }] };
  bridge.start = async () => {};
  bridge.lifecycle.read = async () => ({ turns: new Map(), messages: [] });
  bridge.getModels = async () => [{ id: 'gpt-a', name: 'GPT-A' }, { id: 'gpt-b', name: 'GPT-B' }];
  bridge.send = async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { result: { thread } };
    if (method === 'thread/queue/add') return { result: { queuedSubmission: { id: 'q1' } } };
    return { result: {} };
  };
  bridge.wake = async id => { calls.push(['wake', id]); };
  // The desktop takes the queued message: a new turn appears in the thread's record.
  const take = (text: string) => thread.turns.push({ id: 't2', status: 'completed', completedAt: 9, items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text }] }, { id: 'a', type: 'agentMessage', text: 'done' }] });
  return { bridge, calls, thread, take };
}
const settle = (emitter: EngineEvents) => new Promise<EngineCompleted>((resolve, reject) => { emitter.once('completed', resolve); emitter.once('error', reject); });

test('Codex: a message to a chat is queued for the desktop and the desktop is woken; the console never runs the turn', async () => {
  const { bridge, calls, take } = fakeCodex();
  const emitter = bridge.startTurn({ threadId: 'th', prompt: 'book the hotel', model: 'gpt-a', reasoningEffort: 'medium' });
  const done = settle(emitter);
  await new Promise(resolve => setTimeout(resolve, 20));
  take('book the hotel');
  const { turn } = await done;
  assert.equal(get(turn, 'id'), 't2'); assert.equal(emitter.turnId, 't2');
  const methods = calls.map(([method]) => method);
  assert.deepEqual(methods.filter(method => method !== 'thread/read'), ['thread/queue/add', 'wake']);
  assert.equal(dig(must(calls.find(([method]) => method === 'thread/queue/add'))[1], 'input', 0, 'text'), 'book the hotel');
  assert.ok(!methods.some(method => ['turn/start', 'thread/resume', 'thread/start'].includes(method)), 'nothing that would take the thread\'s writer lock');
  emitter.emit('interrupt');
  // Whatever the app-server asks its client to approve is not this console's to answer.
  const replies: unknown[] = []; bridge.proc = fake<ChildProcessWithoutNullStreams>({ stdin: fake<ChildProcessWithoutNullStreams['stdin']>({ write: (text: string) => replies.push(JSON.parse(text)) > 0 }) });
  bridge.handleMessage({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'th' } });
  assert.equal(dig(replies, 0, 'error', 'code'), -32601);
});

test('Codex: a different model is picked in the desktop first; when it cannot be, nothing is queued', async () => {
  const { bridge, calls, take } = fakeCodex();
  const asked: unknown[] = [];
  const ui = bridge.ui = fake<DesktopAutomation>({ check: async () => ({ available: true }), run: async (args, options) => { asked.push([args, options?.settings]); return { ok: true, changed: ['model'] }; } });
  const emitter = bridge.startTurn({ threadId: 'th', prompt: 'go', model: 'gpt-b', reasoningEffort: 'high' });
  const done = settle(emitter);
  await new Promise(resolve => setTimeout(resolve, 20)); take('go'); await done; emitter.emit('interrupt');
  assert.deepEqual(asked, [[['settings', 'Plan the trip'], { model: 'GPT-B', effort: 'high' }]]);
  // The desktop could not switch: the message is not queued, and the reason says why.
  calls.length = 0;
  ui.run = async () => ({ ok: false, error: '在 Codex 桌面版里选了 GPT-B，但它没有切换过去' });
  const refused = bridge.startTurn({ threadId: 'th', prompt: 'again', model: 'gpt-b' });
  const error: unknown = await settle(refused).catch((err: unknown) => err);
  assert.match(String(errorField(error, 'message')), /没有切换过去，没有发送$/); assert.equal(errorField(error, 'terminal'), true);
  assert.ok(!calls.some(([method]) => method === 'thread/queue/add'));
  // Same settings as the chat already has: the desktop is not touched.
  // (a fresh list: the assertion above narrowed `asked` to what it held)
  const touched: unknown[] = []; ui.run = async args => { touched.push(args); return { ok: true }; };
  const same = bridge.startTurn({ threadId: 'th', prompt: 'more', model: 'gpt-a', reasoningEffort: 'medium' });
  await new Promise(resolve => setTimeout(resolve, 20)); same.emit('interrupt');
  assert.deepEqual(touched, []);
});

test('Codex: stopping takes back a message the desktop has not started, and stops a running turn through the desktop', async () => {
  const { bridge, calls } = fakeCodex();
  const queued = new CodexRun(); queued.queuedId = 'q1';
  let stopped = false; queued.once('interrupt', () => { stopped = true; });
  assert.deepEqual(await bridge.interruptTurn('th', queued), {});
  assert.deepEqual(at(calls, -1), ['thread/queue/delete', { threadId: 'th', queuedSubmissionId: 'q1' }]); assert.equal(stopped, true);
  const running = new CodexRun(); running.turnId = 't2';
  const asked: unknown[] = []; bridge.desktop = fake<CodexDesktopIpc>({ interrupt: async request => { asked.push(request); } });
  // The record says how it ended, so the stop is only pending here.
  assert.deepEqual(await bridge.interruptTurn('th', running), { pending: true });
  assert.deepEqual(asked, [{ threadId: 'th', turnId: 't2' }]);
  bridge.desktop = fake<CodexDesktopIpc>({ interrupt: async () => { throw new Error('no-client-found'); } });
  await assert.rejects(bridge.interruptTurn('th', running), err => errorField(err, 'status') === 409 && /请在桌面端停止$/.test(String(errorField(err, 'message'))));
});

test('Codex: a new chat is started on the desktop\'s New chat page, in the project the console picked', async () => {
  const { bridge } = fakeCodex();
  const listed: object[][] = [[{ id: 'old' }], [{ id: 'old' }, { id: 'new', preview: 'plan a trip', cwd: '/work/trips' }]];
  let reads = 0;
  bridge.send = async (method, params) => {
    if (method === 'thread/list') return { result: { data: listed[Math.min(reads++, 1)] } };
    if (method === 'thread/read') return { result: { thread: { id: get(params, 'threadId'), path: '/x', turns: [] } } };
    return { result: {} };
  };
  bridge.listProjects = async () => [{ id: 'p', name: 'trips', cwd: '/work/trips' }];
  const asked: Array<[string[], unknown]> = [];
  const ui = bridge.ui = fake<DesktopAutomation>({ check: async () => ({ available: true }), run: async (args, options) => { asked.push([args, options]); return { ok: true, started: true }; } });
  const session = await bridge.create({ prompt: 'plan a trip', cwd: '/work/trips', model: 'gpt-b' });
  assert.deepEqual(session, { id: 'new', cwd: '/work/trips', started: true });
  assert.deepEqual(asked[0], [['new', 'trips'], { input: 'plan a trip', settings: { model: 'GPT-B' } }]);
  bridge.observe('new').emit('interrupt');
  await assert.rejects(bridge.create({ prompt: 'x', cwd: '/elsewhere' }), err => errorField(err, 'status') === 409 && /不是 Codex 桌面版里的项目/.test(String(errorField(err, 'message'))));
  asked.length = 0; listed[1] = [{ id: 'old' }, { id: 'loose', preview: 'hi' }]; reads = 0;
  await bridge.create({ prompt: 'hi' });
  assert.equal(at(at(asked, 0)[0], 1), ':none', 'no folder: a chat outside every project');
  bridge.observe('loose').emit('interrupt');
  ui.check = async () => ({ available: false, reason: 'Codex 桌面版没有在运行' });
  await assert.rejects(bridge.create({ prompt: 'x' }), /没有在运行/);
});
test('native history observer publishes changes and releases its subscription', async () => {
  const host = new PluginHost(), hub = new EventHub(); let revision = 'first';
  host.register(fake<Engine>({ ...required, id: 'native', read: async () => fake<History>({ session: fake<UnifiedSession>({ id: 's' }), turns: [fake<UnifiedTurn>({ id: 't', assistantReply: revision })] }) }));
  const observer = new SessionObserver(host, hub, noRuns(), { intervalMs: 5 });
  const received: HubMessage[] = [], unsubscribe = hub.subscribe('native', 's', null, event => received.push(event));
  const release = observer.acquire('native', 's');
  await new Promise(resolve => setTimeout(resolve, 10)); revision = 'second';
  await new Promise(resolve => setTimeout(resolve, 15)); release(); unsubscribe();
  assert.equal(at(received, -1).type, 'session.snapshot'); assert.equal(dig(at(received, -1).data, 'turns', 0, 'messages', 0, 'text'), 'second');
  assert.equal(observer.observers.size, 0); observer.dispose();
});
test('SQLite reader reads with bound parameters and rejects writes', (t) => {
  const Database = __node_sqlite.DatabaseSync;
  const { readSqlite } = __services_sqlite_reader;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sqlite-')), file = path.join(dir, 'history.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const database = new Database(file); database.exec("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('session');"); database.close();
  assert.equal(get(at(readSqlite(file, 'SELECT id FROM sessions WHERE id = ?', ['session']), 0), 'id'), 'session');
  assert.equal(readSqlite(file, 'SELECT id FROM sessions WHERE id = ?', ["' OR 1=1 --"]).length, 0);
  assert.throws(() => readSqlite(file, "INSERT INTO sessions VALUES ('other')"), /readonly|read.only/i);
  fs.rmSync(dir, { recursive: true });
});
test('Codex usage maps real windows without exposing account or reset-credit identifiers', async () => {
  const bridge = new CodexBridge({ codexBin: null }); bridge.start = async () => {};
  bridge.send = async method => { assert.equal(method, 'account/rateLimits/read'); return { result: { accountId: 'PRIVATE-ACCOUNT', rateLimitResetCredits: { secret: 'PRIVATE-CREDIT' }, rateLimits: { planType: 'plus', primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 123 }, secondary: { usedPercent: 50, windowDurationMins: 10080 } } } }; };
  const usage = await bridge.getUsage(); assert.equal(at(usage.windows, 0).remainingPercent, 66); assert.equal(at(usage.windows, 1).remainingPercent, 50);
  assert.equal(usage.available, true); assert.doesNotMatch(JSON.stringify(usage), /PRIVATE/);
});

test('Antigravity decodes JSON-encoded tool arguments, pairs results in order and explains a missing agent environment', async t => {
  const { AntigravityBridge } = __antigravity_bridge;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-')), logs = path.join(dir, 'brain', 'c1', '.system_generated', 'logs');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(logs, { recursive: true });
  const records = [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nList files\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: 'Looking', tool_calls: [
      { name: 'run_command', args: { CommandLine: '"ls -la"', toolSummary: '"List files"' } },
      { name: 'read_file', args: { Path: '"/w/a.md"' } },
    ] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Created At: x\nCompleted At: y\nfile-list' },
    { step_index: 3, type: 'GENERIC', status: 'ERROR', content: 'missing' },
    { step_index: 4, type: 'PLANNER_RESPONSE', content: 'Done.' },
  ];
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const bridge = new AntigravityBridge({ agyHome: dir, agentapiBin: '/bin/false', catalogs: {} }, {});
  const { turns, session } = await bridge.getConversationHistory('c1');
  assert.equal(at(turns, 0).userPrompt, 'List files');
  const command = at(at(turns, 0).steps, 0), read = at(at(turns, 0).steps, 1);
  assert.equal(command.detail, 'ls -la'); assert.equal(command.title, 'List files'); assert.equal(command.output, 'file-list');
  assert.equal(read.status, 'failed'); assert.equal(get(read.input, 'Path'), '/w/a.md');
  assert.deepEqual(at(turns, 0).messages.map(message => message.phase), ['commentary', 'final_answer']);
  assert.match(String(session?.sendBlocked), /Antigravity/);
  assert.match(bridge.sendBlockedReason(), /Antigravity/);
  fs.mkdirSync(path.join(dir, 'daemon'));
  fs.writeFileSync(path.join(dir, 'daemon', 'hub_1.json'), JSON.stringify({ pid: process.pid, httpPort: 1234, csrfToken: 'token' }));
  assert.deepEqual(bridge.lsEnv(), { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1234', ANTIGRAVITY_CSRF_TOKEN: 'token' });
  assert.equal(bridge.sendBlockedReason(), '');
  assert.equal(new AntigravityBridge({ agyHome: dir, agentapiBin: '/bin/false' }, { ANTIGRAVITY_LS_ADDRESS: 'x', ANTIGRAVITY_CSRF_TOKEN: 'y' }).sendBlockedReason(), '');
  fs.rmSync(dir, { recursive: true });
});

test('Antigravity sends the person\'s messages as the desktop composer does, never as agentapi system messages', async t => {
  const { AntigravityBridge } = __antigravity_bridge;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-send-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = new AntigravityBridge({ agyHome: dir, agentapiBin: '/bin/false', catalogs: {} }, { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9', ANTIGRAVITY_CSRF_TOKEN: 'csrf' });
  const sent: Array<{ url: string; token: unknown; body: unknown }> = [];
  bridge.fetch = async (url, options) => { sent.push({ url: String(url), token: get(options?.headers, 'x-codeium-csrf-token'), body: bodyOf(options) }); return answer({}); };
  bridge.agentapi = async () => { throw new Error('agentapi must not send messages'); };
  await bridge.steer('c1', { prompt: 'also this', attachments: [] });
  await bridge.sendUserMessage('c1', 'hello');
  assert.match(at(sent, 0).url, /\/exa\.language_server_pb\.LanguageServerService\/SendUserCascadeMessage$/);
  assert.equal(at(sent, 0).token, 'csrf');
  assert.deepEqual(at(sent, 0).body, { cascadeId: 'c1', items: [{ text: 'also this' }], messageOrigin: 'AGENT_MESSAGE_ORIGIN_IDE', deliveryStrategy: 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION' });
  assert.deepEqual(at(sent, 1).body, { cascadeId: 'c1', items: [{ text: 'hello' }], messageOrigin: 'AGENT_MESSAGE_ORIGIN_IDE' });
  bridge.fetch = async () => answer({ message: 'boom' }, { ok: false, status: 500 });
  await assert.rejects(bridge.sendUserMessage('c1', 'x'), /Antigravity 没有接收这条消息（500：boom）/);
  fs.rmSync(dir, { recursive: true });
});

// A conversation the desktop keeps without a transcript file, and the language server's record of it.
function antigravityFixture(steps: object[], { idle = 1, inputIndex = 0, t }: { idle?: number; inputIndex?: number; t?: TestContext } = {}) {
  const { AntigravityBridge } = __antigravity_bridge;
  const Database = __node_sqlite.DatabaseSync;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ls-'));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, last_modified_time text, workspace_uris text, not_fully_idle numeric, killed numeric, status text, step_count integer, last_user_input_time text, last_user_input_step_index integer, nesting_depth integer)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,0)').run('c1', 'Old chat', '', '2026-11-11T17:02:07Z', '["file:///w/app"]', idle ? 0 : 1, 0, '', steps.length, '2026-11-11T17:02:07Z', inputIndex);
  db.close();
  const bridge = new AntigravityBridge({ agyHome: dir, agentapiBin: '/bin/false', catalogs: {} }, { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9', ANTIGRAVITY_CSRF_TOKEN: 'csrf' });
  t?.after(() => bridge.dispose());
  const calls: Array<{ method: string; body: unknown }> = [];
  bridge.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1) || '', body = bodyOf(options); calls.push({ method, body });
    if (method === 'GetCascadeTrajectorySteps') return answer({ steps: steps.slice(Number(get(body, 'stepOffset')) || 0) });
    if (method === 'GetCascadeModelConfigData') return answer({ clientModelConfigs: [{ label: 'Flash (High)', modelOrAlias: { model: 'MODEL_A' }, modelId: 'flash-high' }, { label: 'Off', modelOrAlias: { model: 'MODEL_B' }, disabled: true }] });
    return answer({});
  };
  Object.assign(bridge, { watchMs: 15, settleMs: 0, giveUpMs: 400 });
  return { bridge, calls, dir };
}
const agyStep = (type: string, status: string, body: object = {}, meta: object = {}) => ({ type: `CORTEX_STEP_TYPE_${type}`, status: `CORTEX_STEP_STATUS_${status}`, metadata: { createdAt: '2026-11-11T17:02:07Z', ...meta }, ...body });
const agyFatal = agyStep('ERROR_MESSAGE', 'DONE', { errorMessage: { shouldShowUser: true, error: { userErrorMessage: 'Agent execution terminated due to error.', shortError: 'unknown model key M8' } } });

test('Antigravity reads a conversation without a transcript from the language server, and shows a turn an error ended as failed', async t => {
  const { bridge, dir } = antigravityFixture([
    agyStep('USER_INPUT', 'DONE', { userInput: { userResponse: 'build it' } }),
    agyStep('PLANNER_RESPONSE', 'DONE', { plannerResponse: { thinking: 'x', toolCalls: [{ id: 't1', name: 'run_command', argumentsJson: '{"CommandLine":"ls"}' }, { id: 't2', name: 'notify_user', argumentsJson: '{}' }] } }, { requestedModel: { model: 'MODEL_A' } }),
    agyStep('ERROR_MESSAGE', 'DONE', { errorMessage: { shouldShowModel: true, error: { userErrorMessage: 'bad tool call', isBenign: true } } }),
    agyStep('NOTIFY_USER', 'DONE', { notifyUser: { notificationContent: 'All set.' } }, { toolCall: { id: 't2' } }),
    agyStep('RUN_COMMAND', 'ERROR', { runCommand: { combinedOutput: { full: 'a.txt' } } }, { toolCall: { id: 't1' } }),
    agyStep('USER_INPUT', 'DONE', { userInput: { userResponse: 'now logos' } }),
    agyFatal,
  ], { t });
  await bridge.getModels();
  const { turns, session } = await bridge.getConversationHistory('c1');
  assert.deepEqual(turns.map(turn => [turn.userPrompt, turn.status, turn.statusEvidence]), [['build it', 'completed', null], ['now logos', 'failed', 'error_message']]);
  // Results are paired with their calls by id, whatever order they finished in; a note to the model is not an error.
  assert.deepEqual(at(turns, 0).steps.map(step => [step.name, step.status, step.output]), [['run_command', 'failed', 'a.txt'], ['notify_user', 'completed', '']]);
  assert.deepEqual(at(turns, 0).messages.map(message => [message.text, message.phase]), [['All set.', 'final_answer']]);
  assert.match(at(at(turns, 1).steps, 0).detail, /unknown model key M8/); assert.equal(at(at(turns, 1).steps, 0).status, 'failed');
  assert.equal(session?.metadata.model, 'Flash (High)'); assert.equal(session?.cwd, '/w/app'); assert.ok(session?.metadata.turnStartedAt);
  assert.equal(at(await bridge.listConversations(), 0).metadata.model, 'Flash (High)');
  fs.rmSync(dir, { recursive: true });
});

test('an Antigravity turn that ends with an error and no reply ends the run as failed instead of leaving it thinking', async t => {
  const steps = [agyStep('USER_INPUT', 'DONE', { userInput: { userResponse: 'old' } }), agyStep('PLANNER_RESPONSE', 'DONE', { plannerResponse: { response: 'old answer' } })];
  const { bridge, calls, dir } = antigravityFixture(steps, { inputIndex: 0, t });
  const ended = (emitter: EngineEmitter) => new Promise<EngineCompleted & { error?: string }>(resolve => { emitter.on('completed', data => resolve(data)); emitter.on('error', err => resolve({ error: err.message })); });
  // Nothing recorded after the message: the run waits, then says so instead of hanging.
  assert.match(String((await ended(bridge.sendMessage({ conversationId: 'c1', prompt: 'hi', model: 'MODEL_A' }))).error), /没有开始这一轮/);
  assert.deepEqual(dig(calls.find(call => call.method === 'SendUserCascadeMessage')?.body, 'cascadeConfig'), { plannerConfig: { requestedModel: { model: 'MODEL_A' } } });
  // The message is recorded and an error follows it at once.
  const Database = __node_sqlite.DatabaseSync;
  const send = () => { const emitter = bridge.sendMessage({ conversationId: 'c1', prompt: 'hi' }); setTimeout(() => { const db = new Database(path.join(dir, 'conversation_summaries.db')); db.exec('UPDATE conversation_summaries SET last_user_input_step_index = 2'); db.close(); }, 30); return emitter; };
  steps.push(agyStep('USER_INPUT', 'DONE', { userInput: { userResponse: 'hi' } }), agyFatal);
  assert.deepEqual((await ended(send())).turn, { status: 'failed', error: { message: 'Agent execution terminated due to error. unknown model key M8' } });
  // A reply after the message: completed, and what was said arrives; a stop the console asked for reads as interrupted.
  steps.splice(3, 1, agyStep('PLANNER_RESPONSE', 'DONE', { plannerResponse: { response: 'done' } }));
  const said: unknown[] = [], emitter = send(); emitter.on('item_completed', data => said.push(data.item.text));
  assert.deepEqual((await ended(emitter)).turn, { status: 'completed' }); assert.deepEqual(said, ['done']);
  const stopping = send();
  assert.deepEqual(await bridge.interrupt('c1'), { pending: true });
  assert.deepEqual(calls.find(call => call.method === 'CancelCascadeInvocation')?.body, { cascadeId: 'c1' });
  assert.deepEqual((await ended(stopping)).turn, { status: 'interrupted' });
  // A model the desktop does not offer is refused before anything is sent.
  await assert.rejects(bridge.sendUserMessage('c1', 'x', { model: 'pro' }), /没有提供这个模型/);
  assert.deepEqual((await bridge.getModels()).map(model => [model.id, model.name, model.agentId]), [['MODEL_A', 'Flash (High)', 'flash-high']]);
  bridge.dispose(); fs.rmSync(dir, { recursive: true });
});

test('what an Antigravity step waits on the person for becomes a card in the chat, answered the way the desktop answers it', async t => {
  const waitingOn = (spec: object, body: object = {}) => agyStep('RUN_COMMAND', 'WAITING', { requestedInteraction: spec, ...body }, { sourceTrajectoryStepInfo: { trajectoryId: 'traj' } });
  const steps = [agyStep('USER_INPUT', 'DONE', { userInput: { userResponse: 'go' } }), waitingOn({ runCommand: {} }, { runCommand: { proposedCommandLine: 'rm -rf build' } })];
  const { bridge, calls, dir } = antigravityFixture(steps, { idle: 0, t });
  const cards: ApprovalRequest[] = [], gone: string[] = [], emitter = new EngineEvents();
  emitter.on('approval', card => cards.push(card)); emitter.on('approval_resolved', data => gone.push(data.id));
  bridge.watchTurn('c1', emitter, { next: 0 });
  const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check()); };
  await until(() => cards.length === 1);
  assert.deepEqual(at(cards, 0), { id: 'c1_1', title: '允许 Antigravity 运行这条命令？', detail: 'rm -rf build', decisions: ['accept', 'decline'] });
  await bridge.decide('c1_1', 'accept');
  assert.deepEqual(at(calls, -1), { method: 'HandleCascadeUserInteraction', body: { cascadeId: 'c1', interaction: { trajectoryId: 'traj', stepIndex: 1, runCommand: { confirm: true, proposedCommandLine: 'rm -rf build', submittedCommandLine: 'rm -rf build' } } } });
  await assert.rejects(bridge.decide('c1_1', 'accept'), /已经处理过了/);
  // The agent's own question: its options are the card's buttons; a permission is allowed once.
  steps[1] = agyStep('RUN_COMMAND', 'DONE', {}, { toolCall: { id: 't' } });
  steps.push(waitingOn({ askQuestion: { questions: [{ question: 'Which one?', options: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }] }] } }));
  await until(() => cards.length === 2);
  assert.deepEqual(at(cards, 1), { id: 'c1_2', title: 'Which one?', detail: '', decisions: [{ id: 'option:a', label: 'Alpha' }, { id: 'option:b', label: 'Beta' }, { id: 'decline', label: '跳过' }] });
  await bridge.decide('c1_2', 'option:b');
  assert.deepEqual(dig(at(calls, -1).body, 'interaction', 'askQuestion', 'responses', 0, 'selectedOptionIds'), ['b']);
  steps[2] = agyStep('RUN_COMMAND', 'DONE', {}, { toolCall: { id: 'q' } });
  steps.push(waitingOn({ permission: { resource: { action: 'write', target: '/w/a.txt' }, actionDescription: 'Write a file' } }));
  await until(() => cards.length === 3);
  assert.deepEqual([at(cards, 2).title, at(cards, 2).detail], ['Write a file', 'write · /w/a.txt']);
  await bridge.decide('c1_3', 'decline');
  assert.deepEqual(dig(at(calls, -1).body, 'interaction', 'permission'), { allow: false, scope: 'PERMISSION_SCOPE_ONCE' });
  // Answered in the desktop instead: the card goes away.
  steps[3] = agyStep('RUN_COMMAND', 'DONE', {}, { toolCall: { id: 'u' } });
  await until(() => gone.includes('c1_3'));
  // The shared run takes a labelled choice as it takes accept / decline.
  const { bindEvents } = __core_presentation;
  const seen: Array<[string, unknown]> = [], source = new EngineEvents(); bindEvents(source, (type, data) => seen.push([type, data]));
  source.emit('approval', at(cards, 1));
  assert.deepEqual(dig(at(seen, 0)[1], 'decisions', 0), { id: 'option:a', label: 'Alpha' });
  emitter.emit('interrupt'); bridge.dispose(); fs.rmSync(dir, { recursive: true });
});

test('Antigravity starts a new chat in a folder through the language server, and serves the pictures a person attached', async t => {
  const { bridge, calls, dir } = antigravityFixture([], { t });
  const real = bridge.fetch;
  bridge.fetch = async (url, options) => String(url).endsWith('/StartCascade') ? (calls.push({ method: 'StartCascade', body: bodyOf(options) }), answer({ cascadeId: 'new1' })) : real(url, options);
  bridge.agentapi = async () => { throw new Error('agentapi cannot name a folder'); };
  assert.deepEqual(await bridge.newConversation({ prompt: 'hello', cwd: dir, model: 'MODEL_A' }), { id: 'new1', engine: 'antigravity', started: true, cwd: dir });
  // The executor refuses to start without a model, so StartCascade carries the pick explicitly.
  assert.deepEqual(at(calls, 0).body, { source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE', workspaceUris: [__node_url.pathToFileURL(dir).href], config: { plannerConfig: { requestedModel: { model: 'MODEL_A' } } } });
  assert.deepEqual([at(calls, 1).method, dig(at(calls, 1).body, 'cascadeId'), dig(at(calls, 1).body, 'items', 0, 'text'), dig(at(calls, 1).body, 'cascadeConfig', 'plannerConfig', 'requestedModel', 'model')], ['SendUserCascadeMessage', 'new1', 'hello', 'MODEL_A']);
  await assert.rejects(bridge.newConversation({ prompt: 'x', cwd: path.join(dir, 'missing') }), /文件夹不存在/);
  // Pictures live in the conversation's own upload folder; anything else is only counted.
  const uploads = path.join(dir, 'brain', 'c9', '.user_uploaded'), logs = path.join(dir, 'brain', 'c9', '.system_generated', 'logs');
  fs.mkdirSync(uploads, { recursive: true }); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'media_1.png'), 'png');
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>look</USER_REQUEST>', media: [{ mime_type: 'image/png', uri: path.join(uploads, 'media_1.png') }, { mime_type: 'image/png', uri: '/etc/elsewhere.png' }] }) + '\n');
  const { turns } = await bridge.getConversationHistory('c9');
  assert.deepEqual(at(turns, 0).userImages, [{ url: '/api/sessions/antigravity/c9/media/media_1.png', alt: '' }]);
  assert.equal(at(turns, 0).userPrompt, '[图片 ×1] look');
  assert.equal(bridge.media('c9', 'media_1.png')?.type, 'image/png');
  assert.equal(bridge.media('c9', '..%2Fsecret.png'), null); assert.equal(bridge.media('c9', 'missing.png'), null);
  fs.rmSync(dir, { recursive: true });
});

test('Claude and Antigravity usage map native quota data to remaining-percent windows', async () => {
  const { usageOf } = __claude_bridge;
  const { quotaOf } = __antigravity_bridge;
  const { quotaLabel } = await import('../src/client/js/navigation.js');
  const claude = usageOf({ subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 30, resets_at: '2026-11-08T15:00:00Z' }, seven_day: { utilization: 55, resets_at: null }, model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: null }] } });
  assert.equal(quotaLabel(claude), '5h 70% · 7d 45%');
  assert.equal(at(claude.windows, 0).resetsAt, Date.parse('2026-11-08T15:00:00Z') / 1000);
  assert.equal(at(claude.windows, -1).label, '每周 · Fable');
  assert.equal(usageOf({ rate_limits_available: false, rate_limits: null }).available, false);
  // The account's own list of limits decides which windows there are: a model's weekly limit only where the plan has one.
  const row = (kind: string, group: string, percent: number, model?: string) => ({ kind, group, percent, resets_at: null, scope: model ? { model: { display_name: model }, surface: null } : null });
  const shared = [row('session', 'session', 16), row('weekly_all', 'weekly', 3)];
  assert.deepEqual(usageOf({ rate_limits: { five_hour: { utilization: 16 }, seven_day: { utilization: 3 }, limits: shared } }).windows?.map(item => item.id), ['five_hour', 'seven_day']);
  const scoped = usageOf({ rate_limits: { limits: [...shared, row('weekly_scoped', 'weekly', 5, 'Fable'), row('weekly_scoped', 'weekly', 40, 'Opus')], model_scoped: [{ display_name: 'Fable', utilization: 5 }] } });
  assert.deepEqual(scoped.windows?.map(item => [item.label, item.remainingPercent]), [['5 小时', 84], ['每周', 97], ['每周 · Fable', 95], ['每周 · Opus', 60]]);
  const { quotaCard, quotaMeter } = await import('../src/client/js/renderers.js');
  assert.equal(quotaCard(scoped).split('quota-row ').length - 1, 4, 'the card draws every window the engine reports');
  // The bar under the avatar has a segment for each of them too; a nearly empty one is marked, and no quota is one empty track.
  assert.equal(quotaMeter(scoped).split('class="meter-bar').length - 1, 4, 'the meter has a segment for every window');
  assert.doesNotMatch(quotaMeter(scoped), /is-low|is-empty/);
  assert.equal(quotaMeter({ available: true, windows: [{ id: 'a', remainingPercent: 9 }, { id: 'b', remainingPercent: 80 }] }).split('is-low').length - 1, 1);
  assert.match(quotaMeter({ available: false, short: '未登录' }), /quota-meter is-empty/);
  assert.match(quotaMeter(null), /quota-meter is-empty/);
  const agy = quotaOf({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Gemini Pro', quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-08T20:00:00Z' } },
    { label: 'Gemini Flash', quotaInfo: { remainingFraction: 0.25 } },
  ] } } });
  assert.equal(quotaLabel(agy), 'Gemini Pro 80%');
  assert.equal(quotaLabel(quotaOf({ configs: [{ label: 'A', quotaInfo: { remainingFraction: 0.9 } }, { label: 'B', quotaInfo: { resetTime: '2026-11-13T04:44:40Z' } }] }, 'B')), 'B 0%');
  assert.equal(agy.windows?.length, 2);
  assert.equal(quotaLabel({ available: false, short: '未登录' }), '未登录');
});

test('dictation relays audio to the engine, publishes the running transcript and merges Antigravity segments', async () => {
  const { DictationService } = __services_dictation;
  const { mergeTranscript } = __antigravity_bridge;
  const received: number[] = [];
  let hooks: DictationHandlers | undefined;
  const host = new PluginHost();
  host.register(fake<Engine>({ ...required, id: 'voice', label: 'Voice',
    dictate: async options => { hooks = options; return { send: chunk => { received.push(chunk.length); }, finish: () => must(hooks).onEnd(), cancel() {} }; } }));
  host.register(fake<Engine>({ ...required, id: 'silent', label: 'Silent' }));
  const service = new DictationService(host), updates: unknown[] = [];
  const { id } = await service.start('voice', { language: 'zh' });
  service.subscribe(id, snapshot => updates.push(snapshot));
  service.audio(id, Buffer.alloc(3200)); must(hooks).onText('你好'); service.finish(id);
  assert.deepEqual(received, [3200]);
  assert.deepEqual(at(updates, -1), { text: '你好', final: true, error: '' });
  // A chat whose agent has no speech service of its own is served by another agent's.
  const borrowed = await service.start('silent', { language: 'zh' });
  assert.equal(borrowed.engine, 'voice');
  service.dispose();
  let text = '';
  for (const [next, final] of [['第一句 话。', false], ['第一句话。 第二句 话在', false], ['第二句话在这里。', true]] as const) text = mergeTranscript(text, next, final);
  assert.equal(text, '第一句话。第二句话在这里。');
});


test('dictation tries the pick, the default, the current agent and the others, and passes over the ones that cannot start', async () => {
  const { DictationService, NO_VOICE } = __services_dictation;
  const { dictationOrder } = await import('../src/shared/dictation.js');
  assert.deepEqual(dictationOrder(['a', 'b', 'c'], { prefer: 'auto', preferred: 'b', current: 'c' }), ['b', 'c', 'a']);
  assert.deepEqual(dictationOrder(['a', 'b', 'c'], { prefer: 'a', preferred: 'b', current: 'c' }), ['a', 'b', 'c']);
  assert.deepEqual(dictationOrder(['a', 'b'], { prefer: 'browser', preferred: 'a' }), []);
  // The default is not switched on here (no Claude at all): it is simply not in the order.
  assert.deepEqual(dictationOrder(['a'], { preferred: 'claude', current: 'x' }), ['a']);

  const started: string[] = [];
  const stream = { send() {}, finish() {}, cancel() {} };
  const host = new PluginHost();
  host.register(fake<Engine>({ ...required, id: 'signedout', label: 'Signed Out',
    dictationReady: () => ({ ready: false, reason: '读取不到 Claude Code 的登录信息，请先运行 claude auth login' }),
    dictate: async () => { started.push('signedout'); return stream; } }));
  host.register(fake<Engine>({ ...required, id: 'broken', label: 'Broken',
    dictate: async options => { options.onError('late'); throw new Error('Broken 语音识别不可用 (503)'); } }));
  host.register(fake<Engine>({ ...required, id: 'works', label: 'Works',
    dictationReady: async () => ({ ready: true }),
    dictate: async () => { started.push('works'); return stream; } }));
  host.register(fake<Engine>({ ...required, id: 'chat', label: 'Chat' }));
  const service = new DictationService(host, { preferred: 'signedout' });

  const info = await service.sources();
  assert.equal(info.preferred, 'signedout');
  assert.deepEqual(info.sources.map(item => [item.engine, item.ready]), [['signedout', false], ['broken', true], ['works', true]]);
  assert.match(info.sources[0]?.reason || '', /claude auth login/);

  const result = await service.start('chat', { language: 'zh' });
  assert.equal(result.engine, 'works');
  assert.equal(result.label, 'Works');
  assert.deepEqual(result.skipped.map(item => [item.engine, item.reason]), [['signedout', '读取不到 Claude Code 的登录信息，请先运行 claude auth login'], ['broken', 'Broken 语音识别不可用 (503)']]);
  assert.deepEqual(started, ['works'], 'a service that says it cannot start is not started');
  // What the failed service reported before it gave up is not this session's.
  assert.equal(service.snapshot(service.get(result.id)).error, '');
  // The person's pick goes first.
  assert.equal((await service.start('chat', { prefer: 'works' })).skipped.length, 0);

  // None can start: the answer says why for each, and the page turns to the browser's recognizer.
  const none = new PluginHost();
  none.register(fake<Engine>({ ...required, id: 'off', label: 'Off', dictationReady: () => ({ ready: false, reason: '未找到正在运行的 Antigravity。请打开 Antigravity 桌面端后重试。' }), dictate: async () => stream }));
  const err = await new DictationService(none).start('off').then(() => assert.fail('started'), (error: unknown) => error);
  assert.equal(errorField(err, 'message'), NO_VOICE);
  assert.equal(errorField(err, 'status'), 409);
  assert.equal(dig(err, 'skipped', 0, 'engine'), 'off');
  // An agent with no speech service at all and nothing else switched on.
  const empty = new PluginHost();
  empty.register(fake<Engine>({ ...required, id: 'chat', label: 'Chat' }));
  assert.deepEqual(await new DictationService(empty).sources(), { preferred: '', sources: [] });
  await assert.rejects(new DictationService(empty).start('chat'), (error: unknown) => errorField(error, 'status') === 409);
  service.dispose();
});

test('antigravity says its speech service needs the desktop app running', (t) => {
  const { AntigravityBridge } = __antigravity_bridge;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = new AntigravityBridge({ agyHome: dir, agentapiBin: '/bin/false', catalogs: {} }, {});
  bridge.lsEnv = () => null;
  assert.deepEqual(bridge.dictationReady(), { ready: false, reason: '未找到正在运行的 Antigravity。请打开 Antigravity 桌面端后重试。' });
});

test('antigravity shows a mid-turn system message and times the work after it', async t => {
  const { AntigravityBridge } = __antigravity_bridge;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  const line = (record: object) => JSON.stringify(record);
  fs.writeFileSync(file, [
    line({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-08T10:00:00Z', content: '<USER_REQUEST>hi</USER_REQUEST>' }),
    line({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-08T10:00:05Z', content: 'first answer' }),
    line({ step_index: 3, type: 'SYSTEM_MESSAGE', created_at: '2026-11-08T11:00:00Z', content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=x sender=system priority=MESSAGE_PRIORITY_HIGH content=why no access\n</SYSTEM_MESSAGE>' }),
    line({ step_index: 4, type: 'PLANNER_RESPONSE', created_at: '2026-11-08T11:00:43Z', content: 'found it' }),
  ].join('\n') + '\n');
  const bridge = new AntigravityBridge({ agyHome: dir, agentapiBin: '/bin/false', catalogs: {} }, {});
  const { turns } = await bridge.parseTranscript(file);
  const notice = must(at(turns, 0).steps.find(step => step.type === 'notice'));
  assert.equal(notice.title, 'Message from System');
  assert.equal(notice.detail, 'why no access');
  assert.equal(at(turns, 0).workedMs, 43000);
  assert.deepEqual(at(turns, 0).timeline?.map(entry => entry.kind), ['message', 'activity', 'message']);
});

test('Antigravity reads the full transcript when the short one cut messages down', async t => {
  const { AntigravityBridge } = __antigravity_bridge;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-full-')), logs = path.join(dir, 'brain/c1/.system_generated/logs');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(logs, { recursive: true });
  const record = (content: string) => JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nq\n</USER_REQUEST>' }) + '\n' + JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content }) + '\n';
  const whole = 'Before\n```mermaid\ngraph TD\n  A --> B\n```\nAfter';
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), record('Before\n```mermaid\ngraph TD <truncated 20 bytes> B\n```\nAfter'));
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), record(whole));
  const bridge = new AntigravityBridge({ agyHome: dir, agentapiBin: '/bin/false', catalogs: {} }, {});
  const { turns } = await bridge.getConversationHistory('c1');
  assert.equal(at(at(turns, 0).messages, -1).text, whole);
  // Older conversations with only the short file still read.
  fs.rmSync(path.join(logs, 'transcript_full.jsonl'));
  assert.match(bridge.transcriptPath('c1'), /transcript\.jsonl$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a code block cut short is closed so it cannot swallow the rest of a reply', async () => {
  // Math in either form the desktops write: Codex's \( \) and \[ \] as well as $ and $$; money stays text.
  const { mathIn } = await import('../src/client/js/renderers.js');
  assert.deepEqual(mathIn('There are \\(k\\) pods, so\n\n\\[\nX=\\boxed{\\frac{5k^4}{4}}\n\\]\n\nand $n^2$ for \\[a\\] too.'),
    [{ tex: 'k', display: false }, { tex: 'X=\\boxed{\\frac{5k^4}{4}}', display: true }, { tex: 'n^2', display: false }, { tex: 'a', display: true }]);
  assert.deepEqual(mathIn('$$x$$\n\nit costs $5 and $10'), [{ tex: 'x', display: true }]);
  assert.deepEqual(mathIn('`\\(code\\)` and\n```\n\\[x\\]\n```'), []);
  assert.deepEqual(mathIn('text\n```\n$$x$$\n```'), []);
  const { closeFences } = await import('../src/client/js/renderers.js');
  assert.equal(closeFences('a\n```js\nx()'), 'a\n```js\nx()\n```');
  assert.equal(closeFences('a\n```js\nx()\n```\nb'), 'a\n```js\nx()\n```\nb');
  assert.equal(closeFences('~~~~\n```\nstill code'), '~~~~\n```\nstill code\n~~~~');
  assert.equal(closeFences('use ```inline``` here'), 'use ```inline``` here');
});

test('a link to a folder or an extensionless file is a file link; bare inline code needs an extension', async () => {
  Reflect.set(globalThis, 'window', Reflect.get(globalThis, 'window') || {});
  const { filePathOf } = await import('../src/client/js/renderers.js');
  assert.equal(filePathOf('/Users/me/network/docs/', { link: true }), '/Users/me/network/docs/');
  assert.equal(filePathOf('config/', { link: true }), 'config/');
  assert.equal(filePathOf('Makefile', { link: true }), 'Makefile');
  assert.equal(filePathOf('../', { link: true }), '');
  assert.equal(filePathOf('npm test', { link: true }), '');
  assert.equal(filePathOf('docs/'), '');
  assert.equal(filePathOf('lib/a.js:3'), 'lib/a.js:3');
  // A path whose file has any extension, a dotfile in a folder, or an absolute path on this machine.
  const scratch = '/private/tmp/claude-501/-Users-me-app/70b5f29d/scratchpad/4130.log';
  assert.equal(filePathOf(scratch), scratch);
  assert.equal(filePathOf('logs/server.log'), 'logs/server.log');
  assert.equal(filePathOf('~/.codex/config.toml'), '~/.codex/config.toml');
  assert.equal(filePathOf('~/.codex/ipc/app.sock'), '~/.codex/ipc/app.sock');
  assert.equal(filePathOf('video/.gitignore'), 'video/.gitignore');
  assert.equal(filePathOf('/Users/Shared/demo'), '/Users/Shared/demo');
  assert.equal(filePathOf('/home/me/q6-demo/'), '/home/me/q6-demo/');
  assert.equal(filePathOf('4130.log'), '4130.log');
  assert.equal(filePathOf('~/.claude/', { link: true }), '~/.claude/');
  assert.equal(filePathOf('file:///d:/%E6%80%BB%E6%95%B0%E6%8D%AE%E5%BA%93/Agent%20Frontdesk/HANDOFF.md:10', { link: true }), 'd:/总数据库/Agent Frontdesk/HANDOFF.md:10');
  assert.equal(filePathOf('C:\\Users\\me\\app.ts:12'), 'C:/Users/me/app.ts:12');
  // Still code: a command, a branch, an API route, a method call, a version, a fraction.
  for (const code of ['npm test', 'origin/main', 'claude/link-parsing', '/api/activity', 'thread/start', 'console.warn', 'v1.2', '1/2.5', 'github.com/me/repo', 'javascript:alert(1)', '~', '~/', '/']) assert.equal(filePathOf(code), '', code);
});

test('a Codex writing block is read up to its closing ::: (a fence inside it does not close it)', async () => {
  Reflect.set(globalThis, 'window', Reflect.get(globalThis, 'window') || {});
  const { writingBlock } = await import('../src/client/js/renderers.js');
  const block = writingBlock(':::writing{variant="email" id="12345" subject="Hi" recipient="a@b.c"}\nDear A,\n\n```\n:::\n```\nBye\n:::\nafter');
  assert.deepEqual(block, { raw: ':::writing{variant="email" id="12345" subject="Hi" recipient="a@b.c"}\nDear A,\n\n```\n:::\n```\nBye\n:::\n', attributes: { variant: 'email', id: '12345', subject: 'Hi', recipient: 'a@b.c' }, body: 'Dear A,\n\n```\n:::\n```\nBye' });
  // One still being written runs to the end of the text.
  assert.deepEqual(writingBlock(':::writing{variant="standard" id="83924"}\nSo the question'), { raw: ':::writing{variant="standard" id="83924"}\nSo the question', attributes: { variant: 'standard', id: '83924' }, body: 'So the question' });
  assert.equal(writingBlock('text\n:::writing{}'), null);
});

test('system notices injected into a trajectory are not how a turn ends', async t => {
  const steps = [
    agyStep('USER_INPUT', 'DONE', { userInput: { userResponse: 'go' } }),
    agyStep('EPHEMERAL_MESSAGE', 'DONE', { ephemeralMessage: { content: '<context/>' } }),
  ];
  const { bridge, dir } = antigravityFixture(steps, { t });
  const row = { last_user_input_step_index: 0 };
  // The cascade went idle while only notices followed the message: not an ending yet.
  assert.equal(await bridge.turnOutcome('c1', row), null);
  steps.push(agyStep('ERROR_MESSAGE', 'DONE', { errorMessage: { shouldShowUser: true, error: { userErrorMessage: 'Agent execution terminated due to error.', shortError: 'quota gone' } } }));
  assert.deepEqual(await bridge.turnOutcome('c1', row), { status: 'failed', error: { message: 'Agent execution terminated due to error. quota gone' } });
  // A tool step settling is not an ending either: the desktop may still be writing its verdict.
  steps.splice(2, 1, agyStep('RUN_COMMAND', 'DONE', { runCommand: { combinedOutput: { full: 'a.txt' } } }));
  assert.equal(await bridge.turnOutcome('c1', row), null);
  steps.splice(2, 1, agyStep('PLANNER_RESPONSE', 'DONE', { plannerResponse: { response: 'done' } }));
  assert.deepEqual(await bridge.turnOutcome('c1', row), { status: 'completed' });
  bridge.dispose(); fs.rmSync(dir, { recursive: true });
});
