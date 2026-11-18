import { test, type TestContext } from 'node:test';
import { readValue } from '../src/server/services/chromium-idb.js';
import { ClaudeChats } from '../src/server/services/claude-chats.js';
import { CodexChatgpt } from '../src/server/services/codex-chatgpt.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import sqlite from 'node:sqlite';
import * as __services_desktop_chat from '../src/server/services/desktop-chat.js';
import * as __core_plugin_host from '../src/server/core/plugin-host.js';
import { at, fake, must, required } from './support.js';
import { get } from '../src/shared/guards.js';
import type { DesktopAutomation, HelperResult } from '../src/server/core/desktop-automation.js';
import type { Engine, EngineEmitter, UnifiedSession } from '../src/shared/contract.js';
// The window helper, given only the run the code under test makes.
type Runner = Pick<DesktopAutomation, 'run'>;

// A raw snappy block made only of literals (what the reader must undo).
function snappy(data: Buffer): Buffer {
  const parts: Buffer[] = [], varint: number[] = []; let n = data.length;
  do { varint.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); n >>>= 7; } while (n);
  parts.push(Buffer.from(varint));
  for (let at = 0; at < data.length; at += 60) { const chunk = data.subarray(at, at + 60); parts.push(Buffer.from([(chunk.length - 1) << 2]), chunk); }
  return Buffer.concat(parts);
}
// An IndexedDB blob as Chromium writes it: Blink header, 0x02 + snappy(Blink header + V8 value).
const blob = (value: unknown) => Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), snappy(Buffer.concat([Buffer.from([0xff, 0x15, 0xfe, 0x00]), v8.serialize(value)]))]);
const tmp = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-spaces-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('IndexedDB values are read from the files alone: compressed or not, any string', () => {
  const value = { a: [1, -2, 3.5, true, null], name: '日语教学 Golden Gate', nested: { at: 'x' } };
  assert.deepEqual(readValue(blob(value)), value);
  assert.deepEqual(readValue(Buffer.concat([Buffer.from([0xff, 0x11]), v8.serialize(value)])), value);
  assert.equal(readValue(Buffer.from('not a value')), null);
});

