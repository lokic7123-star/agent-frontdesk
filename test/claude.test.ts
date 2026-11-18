import { test } from 'node:test';
import { EngineEvents } from '../src/server/types.js';
import { at, dig, fake, must, respond, withStatus } from './support.js';
import { errorField, get, list } from '../src/shared/guards.js';
import type { ClaudeDesktop } from '../src/server/claude-desktop.js';
import type { DesktopRun, StreamRun } from '../src/server/claude-bridge.js';
import type { HelperResult } from '../src/server/core/desktop-automation.js';
import type { ApprovalRequest, EngineCompleted, EngineEmitter, EngineEventName, UnifiedTurn } from '../src/shared/contract.js';
// A run the stream handler writes to: its emitter and nothing seen yet.
const streamRun = (emitter: EngineEmitter, interrupted = false): StreamRun => ({ emitter, interrupted, lastMessage: null, plan: null });
// How a run ended: the completed event, or the error it failed with.
const completion = (emitter: EngineEmitter) => new Promise<EngineCompleted>((resolve, reject) => { emitter.on('completed', resolve); emitter.on('error', reject); });
const failure = (emitter: EngineEmitter) => new Promise<Error>(resolve => emitter.on('error', resolve));
import { ClaudeBridge, isHumanPrompt, applyPlan, parseLines, buildTurns, usageOf, modelsOf, repoName, desktopRunning, sessionRunning, awaitingStep, createStreamHandler } from '../src/server/claude-bridge.js';
import { bindEvents } from '../src/server/core/presentation.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as __claude_desktop from '../src/server/claude-desktop.js';
import { fileURLToPath as __fileURLToPath } from 'node:url';
const __dirname = __fileURLToPath(new URL('.', import.meta.url));

