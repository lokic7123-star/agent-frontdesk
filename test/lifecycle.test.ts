import { test } from 'node:test';
import { EngineEvents } from '../src/server/types.js';
import { at, bridgeEvent, fake, hostOf, must, noRuns, required } from './support.js';
import type { LifecycleTurn } from '../src/server/services/codex-lifecycle.js';
import { get } from '../src/shared/guards.js';
import type { Activity, BridgeEventType, Engine, History, PresentedTurn, RunTurn, UnifiedSession, UnifiedTurn } from '../src/shared/contract.js';
import { CodexLifecycle, resolveCodexTurn } from '../src/server/services/codex-lifecycle.js';
import { CodexBridge } from '../src/server/codex-bridge.js';
import { bindEvents } from '../src/server/core/presentation.js';
import { ActivityFeed } from '../src/server/services/activity-feed.js';
import { EventHub } from '../src/server/core/event-hub.js';
import type { RunRecord, RunService } from '../src/server/core/run-service.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as __core_plugin_host from '../src/server/core/plugin-host.js';
import * as __core_run_service from '../src/server/core/run-service.js';

test('unloaded interrupted/failed turns without completedAt never become terminal', () => {
  for (const status of ['interrupted', 'failed', 'completed']) assert.equal(resolveCodexTurn({ status, completedAt: null }).status, 'unknown');
  assert.equal(resolveCodexTurn({ status: 'interrupted', completedAt: null }, fake<LifecycleTurn>({ status: 'running', statusEvidence: 'task_started' })).status, 'running');
});
test('lifecycle reader keeps a running turn through command failure, retry and final message until task_complete', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-life-')), file = path.join(dir, 'history.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const append = (payload: object) => fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload }) + '\n');
  append({ type: 'task_started', turn_id: 'turn' });
  append({ type: 'error', will_retry: true });
  fs.appendFileSync(file, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', id: 'final', phase: 'final_answer', content: [{ type: 'output_text', text: 'My final reply' }] } }) + '\n');
  const reader = new CodexLifecycle(); const first = await reader.read(file);
  assert.equal(first.turns.get('turn')?.status, 'running'); assert.equal(at(first.messages, 0).preview, 'My final reply');
  const partial = JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: 'turn' } });
  fs.appendFileSync(file, partial.slice(0, 20)); await reader.read(file); assert.equal(first.turns.get('turn')?.status, 'running');
  fs.appendFileSync(file, partial.slice(20) + '\n'); const ended = await reader.read(file); assert.equal(ended.turns.get('turn')?.status, 'completed');
  assert.equal(ended.turns.get('turn')?.statusEvidence, 'task_complete');
  fs.rmSync(dir, { recursive: true });
});
test('a confirmed terminal state cannot be rewritten by later contradictory events', async () => {
  const { createStore } = await import('../src/client/js/store.js'); const store = createStore();
  store.apply(bridgeEvent('run.started', { turn: fake<RunTurn>({ id: 't', status: 'running', messages: [], activities: [], artifacts: [], approvals: [] }) }, { turnId: 't' }));
  store.apply(bridgeEvent('run.failed', { message: 'Confirmed failure' }, { turnId: 't' }));
  store.apply(bridgeEvent('run.completed', {}, { turnId: 't' }));
  assert.equal(at(store.turns, 0).status, 'failed');
});
test('assistant notices fire once per complete message, never once per token or private reasoning', async () => {
  const hub = new EventHub(), feed = new ActivityFeed(hostOf(), hub, noRuns());
  hub.publish('codex', 's', 't', 'message.updated', { id: 'm', status: 'streaming', text: 'H' });
  hub.publish('codex', 's', 't', 'message.updated', { id: 'm', status: 'streaming', text: 'Hello' });
  hub.publish('codex', 's', 't', 'message.updated', { id: 'private', phase: 'analysis', status: 'completed', text: 'PRIVATE REASONING' });
  assert.equal(feed.snapshot().notices.length, 0);
  hub.publish('codex', 's', 't', 'message.updated', { id: 'm', status: 'completed', text: 'Hello' });
  hub.publish('codex', 's', 't', 'message.updated', { id: 'm', status: 'completed', text: 'Hello' });
  assert.equal(feed.snapshot().notices.length, 1);
  const { MessageInbox, previewText } = await import('../src/client/js/message-inbox.js'); const inbox = new MessageInbox();
  assert.deepEqual(inbox.ingest(feed.snapshot().notices), []);
  hub.publish('codex', 's', 't', 'message.updated', { id: 'second', status: 'completed', text: 'Hello' });
  assert.equal(inbox.ingest(feed.snapshot().notices).length, 1); assert.equal(inbox.ingest(feed.snapshot().notices).length, 0);
  assert.equal(previewText('a'.repeat(300), 100).length, 101); feed.dispose();
});
test('an older turn finishing cannot stop a newer running turn', () => {
  const reader = new CodexLifecycle(), entry = reader.fresh();
  reader.record(entry, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'old' } });
  reader.record(entry, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new' } });
  reader.record(entry, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' }, timestamp: new Date().toISOString() });
  assert.equal(entry.latest?.id, 'new'); assert.equal(entry.latest?.status, 'running'); assert.equal(entry.turns.get('old')?.status, 'completed');
});
test('native snapshots cannot overwrite an active console turn with unconfirmed interruption', async () => {
  const { createStore } = await import('../src/client/js/store.js'); const store = createStore();
  store.apply(bridgeEvent('run.started', { turn: fake<RunTurn>({ id: 'local', userPrompt: 'task', timestamp: '2026-11-08T00:00:00Z', status: 'running', messages: [], activities: [], artifacts: [], approvals: [] }) }, { turnId: 'local' }));
  store.reconcile({ turns: [fake<PresentedTurn>({ id: 'native', userPrompt: 'task', timestamp: '2026-11-08T00:00:00Z', status: 'unknown' })] });
  assert.equal(store.turns.length, 1); assert.equal(must(store.active).id, 'local');
});
test('a console turn the server no longer follows yields to the native history', async () => {
  const { createStore } = await import('../src/client/js/store.js');
  const started = bridgeEvent('run.started', { turn: fake<RunTurn>({ id: 'local', userPrompt: 'task', timestamp: '2026-11-08T00:00:00Z', status: 'running', messages: [], activities: [fake<Activity>({ id: 'a', status: 'running' })], artifacts: [], approvals: [] }) }, { turnId: 'local' });
  const native = fake<PresentedTurn>({ id: 'native', userPrompt: 'task', timestamp: '2026-11-08T00:00:01Z', status: 'completed', messages: [{ id: 'm', text: 'done' }] });
  // Server restarted mid-run: the full read has no active turn, the desktop finished the turn.
  let store = createStore(); store.apply(started);
  store.reconcile({ turns: [native], activeTurn: null });
  assert.deepEqual(store.turns.map(turn => turn.id), ['native']); assert.equal(store.active, undefined);
  // Still followed by the server: the console turn keeps its place.
  store = createStore(); store.apply(started);
  store.reconcile({ turns: [{ ...native, status: 'running' }], activeTurn: fake<RunTurn>({ id: 'local' }) });
  assert.equal(must(store.active).id, 'local');
  // Nothing native yet: kept, but no longer shown as running.
  store = createStore(); store.apply(started);
  store.reconcile({ turns: [], activeTurn: null });
  const kept = at(store.turns, 0);
  assert.equal(kept.status, 'unknown'); assert.equal(at(kept.activities, 0).status, 'unknown'); assert.match(must(kept.warning), /桌面版的记录/);
});
test('native task completion notifications require explicit end evidence', async () => {
  const hub = new EventHub(); let end = false;
  const host = hostOf({ id: 'native', list: async () => [fake<UnifiedSession>({ id: 's', status: end ? 'idle' : 'busy', updatedAt: Date.now(), metadata: { latestTurn: end ? { id: 't', status: 'completed', completedAt: Date.now(), statusEvidence: 'task_complete' } : { id: 't', status: 'running', statusEvidence: 'task_started', completedAt: null } } })] });
  const feed = new ActivityFeed(host, hub, noRuns()); await feed.poll(); assert.equal(at(feed.snapshot().sessions, 0).completedAt, 0);
  end = true; await feed.poll(); assert.equal(at(feed.snapshot().sessions, 0).outcome, 'completed'); assert.ok((at(feed.snapshot().sessions, 0).completedAt || 0) > 0); feed.dispose();
});
test('completed message and transient error metadata do not mean a failed task', () => {
  const emitter = new EngineEvents(), events: Array<{ type: BridgeEventType; data: unknown }> = []; bindEvents(emitter, (type, data) => events.push({ type, data }));
  emitter.emit('delta', { type: 'agent_message', itemId: 'm', text: 'Answer' });
  emitter.emit('completed', { turn: { status: 'completed', error: { message: 'Old retry warning' } } });
  assert.equal(at(events, -1).type, 'run.completed'); assert.equal(events.some(event => event.type === 'run.failed'), false);
  assert.equal(get(must(events.findLast(event => event.type === 'message.updated')).data, 'status'), 'completed');
});
test('transport loss preserves the active task rather than claiming failure', async () => {
  const { PluginHost } = __core_plugin_host; const { RunService } = __core_run_service;
  const host = new PluginHost(), hub = new EventHub(), emitter = new EngineEvents(); emitter.turnId = 'native';
  host.register(fake<Engine>({ ...required, id: 'provider', label: 'Provider', capabilities: {},
    read: async () => fake<History>({ turns: [fake<UnifiedTurn>({ id: 'native', status: 'running', statusEvidence: 'task_started', userPrompt: 'task', steps: [], messages: [] })] }), send: () => emitter }));
  const runs = new RunService(host, hub); runs.start('provider', 's', { prompt: 'task' }); await new Promise(resolve => setImmediate(resolve));
  emitter.emit('error', Object.assign(new Error('Connection dropped'), { transport: true }));
  await new Promise(resolve => setImmediate(resolve)); assert.ok(runs.get('provider', 's')); assert.equal(runs.get('provider', 's')?.run.status, 'reconnecting'); runs.dispose();
});
test('new speech marks unread while execution continues without inventing task completion', async () => {
  const { ReadMarkers } = await import('../src/client/js/navigation.js'); const markers = new ReadMarkers();
  const hub = new EventHub(), feed = new ActivityFeed(hostOf(), hub, noRuns());
  hub.publish('codex', 's', 't', 'run.started', { turn: fake<RunTurn>({}) });
  hub.publish('codex', 's', 't', 'message.updated', { id: 'speech', status: 'completed', text: 'I am still working' });
  const state = at(feed.snapshot().sessions, 0); assert.equal(state.running, true); assert.equal(state.completedAt, 0); assert.equal(markers.unread(state), true); feed.dispose();
});
test('a console run that lost its turn is shown working only while the desktop record says so', async () => {
  let status: UnifiedSession['status'] = 'idle';
  const said = { id: 'm1', preview: 'First line of the turn', phase: 'commentary', at: Date.now() - 1000 };
  const host = hostOf({ id: 'codex', list: async () => [fake<UnifiedSession>({ id: 's', title: 'T', status, updatedAt: 'r', metadata: { turnStartedAt: Date.now() - 5000, recentMessages: [said] } })] });
  const hub = new EventHub(), run = fake<RunRecord>({ run: fake<RunTurn>({ status: 'reconnecting', timestamp: new Date().toISOString() }) });
  const feed = new ActivityFeed(host, hub, fake<RunService>({ get: () => run }));
  hub.publish('codex', 's', 't', 'run.started', { turn: fake<RunTurn>({}) });
  hub.publish('codex', 's', 't', 'run.connection_lost', { message: 'checking' });
  assert.equal(at(feed.snapshot().sessions, 0).running, false, 'not typing forever on the lost run alone');
  status = 'busy'; await feed.poll();
  assert.equal(at(feed.snapshot().sessions, 0).running, true); assert.equal(at(feed.snapshot().sessions, 0).confirmedTerminal, false);
  status = 'idle'; await feed.poll(); assert.equal(at(feed.snapshot().sessions, 0).running, false);
  // A chat first seen while its turn runs speaks what that turn has said so far.
  status = 'busy'; const fresh = new ActivityFeed(host, new EventHub(), noRuns()); await fresh.poll();
  assert.equal(at(fresh.snapshot().notices, 0).preview, 'First line of the turn'); feed.dispose(); fresh.dispose();
});
test('a console turn and the desktop record of it are one turn, attachments or a slow new chat or not', async t => {
  const { createStore } = await import('../src/client/js/store.js');
  const { sameTurn } = await import('../src/shared/turn-match.js');
  const { AttachmentStore, withAttachments } = await import('../src/server/core/attachments.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  // The desktop's prompt carries the attached file's path after what the person typed.
  const run = { id: 'local', userPrompt: 'look at this', timestamp: '2026-11-16T06:11:00Z' };
  const written = withAttachments('look at this', [{ path: '/tmp/a.png', originalname: 'shot\n1.png', mimetype: 'image/png' }]);
  assert.equal(written, 'look at this\n\n附件 shot 1.png：/tmp/a.png');
  // Claude's desktop takes a file by its own reference, which it then attaches itself.
  assert.equal(withAttachments('look', [{ path: '/tmp/a.png', originalname: 'a.png', mimetype: 'image/png' }, { path: '/tmp/my notes.txt', originalname: 'n', mimetype: '' }], 'mention'), 'look\n\n@/tmp/a.png @"/tmp/my notes.txt"');
  assert.equal(sameTurn({ id: 'n', userPrompt: written, timestamp: '2026-11-16T06:11:01Z' }, run), true);
  // An earlier message with the same words is another turn; the engine's own id settles it either way.
  assert.equal(sameTurn({ id: 'n', userPrompt: written, timestamp: '2026-11-16T06:10:00Z' }, run), false);
  assert.equal(sameTurn({ id: 'n', userPrompt: 'else', timestamp: '2026-11-16T06:10:00Z' }, { ...run, nativeTurnId: 'n' }), true);
  // Codex's composer writes the message down in its Markdown: a line break as `\` and a newline, escapes, references.
  const { promptStarts } = await import('../src/shared/turn-match.js');
  const sent = withAttachments('do question 1\n\nthen 2 ~ & more', [{ path: '/tmp/hw2.pdf', originalname: 'hw2.pdf', mimetype: 'application/pdf' }]);
  const codexWrote = 'do question 1\\\n\\\nthen 2 \\~ &#x26;&#x20;more\\\n\\\n附件 hw2.pdf：/tmp/hw2.pdf\n';
  assert.equal(promptStarts(codexWrote, sent, 200), true);
  assert.equal(sameTurn({ id: 'n', userPrompt: codexWrote, timestamp: '2026-11-16T06:11:01Z' }, { ...run, userPrompt: sent }), true);
  assert.equal(promptStarts(codexWrote, 'do question 2'), false);
  assert.equal(promptStarts(codexWrote, '  '), false);
  // The bubble shows it as the desktop renders it: no Markdown escapes, code as written.
  const { composerText } = await import('../src/server/codex-bridge.js');
  assert.equal(composerText(codexWrote), 'do question 1\n\nthen 2 ~ & more\n\n附件 hw2.pdf：/tmp/hw2.pdf\n');
  assert.equal(composerText('run `a\\|b` then\\\n```\nx \\\\\n```\nC:\\\\dir \\q'), 'run `a\\|b` then\n```\nx \\\\\n```\nC:\\dir \\q');
  // The page: the followed turn stays, once, and shows the message as the desktop wrote it.
  const store = createStore();
  store.apply(bridgeEvent('run.started', { turn: fake<RunTurn>({ ...run, status: 'running', messages: [], activities: [], artifacts: [], approvals: [] }) }, { turnId: 'local' }));
  store.reconcile({ turns: [fake<PresentedTurn>({ id: 'n', userPrompt: written, timestamp: '2026-11-16T06:11:01Z', status: 'running' })], activeTurn: fake<RunTurn>({ id: 'local' }) });
  assert.deepEqual(store.turns.map(turn => [turn.id, turn.nativeTurnId, turn.userPrompt]), [['local', 'n', written]]);
  // What a message may name: only a file the store holds, typed by its stored name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-attachments-')), files = new AttachmentStore(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'abc.png'), 'png');
  assert.deepEqual(files.resolve([{ filename: 'abc.png', originalname: '截屏.png', mimetype: 'text/html', path: '/etc/passwd' }, { filename: 'abc.png' }]),
    [{ filename: 'abc.png', path: path.join(dir, 'abc.png'), originalname: '截屏.png', mimetype: 'image/png', url: '/uploads/abc.png' }]);
  assert.throws(() => files.resolve([{ filename: '../abc.png/../../x' }]), /附件不存在/);
  assert.throws(() => files.resolve(Array.from({ length: 11 }, () => ({ filename: 'abc.png' }))), /Invalid attachments/);
  fs.rmSync(dir, { recursive: true });
});