test("Claude's Claude mode: its Recents and pinned projects from the desktop's saved lists, nothing else", (t) => {
  const home = tmp(t), dir = path.join(home, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob', '1', '00');
  fs.mkdirSync(dir, { recursive: true });
  const chat = (uuid: string, name: string, updated: string, extra: object = {}) => ({ uuid, name, updated_at: updated, is_archived: false, is_temporary: false, project_uuid: null, ...extra });
  fs.writeFileSync(path.join(dir, '7'), blob({ clientState: { queries: [
    { queryKey: ['current_account', 'x'], state: { data: { account: { email_address: 'someone@example.com' } } } },
    { queryKey: ['chat_conversation_list', { orgUuid: 'o' }, 'infinite', { limit: 30 }], state: { data: { pages: [{ data: [chat('c1', 'Older', '2024-01-01T00:00:00Z'), chat('c2', 'Newer', '2026-11-07T00:00:00Z', { project_uuid: 'p2' }), chat('c3', 'Gone', '2026-11-08T00:00:00Z', { is_archived: true })] }] } } },
    { queryKey: ['project_list', { orgUuid: 'o' }, { starred: true }], state: { data: [{ uuid: 'p1', name: 'my-ai', is_starred: true, archived_at: null }] } },
    { queryKey: ['project_list', { orgUuid: 'o' }, { creatorFilter: 'is_creator' }], state: { data: [{ uuid: 'p1', name: 'my-ai', is_starred: true }, { uuid: 'p2', name: 'Research', is_starred: false }, { uuid: 'p3', name: 'Unpinned', is_starred: false }] } },
  ] } }));
  const { chats, projects } = new ClaudeChats({ desktopHome: home }).read();
  assert.deepEqual(chats.map(item => item.title), ['Newer', 'Older']);
  assert.equal(at(chats, 0).projectId, 'p2');
  // Pinned projects, then a project a listed chat is in; an unpinned project with no listed chat is not shown.
  assert.deepEqual(projects.map(item => item.name), ['my-ai', 'Research']);
  assert.doesNotMatch(JSON.stringify({ chats, projects }), /example\.com/);
  assert.deepEqual(new ClaudeChats({ desktopHome: tmp(t) }).read(), { chats: [], projects: [] });
});

test("Codex's ChatGPT mode: Recents from the desktop's catalog, projects in its own order", (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, 'sqlite'));
  const db = new sqlite.DatabaseSync(path.join(home, 'sqlite', 'codex.db'));
  db.exec("CREATE TABLE local_thread_catalog (thread_id TEXT, display_title TEXT, host_id TEXT, source_recency_at REAL, source_updated_at REAL, missing_candidate INTEGER, thread_source TEXT)");
  const add = db.prepare('INSERT INTO local_thread_catalog VALUES (?, ?, ?, ?, ?, ?, ?)');
  add.run('t-local', 'Reply with PONG', 'local', 300, 300, 0, 'user');
  add.run('c-1', '搜索机票', 'chatgpt:acct:user', 200, 200, 0, null);
  add.run('c-gone', 'Missing', 'chatgpt:acct:user', 400, 400, 1, null);
  add.run('g-1', 'Review', 'local', 500, 500, 0, 'guardian_review');
  db.close();
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { L1: { name: 'coding', rootPaths: ['/w/coding'] }, L2: { name: 'network', rootPaths: ['/w/network'] } },
    'electron-owner-atoms:abc': {
      'chatgpt-sidebar-state-v2': { acct: { projects: [{ id: 'g-p-net', name: 'network' }, { id: 'g-p-jp', name: '日语教学' }] } },
      // "network" (L2) is backed by the ChatGPT project, so the order lists it once.
      'unified-sidebar-project-order-v1': ['chatgpt:project:g-p-net', 'codex:project:L1', 'chatgpt:project:g-p-jp'],
    },
  }));
  const { conversations, projects } = new CodexChatgpt({ codexHome: home }).read();
  assert.deepEqual(conversations.map(item => [item.id, item.local]), [['t-local', true], ['c-1', false]]);
  assert.equal(at(conversations, 1).updatedAt, new Date(200 * 1000).toISOString());
  assert.deepEqual(projects, [{ id: 'chatgpt:project:g-p-net', name: 'network', cwd: '' }, { id: 'codex:project:L1', name: 'coding', cwd: '/w/coding' }, { id: 'chatgpt:project:g-p-jp', name: '日语教学', cwd: '' }]);
  assert.deepEqual(new CodexChatgpt({ codexHome: tmp(t) }).read(), { conversations: [], projects: [] });
});

test('a session can be in several modes, placed and ordered as each mode shows it', async () => {
  const { spacesOf, inSpace, isInSpace, organize } = await import('../src/client/js/sidebar.js');
  const spaces = spacesOf({ spaces: [{ id: 'chatgpt', label: 'ChatGPT' }, { id: 'codex', label: 'Codex', default: true }] });
  const thread = { id: 't', title: 't', metadata: { space: ['codex', 'chatgpt'], group: { id: 'p', name: 'coding' }, bySpace: { chatgpt: { group: null, rank: 1 } } } };
  const remote = { id: 'c', title: 'c', metadata: { space: 'chatgpt', group: null, bySpace: { chatgpt: { rank: 0 } } } };
  const plain = { id: 'x', title: 'x', metadata: {} };
  assert.deepEqual(inSpace([thread, remote, plain], spaces, 'codex').map(item => item.id), ['t', 'x']);
  assert.equal(at(at(organize(inSpace([thread, plain], spaces, 'codex')).projects, 0).items, 0).session.id, 't');
  const chatgpt = inSpace([thread, remote, plain], spaces, 'chatgpt');
  assert.deepEqual(chatgpt.map(item => item.id), ['c', 't']); // the mode's own order (rank)
  assert.deepEqual(organize(chatgpt).chats.map(entry => entry.session.id), ['c', 't']); // in Recents there
  assert.equal(thread.metadata.group.id, 'p'); // the session itself is untouched
  const fresh = { id: 'n', title: 'n', metadata: { space: 'chatgpt', group: null } }; // just started from the page
  assert.deepEqual(inSpace([thread, remote, fresh], spaces, 'chatgpt').map(item => item.id), ['n', 'c', 't']);
  assert.ok(isInSpace(thread, spaces, 'chatgpt') && isInSpace(thread, spaces, 'codex') && !isInSpace(remote, spaces, 'codex'));
});