const human = (uuid: string, text: string, extra: object = {}) => ({ type: 'user', uuid, timestamp: '2026-11-08T10:00:00Z', turnOrigin: 'human', origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra });
const say = (uuid: string, text: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
const think = (uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'thinking', thinking: 'private' }] } });
const use = (uuid: string, id: string, name: string, input: object) => ({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: unknown, isError = false) => ({ type: 'user', uuid: `r-${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

test('Claude: only what a person typed starts a turn', () => {
  assert.equal(isHumanPrompt(human('a', 'hello')), true);
  assert.equal(isHumanPrompt(human('b', 'from the web', { turnOrigin: 'sdk', origin: undefined })), true);
  assert.equal(isHumanPrompt(human('c', '[Image: source: /tmp/x.png]', { isMeta: true })), false);
  assert.equal(isHumanPrompt(human('d', '<task-notification>done</task-notification>')), false);
  assert.equal(isHumanPrompt(human('e', 'summary', { isCompactSummary: true })), false);
  assert.equal(isHumanPrompt(human('f', 'side', { isSidechain: true })), false);
  assert.equal(isHumanPrompt(result('t', 'ok')), false);
  assert.equal(isHumanPrompt({ ...human('g', 'x'), message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }), false);
});

test('Claude: the step list replays update_plan items, advance, done and start', () => {
  let plan = applyPlan(null, 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] });
  plan = applyPlan(plan, 'mcp__ccd_turn__update_plan', { advance: true });
  assert.deepEqual(plan?.map(step => step.status), ['completed', 'in_progress', 'pending']);
  plan = applyPlan(plan, 'mcp__ccd_turn__update_plan', { done: [2], start: 3 });
  assert.deepEqual(plan?.map(step => step.status), ['completed', 'completed', 'in_progress']);
  assert.deepEqual(applyPlan(null, 'TodoWrite', { todos: [{ content: 'X', status: 'pending' }] }), [{ content: 'X', status: 'pending' }]);
});

test('Claude: transcripts become turns with ordered messages, paired tools, plans, images and evidence', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const records = [
    human('u1', 'first'), think('t1'), say('a1', 'Looking.'), use('a2', 'tool1', 'Bash', { command: 'npm test' }), result('tool1', 'ok'),
    use('a3', 'plan1', 'mcp__ccd_turn__update_plan', { items: [{ content: 'Do it', status: 'in_progress' }] }), result('plan1', 'Plan shown'),
    use('a4', 'shot', 'mcp__Claude_Browser__computer', { action: 'screenshot' }), result('shot', [{ type: 'text', text: 'done' }, image]),
    say('a5', 'All done.'), { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-11-08T10:01:00Z' },
    human('m1', 'meta', { isMeta: true }),
    human('u2', 'second'), use('a6', 'fail', 'Bash', { command: 'false' }), result('fail', 'exit 1', true),
  ];
  const turns = buildTurns(records, 'sess');
  assert.equal(turns.length, 2);
  const first = at(turns, 0), second = at(turns, 1);
  assert.deepEqual(first.messages.map(m => [m.text, m.phase]), [['Looking.', 'commentary'], ['All done.', 'final_answer']]);
  assert.ok(!JSON.stringify(first).includes('private'), 'thinking never becomes content');
  assert.deepEqual(first.timeline?.map(entry => entry.kind), ['message', 'activity', 'activity', 'activity', 'message']);
  assert.equal(at(first.steps, 0).type, 'command'); assert.equal(at(first.steps, 0).output, 'ok');
  assert.deepEqual(at(first.steps, 1).plan, [{ content: 'Do it', status: 'in_progress' }]);
  assert.equal(at(first.steps, 1).output, '', 'plan tool output is not shown');
  assert.equal(at(at(first.steps, 2).images, 0).url, '/api/sessions/claude/sess/media/shot-0');
  assert.equal(first.status, 'completed'); assert.equal(first.statusEvidence, 'stop_hook');
  assert.equal(at(second.steps, 0).status, 'failed');
  assert.equal(second.statusEvidence, null, 'no evidence for the open turn');
});

test('Claude: transcript reader skips API blobs and unreadable lines', () => {
  const lines = ['{"type":"api-request-blob","x":1}', JSON.stringify(human('u', 'hi')), '{broken', ''].join('\n');
  assert.equal(parseLines(lines).length, 1);
});

test('Claude: usage, models, repository names and running evidence map native data', () => {
  const usage = usageOf({ subscription_type: 'pro', rate_limits: { five_hour: { utilization: 75, resets_at: '2026-11-09T08:00:00Z' }, seven_day: { utilization: 36, resets_at: null } } });
  assert.deepEqual(usage.windows?.map(w => [w.label, w.remainingPercent, w.windowMinutes]), [['5 小时', 25, 300], ['每周', 64, 10080]]);
  assert.equal(usageOf({}).available, false);
  const models = modelsOf({ models: [{ value: 'default', displayName: 'Default' }, { value: 'opus', displayName: 'Opus 5.5', description: 'Best', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }] });
  assert.deepEqual(models, [{ id: 'opus', name: 'Opus 5.5', description: 'Best', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'medium' }]);
  assert.equal(repoName('https://github.com/Phz-06/focus-ai.git\n', '/x/Do-Everything'), 'focus-ai');
  assert.equal(repoName('', '/x/folder'), 'folder');
  assert.equal(desktopRunning({ latestUserFrameAt: 2, lastTurnEdgeAt: 1 }), true);
  assert.equal(desktopRunning({ latestUserFrameAt: 1, lastTurnEdgeAt: 2 }), false);
  assert.equal(desktopRunning(null), false);
  // The desktop also moves the edge when a turn pauses mid-step (a steer queued, a permission
  // dialog): the last reply asked for a tool, and the turn goes on.
  assert.equal(desktopRunning({ latestUserFrameAt: 1000, lastTurnEdgeAt: 9000 }, true), true, 'an edge mid-step is a pause');
  const paused = { latestUserFrameAt: 5000, lastTurnEdgeAt: 9000 };
  assert.equal(sessionRunning(paused, { turns: [{}], mtimeMs: 9000, writtenAt: 8000, lastStop: 'tool_use' }, 60000), true, 'waiting on a tool or the person');
  assert.equal(sessionRunning(paused, { turns: [{}], mtimeMs: 9000, writtenAt: 8000, lastStop: 'end_turn' }, 60000), false, 'a final reply: the edge is the end');
  assert.equal(sessionRunning(paused, { turns: [{}], mtimeMs: 9000, writtenAt: 8000, lastStop: 'tool_use' }, 8000 + 31 * 60000), false, 'a desktop that quit mid-step is not running for ever');
  assert.equal(sessionRunning(paused, { turns: [{ statusEvidence: 'interrupt_marker', completedAt: 8500 }], mtimeMs: 9000, writtenAt: 8500, lastStop: 'tool_use' }, 60000), false, 'stopped during a tool');
  // Waiting on the person: a dialog tool from its call on; another pending tool once the edge stands
  // after the last record with nothing queued at it.
  const pending = (name: string) => fake<UnifiedTurn>({ statusEvidence: null, steps: [{ id: 's1', name, status: 'running', input: {} }] as UnifiedTurn['steps'] });
  assert.equal(awaitingStep(pending('mcp__computer-use__request_access'), { latestUserFrameAt: 5000, lastTurnEdgeAt: 900 }, { writtenAt: 8000, lastStop: 'tool_use' })?.id, 's1');
  assert.equal(awaitingStep(pending('Bash'), { latestUserFrameAt: 5000, lastTurnEdgeAt: 900 }, { writtenAt: 8000, lastStop: 'tool_use' }), null, 'a long command');
  assert.equal(awaitingStep(pending('Bash'), paused, { writtenAt: 8000, lastStop: 'tool_use' })?.id, 's1', 'the edge stands after the last record');
  assert.equal(awaitingStep(pending('Bash'), paused, { writtenAt: 8000, queuedAt: [9004], lastStop: 'tool_use' }), null, 'a steer moved the edge');
  assert.equal(awaitingStep(pending('Bash'), paused, { writtenAt: 9500, lastStop: 'tool_use' }), null, 'written after the edge: it went on');
  // A frame the transcript never followed (a settings change) does not keep the chat running.
  const ended = { turns: [{ statusEvidence: 'stop_hook' }], mtimeMs: 1000 }, open = { turns: [{}], mtimeMs: 1000 };
  const frame = { latestUserFrameAt: 5000, lastTurnEdgeAt: 900 };
  assert.equal(sessionRunning(frame, ended, 5000 + 10 * 60000), false);
  assert.equal(sessionRunning(frame, ended, 5000 + 1000), true, 'the transcript may not have caught up yet');
  assert.equal(sessionRunning(frame, { ...ended, mtimeMs: 6000 }, 5000 + 10 * 60000), true, 'something was written after the frame');
  assert.equal(sessionRunning(frame, { ...ended, mtimeMs: 6000, writtenAt: 1000 }, 5000 + 10 * 60000), false, 'undated bookkeeping appended later is not a turn');
  assert.equal(sessionRunning(frame, open, 5000 + 10 * 60000), true, 'an open turn is still running');
  assert.equal(sessionRunning({ latestUserFrameAt: 1, lastTurnEdgeAt: 2 }, open), false);
  // Stopped in the desktop: the index keeps the frame, the transcript has the interrupt marker after it.
  const stopped = { turns: [{ statusEvidence: 'interrupt_marker', completedAt: new Date(7000).toISOString() }], mtimeMs: 7000 };
  assert.equal(sessionRunning(frame, stopped, 8000), false);
});

test('Claude: transcript records become console events', () => {
  const emitter = new EngineEvents(), events: Array<{ type: string; data: unknown }> = [];
  bindEvents(emitter, (type, data) => events.push({ type, data }));
  const handle = createStreamHandler('sess', streamRun(emitter));
  handle({ type: 'assistant', uuid: 'm1', message: { content: [{ type: 'text', text: 'Checking.' }] } });
  handle({ type: 'assistant', uuid: 'm2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
  handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } });
  handle({ type: 'assistant', uuid: 'm3', message: { content: [{ type: 'tool_use', id: 'p1', name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'Step', status: 'in_progress' }] } }] } });
  handle({ type: 'assistant', uuid: 'm4', message: { content: [{ type: 'text', text: 'Done.' }] } });
  handle({ type: 'result', subtype: 'success', is_error: false });
  const activity = events.filter(e => e.type === 'activity.upsert').map(e => e.data);
  assert.equal(get(activity.find(a => get(a, 'id') === 't1' && get(a, 'status') === 'completed'), 'output'), 'a\nb');
  assert.deepEqual(get(activity.find(a => get(a, 'id') === 'p1'), 'plan'), [{ content: 'Step', status: 'in_progress' }]);
  assert.equal(events.some(e => e.type === 'approval.requested'), false, 'approvals are asked in the desktop app');
  const final = at(events.filter(e => e.type === 'message.updated' && get(e.data, 'id') === 'm4'), -1).data;
  assert.equal(get(final, 'phase'), 'final_answer');
  assert.equal(at(events, -1).type, 'run.completed');
});

test('Claude: an interrupted or failed result is reported as such', () => {
  for (const [interrupted, message, expected] of [[true, { type: 'result', subtype: 'success' }, 'run.interrupted'], [false, { type: 'result', subtype: 'error_during_execution', is_error: true }, 'run.failed']] as const) {
    const emitter = new EngineEvents(), events: string[] = [];
    bindEvents(emitter, (type, data) => { events.push(type); });
    createStreamHandler('s', streamRun(emitter, interrupted))(message);
    assert.equal(at(events, -1), expected);
  }
});

test('Claude: the list reads each transcript once, and a transcript being written only where it grew', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(index, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  // More sessions than a short cache would hold: every one of them is asked for by every list.
  const ids = Array.from({ length: 40 }, (_, n) => `s-${n}`);
  for (const id of ids) {
    fs.writeFileSync(path.join(index, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, cwd: '/work', title: `T-${id}`, lastActivityAt: 1 }));
    fs.writeFileSync(path.join(project, `${id}.jsonl`), [human(`u-${id}`, 'hi'), say(`a-${id}`, 'hello')].map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  const bridge = new ClaudeBridge({ home, env: {}, bin: null, desktop: fake<ClaudeDesktop>({}) });
  const whole: string[] = [], original = fs.readFileSync;
  // The transcripts read from start to end (the index files are read too: only .jsonl counts).
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => { if (String(file).endsWith('.jsonl')) whole.push(path.basename(String(file))); return Reflect.apply(original, fs, [file, ...rest]); }) as typeof fs.readFileSync;
  const seen = (): string[] => whole;
  try {
    assert.equal(bridge.list().length, 40);
    assert.equal(seen().length, 40);
    whole.length = 0;
    assert.equal(bridge.list().length, 40); bridge.read('s-0');
    assert.deepEqual(seen(), [], 'nothing changed: nothing is read again');

    // A transcript that changed is read whole once more; from then on, only what is appended.
    const file = path.join(project, 's-7.jsonl');
    const replies = () => must(bridge.parse('s-7')).turns.flatMap(turn => turn.messages.map(message => message.text));
    fs.appendFileSync(file, JSON.stringify(say('a2', 'second')) + '\n');
    assert.deepEqual(replies(), ['hello', 'second']);
    assert.deepEqual(seen(), ['s-7.jsonl']);
    whole.length = 0;
    // A line still being written is not taken yet, and is read in full once its end arrives.
    const next = JSON.stringify(say('a3', '第三条'));
    fs.appendFileSync(file, JSON.stringify(human('u2', 'again')) + '\n' + next.slice(0, 20));
    assert.deepEqual(must(bridge.parse('s-7')).turns.map(turn => turn.userPrompt), ['hi', 'again']);
    assert.deepEqual(replies(), ['hello', 'second']);
    fs.appendFileSync(file, next.slice(20) + '\n');
    assert.deepEqual(replies(), ['hello', 'second', '第三条']);
    assert.deepEqual(seen(), [], 'the appended part was read, not the file again');
    assert.equal(must(bridge.list().find(item => item.id === 's-7')).metadata.recentMessages?.at(-1)?.preview, '第三条');
    // A file that got shorter was rewritten: it is read from the start.
    fs.writeFileSync(file, JSON.stringify(human('u9', 'fresh')) + '\n');
    assert.deepEqual(must(bridge.parse('s-7')).turns.map(turn => turn.userPrompt), ['fresh']);
    assert.deepEqual(seen(), ['s-7.jsonl']);
    // Only the transcripts changed most recently keep their records.
    for (const id of ['s-1', 's-2', 's-3', 's-4']) { fs.appendFileSync(path.join(project, `${id}.jsonl`), JSON.stringify(say(`b-${id}`, 'more')) + '\n'); bridge.parse(id); }
    assert.deepEqual(ids.filter(id => bridge.cache.get(id)?.tail), ['s-2', 's-3', 's-4']);
  } finally { fs.readFileSync = original; }
});

test('Claude: desktop index drives the list, groups and the reason sending is blocked', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(index, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const write = (local: string, cli: string, extra: object) => fs.writeFileSync(path.join(index, `local_${local}.json`), JSON.stringify({ sessionId: `local_${local}`, cliSessionId: cli, cwd: '/work', title: `T-${local}`, model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'auto', lastActivityAt: 1000, lastTurnEdgeAt: 10, latestUserFrameAt: 5, ...extra }));
  write('parent', 'p-1', {}); write('child', 'c-1', { spawnedFrom: { sessionId: 'local_parent' }, latestUserFrameAt: 20 }); write('empty', 'e-1', {});
  fs.writeFileSync(path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: { 'dframe-group-scopes': { 'acct/org': { groups: [{ id: 'g1', name: '中控台' }], assignments: { 'code:local_parent': 'g1' } } } } } }));
  for (const id of ['p-1', 'c-1']) fs.writeFileSync(path.join(project, `${id}.jsonl`), [human('u', 'hi'), say('a', 'hello')].map(r => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(project, 'e-1.jsonl'), '');
  const desktop = fake<ClaudeDesktop>({ check: async () => ({ available: true }) });
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop });
  bridge.auth = { at: Date.now(), loggedIn: true, error: '' };
  const sessions = bridge.list();
  assert.deepEqual(sessions.map(s => s.id).sort(), ['c-1', 'p-1'], 'never-used sessions are hidden');
  const child = must(sessions.find(s => s.id === 'c-1'));
  assert.equal(child.metadata.parentId, 'p-1'); assert.equal(child.metadata.group?.name, '中控台'); assert.equal(child.status, 'busy');
  assert.equal(at(child.metadata.recentMessages, 0).preview, 'hello');
  assert.equal(await bridge.sendBlockedReason('c-1'), '', 'a session running on the desktop can still be sent to');
  assert.equal(await bridge.sendBlockedReason('p-1'), '');
  assert.deepEqual(bridge.settingsFor('p-1'), { model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'auto', inherited: false });
  assert.equal(bridge.read('p-1')?.turns.length, 1);
  // Only the desktop app sends: the CLI's sign-in does not matter, the desktop being there does.
  bridge.auth = { at: Date.now(), loggedIn: false, error: '未登录' };
  assert.equal(await bridge.sendBlockedReason('p-1'), '');
  desktop.check = async () => ({ available: false, reason: 'Claude 桌面版没有在运行' });
  assert.equal(await bridge.sendBlockedReason('p-1'), 'Claude 桌面版没有在运行');
  assert.deepEqual(await bridge.getStatus(), { connected: false, error: 'Claude 桌面版没有在运行' });
  fs.rmSync(home, { recursive: true, force: true });
});

test('Claude: a worktree chat keeps its project on the checkout it came from, and a looked-at status asks for no look', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(index, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const write = (local: string, cli: string, extra: object) => fs.writeFileSync(path.join(index, `local_${local}.json`), JSON.stringify({ sessionId: `local_${local}`, cliSessionId: cli, cwd: '/work', title: `T-${local}`, lastActivityAt: 1000, lastTurnEdgeAt: 500, latestUserFrameAt: 5, ...extra }));
  // Seen on the real app: a chat in a worktree has its cwd there and originCwd on the checkout.
  write('tree', 't-1', { cwd: '/work/.claude/worktrees/prep-b116fb', originCwd: '/work', postTurnSummary: { status_category: 'blocked' }, lastFocusedAt: 400 });
  write('seen', 's-1', { postTurnSummary: { status_category: 'review_ready' }, lastFocusedAt: 600 });
  for (const id of ['t-1', 's-1']) fs.writeFileSync(path.join(project, `${id}.jsonl`), [human('u', 'hi'), say('a', 'hello')].map(r => JSON.stringify(r)).join('\n'));
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop: fake<ClaudeDesktop>({ check: async () => ({ available: true }) }) });
  const sessions = bridge.list(), tree = must(sessions.find(s => s.id === 't-1')), seen = must(sessions.find(s => s.id === 's-1'));
  assert.equal(tree.cwd, '/work/.claude/worktrees/prep-b116fb');
  assert.equal(tree.metadata.group?.cwd, '/work', 'a new chat from the project starts in the folder the desktop lists');
  assert.equal(tree.metadata.attention, 'blocked', 'not opened on the desktop since the turn ended');
  assert.equal(seen.metadata.attention, '', 'opened on the desktop after the turn ended');
  fs.rmSync(home, { recursive: true, force: true });
});

test('pictures a person attaches show with their message, without the app placeholder lines', () => {
  const records = [{ type: 'user', uuid: 'u-1', timestamp: '2026-11-09T00:00:00Z', message: { role: 'user', content: [
    { type: 'text', text: '看一下这个\n[Image: source: /tmp/a.png][Image: source: /tmp/b.png]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
  ] } }];
  const turn = at(buildTurns(records, 's-1'), 0);
  assert.equal(turn.userPrompt, '看一下这个');
  assert.deepEqual(turn.userImages?.map(image => image.url), ['/api/sessions/claude/s-1/media/u-1-0', '/api/sessions/claude/s-1/media/u-1-1']);
});

test('dictation streams interim text and replaces it with the final transcript when stopped', async () => {
  const sent: unknown[] = [];
  // Stands in for Node's WebSocket: only what the dictation stream uses.
  class FakeSocket {
    static OPEN = 1;
    static last: FakeSocket | undefined;
    url: string; options: unknown; readyState: number;
    onopen?: () => void; onmessage: (event: { data: string }) => void = () => {};
    constructor(url: string, options: unknown) { this.url = url; this.options = options; this.readyState = 1; FakeSocket.last = this; queueMicrotask(() => this.onopen?.()); }
    send(data: unknown) { sent.push(data); if (String(data).includes('CloseStream')) queueMicrotask(() => { this.onmessage({ data: JSON.stringify({ type: 'TranscriptText', data: '你好世界' }) }); this.onmessage({ data: JSON.stringify({ type: 'TranscriptEndpoint' }) }); }); }
    close() { this.readyState = 3; }
  }
  const original = globalThis.WebSocket; Reflect.set(globalThis, 'WebSocket', FakeSocket);
  try {
    const bridge = new ClaudeBridge({ home: '/nonexistent', env: {}, bin: null });
    bridge.oauthToken = async () => 'test-token';
    const texts: string[] = []; let ended = false;
    const session = await bridge.dictate({ language: 'zh', onText: text => texts.push(text), onError: assert.fail, onEnd: () => { ended = true; } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const socket = must(FakeSocket.last, 'socket');
    assert.match(socket.url, /speech_to_text\/voice_stream\?.*language=zh/);
    assert.equal(dig(socket.options, 'headers', 'Authorization'), 'Bearer test-token');
    socket.onmessage({ data: JSON.stringify({ type: 'TranscriptInterim', data: '你好' }) });
    session.send(Buffer.from([1, 2]));
    session.finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(texts.at(0), '你好');
    assert.equal(texts.at(-1), '你好世界');
    assert.ok(ended);
    assert.ok(sent.some(item => Buffer.isBuffer(item)));
  } finally { Reflect.set(globalThis, 'WebSocket', original); }
});

test('without a Claude sign-in dictation explains what to do', async () => {
  const bridge = new ClaudeBridge({ home: '/nonexistent', env: {}, bin: null });
  bridge.oauthToken = async () => null;
  await assert.rejects(bridge.dictate({ language: 'zh', onText() {}, onError() {}, onEnd() {} }), /claude auth login/);
});

test('Claude: a turn paused mid-step (a steer queued, a permission dialog) does not end the followed run', async t => {
  // The desktop moves the index's turn edge when it queues a steer (seen with an image steered
  // during a long tool call) and when a tool waits for the person's permission: the console
  // keeps following, the turn ends only with its reply.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const indexDir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(indexDir, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const indexFile = path.join(indexDir, 'local_s1.json'), transcript = path.join(project, 's-1.jsonl');
  const index = (extra: object) => fs.writeFileSync(indexFile, JSON.stringify({ sessionId: 'local_s1', cliSessionId: 's-1', cwd: '/work', title: '插话', model: 'claude-opus-5-5', lastTurnEdgeAt: 10, latestUserFrameAt: 5, ...extra }));
  index({});
  fs.writeFileSync(transcript, [human('u0', 'earlier'), say('a0', 'earlier reply')].map(r => JSON.stringify(r)).join('\n') + '\n');
  const append = (records: object[]) => fs.appendFileSync(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  let endedAt = 0;
  const desktop = fake<ClaudeDesktop>({
    check: async () => ({ available: true }),
    async send(_meta, text) {
      const at = Date.now();
      setTimeout(() => { append([{ ...human('u1', text), timestamp: new Date(at).toISOString() }, { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 300' } }], stop_reason: 'tool_use' } }]); index({ latestUserFrameAt: at }); }, 50);
      // The steer: the index edge moves, and the enqueue record follows a moment later.
      setTimeout(() => { const now = Date.now(); index({ latestUserFrameAt: at, lastTurnEdgeAt: now }); setTimeout(() => append([{ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(now + 5).toISOString(), content: '还有这个' }]), 5); }, 500);
      // A tool asks for permission: the edge moves again, with nothing queued.
      setTimeout(() => { append([{ type: 'user', uuid: 'r0', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'moved to background' }] } }, { type: 'assistant', uuid: 'a1b', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__computer-use__request_access', input: { apps: ['ChatGPT'], reason: '看写作块' } }], stop_reason: 'tool_use' } }]); index({ latestUserFrameAt: at, lastTurnEdgeAt: Date.now() }); }, 2600);
      setTimeout(() => { endedAt = Date.now(); append([{ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'granted' }] } }, { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'final' }], stop_reason: 'end_turn' } }]); index({ latestUserFrameAt: at, lastTurnEdgeAt: Date.now() + 100 }); }, 4600);
      return { ok: true };
    },
  });
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop });
  bridge.spawnCli = () => { throw new Error('the CLI must not run'); };
  const emitter = bridge.sendMessage('s-1', { prompt: '查一下', model: 'claude-opus-5-5' });
  const texts: unknown[] = [], cards: unknown[] = [];
  emitter.on('item_completed', (data: unknown) => texts.push(dig(data, 'item', 'text')));
  emitter.on('approval', (data: unknown) => cards.push(['open', get(data, 'id'), get(data, 'title'), get(data, 'decisions')]));
  emitter.on('approval_resolved', (data: unknown) => cards.push(['closed', get(data, 'id')]));
  let midway: unknown = null, waiting: unknown = null;
  setTimeout(() => { midway = bridge.read('s-1').session?.status; }, 2000);
  setTimeout(() => { waiting = bridge.read('s-1').turns.at(-1)?.approvals?.map(card => [card.id, card.decisions]); }, 3600);
  const done = await new Promise<EngineCompleted>(resolve => emitter.on('completed', resolve));
  assert.equal(get(done.turn, 'status'), 'completed');
  assert.ok(endedAt && Date.now() >= endedAt, 'ended with the reply, not at the steer');
  assert.ok(texts.includes('final'));
  assert.equal(midway, 'busy', 'the chat reads as running after the steer too');
  // The permission dialog: a card with a button to the desktop while it is open, gone with the answer.
  assert.deepEqual(cards, [['open', 'desktop:t2', 'Claude 桌面版在等你批准', ['desktop']], ['closed', 'desktop:t2']]);
  assert.deepEqual(waiting, [['desktop:t2', ['desktop']]], 'a history read shows it too');
});

test('Claude: a session the desktop has is sent by the desktop app and followed in its transcript', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const indexDir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(indexDir, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const indexFile = path.join(indexDir, 'local_d1.json'), transcript = path.join(project, 'd-1.jsonl');
  const index = (extra: object) => fs.writeFileSync(indexFile, JSON.stringify({ sessionId: 'local_d1', cliSessionId: 'd-1', cwd: '/work', title: '桌面会话', model: 'claude-opus-5-5', lastTurnEdgeAt: 10, latestUserFrameAt: 5, ...extra }));
  index({});
  fs.writeFileSync(transcript, [human('u0', 'earlier'), say('a0', 'earlier reply')].map(r => JSON.stringify(r)).join('\n') + '\n');
  const append = (records: object[]) => fs.appendFileSync(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const sent: unknown[] = [], stopped: string[] = [];
  const desktop = fake<ClaudeDesktop>({
    check: async () => ({ available: true }),
    async send(meta, text) {
      sent.push([meta.title, meta.localId, text]);
      const at = Date.now();
      setTimeout(() => { append([{ ...human('u1', text), timestamp: new Date(at).toISOString() }]); index({ latestUserFrameAt: at }); }, 50);
      setTimeout(() => { append([say('a1', 'ok')]); index({ latestUserFrameAt: at, lastTurnEdgeAt: at + 100 }); }, 800);
      return { ok: true };
    },
    async stop(meta) { stopped.push(meta.title); return { ok: true }; },
  });
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop });
  bridge.spawnCli = () => { throw new Error('the CLI must not run'); };
  const emitter = bridge.sendMessage('d-1', { prompt: '只回复 ok', model: 'claude-opus-5-5' });
  const events: Array<[string, unknown]> = [];
  for (const name of ['item_completed', 'warning', 'error'] as const) emitter.on(name, (data: unknown) => events.push([name, dig(data, 'item', 'text') || get(data, 'message')]));
  const done = await new Promise<EngineCompleted>(resolve => emitter.on('completed', resolve));
  assert.deepEqual(sent, [['桌面会话', 'local_d1', '只回复 ok']]);
  assert.equal(get(done.turn, 'status'), 'completed');
  assert.equal(emitter.turnId, 'u1', 'the run is the turn the desktop wrote');
  assert.deepEqual(events.filter(([name]) => name === 'item_completed').map(([, text]) => text), ['ok', 'ok']);
  assert.equal(events.some(([name]) => name === 'warning' || name === 'error'), false, 'same settings as the desktop: nothing to warn about');
  assert.equal(bridge.runs.size, 0);

  // Stop presses the desktop's own Stop; a failure to deliver is reported, not hidden.
  bridge.runs.set('d-1', fake<DesktopRun>({ desktop: true, meta: must(bridge.metaFor('d-1')) }));
  assert.deepEqual(await bridge.interrupt('d-1'), { pending: true }, 'the transcript decides the final status');
  assert.equal(bridge.runs.get('d-1')?.interrupted, undefined);
  assert.deepEqual(stopped, ['桌面会话']);
  bridge.runs.clear();
  assert.deepEqual(await bridge.interrupt('d-1'), { pending: true }, 'a desktop-started turn can use the same native Stop');
  assert.deepEqual(stopped, ['桌面会话', '桌面会话']);

  // Stop pressed as the reply finished on its own: completed. Stop that cut the turn: stopped.
  const stopRun = async (records: object[]) => {
    desktop.send = async (meta, text) => {
      const at = Date.now();
      setTimeout(() => { append([{ ...human(`h${at}`, text), timestamp: new Date(at).toISOString() }]); index({ latestUserFrameAt: at }); }, 50);
      setTimeout(async () => { await bridge.interrupt('d-1'); append(records); index({ latestUserFrameAt: at, lastTurnEdgeAt: at + 100 }); }, 800);
      return { ok: true };
    };
    const emitter = bridge.sendMessage('d-1', { prompt: 'stop test' });
    return get((await new Promise<EngineCompleted>(resolve => emitter.on('completed', resolve))).turn, 'status');
  };
  const reply = (uuid: string, text: string, stop_reason: string | null) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }], stop_reason } });
  assert.equal(await stopRun([reply('a2', 'done', 'end_turn')]), 'completed');
  assert.equal(await stopRun([{ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }, human('m1', '[Request interrupted by user for tool use]', { turnOrigin: undefined, origin: undefined })]), 'interrupted');
  assert.equal(await stopRun([reply('a4', 'half a sente', null)]), 'interrupted');
  // After a stop the desktop may never mark the turn's edge in its index: the transcript's
  // interrupt marker ends the run on its own, so the page does not stay "working".
  desktop.send = async (meta, text) => {
    const at = Date.now();
    setTimeout(() => { append([{ ...human(`x${at}`, text), timestamp: new Date(at).toISOString() }]); index({ latestUserFrameAt: at, lastTurnEdgeAt: at - 1 }); }, 50);
    setTimeout(async () => { await bridge.interrupt('d-1'); append([{ type: 'assistant', uuid: `t${at}`, message: { content: [{ type: 'tool_use', id: `tt${at}`, name: 'Bash', input: {} }], stop_reason: 'tool_use' } }, human(`i${at}`, '[Request interrupted by user for tool use]', { turnOrigin: undefined, origin: undefined })]); }, 800);
    return { ok: true };
  };
  const unedged = bridge.sendMessage('d-1', { prompt: 'stop, index never updated' });
  assert.equal(get((await new Promise<EngineCompleted>(resolve => unedged.on('completed', resolve))).turn, 'status'), 'interrupted');
  // The desktop is still running a turn the page took for finished: the message joins that turn
  // (as the desktop's own composer would), and the run follows from its own record, not from
  // another prompt that lands first.
  bridge.runs.clear();
  desktop.send = async () => ({ ok: false, code: 'busy', error: '这个会话正在 Claude 桌面版里运行，等这一轮结束再发' });
  const joinedTexts: string[] = [], before = desktop.steer;
  desktop.steer = async (meta, text) => {
    joinedTexts.push(text); const at = Date.now();
    setTimeout(() => { append([{ ...human(`o${at}`, 'someone else'), timestamp: new Date(at).toISOString() }, reply('a5', 'the earlier turn', 'end_turn'), { ...human(`j${at}`, text), timestamp: new Date(at + 10).toISOString() }, reply('a6', 'joined reply', 'end_turn')]); index({ latestUserFrameAt: at, lastTurnEdgeAt: at + 100 }); }, 50);
    return { ok: true };
  };
  const joinedRun = bridge.sendMessage('d-1', { prompt: 'join me' }), notes: string[] = [], said: unknown[] = [];
  joinedRun.on('warning', note => notes.push(note.message ?? '')); for (const type of ['delta', 'item_completed'] as const) joinedRun.on(type, (data: unknown) => said.push(get(data, 'text') || dig(data, 'item', 'text') || ''));
  assert.equal(get((await completion(joinedRun)).turn, 'status'), 'completed');
  assert.deepEqual(joinedTexts, ['join me']); assert.match(notes.join(), /这一轮还没结束/);
  assert.doesNotMatch(said.join(''), /the earlier turn/); assert.match(said.join(''), /joined reply/);
  desktop.steer = before;
  desktop.send = async () => ({ ok: false, error: '没能在 Claude 桌面版里打开这个会话' });
  bridge.runs.clear();
  const failed = await failure(bridge.sendMessage('d-1', { prompt: 'x' }));
  assert.match(failed.message, /没能在 Claude 桌面版里打开/);
  bridge.dispose();
  fs.rmSync(home, { recursive: true, force: true });
});

test('Claude: without the desktop app nothing is sent, and the page is told why; no other process runs it', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const indexDir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(indexDir, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'local_d1.json'), JSON.stringify({ sessionId: 'local_d1', cliSessionId: 'd-1', cwd: '/work', title: '桌面会话' }));
  fs.writeFileSync(path.join(project, 'd-1.jsonl'), JSON.stringify(human('u0', 'hi')) + '\n');
  const desktop = fake<ClaudeDesktop>({ check: async () => ({ available: false, reason: '没有辅助功能权限' }) });
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop });
  bridge.spawnCli = () => { throw new Error('the CLI must not run'); };
  const refused = await failure(bridge.sendMessage('d-1', { prompt: 'hi' }));
  assert.equal(refused.message, '没有辅助功能权限');
  // A chat the desktop does not have cannot be written to from here.
  desktop.check = async () => ({ available: true });
  const unknown = await failure(bridge.sendMessage('not-there', { prompt: 'hi' }));
  assert.match(unknown.message, /不在 Claude 桌面版里/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Claude: a message the desktop prefixed with system reminders still starts a turn', () => {
  const reminder = { type: 'text', text: '<system-reminder>\nLinked sessions now: …\n</system-reminder>' };
  const typed = human('u1', '实测停止', { message: { role: 'user', content: [reminder, { type: 'text', text: '实测停止' }] } });
  assert.equal(isHumanPrompt(typed), true);
  assert.equal(isHumanPrompt(human('u2', '', { message: { role: 'user', content: [reminder] } })), false, 'reminders alone are not a person');
  assert.equal(isHumanPrompt(human('u3', '<system-reminder>x</system-reminder>\n继续')), true);
  const turns = buildTurns([human('u0', 'first'), say('a0', 'one'), typed, say('a1', 'two')], 's');
  assert.deepEqual(turns.map(turn => turn.userPrompt), ['first', '实测停止']);
});

test('Claude: progress notes the desktop shows in place of thinking are what Claude says', () => {
  const think = (uuid: string, thinking: string, thinkingDisplay: string | undefined) => ({ type: 'assistant', uuid, thinkingDisplay, message: { content: [{ type: 'thinking', thinking, signature: 'x' }] } });
  const records = [human('u', 'go'), think('t0', '', 'updates'), think('t1', '找到原因了，现在去修。', 'updates'), think('t2', 'private reasoning', undefined), say('a', 'done')];
  assert.deepEqual(at(buildTurns(records, 's'), 0).messages.map(m => m.text), ['找到原因了，现在去修。', 'done']);
  const events: Array<[string, unknown]> = [], emitter = fake<EngineEmitter>({ emit: (name: EngineEventName, data?: unknown) => events.push([name, dig(data, 'item', 'text') || get(data, 'type')]) > 0 });
  const handle = createStreamHandler('s', streamRun(emitter));
  for (const record of records.slice(1, 4)) handle(record);
  assert.deepEqual(events, [['delta', 'reasoning'], ['item_completed', '找到原因了，现在去修。'], ['delta', 'reasoning']]);
});

test('Claude: background commands, task notices, stops and compaction show as the desktop lists them', () => {
  const tool = (uuid: string, id: string, name: string, input: object) => ({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (uuid: string, id: string, text: string, is_error = false) => ({ type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] } });
  const records = [
    human('u1', 'start'),
    tool('a1', 't1', 'Bash', { command: 'node server.js', description: '启动服务', run_in_background: true }),
    result('r1', 't1', 'Command running in background with ID: bg1. Output is being written to: /tmp/x'),
    tool('a2', 't2', 'Bash', { command: 'sleep 1 &', run_in_background: true }),
    result('r2', 't2', 'Command running in background with ID: bg2.'),
    { type: 'system', uuid: 's1', subtype: 'compact_boundary', compactMetadata: { cumulativeDroppedTokens: 448510 } },
    { type: 'system', uuid: 's2', subtype: 'informational', content: 'Compacted using a summary' },
    { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>bg2</task-id>\n<status>completed</status>\n<summary>Background command "sleep" completed</summary>\n</task-notification>' } },
    { type: 'user', uuid: 'n1', origin: { kind: 'task-notification' }, message: { content: '<task-notification>\n<task-id>bg2</task-id>\n<status>completed</status>\n<summary>Background command "sleep" completed</summary>\n</task-notification>' } },
    say('a3', 'started'), { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-11-08T10:01:00Z' },
    // After the turn ended: wakes Claude for a reply of its own; no row, but the command is done.
    { type: 'user', uuid: 'n2', origin: { kind: 'task-notification' }, message: { content: '<task-notification>\n<task-id>bg3</task-id>\n<status>completed</status>\n<summary>late</summary>\n</task-notification>' } },
    say('a6', 'done'),
    human('u2', 'stop it'),
    tool('a4', 't3', 'TaskStop', { task_id: 'bg1' }), result('r3', 't3', 'stopped'),
    tool('a5', 't4', 'Bash', { command: 'ping' }), result('r4', 't4', "The user doesn't want to proceed with this tool use.", true),
  ];
  const first = at(buildTurns(records, 's'), 0), second = at(buildTurns(records, 's'), 1);
  const by = (turn: typeof first, type: string) => turn.steps.filter(step => step.type === type);
  assert.deepEqual(by(first, 'notice').map(step => step.title), ['Compacted session · saved 448.5k tokens', 'Claude Code notice']);
  assert.deepEqual(by(first, 'background_task').map(step => [step.title, step.status]), [['Background command "sleep" completed', 'completed']], 'listed once, from the queued copy; the delivered one adds no row');
  assert.equal(at(first.steps, 0).status, 'interrupted', 'stopped later by TaskStop, even from a later turn');
  assert.equal(at(first.steps, 1).status, 'completed');
  assert.deepEqual(by(second, 'stop_task').map(step => step.title), ['Stopped task']);
  assert.equal(at(by(second, 'command'), 0).status, 'interrupted', 'a refused tool use is stopped, not failed');
  // Still running in the background when its turn ended: shown as running, like the desktop.
  const open = at(buildTurns([...records.slice(0, 3), say('a3', 'ok'), { type: 'system', subtype: 'stop_hook_summary' }], 's'), 0);
  assert.equal(at(open.steps, 0).status, 'running');
});

test('Claude: a message sent during a desktop turn goes through the desktop queue and continues the turn', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const indexDir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(indexDir, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const indexFile = path.join(indexDir, 'local_d1.json'), transcript = path.join(project, 'd-1.jsonl');
  const index = (extra: object) => fs.writeFileSync(indexFile, JSON.stringify({ sessionId: 'local_d1', cliSessionId: 'd-1', cwd: '/work', title: '桌面会话', lastTurnEdgeAt: 10, latestUserFrameAt: 5, ...extra }));
  index({});
  fs.writeFileSync(transcript, [human('u0', 'earlier'), say('a0', 'earlier reply')].map(r => JSON.stringify(r)).join('\n') + '\n');
  const append = (records: object[]) => fs.appendFileSync(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const steered: string[] = [], nudged: string[] = [];
  let started = 0;
  const desktop = fake<ClaudeDesktop>({
    check: async () => ({ available: true }),
    async send(meta, text) {
      started = Date.now();
      setTimeout(() => { append([{ ...human('u1', text), timestamp: new Date(started).toISOString() }]); index({ latestUserFrameAt: started, lastTurnEdgeAt: 10 }); }, 30);
      return { ok: true };
    },
    async steer(meta, text) {
      steered.push(text);
      // The desktop queues it, then puts it in at the next step as a prompt of its own.
      setTimeout(() => append([{ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: text }]), 30);
      return { ok: true };
    },
    async sendNow(meta) { nudged.push(meta.title); return { ok: true }; },
  });
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop });
  bridge.spawnCli = () => { throw new Error('the CLI must not run'); };
  const emitter = bridge.sendMessage('d-1', { prompt: 'long task' });
  let completed = false; emitter.on('completed', () => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 900));
  await bridge.steer('d-1', { prompt: 'also check the docs', attachments: [] });
  assert.deepEqual(steered, ['also check the docs']);
  assert.deepEqual(bridge.read('d-1')?.session?.metadata.desktopQueue?.map(item => item.prompt), ['also check the docs'], 'the page shows what the desktop holds');
  // Held by the desktop until it is put in; Send now is pressed there.
  const held = must(bridge.parse('d-1')).queue;
  assert.deepEqual(held.map(item => item.prompt), ['also check the docs']);
  await bridge.sendNow('d-1');
  assert.deepEqual(nudged, ['桌面会话']);
  append([{ type: 'queue-operation', operation: 'dequeue', timestamp: new Date().toISOString() }, { ...human('u2', 'also check the docs'), timestamp: new Date().toISOString() }]);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(completed, false, 'the steered message does not end the turn it joined');
  assert.deepEqual(bridge.parse('d-1')?.queue, []);
  append([say('a2', 'done')]); index({ latestUserFrameAt: started, lastTurnEdgeAt: Date.now() + 1000 });
  await new Promise(resolve => emitter.on('completed', resolve));
  // Without the desktop it waits in the console's own queue instead.
  desktop.check = async () => ({ available: false, reason: 'no access' });
  bridge.desktop.state = null;
  await assert.rejects(bridge.steer('d-1', { prompt: 'x', attachments: [] }), error => errorField(error, 'fallback') === 'queue');
  bridge.dispose();
  fs.rmSync(home, { recursive: true, force: true });
});

test('Claude: a new chat is created by the desktop app with its first message; without the desktop nothing is created', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const indexDir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(indexDir, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(indexDir, 'local_old.json'), JSON.stringify({ sessionId: 'local_old', cliSessionId: 'old-1', cwd: '/work', title: 'older', createdAt: 1 }));
  const made: unknown[] = [];
  const desktop = fake<ClaudeDesktop>({
    check: async () => ({ available: true }),
    async create(folder, text) {
      made.push([folder, text]); const at = Date.now();
      // The desktop writes its index entry and the transcript a moment after Send.
      setTimeout(() => {
        fs.writeFileSync(path.join(project, 'new-1.jsonl'), JSON.stringify({ ...human('u1', text), timestamp: new Date(at).toISOString() }) + '\n');
        fs.writeFileSync(path.join(indexDir, 'local_new.json'), JSON.stringify({ sessionId: 'local_new', cliSessionId: 'new-1', cwd: folder, title: 'New one', createdAt: at, latestUserFrameAt: at }));
      }, 120);
      setTimeout(() => {
        fs.appendFileSync(path.join(project, 'new-1.jsonl'), JSON.stringify(say('a1', 'hello from desktop')) + '\n');
        fs.writeFileSync(path.join(indexDir, 'local_new.json'), JSON.stringify({ sessionId: 'local_new', cliSessionId: 'new-1', cwd: folder, title: 'New one', createdAt: at, latestUserFrameAt: at, lastTurnEdgeAt: at + 100 }));
      }, 900);
      return { ok: true };
    },
  });
  const bridge = new ClaudeBridge({ home, claudeHome: path.join(home, '.claude'), desktopHome: path.join(home, 'Library/Application Support/Claude'), bin: '/bin/false', desktop });
  const session = await bridge.create({ prompt: 'first message', cwd: '/work' });
  assert.deepEqual(made, [['/work', 'first message']]);
  assert.deepEqual([session.id, session.cwd, session.started], ['new-1', '/work', true], 'the id is the session the desktop made');
  const emitter = bridge.observe('new-1'), said: unknown[] = [];
  for (const type of ['delta', 'item_completed'] as const) emitter.on(type, (data: unknown) => said.push(get(data, 'text') || dig(data, 'item', 'text') || ''));
  assert.equal(get((await completion(emitter)).turn, 'status'), 'completed');
  assert.match(said.join(''), /hello from desktop/);
  assert.throws(() => bridge.observe('new-1'), /没有正在执行/);
  assert.equal(bridge.list().some(item => item.id === 'new-1'), true, 'and it is listed, because the desktop has it');

  // No desktop: nothing is created anywhere, and the reason goes back to the page.
  desktop.check = async () => ({ available: false, reason: 'Claude 桌面版没有在运行' });
  bridge.spawnCli = () => { throw new Error('the CLI must not run'); };
  await assert.rejects(bridge.create({ prompt: 'second', cwd: '/work' }), err => errorField(err, 'status') === 409 && errorField(err, 'message') === 'Claude 桌面版没有在运行');
  // The desktop refused before Send: nothing was sent, and nothing else sends it.
  desktop.check = async () => ({ available: true });
  desktop.create = async () => ({ ok: false, code: 'fill_failed', error: '没能把消息填进 Claude 桌面版的输入框' });
  await assert.rejects(bridge.create({ prompt: 'third' }), /没能把消息填进/);
  await assert.rejects(bridge.create({ cwd: '/work' }), err => errorField(err, 'status') === 400);
  bridge.dispose();
  fs.rmSync(home, { recursive: true, force: true });
});

test('Claude: model, effort and permissions picked in the console are picked in the desktop app before it sends', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const indexDir = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  const project = path.join(home, '.claude/projects/-work');
  fs.mkdirSync(indexDir, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  const indexFile = path.join(indexDir, 'local_d1.json'), transcript = path.join(project, 'd-1.jsonl');
  const index = (extra: object) => fs.writeFileSync(indexFile, JSON.stringify({ sessionId: 'local_d1', cliSessionId: 'd-1', cwd: '/work', title: '桌面会话', model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'auto', lastTurnEdgeAt: 10, latestUserFrameAt: 5, ...extra }));
  index({});
  fs.writeFileSync(transcript, JSON.stringify(human('u0', 'earlier')) + '\n');
  const append = (records: object[]) => fs.appendFileSync(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const asked: unknown[] = [];
  let answer = (wanted: object): HelperResult => ({ ok: true, changed: Object.keys(wanted).filter(key => key !== 'mode'), notes: ['This session is cached for Opus 5.5.'] });
  const desktop = fake<ClaudeDesktop>({
    check: async () => ({ available: true }),
    async send(meta, text, wanted = {}) {
      asked.push(wanted);
      const result = answer(wanted);
      if (!result.ok) return result;
      const at = Date.now();
      setTimeout(() => { append([{ ...human('u1', text), timestamp: new Date(at).toISOString() }, say('a1', 'ok')]); index({ latestUserFrameAt: at, lastTurnEdgeAt: at + 100 }); }, 50);
      return result;
    },
  });
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop });
  bridge.spawnCli = () => { throw new Error('the CLI must not run'); };
  bridge.modelCache = { at: Date.now(), models: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'fable', name: 'Fable 5.2' }, { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }] };
  const run = (input: object) => new Promise<Array<[string, string]>>(resolve => {
    const events: Array<[string, string]> = [], emitter = bridge.sendMessage('d-1', { prompt: 'hi', ...input });
    emitter.on('warning', data => events.push(['warning', data.message ?? '']));
    emitter.on('error', err => resolve([...events, ['error', err.message]]));
    emitter.on('completed', () => resolve(events));
  });
  // Named as the desktop's menus name them; the helper picks whatever its composer shows differently.
  const events = await run({ model: 'fable', reasoningEffort: 'xhigh', permissionMode: 'acceptEdits' });
  assert.deepEqual(asked.pop(), { model: 'Fable 5.2', effort: 'Extra', mode: 'Accept edits' });
  assert.deepEqual(events, [['warning', '已在 Claude 桌面版里把这个会话切换为 Fable 5.2 · Extra（桌面版提示：This session is cached for Opus 5.5.）']], 'what the desktop changed, and what it said, is reported');
  const { english } = await import('../src/client/js/i18n.js');
  assert.equal(english(at(events, 0)[1]), "Switched this chat in Claude's desktop app to Fable 5.2 · Extra (the desktop app says: This session is cached for Opus 5.5.)");
  // Nothing picked, or the session's own model: nothing to look up; the old name of "manual" still maps.
  answer = () => ({ ok: true, changed: [] });
  assert.deepEqual(await run({ model: 'claude-opus-5-5', permissionMode: 'default' }), []);
  assert.deepEqual(asked.pop(), { mode: 'Manual' });
  // What the session already has (its own entry in the desktop's index, compared by id) is not
  // asked for again: a message that changes nothing opens no menu in the desktop, whatever
  // language its menus are in. One pick that differs is the only one passed.
  assert.deepEqual(await run({ model: 'claude-opus-5-5', reasoningEffort: 'medium', permissionMode: 'auto' }), []);
  assert.deepEqual(asked.pop(), {});
  assert.deepEqual(await run({ reasoningEffort: 'high', permissionMode: 'auto' }), []);
  assert.deepEqual(asked.pop(), { effort: 'High' });
  assert.deepEqual(await bridge.desktopSettings({ permissionMode: 'default' }, { permissionMode: 'manual' }), {});
  // A new chat has no settings of its own yet: everything picked is passed.
  assert.deepEqual(await bridge.desktopSettings({ reasoningEffort: 'medium', permissionMode: 'auto' }), { effort: 'Medium', mode: 'Auto' });
  assert.deepEqual(await bridge.desktopSettings({ model: 'claude-sonnet-4-6', reasoningEffort: 'bogus', permissionMode: 'rm' }), { model: 'Sonnet 4.6' });
  // A setting the desktop could not change: nothing is sent, and the reason is the desktop's.
  answer = () => ({ ok: false, code: 'hidden', error: 'Claude 桌面版的窗口不在屏幕上，这次没能改它的模型和权限：把窗口放到看得见的地方再发', changed: [] });
  const refused = await run({ model: 'fable' });
  assert.match(at(refused, -1)[1], /^Claude 桌面版的窗口不在屏幕上/); assert.equal(at(refused, -1)[0], 'error');
  assert.equal(bridge.runs.size, 0);
  // A model the list does not know has no name to pick in the desktop: say so instead of guessing.
  const before = asked.length;
  assert.deepEqual(at(await run({ model: 'mystery-9' }), -1), ['error', '没能确定这个模型在 Claude 桌面版里叫什么，没有发送']);
  assert.equal(asked.length, before, 'and nothing reaches the desktop');
});

test('Claude desktop helper: settings ride on send, steer and new as flags', async () => {
  const { ClaudeDesktop } = __claude_desktop;
  const calls: string[][] = [];
  const desktop = new ClaudeDesktop({ runner: async (file, args) => { calls.push(args); return { ok: true }; } });
  desktop.binary = '/bin/helper';
  const session = { title: '会话', localId: 'local_x1' };
  await desktop.send(session, 'hi', { model: 'Opus 5.5', effort: 'High', mode: 'Plan' });
  await desktop.steer(session, 'hi', { mode: 'Manual' });
  await desktop.create('/work', 'hi', { effort: 'Low' });
  await desktop.send(session, 'hi');
  assert.deepEqual(calls, [
    ['send', '会话', 'local_x1', '--model', 'Opus 5.5', '--effort', 'High', '--mode', 'Plan'],
    ['send', '会话', 'local_x1', 'steer', '--mode', 'Manual'],
    ['new', '/work', '--effort', 'Low'],
    ['send', '会话', 'local_x1'],
  ]);
});

test('Claude: a new chat asks what the desktop page asks, and each pick is made there', async () => {
  const { ClaudeDesktop } = __claude_desktop;
  const calls: string[][] = [];
  const helper = new ClaudeDesktop({ runner: async (file, args) => { calls.push(args); return { ok: true, controls: [] }; } });
  helper.binary = '/bin/helper';
  await helper.newControls(); await helper.newPick('Environment', 'This computer');
  await helper.newPick([{ control: 'Environment', option: 'This computer' }, { control: 'Folder', option: '/w/app' }]);
  // Every visit asks to stay on the page (`--stay`): the desktop is not taken there and back per step.
  assert.deepEqual(calls, [['new-controls', '--stay'], ['new-pick', 'Environment', 'This computer', '--stay'], ['new-pick', 'Environment', 'This computer', 'Folder', '/w/app', '--stay']]);
  // What the console showed as chosen rides on the first message, for the page to be checked against.
  calls.length = 0;
  await helper.create('', 'hi', {}, [{ control: 'Environment', option: 'This computer' }, { control: 'Folder', option: '~/w/app' }]);
  assert.deepEqual(calls, [['new', '-', 'Environment', 'This computer', 'Folder', '~/w/app']]);

  // The page changes with each pick: a local environment brings up the folder.
  let page: object[] = [{ kind: 'menu', label: 'Environment', value: 'agent-frontdesk', options: [{ label: 'This computer', section: 'Local', selected: false }, { label: 'agent-frontdesk', section: 'Local', selected: true }] }, { kind: 'toggle', label: 'Worktree', value: 'off' }];
  const desktop = fake<ClaudeDesktop>({
    check: async () => ({ available: true }),
    newControls: async () => ({ ok: true, controls: page }),
    newPick: async picks => {
      const option = Array.isArray(picks) ? at(picks, 0).option : '';
      if (option === 'nope') return { ok: false, error: 'Claude 桌面版的「Environment」菜单里没有「nope」', controls: page };
      page = [{ ...at(page, 0), value: option }, { kind: 'menu', label: 'Folder', value: 'Choose folder…', options: [{ label: 'work', section: 'Recent', selected: false }] }];
      return { ok: true, controls: page };
    },
  });
  const bridge = new ClaudeBridge({ home: '/nonexistent', env: {}, bin: null, desktop });
  assert.deepEqual((await bridge.newOptions()).controls.map(item => item.label), ['Environment', 'Worktree']);
  assert.deepEqual((await bridge.pickNewOption('Environment', 'This computer')).controls.map(item => item.label), ['Environment', 'Folder']);
  await assert.rejects(bridge.pickNewOption('Environment', 'nope'), err => errorField(err, 'status') === 409 && dig(err, 'controls', 'length') === 2 && dig(err, 'picked', 'length') === 0);
  // What the page's own model and permission menus show comes back in the console's ids, so its
  // menus start on what the first message will really use; what is not recognised is left out.
  bridge.modelCache = { at: Date.now(), models: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'fable', name: 'Fable 5.2' }, { id: 'claude-fable-5', name: 'Fable 5' }] };
  desktop.newControls = async () => ({ ok: true, controls: page, shown: { model: 'Fable 5.2 Medium', mode: 'Auto' } });
  assert.deepEqual((await bridge.newOptions()).settings, { model: 'fable', effort: 'medium', permissionMode: 'auto' });
  assert.deepEqual(await bridge.shownSettings({ model: 'Fable 5 Extra', mode: 'Accept edits' }), { model: 'claude-fable-5', effort: 'xhigh', permissionMode: 'acceptEdits' });
  assert.deepEqual(await bridge.shownSettings({ model: 'Opus 5.5', mode: 'Something new' }), { model: 'opus' });
  assert.deepEqual(await bridge.shownSettings({ model: 'Unknown 9 High' }), {});
  desktop.check = async () => ({ available: false, reason: 'Claude 桌面版没有在运行' });
  await assert.rejects(bridge.newOptions(), /没有在运行/);
});

test('the desktop stays on its new-chat page while the person chooses, and goes back to their conversation afterwards', async t => {
  const { ClaudeDesktop } = __claude_desktop;
  // The parking is a matter of time: the clock is the test's own, so nothing depends on how busy the machine is.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const pass = async (ms: number) => { t.mock.timers.tick(ms); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); };
  const calls: string[][] = [];
  // The helper's side of it: the first visit leaves a conversation, later ones find the page on screen.
  let onPage = false;
  const env = (value: string, options?: object[]) => ({ kind: 'menu', label: 'Environment', value, ...(options ? { options } : {}) });
  const folder = (value: string, options?: object[]) => ({ kind: 'menu', label: 'Folder', value, ...(options ? { options } : {}) });
  let page: object[] = [env('Cloud')];
  let crash = false;
  const desktop = new ClaudeDesktop({ parkMs: 30, warmEveryMs: 0, runner: async (_file, args) => {
    calls.push(args);
    if (crash && args[0] === 'new-pick') return { ok: false, code: 'crashed', error: '桌面版没有及时响应' };
    if (args[0] === 'new-controls' || args[0] === 'new-pick') {
      const previous = onPage ? '' : '我的会话'; onPage = true;
      if (args[0] === 'new-pick') page = [env(String(args[2])), folder('Choose folder…')];
      const read = args.slice(1).filter(arg => !arg.startsWith('--') && arg !== '我的会话');
      const shown = args[0] === 'new-controls' ? page.map(item => (read.includes(String(get(item, 'label'))) ? { ...item, options: [{ label: `${String(get(item, 'label'))}-option`, section: '', selected: false }] } : item)) : page;
      return { ok: true, controls: shown, previous, stayed: args.includes('--stay') };
    }
    onPage = false;
    return { ok: true };
  } });
  desktop.binary = process.execPath; // a file that is there: a missing helper is built again (next test)
  const labels = (result: HelperResult) => list(result['controls']).map(item => [get(item, 'label'), list(get(item, 'options')).length]);
  // Read afresh each time (an assert on one value would otherwise narrow it for the rest of the test).
  const made = (): string[][] => calls, parkedOn = () => desktop.parked?.previous ?? null;

  // The page is read (values only), then only the menu about to be shown is opened.
  assert.deepEqual(labels(await desktop.newControls(['Environment'])), [['Environment', 1]]);
  assert.deepEqual(calls, [['new-controls', '--stay'], ['new-controls', 'Environment', '--stay', '--previous', '我的会话']]);
  // Asked again for the same page: answered from what was read, the desktop is not touched.
  calls.length = 0;
  assert.deepEqual(labels(await desktop.newControls(['Environment'])), [['Environment', 1]]);
  assert.deepEqual(calls, []);
  // A pick changes the page: the folder menu it brought up has not been read, the environment's
  // options for the page as it is now have not either (they mark another row).
  assert.deepEqual(labels(await desktop.newPick('Environment', 'This computer')), [['Environment', 0], ['Folder', 0]]);
  assert.deepEqual(labels(await desktop.newControls(['Folder'])), [['Environment', 0], ['Folder', 1]]);
  assert.deepEqual(calls, [['new-pick', 'Environment', 'This computer', '--stay', '--previous', '我的会话'], ['new-controls', 'Folder', '--stay', '--previous', '我的会话']]);
  // "Read it again" forgets what was read.
  calls.length = 0;
  await desktop.newControls(['Folder'], { fresh: true });
  assert.deepEqual(made().map(args => args.slice(0, 2)), [['new-controls', '--stay'], ['new-controls', 'Folder']]);

  // A message to a conversation meanwhile: that command goes back to the person's conversation
  // itself when it is done, and the parking ends with it.
  calls.length = 0;
  await desktop.send({ title: '别的会话', localId: 'x1' }, 'hi');
  assert.deepEqual(calls, [['send', '别的会话', 'local_x1', '--previous', '我的会话']]);
  assert.equal(parkedOn(), null);
  await pass(60);
  assert.equal(made().length, 1, 'nothing is left to undo');

  // Left alone on the page, the desktop is sent back once the choosing has gone quiet.
  calls.length = 0;
  await desktop.newControls([], { fresh: true });
  assert.equal(parkedOn(), '我的会话');
  await pass(29); assert.equal(parkedOn(), '我的会话', 'not before its time');
  await pass(2);
  assert.deepEqual(made().at(-1), ['new-leave', '--previous', '我的会话']);
  assert.equal(parkedOn(), null);
  // A command that ended without saying where it left the desktop (stopped for taking too long):
  // the desktop is sent back at once, not at the end of a parking nobody renews.
  await desktop.newControls([], { fresh: true });
  crash = true; calls.length = 0;
  assert.equal((await desktop.newPick('Environment', 'Cloud')).ok, false);
  await pass(0);
  assert.deepEqual(made().map(args => args[0]), ['new-pick', 'new-leave']);
  assert.equal(parkedOn(), null);
  crash = false;
  // A command in another of the desktop's modes leaves the parking as it is.
  await desktop.newControls([], { fresh: true });
  calls.length = 0;
  await desktop.run(['read-chat', '聊天'], { settings: { space: 'chat' } });
  assert.deepEqual(made(), [['read-chat', '聊天', '--space', 'chat']]);
  assert.equal(parkedOn(), '我的会话');
  desktop.unpark();
  // A menu's options are kept for one round of choosing, then read from the desktop again.
  await desktop.newControls(['Environment'], { fresh: true });
  calls.length = 0;
  await desktop.newControls(['Environment']);
  assert.deepEqual(made(), []);
  await pass(61_000); calls.length = 0;
  await desktop.newControls(['Environment']);
  assert.deepEqual(made().map(args => args.slice(0, 2)), [['new-controls', '--stay'], ['new-controls', 'Environment']]);
  desktop.unpark();
});

test('a page parked in another mode than the person\'s keeps that mode until the choosing is over, then both come back', async t => {
  const { ClaudeDesktop } = __claude_desktop;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const pass = async (ms: number) => { t.mock.timers.tick(ms); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); };
  const calls: string[][] = [];
  // The helper's side of it: the person was in the chat mode; the first visit switches to the
  // page's mode and says so (previousSpace), later ones find the desktop already there.
  let mode = 'chat';
  const desktop = new ClaudeDesktop({ parkMs: 30, warmEveryMs: 0, runner: async (_file, args) => {
    calls.push(args);
    if (args[0] === 'new-controls' || args[0] === 'new-pick') {
      const was = mode; mode = 'code';
      return { ok: true, controls: [], previous: '', stayed: true, ...(was === 'chat' ? { previousSpace: 'chat' } : {}) };
    }
    return { ok: true };
  } });
  desktop.binary = process.execPath;
  const made = (): string[][] => calls, parkedIn = () => desktop.parked?.space ?? null;

  // The page was already on screen in its own mode (previous ""), but the mode was the person's
  // to have back: the desktop is parked all the same.
  await desktop.newControls([]);
  assert.equal(parkedIn(), 'chat');
  // The next step is told the mode to keep for the person; it does not switch back and forth.
  await desktop.newPick('Environment', 'This computer');
  assert.deepEqual(made().at(-1), ['new-pick', 'Environment', 'This computer', '--stay', '--previous', '', '--previous-space', 'chat']);
  assert.equal(parkedIn(), 'chat', 'a later step that found the mode borrowed keeps what the first one learned');
  // Once the choosing has gone quiet, new-leave is told both.
  await pass(31);
  assert.deepEqual(made().at(-1), ['new-leave', '--previous', '', '--previous-space', 'chat']);
  assert.equal(parkedIn(), null);
  // A message sent meanwhile ends the parking and takes the mode back itself.
  mode = 'chat'; calls.length = 0;
  await desktop.newControls([], { fresh: true });
  await desktop.send({ title: '别的会话', localId: 'x1' }, 'hi');
  assert.deepEqual(made().at(-1), ['send', '别的会话', 'local_x1', '--previous', '', '--previous-space', 'chat']);
  assert.equal(parkedIn(), null);
  await pass(60);
  assert.equal(made().length, 2, 'nothing is left to undo');
});

test('a server whose helper was cleaned out of the cache builds it again and runs the command once more', async () => {
  const { ClaudeDesktop } = __claude_desktop;
  const ran: string[] = [];
  const desktop = new ClaudeDesktop({ warmEveryMs: 0, runner: async file => { ran.push(file); return file.endsWith('gone') ? { ok: false, code: 'crashed', error: '桌面代发程序没有正常返回' } : { ok: true }; } });
  let builds = 0;
  desktop.binary = '/nonexistent/helper-gone';
  desktop.helper = async () => desktop.binary || (builds++, desktop.binary = process.execPath);
  assert.equal((await desktop.run(['probe'])).ok, true);
  assert.deepEqual(ran, ['/nonexistent/helper-gone', process.execPath]);
  assert.equal(builds, 1);
  // A helper that is there and fails is not run twice: the command may have done something.
  ran.length = 0; desktop.binary = process.execPath;
  desktop.runner = async file => { ran.push(file); return { ok: false, code: 'crashed', error: '桌面版没有及时响应' }; };
  assert.equal((await desktop.run(['send', '会话', '-'])).ok, false);
  assert.equal(ran.length, 1);
});

test('while the console is in use the desktop is kept warm, and left alone once it has gone quiet', async t => {
  const { ClaudeDesktop } = __claude_desktop;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const pass = async (ms: number) => { t.mock.timers.tick(ms); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); };
  const calls: string[][] = [];
  let release: () => void = () => {};
  const desktop = new ClaudeDesktop({ warmEveryMs: 10, runner: async (_file, args) => {
    calls.push(args);
    if (args[0] === 'slow') await new Promise<void>(resolve => { release = resolve; });
    return { ok: true };
  } });
  desktop.binary = '/bin/helper';
  const made = (): string[][] => calls;
  desktop.keepWarm(35);
  await pass(0);
  assert.deepEqual(made(), [['warm']], 'the first sign of use reads the page at once');
  await pass(10); await pass(10);
  assert.deepEqual(made(), [['warm'], ['warm'], ['warm']]);
  // While a command runs nothing is added: it reads the page itself.
  calls.length = 0;
  const running = desktop.run(['slow']);
  await pass(0);
  desktop.keepWarm(35); await pass(10); await pass(10);
  assert.deepEqual(made(), [['slow']]);
  release(); await pass(0); await running;
  // Quiet again: the beat stops by itself.
  calls.length = 0;
  await pass(40); await pass(40);
  assert.deepEqual(made().filter(args => args[0] === 'warm').length <= 2, true);
  calls.length = 0;
  await pass(100);
  assert.deepEqual(made(), []);
  assert.equal(desktop.warmTimer, null);
});

test('nothing is done to a control that is not the only one its locator finds, and a control found by its place has to prove itself', () => {
  const driver = fs.readFileSync(path.join(__dirname, '../src/server/native/ax-driver.swift'), 'utf8');
  const flowOf = (id: string) => fs.readFileSync(path.join(__dirname, `../src/server/native/${id}-desktop.swift`), 'utf8');
  const profile = (id: string) => JSON.parse(fs.readFileSync(path.join(__dirname, `../src/server/native/profiles/${id}.json`), 'utf8'));
  type Way = Record<string, unknown>;
  const waysOf = (value: unknown): Way[] => (Array.isArray(value) ? value : [value]) as Way[];
  // Looking takes the first match (a look is repeated while the page settles; reading the whole
  // page each time costs tenths of a second). Doing asks the way that found the control for
  // everything it finds: every action goes through that check, and only scrolling into view (how
  // the page is kept fresh off screen) is let through.
  assert.match(driver, /func sole\(_ e: AXUIElement, _ depth: Int = 0\) -> Bool \{/);
  assert.match(driver, /guard action == "AXScrollToVisible" \|\| sole\(e\) else \{ return \.failure \}/);
  for (const action of ['setValue', 'focus']) assert.match(driver, new RegExp(`func ${action}\\([^)]*\\) \\{ guard sole\\(e\\) else \\{ return \\}`));
  assert.match(driver, /func insert\(_ e: AXUIElement, _ text: String\) \{\n\s+guard sole\(e\) else \{ return \}/);
  assert.equal([...driver.matchAll(/AXUIElementPerformAction\(/g)].length, 1, 'no action goes around act()');
  // Several controls answering to one way is ambiguous unless another way singles this one out;
  // a way that goes by its place finds one by construction.
  assert.match(driver, /if !l\.placed \{\n\s+let hits = matches\(l\)\n\s+if hits\.count > 1 \{/);
  assert.match(driver, /if !singled \{ refused\[from\.key\] = hits\.count;/);
  assert.match(driver, /var placed: Bool \{ index != nil \|\| after != nil \}/);
  // Once something was held back the focus may not be where the flow put it: only Escape goes out.
  assert.match(driver, /guard refused\.isEmpty \|\| code == \.escape else/);
  // The answer says why, whatever step the flow then failed at; a flow that has just pressed Send
  // asks at once, so a message that did not go out is not waited for.
  assert.match(driver, /because\("ambiguous", /);
  assert.match(driver, /because\("unconfirmed", /);
  assert.match(driver, /if let step = object\["code"\] \{ object\["step"\] = step \}/);
  assert.equal([...flowOf('claude').matchAll(/act\(send, kAXPressAction as String\)\n(?:\s+\/\/[^\n]*\n)*\s+if heldBack\(\) \{/g)].length, 2);
  assert.match(flowOf('codex'), /press\(send\)\n(?:\s+\/\/[^\n]*\n)*\s+if heldBack\(\) \{ giveUp\(/);
  assert.match(driver, /press\(send\)\n\s+if heldBack\(\) \{ clear\(sendKey\("composer"\)\); return StepError\(/);
  // Every answer says which controls were found by another way than their first.
  assert.match(driver, /if let hit \{ origin\[hit\] = \(key, way\); via\[key\] = way; return hit \}/);
  assert.match(driver, /if !other\.isEmpty \{ object\["via"\] = other \}/);

  // A menu button found by its place has to open the menu the profile describes ("menuSigns":
  // what one of that menu's rows is, by a mark no language changes), or the menu is closed again.
  assert.match(driver, /if shown, let button = menu\(\), !confirmed\(button\) \{ close\(menu\); return false \}/);
  assert.match(driver, /ways\[from\.way\]\.placed, let spec = menuSigns\[from\.key\] else \{ return true \}/);
  const matchers = ['role', 'roles', 'class', 'keys', 'id', 'subrole', 'url', 'popup'];
  for (const id of ['claude', 'codex']) {
    const data = profile(id), signs = data.menuSigns as Record<string, unknown>;
    const placed = (way: Way) => 'index' in way || 'after' in way;
    // The model menu's button is found by its place in both (in another language for Claude, always for Codex).
    assert.ok('modelMenu' in signs, `${id} says what its model menu shows`);
    for (const [key, value] of Object.entries(signs)) {
      assert.ok(waysOf(data.locators[key]).some(placed), `${id}.menuSigns.${key} is for a control with a way that goes by its place`);
      for (const way of waysOf(value)) for (const field of Object.keys(way)) assert.ok(matchers.includes(field), `${id}.menuSigns.${key}: ${field} is a mark, not a word or a place`);
    }
  }
  // (Seen on the real apps: Codex's model menu has the row that opens the models, by its own
  // class; Claude's ends in rows that open a submenu, which its permission menu has none of.)
  assert.deepEqual(profile('codex').menuSigns.modelMenu, { role: 'AXMenuItem', class: 'ViewToggle-*' });
  assert.deepEqual(profile('claude').menuSigns.modelMenu, { role: 'AXMenuItem', popup: true });

  // `probe` and `warm check` share one reading of whether the profile still matches the page.
  assert.match(driver, /func profileCheck\(\) -> \(found: \[String: Int\], ways: \[String: \[Int\]\], differ: \[String\], drift: \[String\], several: \[String: Int\]\)/);
  assert.match(driver, /if args\.contains\("check"\), ready \{ let state = profileCheck\(\); answer\["checked"\] = true; answer\["drift"\] = state\.drift; answer\["differ"\] = state\.differ \}/);
  // Drift: a way that goes by a mark finds nothing where a later way finds a control the mark
  // should have covered (of its role, in its box).
  assert.match(driver, /guard way\.kind == "mark", way\.role\.map\(\{ \$0 == role\(hit\) \}\) \?\? true/);
});

test('about once a minute the warm read checks the profile against the desktop, and what two checks in a row say is reported', async t => {
  const { ClaudeDesktop } = __claude_desktop;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const pass = async (ms: number) => { t.mock.timers.tick(ms); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); };
  const warned: string[] = [];
  t.mock.method(console, 'warn', (line: unknown) => { warned.push(String(line)); });
  const calls: string[][] = [];
  let answer: Record<string, unknown> = { checked: true, drift: ['send'], differ: [] };
  const desktop = new ClaudeDesktop({ warmEveryMs: 10, runner: async (_file, args) => { calls.push(args); return args[1] === 'check' ? { ok: true, ...answer } : { ok: true }; } });
  desktop.binary = '/bin/helper';
  // Every sixth read checks; the first read (the page may be half built) never does.
  for (let beat = 0; beat < 12; beat++) { desktop.keepWarm(1000); await pass(beat ? 10 : 0); }
  assert.deepEqual(calls.map(args => args.join(' ')), [...Array(5).fill('warm'), 'warm check', ...Array(5).fill('warm'), 'warm check']);
  // Named once: not yet. Named twice in a row: reported, logged once, shown with the status.
  assert.deepEqual(desktop.staleControls(), ['send']);
  assert.equal(warned.length, 1);
  assert.match(must(warned[0]), /Claude 桌面版的界面和 src\/server\/native\/profiles\/claude\.json 对不上了：send/);
  desktop.checked({ ok: true, checked: true, drift: ['send'], differ: ['stop'] });
  assert.deepEqual(desktop.staleControls(), ['send'], 'a control named for the first time waits for the next check');
  assert.equal(warned.length, 1);
  // A read that did not check (the page was not built) says nothing either way.
  desktop.checked({ ok: true, ready: false });
  desktop.checked({ ok: false, code: 'crashed' });
  assert.deepEqual(desktop.staleControls(), ['send']);
  // One clean check clears it.
  answer = { checked: true, drift: [], differ: [] };
  desktop.checked({ ok: true, ...answer });
  assert.deepEqual(desktop.staleControls(), []);
  assert.match(must(warned[1]), /重新对上了/);
  // A command that held something back is logged too, with what it would not touch.
  const refused = new ClaudeDesktop({ warmEveryMs: 0, runner: async () => ({ ok: false, code: 'ambiguous', step: 'no_send', error: 'x', ambiguous: { send: 2 } }) });
  refused.binary = '/bin/helper';
  assert.equal((await refused.run(['send', 't', ''])).code, 'ambiguous');
  assert.match(must(warned[2]), /\[ax claude\] send: ambiguous \{"send":2\}/);
});

test('new chat cards: one control at a time, the next after each pick, picks undone by later ones come back', async () => {
  const { NewOptions } = await import('../src/client/js/new-options.js');
  let page: object[] = [{ kind: 'menu', label: 'Environment', value: 'This computer', options: [{ label: 'This computer', section: 'Local', selected: true }, { label: 'Cloud', section: 'Cloud', selected: false }] }];
  const posts: string[][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      const picked: unknown = JSON.parse(String(options.body)), control = String(get(picked, 'control')), option = String(get(picked, 'option')); posts.push([control, option]);
      if (control === 'Environment') page = [{ ...page[0], value: option }, ...(option === 'This computer' ? [{ kind: 'menu', label: 'Folder', value: 'Choose folder…', options: [{ label: 'work', section: 'Recent', selected: false }] }] : [])];
      if (control === 'Folder') page = [at(page, 0), { ...page[1], value: '~/work' }, { kind: 'toggle', label: 'Worktree', value: 'off' }];
      if (control === 'Worktree') page = [at(page, 0), at(page, 1), { ...page[2], value: option }];
    }
    return respond({ controls: page });
  };
  try {
    let changes = 0;
    const cards = new NewOptions({ onChange: () => changes++ });
    // Read afresh each time: the null assert above would otherwise narrow cards.current for good.
    const label = () => cards.current?.label;
    await cards.load('claude');
    assert.equal(must(cards.current).label, 'Environment');
    assert.match(cards.html('Claude'), /data-new-option="This computer"[^>]*aria-pressed="true"/);
    await cards.pick('Environment', 'This computer');
    assert.equal(must(cards.current).label, 'Folder', 'the pick brought up the next control');
    await cards.pick('Folder', 'work');
    assert.equal(must(cards.current).label, 'Worktree');
    assert.match(cards.html('Claude'), /new-option-chip[\s\S]*Folder[\s\S]*work/);
    await cards.pick('Worktree', 'off');
    assert.equal(cards.current, null); assert.match(cards.html('Claude'), /new-options-ready/);
    // Going back to the environment and picking another one: the folder it took away is gone,
    // and picking the local one again asks for the folder again.
    cards.edit('Environment'); assert.equal(label(), 'Environment');
    await cards.pick('Environment', 'Cloud'); assert.equal(cards.current, null);
    cards.edit('Environment'); await cards.pick('Environment', 'This computer');
    assert.equal(label(), 'Folder');
    assert.deepEqual(posts.map(([control]) => control), ['Environment', 'Folder', 'Worktree', 'Environment', 'Environment']);
    assert.ok(changes > 0);
  } finally { globalThis.fetch = original; }
});

test('asking for a new chat again shows what was chosen at once, and checks it against the desktop behind the cards', async () => {
  const { NewOptions } = await import('../src/client/js/new-options.js');
  const env = (value: string) => ({ kind: 'menu', label: 'Environment', value, options: [{ label: 'This computer', section: '', selected: value === 'This computer' }, { label: 'Cloud', section: '', selected: value === 'Cloud' }] });
  let page: object[] = [env('This computer'), { kind: 'toggle', label: 'Worktree', value: 'off' }];
  const calls: string[] = [];
  let hold: Promise<void> | null = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${String(url).replace(/^.*new-options\//, '')}`);
    if (options.method === 'POST') { const picked: unknown = JSON.parse(String(options.body)); page = page.map(item => (get(item, 'label') === get(picked, 'control') ? { ...item, value: get(picked, 'option') } : item)); }
    if (hold) await hold;
    return respond({ controls: page });
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const cards = new NewOptions();
    cards.open('claude'); await tick(); await tick();
    await cards.pick('Environment', 'This computer'); await cards.pick('Worktree', 'off');
    assert.equal(cards.current, null);
    // What is shown as chosen goes with the first message, in the page's order.
    assert.deepEqual(cards.expect(), [{ control: 'Environment', option: 'This computer' }, { control: 'Worktree', option: 'off' }]);
    cards.sent();

    // Another engine in between, then back: the cards are there before the desktop has answered.
    cards.open('codex'); await tick(); await tick();
    calls.length = 0;
    let free: () => void = () => {}; hold = new Promise<void>(resolve => { free = resolve; });
    cards.open('claude');
    assert.equal(cards.busy, '', 'no spinner');
    assert.equal(cards.current, null); assert.match(cards.html('Claude'), /new-options-ready/);
    assert.deepEqual(calls, ['GET claude'], 'the page is read again behind them');
    // The desktop's page was changed there meanwhile: that control comes up again as a card.
    page = [env('Cloud'), at(page, 1)];
    free(); hold = null; await tick(); await tick(); await tick();
    const label = () => cards.current?.label; // read afresh: the null assert above would narrow cards.current
    assert.equal(label(), 'Environment');
    assert.deepEqual(cards.expect(), [{ control: 'Worktree', option: 'off' }]);
    // The reload button asks the server to forget what it read.
    calls.length = 0;
    cards.reload(); await tick(); await tick();
    assert.equal(calls[0], 'GET claude?fresh=1');
    await cards.pick('Environment', 'Cloud');
    // The first message waits for a check that is still out, so it goes with the page as it is now.
    let done: () => void = () => {}; hold = new Promise<void>(resolve => { done = resolve; });
    cards.open('codex'); cards.open('claude');
    let waited = false; const waiting = cards.checked().then(() => { waited = true; });
    await tick(); assert.equal(waited, false);
    done(); hold = null; await waiting; assert.equal(cards.checking, null);
    await cards.checked(); // nothing out: at once
    // A menu read a while ago is read again before it is chosen from.
    calls.length = 0;
    cards.edit('Environment'); await tick(); await tick();
    assert.deepEqual(calls, [], 'read a moment ago: shown from that read');
    cards.optionsAt.set('Environment', Date.now() - 61_000);
    cards.edit('Environment'); await tick(); await tick();
    assert.deepEqual(calls, ['GET claude?read=Environment']);
    // When the desktop cannot be read the cards stay, with the reason: they are not checked.
    globalThis.fetch = async () => respond({ error: 'Claude 桌面版没有在运行' }, { ok: false, status: 409 });
    await cards.refresh();
    assert.match(cards.error, /没有在运行/); assert.ok(cards.controls?.length);
    assert.match(cards.html('Claude'), /new-options-error/);
  } finally { globalThis.fetch = original; }
});

