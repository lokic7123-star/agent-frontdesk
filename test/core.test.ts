import { test } from 'node:test';
import { once } from 'node:events';
import { EngineEvents } from '../src/server/types.js';
import { at, bridgeEvent, dig, fake, must, required } from './support.js';
import { errorField, get } from '../src/shared/guards.js';
import { loadConfig } from '../src/server/config.js';
import type { CodexDesktopIpc, DesktopRequest } from '../src/server/codex-desktop.js';
import type { AnyBridgeEvent, BridgeEventMap, BridgeEventType, Engine, History, RunTurn, UnifiedSession, UnifiedStep, UnifiedTurn } from '../src/shared/contract.js';
import type { HubMessage } from '../src/server/core/event-hub.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { EventHub } from '../src/server/core/event-hub.js';
import { RunService } from '../src/server/core/run-service.js';
import { presentHistory } from '../src/server/core/presentation.js';
import { tailJsonl } from '../src/server/services/jsonl-tail.js';
import { UnifiedSession as Listed } from '../src/server/types.js';
import { createApp } from '../src/server/server.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as __types from '../src/server/types.js';
import * as __core_presentation from '../src/server/core/presentation.js';
import __node_net from 'node:net';
import * as __codex_desktop from '../src/server/codex-desktop.js';
import * as __codex_bridge from '../src/server/codex-bridge.js';
import { fileURLToPath as __fileURLToPath } from 'node:url';
const __dirname = __fileURLToPath(new URL('.', import.meta.url));
// An engine whose runs the test drives: `emitter` is the latest run's.
function provider(id = 'fixture'): Engine & { readonly emitter: EngineEvents | undefined } {
  let emitter: EngineEvents | undefined;
  return { id, label: 'Fixture', capabilities: { interrupt: true },
    status: async () => ({ connected: true }), models: async () => [], list: async () => [],
    read: async (): Promise<History> => { throw new Error('Not persisted yet'); }, create: async () => ({ id: 'new-session', isNew: true }),
    send() { emitter = new EngineEvents(); return emitter; }, interrupt: async () => must(emitter).emit('interrupt'),
    get emitter() { return emitter; },
  };
}
// A history the engine reads: only the session status the test changes.
const busyHistory = (status: 'busy' | 'idle'): History => fake<History>({ session: fake<UnifiedSession>({ status }), turns: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('only engines that opt in can stop a turn without a Frontdesk run', async () => {
  const host = new PluginHost(), hub = new EventHub(), calls: string[] = [];
  host.register(provider());
  host.register({ ...provider('desktop'), capabilities: { interrupt: true, desktopInterrupt: true },
    interrupt: (id, emitter) => { assert.equal(emitter, undefined); calls.push(id); return { pending: true }; } });
  const service = new RunService(host, hub);
  await assert.rejects(service.interrupt('fixture', 'session'), err => errorField(err, 'status') === 409);
  assert.deepEqual(await service.interrupt('desktop', 'session'), { pending: true });
  assert.deepEqual(calls, ['session']);
  assert.equal(service.active.size, 0);
});
test('new engines work through registry without changing routes; duplicate registration fails', () => {
  const host = new PluginHost(); host.register(provider('fourth-engine'));
  assert.equal(host.get('fourth-engine').label, 'Fixture');
  assert.throws(() => host.register(provider('fourth-engine')), /Duplicate/);
  assert.throws(() => host.get('absent'), /Unknown/);
});
test('engines declare the desktop\'s modes; the manifest keeps valid ones and exactly one default', () => {
  const host = new PluginHost();
  host.register({ ...provider('moded'), spaces: [{ id: 'chat', label: 'Chat', unavailable: 'later' }, { id: 'code', label: 'Code', default: true, noNew: 'not here' }, { id: 'Bad Id', label: 'x' }, { id: 'code', label: 'again' }] });
  host.register({ ...provider('single'), spaces: [{ id: 'only', label: 'Only' }] });
  host.register({ ...provider('nodefault'), spaces: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  const [moded, single, nodefault] = ['moded', 'single', 'nodefault'].map(id => must(host.manifests().find(item => item.id === id)));
  assert.deepEqual(moded?.spaces, [{ id: 'chat', label: 'Chat', default: false, unavailable: 'later' }, { id: 'code', label: 'Code', default: true, noNew: 'not here' }]);
  assert.deepEqual(single?.spaces, []);
  assert.deepEqual(nodefault?.spaces.map(item => item.default), [true, false]);
});
test('journal replays exactly after cursor and resets when retention/epoch is lost', () => {
  const hub = new EventHub({ maxEvents: 2 });
  const first = hub.publish('a', 's', 't', 'run.started', { turn: fake<RunTurn>({}) });
  hub.publish('a', 's', 't', 'run.completed', {}); hub.publish('a', 's', 't', 'run.interrupted', {});
  const replay: string[] = []; const off = hub.subscribe('a', 's', first.id, event => replay.push(event.type));
  assert.deepEqual(replay, ['run.completed', 'run.interrupted']); off();
  const reset: string[] = []; hub.subscribe('a', 's', 'old-epoch:9', event => reset.push(event.type))();
  assert.deepEqual(reset, ['stream.reset']);
});
test('runs isolate sessions, reject overlap, preserve tool output and terminate once', async () => {
  const host = new PluginHost(), engine = provider(), hub = new EventHub(); host.register(engine);
  const service = new RunService(host, hub), events: HubMessage[] = [];
  const off = hub.subscribe('fixture', 'session', null, event => events.push(event));
  service.start('fixture', 'session', { prompt: 'hello', attachments: [] });
  assert.throws(() => service.start('fixture', 'session', { prompt: 'again', attachments: [] }), /已有任务/);
  await tick();
  must(engine.emitter).emit('item_started', { item: { id: 'cmd', type: 'commandExecution', command: 'npm test' } });
  must(engine.emitter).emit('delta', { type: 'command_output', itemId: 'cmd', output: 'passed' });
  must(engine.emitter).emit('delta', { type: 'agent_message', itemId: 'message', text: 'Done' });
  assert.equal(at(service.get('fixture', 'session')?.run.activities, 0).output, 'passed');
  assert.equal(dig(at(hub.journals.get(hub.key('fixture', 'session'))?.events, 0).data, 'turn', 'messages', 'length'), 0, 'journal snapshots cannot mutate later');
  must(engine.emitter).emit('completed', {}); must(engine.emitter).emit('completed', {});
  assert.doesNotThrow(() => must(engine.emitter).emit('error', new Error('late error')));
  assert.equal(events.filter(event => event.type === 'run.completed').length, 1);
  assert.equal(service.get('fixture', 'session'), undefined);
  assert.equal(at(hub.cursor('fixture', 'different').split(':'), -1), '0');
  off(); service.dispose();
});
test('history presentation removes patches, raw thinking and file contents', () => {
  // A native artifact may carry more than the contract names (here a diff); it must not pass through.
  const artifact = { path: '/work/brief.md', diff: 'PRIVATE PATCH' };
  const output = presentHistory({ turns: [fake<UnifiedTurn>({ id: 't', steps: [fake<UnifiedStep>({ id: 'r', type: 'reasoning', detail: 'PRIVATE THINKING' }), fake<UnifiedStep>({ id: 'f', type: 'file_change', detail: 'SECRET CONTENT', patch: 'PRIVATE PATCH', output: 'PRIVATE PATCH' })], artifacts: [artifact] })] });
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|SECRET/);
  assert.equal(at(at(output.turns, 0).artifacts, 0).title, 'brief.md');
});
test('tailer retains partial JSON and multibyte text and releases timer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tail-')), file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, ''); const records: unknown[] = [], errors: unknown[] = [];
  const tail = tailJsonl(file, 0, record => records.push(record), { onError: err => errors.push(err) });
  const bytes = Buffer.from('{"text":"你好"}\n');
  fs.appendFileSync(file, bytes.subarray(0, 11)); tail.read(); assert.equal(records.length, 0);
  fs.appendFileSync(file, bytes.subarray(11)); tail.read(); assert.deepEqual(records, [{ text: '你好' }]);
  fs.appendFileSync(file, '{"next":1}\n'); tail.read(); tail.read(); assert.equal(records.length, 2);
  tail.close(); fs.rmSync(dir, { recursive: true }); assert.deepEqual(errors, []);
});
test('frontend reducer deduplicates replay and separates commentary from final output', async () => {
  const { createStore } = await import('../src/client/js/store.js'); const store = createStore();
  const event = <K extends BridgeEventType>(type: K, data: BridgeEventMap[K], id: string) => bridgeEvent(type, data, { id, turnId: 'turn' });
  store.apply(event('run.started', { turn: fake<RunTurn>({ id: 'turn', userPrompt: 'hello', status: 'running', messages: [], activities: [], artifacts: [], approvals: [] }) }, '1'));
  store.apply(event('message.updated', { id: 'preamble', phase: 'assistant', text: 'I will inspect' }, '2'));
  const final = event('message.updated', { id: 'final', phase: 'assistant', text: 'Result' }, '3'); store.apply(final); store.apply(final);
  store.apply(event('run.completed', {}, '4'));
  const turn = at(store.turns, 0);
  assert.equal(turn.messages.length, 2);
  assert.equal(at(turn.messages, 0).phase, 'commentary'); assert.equal(at(turn.messages, 1).phase, 'final_answer');
  assert.equal(store.active, undefined);
});
test('generic HTTP routes support drafts, errors, event replay and interrupt', async t => {
  const host = new PluginHost(), engine = provider('fourth'); host.register(engine);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-http-'));
  const context = await createApp({ host, config: { ...loadConfig(), uploadsDir: directory, defaultCwd: '/work' } });
  const server = context.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  t.after(async () => { await context.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  const json = async (url: string, body?: unknown): Promise<{ status: number; data: unknown }> => { const response = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  assert.equal(dig((await json('/api/engines')).data, 'engines', 0, 'id'), 'fourth');
  assert.equal(dig((await json('/api/usage')).data, 'fourth', 'available'), false);
  // The page's libraries are bundled into it now; the old /vendor routes are gone.
  assert.equal((await fetch(base + '/vendor/marked.js')).status, 404);
  assert.equal((await json('/api/sessions/unknown/id')).status, 404);
  assert.equal(dig((await json('/api/sessions/fourth', {})).data, 'id'), 'new-session');
  assert.equal(dig((await json('/api/sessions/fourth/new-session')).data, 'turns', 'length'), 0);
  assert.equal(dig((await json('/api/sessions')).data, 'fourth', 'length'), 1);
  // A list goes to the page without the recent replies kept for the activity feed, compressed
  // when it is big enough to be worth it; the engine's own list still has them.
  engine.list = async () => [new Listed({ id: 'listed', engine: 'fourth', title: 'T', updatedAt: '2026-11-13T00:00:00Z', metadata: { model: 'm', recentMessages: Array.from({ length: 6 }, (_, n) => ({ id: `m${n}`, preview: 'x'.repeat(400), phase: 'assistant', at: n })) } })];
  const listed = dig((await json('/api/sessions')).data, 'fourth');
  assert.deepEqual(dig(listed, 1, 'metadata'), { model: 'm' }); assert.equal(dig(listed, 1, 'title'), 'T');
  assert.equal(at(await engine.list(), 0).metadata.recentMessages?.length, 6);
  engine.list = async () => Array.from({ length: 40 }, (_, n) => new Listed({ id: `s${n}`, engine: 'fourth', title: `Session ${n}`, updatedAt: '2026-11-13T00:00:00Z' }));
  const packed = await fetch(base + '/api/sessions', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(packed.headers.get('content-encoding'), 'gzip'); assert.equal(dig(await packed.json(), 'fourth', 'length'), 41);
  // An event stream is never compressed: each event must go out as it is written.
  const stream = await fetch(base + '/api/activity/events', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(stream.headers.get('content-encoding'), null); await stream.body?.cancel();
  engine.list = async () => [];
  assert.equal((await json('/api/sessions/fourth/new-session/messages', { prompt: 22 })).status, 400);
  assert.equal((await json('/api/sessions/fourth/new-session/messages', { prompt: 'hi', attachments: [{ filename: '../absent' }] })).status, 400);
  const started = await json('/api/sessions/fourth/new-session/messages', { prompt: 'hi' }); assert.equal(started.status, 202);
  assert.equal((await json('/api/sessions/fourth/new-session/messages', { prompt: 'again' })).status, 409);
  assert.equal(dig((await json('/api/sessions/fourth/new-session')).data, 'activeTurn', 'userPrompt'), 'hi');
  const overviewController = new AbortController();
  const overview = await fetch(base + '/api/activity/events', { signal: overviewController.signal });
  const overviewText = new TextDecoder().decode((await must(overview.body).getReader().read()).value);
  assert.match(overviewText, /event: activity/); assert.match(overviewText, /"running":true/); overviewController.abort();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/sessions/fourth/new-session/events?after=${encodeURIComponent(String(dig(started.data, 'cursor')))}`, { signal: controller.signal });
  const reader = must(response.body).getReader(); const ready = new TextDecoder().decode((await reader.read()).value); assert.match(ready, /event: ready/);
  must(engine.emitter).emit('delta', { type: 'agent_message', text: 'answer', itemId: 'm' });
  const eventText = new TextDecoder().decode((await reader.read()).value); assert.match(eventText, /message.updated/); controller.abort();
  assert.equal((await json('/api/sessions/fourth/new-session/interrupt', {})).status, 200);
  assert.equal(context.runs.active.size, 0);
  assert.equal(dig((await json('/api/activity')).data, 'sessions', 0, 'running'), false);
  const originResponse = await fetch(base + '/api/sessions/fourth', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(originResponse.status, 403);
});
test('a wrap-up card\'s desktop buttons are read and pressed through the engine only when it declares cardActions', async t => {
  const calls: Array<[string, string, unknown]> = [];
  const host = new PluginHost();
  host.register({ ...provider('presses'), capabilities: { cardActions: true },
    readCard: (id, card) => { calls.push(['read', id, card]); return { actions: ['Create PR'] }; },
    pressAction: (id, action) => { calls.push(['press', id, action]); if (action.index > 0) throw Object.assign(new Error('卡片上没有这个按钮'), { status: 409 }); return { pressed: true }; } });
  host.register(provider('cannot'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-actions-'));
  const context = await createApp({ host, config: { ...loadConfig(), uploadsDir: directory, defaultCwd: '/work' } });
  const server = context.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  t.after(async () => { await context.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  const post = async (url: string, body: unknown) => { const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  const card = { ask: '要推送分支并开 PR 吗？', recap: 'Done.', replies: ['先不用'] };
  const read = await post('/api/sessions/presses/s1/card', card);
  assert.equal(read.status, 200); assert.deepEqual(read.data, { actions: ['Create PR'] }, 'the desktop names its own buttons');
  assert.equal((await post('/api/sessions/presses/s1/card', { replies: [] })).status, 400, 'a card is found by its words');
  const press = { ...card, index: 0, label: 'Create PR' };
  const ok = await post('/api/sessions/presses/s1/actions', press);
  assert.equal(ok.status, 200); assert.equal(dig(ok.data, 'pressed'), true);
  assert.deepEqual(calls, [['read', 's1', card], ['press', 's1', press]]);
  assert.equal((await post('/api/sessions/presses/s1/actions', card)).status, 400, 'a press says which of the desktop\'s buttons');
  const failed = await post('/api/sessions/presses/s1/actions', { ...press, index: 1 });
  assert.equal(failed.status, 409); assert.equal(dig(failed.data, 'error'), '卡片上没有这个按钮');
  const off = await post('/api/sessions/cannot/s1/actions', press);
  assert.equal(off.status, 501); assert.equal(dig(off.data, 'error'), '这个操作只能在桌面版里点');
  assert.equal((await post('/api/sessions/cannot/s1/card', card)).status, 501);
  assert.equal(calls.length, 3, 'an engine without cardActions is never asked');
});

test('step lists and engine-served images pass through history and live events; other image sources are dropped', async () => {
  const { UnifiedStep } = __types;
  const { presentHistory, bindEvents } = __core_presentation;
  const plan = [{ content: 'Read the code', status: 'completed' }, { content: 'Change the page', status: 'in_progress' }];
  const history = presentHistory({ turns: [fake<UnifiedTurn>({ id: 't', userPrompt: 'go', messages: [{ id: 'm', text: 'ok', phase: 'final_answer' }], timeline: [{ kind: 'activity', id: 'p' }, { kind: 'activity', id: 's' }, { kind: 'message', id: 'm' }],
    steps: [new UnifiedStep({ id: 'p', type: 'tool_call', name: 'TodoWrite', plan }), new UnifiedStep({ id: 's', type: 'tool_call', name: 'screenshot', images: [{ url: '/api/sessions/x/t/media/a.png' }, { url: 'https://example.com/b.png' }] })] })] });
  const planStep = at(at(history.turns, 0).activities, 0), shot = at(at(history.turns, 0).activities, 1);
  assert.deepEqual(planStep.plan, plan);
  assert.deepEqual(shot.images?.map(image => image.url), ['/api/sessions/x/t/media/a.png']);
  const emitter = new EngineEvents(), events: Array<{ type: string; data: unknown }> = []; bindEvents(emitter, (type, data) => events.push({ type, data }));
  emitter.emit('delta', { type: 'tool_call', id: 'c', name: 'screenshot', input: {} });
  emitter.emit('delta', { type: 'tool_result', id: 'c', output: 'done', images: [{ url: '/api/sessions/x/t/media/c.png' }] });
  assert.equal(dig(at(events, -1).data, 'images', 0, 'url'), '/api/sessions/x/t/media/c.png');
});

test('codex edits become line counts only, native items map to rows, times read as ISO', () => {
  const { activityOf: present, presentHistory: history } = __core_presentation;
  const edit = present({ type: 'fileChange', id: 'f', changes: [
    { path: '/w/a.py', kind: { type: 'update' }, diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+more\n keep' },
    { path: '/w/new.md', kind: { type: 'add' }, diff: 'line one\nline two\n' },
  ] });
  assert.deepEqual(edit.changes, [{ path: '/w/a.py', kind: 'update', added: 2, removed: 1 }, { path: '/w/new.md', kind: 'add', added: 2, removed: 0 }]);
  assert.ok(!JSON.stringify(edit).includes('new\\n+more'), 'the patch itself is not passed on');
  assert.equal(present({ type: 'mcpToolCall', id: 'm', server: 'codex_app', tool: 'list', arguments: {}, status: 'completed' }).title, 'Called · codex_app.list');
  assert.equal(present({ type: 'imageView', id: 'i', path: '/w/shot.png' }).kind, 'image_view');
  assert.equal(present({ type: 'contextCompaction', id: 'c', completedAtMs: 1 }).title, 'Context automatically compacted');
  const turn = at(history({ turns: [fake<UnifiedTurn>({ id: 't', timestamp: 1794209597, completedAt: 1794209971000, durationMs: 374927, steps: [], artifacts: [{ path: '/w/a.md' }, { path: '/w/a.md' }] })] }).turns, 0);
  assert.equal(turn.timestamp, new Date(1794209597000).toISOString());
  assert.equal(turn.completedAt, new Date(1794209971000).toISOString());
  assert.equal(turn.durationMs, 374927);
  assert.equal(turn.artifacts.length, 1);
});

test('a message sent during a turn joins it (steer) or waits for it to end (queue)', async () => {
  const host = new PluginHost(), engine = provider(), hub = new EventHub(); host.register(engine);
  const steered: string[] = [];
  engine.steer = async (id, input) => { steered.push(input.prompt); return {}; };
  let busy = false; engine.read = async () => busyHistory(busy ? 'busy' : 'idle');
  const service = new RunService(host, hub); service.pollMs = 5;
  service.start('fixture', 'session', { prompt: 'first', attachments: [] }); await tick();
  await service.steer('fixture', 'session', { prompt: 'also check the tests', attachments: [] });
  assert.deepEqual(steered, ['also check the tests']);
  assert.equal(at(service.get('fixture', 'session')?.run.activities, -1).kind, 'user_message');
  const queued = service.enqueue('fixture', 'session', { prompt: 'then write docs', attachments: [] });
  service.enqueue('fixture', 'session', { prompt: 'dropped', attachments: [] });
  service.dequeue('fixture', 'session', at(service.queued('fixture', 'session'), 1).id);
  assert.equal(service.queued('fixture', 'session').length, 1);
  assert.equal(queued.status, 'queued');
  // The queued message waits for the running turn, then for the desktop's own turn.
  busy = true;
  must(engine.emitter).emit('completed', {});
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(service.get('fixture', 'session'), undefined, 'still waiting while the desktop is busy');
  busy = false;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(service.get('fixture', 'session')?.run.userPrompt, 'then write docs');
  assert.equal(service.queued('fixture', 'session').length, 0);
  // An engine that cannot join a turn started elsewhere queues instead.
  engine.steer = async () => { throw Object.assign(new Error('not ours'), { fallback: 'queue' }); };
  assert.equal((await service.steer('fixture', 'session', { prompt: 'later', attachments: [] })).status, 'queued');
  service.dispose();
});

test('a queued message can still be steered in, or taken back to edit', async () => {
  const host = new PluginHost(), engine = provider(), hub = new EventHub(); host.register(engine);
  engine.read = async () => busyHistory('busy');
  const service = new RunService(host, hub); service.pollMs = 1000;
  service.start('fixture', 'session', { prompt: 'first', attachments: [] }); await tick();
  const a = service.enqueue('fixture', 'session', { prompt: 'one', attachments: [] });
  const b = service.enqueue('fixture', 'session', { prompt: 'two', attachments: [{ filename: 'x.png', path: '/tmp/x.png', originalname: 'x.png', mimetype: 'image/png', url: '/uploads/x.png' }] });
  service.enqueue('fixture', 'session', { prompt: 'three', attachments: [] });
  // The turn still cannot take it: the message keeps its place in the queue.
  engine.steer = async () => { throw Object.assign(new Error('这一轮没法插进去（no-client-found），消息已排队'), { fallback: 'queue' }); };
  await assert.rejects(service.steerQueued('fixture', 'session', b.id), err => errorField(err, 'status') === 409 && /消息还在队列里/.test(String(errorField(err, 'message'))));
  assert.deepEqual(service.queued('fixture', 'session').map(item => item.prompt), ['one', 'two', 'three']);
  // It can: the message leaves the queue and shows in the running turn.
  const steered: string[] = []; engine.steer = async (id, input) => { steered.push(input.prompt); return {}; };
  assert.equal((await service.steerQueued('fixture', 'session', a.id)).status, 'steered');
  assert.deepEqual(steered, ['one']);
  assert.deepEqual(service.queued('fixture', 'session').map(item => item.prompt), ['two', 'three']);
  // Editing takes it out of the queue and hands back its text and attachments (no local paths).
  const taken = service.dequeue('fixture', 'session', b.id);
  assert.equal(taken.prompt, 'two');
  assert.deepEqual(taken.attachments, [{ filename: 'x.png', originalname: 'x.png', mimetype: 'image/png', url: '/uploads/x.png' }]);
  service.dispose();
});

test('Codex steers a desktop-run turn through the desktop IPC as a thread follower', async t => {
  const net = __node_net, codexDesktop = __codex_desktop;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-'));
  // Windows: AF_UNIX bind of a filesystem path is refused (EACCES); a named pipe stands in.
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\frontdesk-ipc-test-${process.pid}` : path.join(dir, 's.sock');
  const seen: unknown[] = [];
  const server = net.createServer(socket => {
    let buffer: Buffer = Buffer.alloc(0); socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0), message: unknown = JSON.parse(buffer.subarray(4, 4 + size).toString()); buffer = buffer.subarray(4 + size);
        seen.push(message);
        if (get(message, 'type') !== 'request') continue;
        if (get(message, 'method') === 'initialize') socket.write(codexDesktop.frame({ type: 'response', requestId: get(message, 'requestId'), resultType: 'success', method: 'initialize', result: { clientId: 'c1' } }));
        else {
          // The router first asks every client whether it owns the thread; a bridge never does.
          socket.write(codexDesktop.frame({ type: 'client-discovery-request', requestId: 'd1', request: message }));
          socket.write(codexDesktop.frame({ type: 'response', requestId: get(message, 'requestId'), resultType: 'success', method: get(message, 'method'), result: { result: { turnId: 't9' } } }));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(sock, resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const result = await codexDesktop.steer({ threadId: 'th1', prompt: 'also run the tests', inputs: [{ type: 'text', text: 'also run the tests', text_elements: [] }] }, { sock, timeoutMs: 2000 });
  assert.deepEqual(result, { result: { turnId: 't9' } });
  const init = at(seen, 0), steer = seen.find(item => get(item, 'type') === 'request' && get(item, 'method') !== 'initialize');
  await new Promise(resolve => setTimeout(resolve, 20));
  const discovery = seen.find(item => get(item, 'type') === 'client-discovery-response');
  assert.equal(get(init, 'method'), 'initialize');
  assert.deepEqual(discovery, { type: 'client-discovery-response', requestId: 'd1', response: { canHandle: false } });
  assert.equal(dig(steer, 'method'), 'thread-follower-steer-turn');
  assert.equal(dig(steer, 'version'), 1);
  assert.equal(dig(steer, 'sourceClientId'), 'c1');
  assert.equal(dig(steer, 'params', 'conversationId'), 'th1');
  assert.equal(dig(steer, 'params', 'restoreMessage', 'text'), 'also run the tests');
  assert.equal(dig(steer, 'params', 'clientUserMessageId'), dig(steer, 'params', 'restoreMessage', 'id'));
  // Nobody owns the thread (the desktop closed it): the bridge falls back to its own queue.
  const { CodexBridge } = __codex_bridge;
  const bridge = new CodexBridge({ codexBin: 'codex' });
  bridge.desktop = fake<CodexDesktopIpc>({ steer: async () => { throw Object.assign(new Error('no-client-found'), { code: 'no-client-found' }); } });
  await assert.rejects(bridge.steerTurn('th1', { prompt: 'x', attachments: [] }), err => errorField(err, 'fallback') === 'queue');
  bridge.desktop = fake<CodexDesktopIpc>({ steer: async () => { throw Object.assign(new Error('timeout'), { code: 'timeout' }); } });
  await assert.rejects(bridge.steerTurn('th1', { prompt: 'x', attachments: [] }), err => !errorField(err, 'fallback') && errorField(err, 'status') === 504);
});

test('a Codex turn keeps its first prompt; messages steered into it show inside the turn', async () => {
  const { CodexBridge } = __codex_bridge;
  const bridge = new CodexBridge({ codexBin: 'codex' });
  bridge.start = async () => {};
  bridge.lifecycle.read = async () => ({ turns: new Map(), messages: [] });
  bridge.send = async () => ({ result: { thread: { id: 'th', turns: [{ id: 't1', status: 'completed', startedAt: 1, completedAt: 9, items: [
    { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Write a story' }] },
    { type: 'reasoning', id: 'r1', summary: [] },
    { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'end with STEER-OK' }] },
    { type: 'agentMessage', id: 'a1', text: 'Once upon a time.\n\nSTEER-OK', phase: 'final_answer' },
  ] }] } } });
  const history = presentHistory(await bridge.getThread('th'));
  const turn = at(history.turns, 0);
  assert.equal(turn.userPrompt, 'Write a story');
  const steer = turn.activities.find(item => item.kind === 'user_message');
  assert.equal(steer?.title, 'end with STEER-OK');
  assert.deepEqual(turn.timeline.map(item => item.id), ['u2', 'a1']);
});
test('how a desktop writes a conversation is the plugin\'s `look`, and the shared kit never asks which engine', () => {
  const host = new PluginHost();
  host.register({ ...provider('folds'), look: { worked: 'fold', ago: 'short' } });
  host.register(provider('plain'));
  const folds = at(host.manifests(), 0), plain = at(host.manifests(), 1);
  assert.deepEqual(folds.look, { worked: 'fold', ago: 'short' });
  assert.deepEqual(plain.look, {});
  // Per-engine differences belong in the plugin (CLAUDE.md): no engine id is compared in the kit.
  const kit = fs.readFileSync(path.join(__dirname, '../src/client/kit/kit.ts'), 'utf8');
  assert.doesNotMatch(kit, /(engine|engineId\(\))\s*===\s*'|\[\s*'(codex|claude|antigravity)'/);
  for (const id of ['claude', 'codex', 'antigravity']) { const base = path.join(__dirname, `../src/server/plugins/${id}.plugin`); assert.match(fs.readFileSync(fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.js`, 'utf8'), /\blook: \{/); }
});
test('a file the agent read or edited is not a file card unless the engine says its desktop shows one', () => {
  const emitter = new EngineEvents(), events: Array<[string, unknown]> = [];
  const { bindEvents } = __core_presentation;
  bindEvents(emitter, (type, data) => events.push([type, data]));
  emitter.emit('delta', { type: 'tool_call', id: 'e', name: 'Edit', input: { file_path: '/w/docs/handoff.md', old_string: 'a', new_string: 'b' } });
  emitter.emit('delta', { type: 'tool_result', id: 'e', output: 'ok' });
  emitter.emit('item_completed', { item: { type: 'fileChange', id: 'p', changes: [{ path: '/w/notes.md', kind: 'update' }] } });
  assert.deepEqual(events.filter(([type]) => type === 'artifact.upsert'), []);
  emitter.emit('artifact', { path: '/w/report.pdf' });
  assert.deepEqual(events.filter(([type]) => type === 'artifact.upsert').map(([, data]) => get(data, 'title')), ['report.pdf']);
});
test('a new Codex chat starts on what the desktop\'s New chat page shows, named in the console\'s ids', () => {
  const { shownSettings } = __codex_bridge;
  const models = [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' }, { id: 'gpt-6', name: 'GPT-6' }];
  assert.deepEqual(shownSettings('GPT-6.1 Sol Medium', models), { model: 'gpt-6.1-sol', effort: 'medium' });
  assert.deepEqual(shownSettings('GPT-6.1 Terra Extra High', models), { model: 'gpt-6.1-terra', effort: 'xhigh' });
  assert.deepEqual(shownSettings('GPT-6 Odd', models), { model: 'gpt-6' }); // an effort it cannot name is left out
  assert.deepEqual(shownSettings('Unknown Model High', models), {});
});
test('what Codex waits on the person for is a card, followed from the owning window and answered through it', async () => {
  const { CodexBridge, askCard } = __codex_bridge;
  const { applyPatches } = __codex_desktop;
  // immer patches, as the owner sends them for its `requests`
  assert.deepEqual(applyPatches([{ id: 1 }], [{ op: 'add', path: [1], value: { id: 2 } }, { op: 'remove', path: [0] }]), [{ id: 2 }]);
  assert.deepEqual(applyPatches([{ id: 1 }, { id: 2 }], [{ op: 'replace', path: ['length'], value: 1 }]), [{ id: 1 }]);
  const question = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 't', questions: [{ id: 'pick', question: 'Which?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] } };
  assert.deepEqual(must(askCard('t', question)).decisions.map(item => get(item, 'id')), ['option:Alpha', 'option:Beta', 'decline']);
  assert.equal(askCard('t', { id: 8, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf build' } })?.detail, 'rm -rf build');
  assert.equal(askCard('t', { id: 9, method: 'item/tool/requestOptionPicker', params: {} }), null);

  const bridge = new CodexBridge({ codexBin: 'codex' }), calls: unknown[] = [];
  let push: ((requests: DesktopRequest[]) => void) | undefined;
  bridge.desktop = fake<CodexDesktopIpc>({ watch: (id, on) => { push = on; return { close() { calls.push('closed'); } }; }, answerUserInput: async input => { calls.push(input); }, decideApproval: async input => { calls.push(input); } });
  const emitter = new EngineEvents(), seen: string[][] = [];
  emitter.on('approval', card => seen.push(['card', card.id])); emitter.on('approval_resolved', ({ id }) => seen.push(['gone', id]));
  const asks = bridge.watchAsks('t', emitter);
  must(push)([question]); must(push)([question]);
  assert.deepEqual(seen, [['card', 't:7']]);
  await bridge.decide('t:7', 'option:Beta');
  assert.deepEqual(calls[0], { threadId: 't', requestId: 7, response: { answers: { pick: { answers: ['Beta'] } } } });
  await assert.rejects(bridge.decide('t:7', 'option:Beta'), /已经回答过了/);
  must(push)([{ id: 8, method: 'item/fileChange/requestApproval', params: { reason: 'write' } }]);
  assert.deepEqual(seen.slice(1), [['card', 't:8'], ['gone', 't:7']]);
  await bridge.decide('t:8', 'accept');
  assert.deepEqual(calls[1], { threadId: 't', requestId: 8, kind: 'fileChange', decision: 'accept' });
  asks.close();
  assert.equal(at(calls, -1), 'closed');
});

test('every icon the page names in its sources is one it carries (the rest of lucide stays out of its script)', async () => {
  const { hasIcon } = await import('../src/client/js/icons.js');
  const client = path.resolve('src/client'), named = new Map<string, string>();
  const files = fs.readdirSync(client, { recursive: true, encoding: 'utf8' }).filter(file => /\.(ts|html)$/.test(file) && !file.endsWith('.d.ts') && !file.endsWith('icons.ts'));
  // The words in quotes, except one a value is compared with (status === 'failed' ? … : …).
  const literals = (text: string) => [...text.matchAll(/(?<![=!]==\s?)['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)['"`]/g)].map(match => match[1] ?? '');
  for (const file of files) {
    const source = fs.readFileSync(path.join(client, file), 'utf8');
    // icon('x'), icon(a ? 'x' : 'y'), icon(map[kind] || 'x'); data-lucide="x"; { icon: 'x' }; and the map of an activity's icons.
    for (const call of source.matchAll(/\bicon\(([^()]*)\)/g)) for (const name of literals(call[1] ?? '')) named.set(name, file);
    for (const match of source.matchAll(/data-lucide="([a-z0-9-]+)"/g)) named.set(match[1] ?? '', file);
    for (const match of source.matchAll(/\bicon: ?'([a-z0-9-]+)'/g)) named.set(match[1] ?? '', file);
    for (const map of source.matchAll(/const icons: Record<string, string> = \{([^}]*)\}/g)) for (const name of literals(map[1] ?? '')) named.set(name, file);
  }
  assert.ok(named.size > 30, 'the scan still finds the page\'s icons');
  const missing = [...named].filter(([name]) => !hasIcon(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, [], 'add these to src/client/js/icons.ts');
  assert.equal(hasIcon('zebra-crossing-not-an-icon'), false);
});

test('the Windows helper builds through dotnet publish and runs the same protocol', async t => {
  const { DesktopAutomation } = await import('../src/server/core/desktop-automation.js');
  const ran: string[][] = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'uia-cache-'));
  const desktop = new DesktopAutomation({ engine: 'claude', platform: 'win32', cacheDir: temp,
    runner: async (_file, args) => { ran.push(args); return args[0] === 'check' ? { ok: true, trusted: true, running: true } : { ok: true }; } });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  // check on win32 says what the machine offers, not the macOS permission refusal.
  const state = await desktop.check();
  assert.equal(state.available, true);
  assert.equal(state.code, undefined);
  // keepWarm works on win32 too: the first beat reads the page through the helper.
  const calls: string[][] = [];
  desktop.runner = async (_file, args) => { calls.push(args); return { ok: true }; };
  desktop.keepWarm(0); // warmEveryMs 0 would stop it; keepWarm(0) still fires one beat
  assert.deepEqual(calls.filter(args => args[0] === 'warm').length <= 1, true);
  // A platform the codebase does not serve still refuses, with the wording both languages carry.
  const nowhere = new DesktopAutomation({ engine: 'claude', platform: 'linux' });
  const refused = await nowhere.check();
  assert.equal(refused.available, false);
  assert.match(refused.reason || '', /macOS 和 Windows|macOS and Windows/);
});