test('a chat read from the desktop window becomes turns, is kept until it changes, and a failure keeps the reason', async () => {
  const { DesktopChatReader, chatTurns, readPage } = __services_desktop_chat;
  const turns = chatTurns('c', [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'one' }, { role: 'assistant', text: 'two' }, { role: 'user', text: 'again' }]);
  assert.deepEqual(turns.map(turn => [turn.userPrompt, turn.status, turn.messages.map(m => `${m.phase}:${m.text}`)]), [['hi', 'completed', ['commentary:one', 'final_answer:two']], ['again', 'unknown', []]]);
  assert.equal(at(turns, 0).statusEvidence, 'desktop_page');
  const calls: unknown[][] = [];
  const automation: Runner = { run: async (args, options) => { calls.push([args, options?.settings]); return { ok: true, messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }], total: 4, read: 2 }; } };
  const reader = new DesktopChatReader(automation);
  const session = fake<UnifiedSession>({ id: 'c', title: 'T', sendBlocked: 'x', metadata: { space: 'chat', contentUnavailable: 'not here' } });
  const page = await readPage(reader, session, 'chat', 'v1', 'reply on desktop');
  assert.deepEqual(calls, [[['read-chat', 'T', 'c'], { space: 'chat' }]]);
  assert.equal(page.turns.length, 1);
  assert.equal(page.session?.sendBlocked, 'reply on desktop');
  assert.equal(page.session?.metadata.contentUnavailable, undefined);
  assert.deepEqual(page.session?.metadata.readFromDesktop, { read: 2, total: 4 });
  await readPage(reader, session, 'chat', 'v1', '');
  assert.equal(calls.length, 1); // kept
  await readPage(reader, session, 'chat', 'v2', '');
  assert.equal(calls.length, 2); // the chat changed
  const failing = new DesktopChatReader({ run: async () => ({ ok: false, error: 'no row' }) });
  const failed = await readPage(failing, session, 'chat', 'v1', '');
  assert.equal(failed.turns.length, 0);
  assert.match(String(failed.session?.metadata.contentUnavailable), /^not here（.*no row）$/);
});

test("a chat mode's new chats and messages go through the desktop window, and the reply counts only once the page shows it done", async () => {
  const { ChatMode } = __services_desktop_chat;
  const listed = [{ id: 'old', title: 'Old chat', updatedAt: '2026-11-01T00:00:00Z' }];
  const calls: unknown[][] = [], pages: HelperResult[] = [];
  // (chat-status moves nothing: the chat is not on the page, and nobody is in the desktop app.)
  const automation: Runner = { run: async (args, options) => { if (args[0] === 'chat-status') return { ok: true, shown: false, running: false, front: false }; calls.push([args[0], args[1], options?.input, options?.settings]); return must(pages.shift(), 'page'); } };
  // What a run said, in order: [event, text] until it ends.
  const events = (emitter: EngineEmitter) => new Promise<Array<[string, unknown]>>(resolve => { const seen: Array<[string, unknown]> = []; for (const name of ['item_completed', 'warning', 'error'] as const) emitter.on(name, (data: unknown) => seen.push([name, get(get(data, 'item'), 'text') ?? get(data, 'message')])); emitter.on('completed', () => resolve(seen)); emitter.on('error', () => resolve(seen)); });
  // Claude: the id is in the page's address; the chat is listed here until the desktop's list has it.
  const claude = new ChatMode({ automation, space: 'chat', label: 'Claude 桌面版', list: () => listed, idFrom: /\/chat\/([0-9a-f-]{36})/, pollMs: 5, awayMs: 0 });
  pages.push({ ok: true, url: 'https://claude.ai/chat/4249168d-ce3c-431b-9b94-5577d7c76e8e', title: 'Pong test', running: false, messages: [{ role: 'user', text: 'Reply PONG' }, { role: 'assistant', text: 'PONG' }] });
  const made = await claude.create({ prompt: 'Reply PONG' }, { id: 'p1', name: 'my-ai' });
  assert.deepEqual(made, { id: '4249168d-ce3c-431b-9b94-5577d7c76e8e', started: true, title: 'Pong test' });
  assert.deepEqual(calls.at(-1), ['chat-new', 'my-ai', 'Reply PONG', { space: 'chat' }]);
  assert.ok(claude.has(made.id) && claude.get(made.id)?.projectId === 'p1');
  assert.deepEqual(await events(claude.observe(made.id)), [['item_completed', 'PONG']]);
  // What the send read is the chat's latest read: opening it does not drive the desktop again.
  assert.equal((await claude.read(fake<UnifiedSession>({ id: made.id, title: 'Pong test', metadata: { contentUnavailable: 'x' } }), 'v9')).turns.length, 1);
  assert.equal(calls.length, 1);
  // A reply still going: the run says so and looks again until the page shows it done.
  pages.push({ ok: true, title: 'Old chat', running: true, messages: [{ role: 'user', text: 'Go on' }] },
    { ok: true, running: true, messages: [{ role: 'user', text: 'Go on' }, { role: 'assistant', text: 'Wor' }] },
    { ok: true, running: false, messages: [{ role: 'user', text: 'Go on' }, { role: 'assistant', text: 'Working on it. Done.' }] });
  const seen = await events(claude.send('old', { prompt: 'Go on' }));
  assert.deepEqual(calls.slice(1).map(call => call[0]), ['chat-send', 'read-chat', 'read-chat']);
  assert.equal(at(seen, 0)[0], 'warning');
  assert.deepEqual(seen.at(-1), ['item_completed', 'Working on it. Done.']);
  // Only what the mode takes: no attachments, no settings of the console's own.
  assert.match(String(at(await events(claude.send('old', { prompt: 'x', attachments: [{ filename: '', path: '', originalname: '', mimetype: '' }] })), 0)[1]), /附件/);
  await assert.rejects(claude.create({ prompt: 'x', model: 'opus' }), /模型和设置要在桌面版里选/);
  // Codex: no address to read, so the id is the entry its list gained (matched by the title).
  const later: Array<{ id: string; title: string; updatedAt: string }> = [];
  const codex = new ChatMode({ automation, space: 'chatgpt', label: 'Codex 桌面版', list: () => later });
  pages.push({ ok: true, url: '', title: 'Reply PONG', running: false, messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'PONG' }] });
  setTimeout(() => later.push({ id: 'c-new', title: 'Reply PONG', updatedAt: '2026-11-12T00:00:00Z' }), 30);
  assert.equal((await codex.create({ prompt: 'hi' })).id, 'c-new');
  assert.deepEqual(at(calls, -1).slice(0, 2), ['chat-new', '-']);
});