test('new chat from a project\'s "+": one visit to the desktop picks its way to the folder; menus are read only when shown', async () => {
  const { NewOptions } = await import('../src/client/js/new-options.js');
  const calls: unknown[] = [];
  let reply: (url: unknown, options: RequestInit) => { status?: number; body: unknown } = () => ({ body: {} });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push(options.method === 'POST' ? JSON.parse(String(options.body)) : String(url).replace(/^.*new-options\/\w+/, 'GET'));
    const { status = 200, body } = reply(url, options);
    return respond(body, { ok: status < 400, status });
  };
  const aim = (cwd: string) => ({ engine: 'claude', id: `repo:${cwd}`, name: 'work', cwd, control: 'Folder', via: { control: 'Environment', option: 'This computer' } });
  const env = { kind: 'menu', label: 'Environment', value: 'This computer' }, worktree = { kind: 'toggle', label: 'Worktree', value: 'off' };
  try {
    // Both picks in one request, no reading first; the next card is a toggle, so nothing more is read.
    reply = () => ({ body: { controls: [env, { kind: 'menu', label: 'Folder', value: '~/work' }, worktree], picked: ['Environment', 'Folder'] } });
    const cards = new NewOptions();
    cards.aim(aim('/Users/me/work'));
    await cards.load('claude');
    assert.deepEqual(calls, [{ picks: [{ control: 'Environment', option: 'This computer' }, { control: 'Folder', option: '/Users/me/work' }] }]);
    assert.equal(cards.settings, null); // the engine did not say what its page's own menus show
    assert.equal(must(cards.current).label, 'Worktree');
    assert.match(cards.html('Claude'), /new-options-aim[\s\S]*work/);
    // Going back to a chip whose menu was never read reads just that menu.
    calls.length = 0;
    reply = () => ({ body: { controls: [env, { kind: 'menu', label: 'Folder', value: '~/work', options: [{ label: 'work', section: 'Recent', selected: true }, { label: 'other', section: 'Recent', selected: false }] }, worktree] } });
    cards.edit('Folder'); await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['GET?read=Folder']);
    assert.match(cards.html('Claude'), /data-new-option="other"/);
    // A hand pick on the folder drops the target.
    reply = () => ({ body: { controls: [env, { kind: 'menu', label: 'Folder', value: '~/other' }, worktree], settings: { model: 'fable', effort: 'medium' } } });
    await cards.pick('Folder', 'other'); assert.equal(cards.target, null);
    assert.deepEqual(cards.settings, { model: 'fable', effort: 'medium' }); // kept for the composer's menus
    // A folder the desktop does not list: what was picked counts, the folder card stays with its options.
    calls.length = 0;
    reply = () => ({ status: 409, body: { error: 'Claude 桌面版的「Folder」菜单里没有「missing」', picked: ['Environment'], controls: [env, { kind: 'menu', label: 'Folder', value: 'Choose folder…', options: [{ label: 'work', section: 'Recent', selected: false }] }, worktree] } });
    cards.aim(aim('/elsewhere/missing')); await cards.load('claude');
    assert.equal(calls.length, 1); assert.match(cards.error, /missing/); assert.equal(must(cards.current).label, 'Folder');
    // Another engine's page is never steered: it is read as usual.
    calls.length = 0;
    reply = () => ({ body: { controls: [{ ...env, options: [] }] } });
    cards.aim(aim('/x/work')); await cards.load('codex'); assert.deepEqual(calls, ['GET']);
  } finally { globalThis.fetch = original; }
});