test("a mode can narrow the engine's capabilities (flags only)", async () => {
  const { PluginHost } = __core_plugin_host;
  const host = new PluginHost();
  // A plugin written in plain JavaScript can put anything in a mode's flags; only real flags are kept.
  const flags = { models: false, cwd: false, bad: 'yes', 'no-dash': false };
  host.register(fake<Engine>({ ...required, id: 'x', label: 'X', capabilities: { models: true }, spaces: [{ id: 'chat', label: 'Chat', capabilities: flags }, { id: 'code', label: 'Code', default: true }] }));
  const manifest = at(host.manifests(), 0);
  assert.deepEqual(at(manifest.spaces, 0).capabilities, { models: false, cwd: false });
  assert.equal(at(manifest.spaces, 1).capabilities, undefined);
});

test('Claude chat mode exposes a desktop reply and retains the partial reply after stopping', async () => {
  const { ChatMode } = __services_desktop_chat;
  const id = '4249168d-ce3c-431b-9b94-5577d7c76e8e';
  const chat = { id, title: 'Chat', updatedAt: 'v1' };
  const messages = [{ role: 'user', text: 'Keep going' }, { role: 'assistant', text: 'Partial reply' }];
  const calls: string[][] = [];
  const mode = new ChatMode({ space: 'chat', list: () => [chat], automation: { run: async args => {
    calls.push(args);
    return args[0] === 'chat-stop' ? { ok: true, running: false, interrupted: true, messages } : { ok: true, running: true, messages };
  } } });
  const session = fake<UnifiedSession>({ ...chat, metadata: { space: 'chat' } });
  const running = await mode.read(session, 'v1');
  assert.equal(running.session?.isDesktopActive, true);
  assert.equal(running.turns?.at(-1)?.status, 'running');

  const emitter = mode.follow(chat, 'Keep going', { ok: true, running: true, messages });
  const ended = new Promise(resolve => emitter.on('completed', resolve));
  assert.deepEqual(await mode.interrupt(id), { pending: false });
  assert.deepEqual(await ended, { turn: { status: 'interrupted' } });
  assert.deepEqual(calls.at(-1), ['chat-stop', 'Chat', id]);
  const stopped = await mode.read(session, 'v1');
  assert.equal(stopped.session?.isDesktopActive, false);
  assert.equal(stopped.turns?.at(-1)?.status, 'interrupted');
  assert.equal(stopped.turns?.at(-1)?.assistantReply, 'Partial reply');
});