test('the shared driver reads a new chat page from the profile: every key it names exists in Claude\'s', () => {
  const driver = fs.readFileSync(path.join(__dirname, '../src/server/native/ax-driver.swift'), 'utf8');
  const flow = fs.readFileSync(path.join(__dirname, '../src/server/native/claude-desktop.swift'), 'utf8');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/server/native/profiles/claude.json'), 'utf8'));
  const keys = [...driver.matchAll(/settings?\("(newPage\w*)"\)/g)].map(match => match[1] ?? '');
  assert.ok(keys.length >= 4);
  for (const key of keys) assert.ok(key in profile, `profile has ${key}`);
  assert.ok(profile.newPageTogglesAfter in profile.locators);
  // The flow only says how to open its page and what to watch for while a pick settles.
  assert.match(flow, /newPageCommands\(open: openNewPage\)/);
  assert.doesNotMatch(flow, /func (pageControls|pickOnPage|listPageControls)\b/);
});

test('controls are found by what the desktop\'s language does not change, their names only as a fallback', () => {
  const driver = fs.readFileSync(path.join(__dirname, '../src/server/native/ax-driver.swift'), 'utf8');
  const profile = (id: string) => JSON.parse(fs.readFileSync(path.join(__dirname, `../src/server/native/profiles/${id}.json`), 'utf8'));
  type Way = Record<string, unknown>;
  const waysOf = (value: unknown): Way[] => (Array.isArray(value) ? value : [value]) as Way[];
  const worded = (way: Way) => 'name' in way || 'prefix' in way || 'contains' in way;
  const matchers = ['role', 'roles', 'class', 'keys', 'id', 'subrole', 'url', 'popup', 'inside', 'after', 'has', 'index', 'name', 'prefix', 'contains', 'named'];
  for (const id of ['claude', 'codex']) {
    const data = profile(id), locators = data.locators as Record<string, unknown>;
    for (const [key, value] of Object.entries(locators)) for (const way of waysOf(value)) {
      // Every matcher is one the driver reads, and a control placed by another names one that exists.
      for (const field of Object.keys(way)) assert.ok(matchers.includes(field), `${id}.${key}: ${field}`);
      for (const field of ['inside', 'after', 'has']) if (field in way) assert.ok(String(way[field]) in locators, `${id}.${key} ${field} ${String(way[field])}`);
    }
    for (const field of ['newPageStart', 'newPageMenusBefore', 'newPageSkipTogglesInside', 'newPageTogglesAfter']) if (field in data) assert.ok(data[field] in locators, `${id}.${field}`);
  }
  // What sending, stopping and starting a chat press in Claude goes first by something no language
  // changes (seen on the real app: the page declares Enter for Send, Escape for Stop, Meta+n for New).
  const claude = profile('claude').locators;
  for (const key of ['composer', 'send', 'stop', 'newChat', 'chatPane', 'spaceSwitch']) {
    const ways = waysOf(claude[key]);
    assert.ok(!worded(must(ways[0])), `claude.${key} goes first by something other than its name`);
    assert.ok(ways.slice(1).some(worded), `claude.${key} keeps its name as a fallback`);
  }
  assert.deepEqual([waysOf(claude.send)[0]?.['keys'], waysOf(claude.stop)[0]?.['keys'], waysOf(claude.newChat)[0]?.['keys']], ['Enter', 'Escape', 'Meta+n']);
  // A guess by position comes after the name: with the control absent it would find something else.
  // (Seen on the real app: the page grew a group around its messages within a day, and "the first
  // group in the chat" stopped being the messages.)
  for (const [id, key] of [['claude', 'modelMenu'], ['claude', 'transcript'], ['codex', 'modelMenu'], ['codex', 'permissionsMenu'], ['codex', 'projectMenu'], ['codex', 'modeSwitch']] as const) {
    const ways = waysOf(profile(id).locators[key]);
    assert.ok(ways.length > 1 && !worded(must(ways.at(-1))) && ways.findIndex(way => 'index' in way || 'inside' in way) > 0, `${id}.${key}`);
  }
  const codex = profile('codex').locators;
  for (const key of ['newChat', 'noProject']) assert.ok(!worded(must(waysOf(codex[key])[0])), `codex.${key}`);
  // Codex's Send shares its place and its classes with the voice button: only its name tells them apart.
  assert.deepEqual(waysOf(codex.send), [{ role: 'AXButton', name: 'Send' }]);
  // The driver: several ways per control, the value after a button's colon in any language, and
  // the page's own check that the ways agree.
  assert.match(driver, /let locators: \[String: \[Locator\]\]/);
  assert.match(driver, /text\.range\(of: "："\)/);
  assert.match(driver, /"ways": state\.ways, "differ": state\.differ, "drift": state\.drift, "several": state\.several/);
  // A menu's row that its name does not find is taken by its place, never by guessing: only in a
  // menu that shows none of the profile's words, with the number of rows the flow expects.
  const flowOf = (id: string) => fs.readFileSync(path.join(__dirname, `../src/server/native/${id}-desktop.swift`), 'utf8');
  assert.match(driver, /func wordless\(/);
  assert.match(flowOf('claude'), /rows\.count == 2, wordless\(rows, \[setting\("effortItem"\), setting\("moreModelsItem"\)\]\)/);
  assert.match(flowOf('claude'), /wordless\(rows, efforts\), place < rows\.count/);
  assert.match(flowOf('claude'), /rows\.count == modes\.count \? rows\[place\] : nil/);
  // Codex's model menu gives each row a class of its own (seen on the real app in Chinese): the
  // rows are found by it, and by the arrow keys the slider's row declares.
  assert.deepEqual(waysOf(codex.selectModelRow)[0], { role: 'AXMenuItem', class: 'ViewToggle-*' });
  assert.deepEqual(waysOf(codex.effortRow)[0], { role: 'AXMenuItem', keys: 'ArrowLeft ArrowRight' });
  assert.match(flowOf('codex'), /find\("selectModelRow"\) \?\? item\(setting\("selectModelItem"\)\)/);
  // After the slider is set, the closed button has to agree only where it speaks the profile's
  // words ("GPT-6.1 Sol 中" does not), and a level that was already there is not reported as changed.
  assert.match(flowOf('codex'), /guard found, shows\(effort: label\) \|\| !worded\(\) else/);
  assert.match(flowOf('codex'), /if moved \{ changed\.append\("effort"\) \}/);
  assert.match(flowOf('codex'), /start\.count == effortOrder\.count/);
  // The orders those places are counted in are the profile's, lowest level first.
  assert.deepEqual(profile('claude').efforts, ['Low', 'Medium', 'High', 'Extra', 'Max']);
  assert.deepEqual(profile('claude').modes.slice(0, 2), ['Auto', 'Manual']);
  assert.deepEqual(profile('codex').effortOrder, Object.keys(profile('codex').effortNames));
  // Codex's Send in another language: the composer's main button once it is renamed (never while it still says what it said empty).
  assert.ok(profile('codex').sendSlot in codex);
  assert.match(driver, /name\(slot\) != idle/);
  // A cloud chat is read by what its parts are where their words are not the profile's: a
  // message's heading by its class, the person's by the bubble after it, the notice by its class.
  const chatRead = profile('codex').chatRead;
  assert.ok(!worded(must(waysOf(chatRead.container)[0])) && waysOf(chatRead.container).slice(1).some(worded));
  for (const part of ['speakerHeading', 'userMessage', 'skip']) for (const way of waysOf(chatRead[part])) {
    assert.ok(!worded(way), `codex.chatRead.${part} does not go by words`);
    for (const field of Object.keys(way)) assert.ok(matchers.includes(field), `codex.chatRead.${part}: ${field}`);
  }
  assert.match(driver, /if let who = speakers\.first\(where: \{ n\.hasPrefix\(\$0\.key\) \}\)[^\n]+\n(?:\s+\/\/[^\n]*\n)+\s+if anyHeading\.contains/);
  assert.match(driver, /userMessage\.contains \{ fits\(after, \$0\) \} \} == true \? "user" : "assistant"/);
  // Claude's chat mode (seen on the real app in Chinese): the messages' group is the one that
  // holds the page's articles, the innermost such; a message's number is the two numbers in its
  // article's name; the assistant's heading sits in its row; the new-chat page goes by its address.
  const claudeRead = profile('claude').chatRead;
  assert.equal(claudeRead.container, 'transcript');
  assert.deepEqual(waysOf(claude.transcript).at(-1), { role: 'AXGroup', subrole: 'AXApplicationGroup', has: 'chatMessage', index: -1 });
  for (const part of ['speakerHeading', 'assistantIn', 'message']) for (const way of waysOf(claudeRead[part])) {
    assert.ok(!worded(way), `claude.chatRead.${part} does not go by words`);
    for (const field of Object.keys(way)) assert.ok(matchers.includes(field), `claude.chatRead.${part}: ${field}`);
  }
  assert.deepEqual(waysOf(claude.chatSendButton)[0], { role: 'AXButton', keys: 'Enter', inside: 'chatPane' });
  assert.deepEqual(waysOf(claude.chatNewPage)[0], { role: 'AXWebArea', url: 'https://claude.ai/new' });
  // Its Stop takes Send's place and declares no shortcut (seen while a reply was streaming): where
  // its name is not the profile's, it is the button in that place whenever that is not Send.
  const claudeSend = profile('claude').chatSend;
  assert.ok(claudeSend.stopSlot in claude && !('stopSlot' in profile('codex').chatSend), 'Codex keeps its voice button there while idle');
  assert.deepEqual(claude.chatSlot, { role: 'AXButton', after: 'chatComposer', index: 0 });
  assert.match(driver, /return findAll\(sendKey\("send"\)\)\.contains \{ CFEqual\(\$0, button\) \} \? \[\] : \[button\]/);
  assert.match(driver, /func answering\(\) -> Bool \{ !stopButtons\(\)\.isEmpty \}/);
  // (Only in a chat showing its messages, on a page that names neither button in the profile's
  // words: seen in English, a new chat's page keeps Dictate in that place.)
  assert.match(driver, /!spoken\(sendKey\("send"\)\), !spoken\(sendKey\("stop"\)\), chatRegion\(\) != nil, let button = find\(sendKey\("stopSlot"\)\)/);
  assert.match(driver, /if let has = l\.has \{/);
  assert.match(driver, /assistantIn\.contains \{ fits\(up, \$0\) \} \} == true \? "assistant" : "user"/);
  assert.match(driver, /if found\.count == 2, let low = found\.min\(\), let high = found\.max\(\), low >= 1 \{ numbers = \(low, high\) \}/);
  // A reply is read with what the page marks in it (seen in Claude's chat mode with web sources):
  // its links by where they point, a cited source's chip marked "citation" by the profile's
  // wordless locator, bold and italic text, and a numbered list's own numbers. A chip wrapped onto
  // the next line stays in its sentence's paragraph; a paragraph that opens in bold is still one.
  assert.deepEqual(claudeRead.citation, { role: 'AXLink', class: 'group/tag' });
  assert.match(driver, /let url = attr\(e, "AXURL"\)[^\n]+\n[^\n]+\n[^\n]+\n[^\n]+\n\s+return "\[\\\(shown\)\]\(\\\(target\)\\\(citation\.contains \{ fits\(e, \$0\) \} \? " \\"citation\\"" : ""\)\)"/);
  assert.match(driver, /sub == "AXStrongStyleGroup" \? "\*\*" : sub == "AXEmphasisStyleGroup" \? "\*" : ""/);
  assert.match(driver, /drawn\.range\(of: #"\^\\d\{1,9\}\[\.\)\]\$"#, options: \.regularExpression\) != nil \? drawn \+ " " : "- "/);
  assert.match(driver, /!\(inline && lastBlock != nil && block != nil && CFEqual\(lastBlock!, block!\)\)/);
  const renderers = fs.readFileSync(path.join(__dirname, '../src/client/js/renderers.ts'), 'utf8');
  assert.match(renderers, /if \(link\.title === 'citation'\) \{ link\.className = 'md-cite'; link\.title = href; \}/);
  // Claude keeps a closed menu's rows on the page, still declaring their numbers (the models' "1"
  // next to the modes' "1"): a row taken by its place is taken from the menu that was opened, the
  // box the page names after its button, and from nowhere when that box is not found.
  assert.deepEqual(claude.menuPopup, { role: 'AXGroup', class: 'group/menu-popup' });
  assert.match(driver, /guard let own = opener\.map\(name\), !own\.isEmpty, let box = findAll\("menuPopup"\)\.first\(where: \{ name\(\$0\) == own \}\) else \{ return \[\] \}/);
  for (const use of [/menuRows\(modelMenu\(\)\)\.filter\(opensSubmenu\)/, /return menuRows\(own\)/, /let rows = menuRows\(modeMenu\(\)\)\n\s+guard let place = modes\.firstIndex/]) assert.match(flowOf('claude'), use);
  // No flow tells a button by the word "Model" any more.
  for (const flow of ['claude', 'codex']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, `../src/server/native/${flow}-desktop.swift`), 'utf8'), /modelPrefix|range\(of: ": "\)/);
});

test('the shared driver turns each desktop\'s accessibility on the way its shell answers, named by the profile', () => {
  const driver = fs.readFileSync(path.join(__dirname, '../src/server/native/ax-driver.swift'), 'utf8');
  const profile = (id: string) => JSON.parse(fs.readFileSync(path.join(__dirname, `../src/server/native/profiles/${id}.json`), 'utf8'));
  // No switch is written into the driver beyond the default; each one set comes from the profile.
  assert.match(driver, /settings\("accessibilitySwitches"\)/);
  assert.equal([...driver.matchAll(/AXUIElementSetAttributeValue\(appRoot/g)].length, 1);
  // Claude is Electron (AXManualAccessibility, the default); Codex's Chrome-based shell answers only AXEnhancedUserInterface.
  assert.equal(profile('claude').accessibilitySwitches, undefined);
  assert.ok(profile('codex').accessibilitySwitches.includes('AXEnhancedUserInterface'));
});

test('Claude\'s question to the person is a card in the chat, answered by picking on the desktop app\'s own card', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ask-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pressed: unknown[] = [];
  let answered = () => {};
  const desktop = fake<ClaudeDesktop>({ check: async () => ({ available: true }), answer: async (meta, question, option) => { pressed.push([meta.title, question, option]); answered(); return { ok: true }; } });
  const bridge = new ClaudeBridge({ home, env: {}, bin: '/bin/claude-test', desktop });
  const file = path.join(home, 'session.jsonl'); fs.writeFileSync(file, '');
  bridge.transcriptPath = () => file;
  const emitter = new EngineEvents(), run = fake<DesktopRun>({ ...streamRun(emitter), meta: fake<DesktopRun['meta']>({ title: 'Chat' }) });
  bridge.runs.set('s1', run);
  const cards: ApprovalRequest[] = [], gone: string[] = [];
  emitter.on('approval', card => cards.push(card)); emitter.on('approval_resolved', data => gone.push(data.id));
  const handle = createStreamHandler('s1', run);
  const ask = (id: string, questions: object[]) => handle({ type: 'assistant', uuid: `m-${id}`, message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
  const result = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] } });
  ask('q1', [{ question: 'Commit now?', header: 'Commit', multiSelect: false, options: [{ label: 'Yes', description: 'commit' }, { label: 'Later', description: 'wait' }] }]);
  assert.deepEqual(at(cards, 0), { id: 'q1', title: 'Commit now?', detail: '', decisions: [{ id: 'option:Yes', label: 'Yes' }, { id: 'option:Later', label: 'Later' }, { id: 'decline', label: '跳过' }] });
  // The desktop records the answer once its card took it; only then is the pick confirmed.
  answered = () => fs.appendFileSync(file, JSON.stringify(result('q1')) + '\n');
  await bridge.decide('q1', 'option:Later');
  assert.deepEqual(at(pressed, 0), ['Chat', 'Commit now?', 'Later']);
  handle(result('q1'));
  assert.deepEqual(gone, ['q1']);
  await assert.rejects(bridge.decide('q1', 'option:Yes'), /已经回答过了/);
  // Skip presses the card's Skip; a form of several questions is the desktop's to answer.
  ask('q2', [{ question: 'Which?', options: [{ label: 'A' }] }]);
  answered = () => fs.appendFileSync(file, JSON.stringify(result('q2')) + '\n');
  await bridge.decide('q2', 'decline');
  assert.deepEqual(at(pressed, 1), ['Chat', 'Which?', null]);
  ask('q3', [{ question: 'One?', options: [{ label: 'A' }] }, { question: 'Two?', options: [{ label: 'B' }] }]);
  assert.deepEqual([at(cards, 2).title, at(cards, 2).detail, at(cards, 2).decisions], ['One?\nTwo?', '这组问题要在 Claude 桌面端回答', ['desktop']], 'answered in the desktop: its button goes there');
  // The desktop could not pick it: said so, nothing claimed.
  desktop.answer = async () => ({ ok: false, error: '没能选中' });
  ask('q4', [{ question: 'Again?', options: [{ label: 'A' }] }]);
  await assert.rejects(bridge.decide('q4', 'option:A'), /没能选中/);
  bridge.dispose(); fs.rmSync(home, { recursive: true });
});