test("a chat mode's reply is followed without moving the desktop under the person, by the chat's id and the name it has now", async () => {
  const { ChatMode } = __services_desktop_chat;
  const id = '75a09041-3f76-4ae0-8827-d3df35768c77', prompt = 'Tell me about worktrees';
  const listed: Array<{ id: string; title: string; updatedAt: string }> = [];
  const done = { ok: true, running: false, messages: [{ role: 'user', text: prompt }, { role: 'assistant', text: 'Here.' }] };
  let status: HelperResult = { ok: true, shown: false, running: false, front: true };
  const calls: string[][] = [];
  const mode = new ChatMode({ space: 'chat', label: 'Claude 桌面版', list: () => listed, idFrom: /\/chat\/([0-9a-f-]{36})/, waitSeconds: 0, pollMs: 5, awayMs: 40, watchVisible: true, automation: { run: async args => {
    calls.push(args);
    if (args[0] === 'chat-status') return status;
    // Sent without waiting: the desktop had not named the chat yet, and nothing of it was read.
    if (args[0] === 'chat-new') return { ok: true, sent: true, running: true, title: '', url: `https://claude.ai/chat/${id}` };
    return args[1] === 'Worktree best practice' ? done : { ok: false, code: 'not_found', error: 'no row' };
  } } });
  const made = await mode.create({ prompt });
  assert.equal(made.id, id);
  const emitter = mode.observe(id), warnings: string[] = [];
  emitter.on('warning', (data: unknown) => warnings.push(String(get(data, 'message'))));
  const ended = new Promise(resolve => emitter.on('completed', resolve));
  const reads = () => calls.filter(call => call[0] === 'read-chat');
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // Opening the chat meanwhile shows the run's own turn: the desktop is not driven for it.
  const opened = await mode.read(fake<UnifiedSession>({ id, title: String(made.title), metadata: { space: 'chat' } }), 'v1');
  assert.deepEqual([opened.session?.status, opened.turns?.length], ['busy', 0]);
  // The person is in the desktop app, on another page: it is left alone, and the run says why.
  await pause(150);
  assert.equal(reads().length, 0);
  assert.match(String(warnings.at(-1)), /^你正在用Claude 桌面版/);
  // They left it: now the chat is brought up, seldom, under the name the desktop has given it since.
  listed.push({ id, title: 'Worktree best practice', updatedAt: 'v2' });
  status = { ok: true, shown: false, running: false, front: false };
  await ended;
  assert.deepEqual(reads(), [['read-chat', 'Worktree best practice', id]]);
  assert.equal((await mode.read(fake<UnifiedSession>({ id, title: 'Worktree best practice', metadata: { space: 'chat' } }), 'v2')).turns?.at(-1)?.assistantReply, 'Here.');

  // A chat that is on the page is read where it is, at once, however recently the desktop was moved.
  calls.length = 0; status = { ok: true, shown: true, running: true, front: true };
  const shown = new ChatMode({ space: 'chat', list: () => listed, pollMs: 5, awayMs: 60000, watchVisible: true, automation: { run: async args => { calls.push(args); return args[0] === 'chat-status' ? status : done; } } });
  const follow = shown.follow(must(listed[0], 'chat'), prompt, { ok: true, sent: true, running: true });
  await new Promise(resolve => follow.on('completed', resolve));
  assert.deepEqual(reads(), [['read-chat', 'Worktree best practice', id]]);

  // One that is elsewhere is looked at less and less often.
  calls.length = 0; status = { ok: true, shown: false, running: false, front: false };
  const away = new ChatMode({ space: 'chat', list: () => listed, pollMs: 5, awayMs: 40, awayMaxMs: 10000, automation: { run: async args => { calls.push(args); return args[0] === 'chat-status' ? status : { ok: true, running: true, messages: [{ role: 'user', text: prompt }] }; } } });
  const going = away.follow(must(listed[0], 'chat'), prompt, { ok: true, sent: true, running: true });
  await pause(300);
  going.emit('interrupt');
  assert.ok(reads().length >= 1 && reads().length <= 3, `looked ${reads().length} times`); // at 40ms, 120ms, 280ms
  assert.ok(calls.filter(call => call[0] === 'chat-status').length > 10);
});