test('Claude: a file from the chat is opened in the desktop, in its own session', async t => {
  const { ClaudeDesktop } = __claude_desktop;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, 'local_abc.json'), JSON.stringify({ sessionId: 'local_abc', cliSessionId: 'cli-1', cwd: '/work', title: '修文件链接' }));
  const calls: string[][] = [];
  const desktop = new ClaudeDesktop({ runner: async (file, args) => { calls.push(args); return args[0] === 'check' ? { ok: true, trusted: true, running: true } : { ok: true, pressed: false }; } });
  desktop.binary = '/bin/helper'; desktop.platform = 'darwin';
  const bridge = new ClaudeBridge({ home, env: {}, bin: null, desktop });
  assert.deepEqual(await bridge.openFile('cli-1', { path: 'lib/a.js:4', absolute: '/work/lib/a.js', relative: 'lib/a.js', label: 'a.js' }), { ok: true, pressed: false });
  assert.deepEqual(at(calls, -1), ['open-file', '修文件链接', 'local_abc', 'lib/a.js:4', '/work/lib/a.js', 'a.js']);
  await assert.rejects(bridge.openFile('missing', { path: 'a.js', absolute: '', relative: '', label: '' }), error => errorField(error, 'status') === 404);
  desktop.runner = async () => ({ ok: false, error: '没能在Claude 桌面版里打开这个会话' });
  await assert.rejects(bridge.openFile('cli-1', { path: 'a.js', absolute: '', relative: '', label: '' }), /没能在Claude 桌面版里打开这个会话/);
});
test('Claude: the header button takes the person to the session in the desktop, a Claude-mode chat in its own mode', async t => {
  const { ClaudeDesktop } = __claude_desktop;
  const { ChatMode } = await import('../src/server/services/desktop-chat.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, 'local_abc.json'), JSON.stringify({ sessionId: 'local_abc', cliSessionId: 'cli-1', cwd: '/work', title: '桌面会话' }));
  const calls: string[][] = [];
  const desktop = new ClaudeDesktop({ runner: async (file, args) => { calls.push(args); return args[0] === 'check' ? { ok: true, trusted: true, running: true } : { ok: true }; } });
  desktop.binary = '/bin/helper'; desktop.platform = 'darwin';
  const bridge = new ClaudeBridge({ home, env: {}, bin: null, desktop });
  await bridge.show('cli-1');
  assert.deepEqual(at(calls, -1), ['show-session', '桌面会话', 'local_abc']);
  await assert.rejects(bridge.show('missing'), error => errorField(error, 'status') === 404);
  const mode = new ChatMode({ automation: desktop, space: 'chat', label: 'Claude 桌面版', list: () => [{ id: 'c-1', title: '云端聊天', updatedAt: 'v1' }] });
  await mode.show('c-1');
  assert.deepEqual(at(calls, -1), ['show-session', '云端聊天', '-', '--space', 'chat']);
  desktop.runner = async () => ({ ok: false, error: '没能在Claude 桌面版里打开这个会话' });
  await assert.rejects(bridge.show('cli-1'), /没能在Claude 桌面版里打开这个会话/);
  await assert.rejects(mode.show('c-1'), error => errorField(error, 'status') === 409);
  fs.rmSync(home, { recursive: true });
});
test('Claude: a wrap-up card\'s buttons are read from the desktop, and a read that found none yet is read again', async t => {
  const { ClaudeDesktop } = __claude_desktop;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'Library/Application Support/Claude/claude-code-sessions/acct/org');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, 'local_abc.json'), JSON.stringify({ sessionId: 'local_abc', cliSessionId: 'cli-1', cwd: '/work', title: '清理' }));
  let drawn: string[] = [], reads = 0;
  const desktop = new ClaudeDesktop({ runner: async (_file, args) => {
    if (args[0] === 'check') return { ok: true, trusted: true, running: true };
    reads++; return { ok: true, actions: drawn };
  } });
  desktop.binary = '/bin/helper'; desktop.platform = 'darwin';
  const bridge = new ClaudeBridge({ home, env: {}, bin: null, desktop });
  const card = { ask: 'Commit these changes?', recap: 'Done.', replies: ['先不提交'] };
  // The desktop draws its buttons a moment after the turn ends: none yet is not the answer for good.
  assert.deepEqual(await bridge.readCard('cli-1', card), { actions: [] });
  // A button that came back without a name was not read (seen when the helper read the names after
  // leaving the chat): it is an error the page tries again, never a blank button, and it is not kept.
  drawn = [''];
  await assert.rejects(bridge.readCard('cli-1', card), withStatus(409));
  drawn = ['Commit changes'];
  assert.deepEqual(await bridge.readCard('cli-1', card), { actions: ['Commit changes'] });
  // Once read, the card's buttons are kept (a drawn card does not change).
  drawn = [];
  assert.deepEqual(await bridge.readCard('cli-1', card), { actions: ['Commit changes'] });
  assert.equal(reads, 3);
  fs.rmSync(home, { recursive: true });
});

test('Claude: reading a wrap-up card does not scroll the desktop\'s page while its window is on screen', () => {
  const driver = fs.readFileSync(path.join(__dirname, '../src/server/native/ax-driver.swift'), 'utf8');
  const flow = fs.readFileSync(path.join(__dirname, '../src/server/native/claude-desktop.swift'), 'utf8');
  // The card flow only names the card as the anchor; the waits scroll it into view, and only off screen.
  const cardFlow = flow.slice(flow.indexOf('case "card", "action":'), flow.indexOf('case "send-now":'));
  assert.ok(cardFlow.length > 0);
  assert.doesNotMatch(cardFlow, /AXScrollToVisible/);
  assert.match(cardFlow, /if let box = found \{ anchor = box \}/);
  assert.match(driver, /func refresh\(\) \{\n  guard !onScreen\(\) else \{ return \}/);
});
test('a wrap-up card keeps the record\'s labels and marks which buttons are the desktop\'s own', async () => {
  const { wrapUpOf } = await import('../src/server/plugins/claude.plugin.js');
  const card = wrapUpOf({ recap: 'Done.', ask: '要开 PR 吗？', actions: [{ action: 'create_pr', label: '开 PR' }, { label: '先不用' }, { action: 'commit', label: '提交' }] });
  assert.equal(card.type, 'summary');
  assert.deepEqual(JSON.parse(String(card.detail)), { recap: 'Done.', ask: '要开 PR 吗？', actions: [{ label: '开 PR', app: 'create_pr' }, { label: '先不用', app: '' }, { label: '提交', app: 'commit' }] });
});

test('a preview the desktop opened in its Browser pane carries the address its result names, in history and live', async () => {
  const { previewOf } = await import('../src/server/plugins/claude.plugin.js');
  const { registerTool } = await import('../src/server/services/tool-catalog.js');
  const { activityOf } = await import('../src/server/core/presentation.js');
  const dispose = registerTool({ match: /^mcp__Claude_Browser__preview_start$/, map: previewOf });
  const output = '{\n  "serverId": "s1",\n  "port": 4102,\n  "name": "fixture",\n  "tabId": "seed"\n}\nServer started on port 4102. Opened tab "seed" at http://localhost:4102. Use tabId "seed" with read_page.';
  try {
    const turns = buildTurns(parseLines([human('u1', 'open it'), use('a1', 't1', 'mcp__Claude_Browser__preview_start', { name: 'fixture' }), result('t1', [{ type: 'text', text: output }])].map(line => JSON.stringify(line)).join('\n')), 's1');
    const step = must(turns[0]?.steps.find(item => item.id === 't1'));
    const activity = activityOf(step);
    assert.equal(activity.kind, 'preview');
    assert.equal(activity.title, 'Started preview · fixture');
    assert.equal(activity.url, 'http://localhost:4102');
    // Live: the address arrives with the result; a failed start has none.
    const source = new EngineEvents(), seen: unknown[] = [];
    bindEvents(source, (type, data) => { if (type === 'activity.upsert') seen.push(data); });
    source.emit('delta', { type: 'tool_call', id: 't2', name: 'mcp__Claude_Browser__preview_start', input: { url: 'https://example.com/docs' } });
    source.emit('delta', { type: 'tool_result', id: 't2', output: 'Opened tab "a" at https://example.com/docs.', isError: false });
    assert.equal(get(seen.at(-1), 'url'), 'https://example.com/docs');
    assert.equal(get(seen.at(-1), 'title'), 'Started preview · https://example.com/docs');
    source.emit('delta', { type: 'tool_call', id: 't3', name: 'mcp__Claude_Browser__preview_start', input: { name: 'web' } });
    source.emit('delta', { type: 'tool_result', id: 't3', output: 'No configuration named web; see http://localhost:1/x', isError: true });
    assert.equal(get(seen.at(-1), 'url'), undefined);
  } finally { dispose(); }
});

test("a session's own temporary folder (scratchpad, task output) is a folder its file links may open", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, '.claude', 'projects', '-Users-me-app');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 's1.jsonl'), '');
  const bridge = new ClaudeBridge({ home, env: {}, bin: null, desktop: fake<ClaudeDesktop>({}), tmpDir: '/tmp' });
  try {
    if (typeof process.getuid === 'function') assert.deepEqual(bridge.fileRoots('s1'), [`/tmp/claude-${process.getuid()}/-Users-me-app/s1`]);
    assert.deepEqual(bridge.fileRoots('missing'), []);
    assert.deepEqual(bridge.fileRoots('../x'), []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a signed-out Claude Code is told the sign-in command that works on this machine', async t => {
  const { loginCommand } = await import('../src/server/claude-bridge.js');
  const { english } = await import('../src/client/js/i18n.js');
  // On the PATH: the plain command. Only the desktop app's own copy: its full path, quoted (it has a space in it).
  assert.equal(loginCommand('/opt/bin/claude', { PATH: '/usr/bin:/opt/bin' }), 'claude auth login');
  assert.equal(loginCommand(null, { PATH: '/usr/bin' }), 'claude auth login');
  const own = '/Users/me/Library/Application Support/Claude/claude-code/2.1.0/abc/claude.app/Contents/MacOS/claude';
  assert.equal(loginCommand(own, { PATH: '/usr/bin:/opt/bin' }), `"${own}" auth login`);
  // The bridge says it where it reports being signed out, and the page says the same in English.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-signin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  try {
    // Windows: a shell script without an extension cannot be spawned; claude.cmd is what an npm
    // install gives there anyway, and authStatus runs it through a shell.
    fs.writeFileSync(bin, process.platform === 'win32' ? '@echo {"loggedIn":false}\r\n' : '#!/bin/sh\necho \'{"loggedIn":false}\'\n', { mode: 0o755 });
    const bridge = new ClaudeBridge({ home: '/nonexistent', env: {}, bin });
    const status = bridge.authStatus();
    assert.equal(status.loggedIn, false);
    assert.equal(status.error, `Claude Code 命令行还没有登录。请在终端运行一次 "${bin}" auth login，然后刷新工作台。`);
    assert.equal(english(status.error), `Claude Code is signed out. Run "${bin}" auth login in a terminal, then refresh.`);
    assert.equal(english('读取不到 Claude Code 的登录信息，请先运行 claude auth login'), 'Claude Code is signed out. Run claude auth login first.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
