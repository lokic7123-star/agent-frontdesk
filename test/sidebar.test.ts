import { test } from 'node:test';
import { CodexBridge } from '../src/server/codex-bridge.js';
import { CodexProjects } from '../src/server/services/codex-projects.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath as __fileURLToPath } from 'node:url';
const __dirname = __fileURLToPath(new URL('.', import.meta.url));
import { at, must } from './support.js';
import { get } from '../src/shared/guards.js';

const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: unknown) => data.set(key, String(value)) }; };
const session = (id: string, extra: object = {}) => ({ id, title: id, updatedAt: '2026-01-01T00:00:00Z', cwd: '', metadata: {}, ...extra });

test('sidebar puts sessions under their project, projectless ones under chats, children under parents', async () => {
  const { organize, projectChoices, repoKey } = await import('../src/client/js/sidebar.js');
  const sessions = [
    session('a', { cwd: '/w/app', metadata: { group: { id: 'p1', name: 'App' } } }),
    session('kid', { cwd: '/w/app', metadata: { group: { id: 'p1', name: 'App' }, parentId: 'a' } }),
    session('b', { cwd: '/tmp/2026/slug', metadata: { group: null } }),
    session('c', { cwd: '/w/lib' }), // no group field: falls back to its folder
    session('d'),
  ];
  const tree = organize(sessions, [{ id: 'empty', name: 'Empty', cwd: '/w/empty' }, { id: 'p1', name: 'App', cwd: '/w/app' }]);
  assert.deepEqual(tree.projects.map(item => [item.id, item.items.length]), [['empty', 0], ['p1', 1], ['repo:/w/lib', 1]]);
  assert.deepEqual(at(at(tree.projects, 1).items, 0).children.map(item => item.id), ['kid']);
  assert.deepEqual(tree.chats.map(item => item.session.id), ['b', 'd']);
  assert.deepEqual(projectChoices(sessions, []).map(item => item.cwd), ['/w/app', '/w/lib']);
  const winTree = organize([session('w1', { cwd: 'd:\\Work\\App' }), session('w2', { cwd: 'D:\\Work\\App\\' })]);
  assert.deepEqual(winTree.projects.map(item => [item.id, item.name, item.items.length]), [['repo:d:/Work/App', 'App', 2]]);
  assert.equal(repoKey('D:/Work/App/'), repoKey('d:\\Work\\App\\'));
  assert.equal(repoKey('C:\\'), 'repo:c:/');
});

test('projects start folded, remember being opened, and long lists fold behind "show more"', async () => {
  const { renderSidebar, SidebarPrefs, PROJECT_ROWS, clampSidebarWidth } = await import('../src/client/js/sidebar.js');
  const store = storage(), prefs = new SidebarPrefs(store);
  const sessions = Array.from({ length: PROJECT_ROWS + 3 }, (_, index) => session(`s${index}`, { title: `<b>${index}</b>`, metadata: { group: { id: 'p', name: 'Proj' } } }));
  const options = { engineId: 'x', currentId: `s${PROJECT_ROWS + 2}`, prefs };
  const projectPart = (html: string) => html.split('data-side-section="recents"')[0] ?? '';
  let html = renderSidebar(sessions, options);
  assert.match(html, /aria-expanded="false"/); assert.doesNotMatch(projectPart(html), /data-session=/); assert.match(html, /has-current/);
  prefs.toggle('x', 'p');
  html = renderSidebar(sessions, { ...options, prefs: new SidebarPrefs(store) }); // a later visit
  assert.equal(must(projectPart(html).match(/data-session=/g)).length, PROJECT_ROWS + 1); // newest rows + the open chat
  assert.match(html, /显示更多 \(2\)/); assert.doesNotMatch(html, /<b>/);
  assert.equal(must(renderSidebar(sessions, { ...options, query: 's' }).match(/data-session=/g)).length, sessions.length);
  assert.equal(new SidebarPrefs(store).isOpen('other', 'p'), false);
  assert.equal(clampSidebarWidth(50), 200); assert.equal(clampSidebarWidth(900, 1400), 520);
});

test('"最近" lists every chat newest first, project ones tagged; a search shows only it', async () => {
  const { organize, renderSidebar, SidebarPrefs, CHAT_ROWS } = await import('../src/client/js/sidebar.js');
  const sessions = [
    session('new', { metadata: { group: { id: 'p', name: 'Proj' } } }),
    session('loose', { metadata: { group: null } }),
    session('kid', { metadata: { group: { id: 'p', name: 'Proj' }, parentId: 'new' } }),
    session('old', { cwd: '/w/lib' }),
  ];
  const tree = organize(sessions, []);
  assert.deepEqual(tree.recents.map(item => [item.session.id, item.project?.name ?? null]), [['new', 'Proj'], ['loose', null], ['old', 'lib']]);
  assert.deepEqual(at(tree.recents, 0).children.map(item => item.id), ['kid']);
  const html = renderSidebar(sessions, { engineId: 'x', prefs: new SidebarPrefs(null) });
  assert.match(html, /data-side-section="projects"/); assert.match(html, /最近/);
  assert.match(html, /data-session="new"[^]*?side-project-tag[^>]*>Proj</);
  assert.doesNotMatch(renderSidebar(sessions, { engineId: 'x', query: 'o', prefs: new SidebarPrefs(null) }), /data-side-section="projects"/);
  // An old chat in a project does not pull the long list down to it; a loose one does.
  const many = Array.from({ length: CHAT_ROWS + 5 }, (_, index) => session(`s${index}`, { metadata: { group: index === CHAT_ROWS + 4 ? null : { id: 'p', name: 'P' } } }));
  const recentRows = (currentId: string) => must((renderSidebar(many, { engineId: 'x', currentId, prefs: new SidebarPrefs(null) }).split('data-side-section="recents"')[1] ?? '').match(/data-session=/g)).length;
  assert.equal(recentRows(`s${CHAT_ROWS + 3}`), CHAT_ROWS);
  assert.equal(recentRows(`s${CHAT_ROWS + 4}`), CHAT_ROWS + 5);
});

test('Codex threads resolve to the desktop project, a project root, or no project', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
    'app-server-project-id-by-legacy-project-id-by-host': { local: { old1: 'P1', old2: 'P2' } },
    'thread-project-assignments': { t1: { projectKind: 'local', projectId: 'old2' }, gone: { projectId: 'deleted' } },
    'projectless-thread-ids': ['t3'], 'project-order': ['old2', 'old1'],
  }));
  const index = new CodexProjects({ codexHome: home }).index([
    { id: 'P1', name: 'one', position: 0, roots: [{ path: '/w/one' }] },
    { id: 'P2', name: 'two', position: 1, roots: [{ path: '/w/two' }, { path: '/w/one' }] },
    { id: 'P3', name: 'new', position: 2, roots: [{ path: '/w/new/' }] },
  ]);
  assert.deepEqual(index.projects.map(item => item.name), ['new', 'two', 'one']);
  assert.equal(index.resolve({ id: 't1', cwd: '/w/one' })?.name, 'two'); // assigned by hand
  assert.equal(index.resolve({ id: 't2', cwd: '/w/one/src' })?.name, 'one'); // by folder
  assert.equal(index.resolve({ id: 't3', cwd: '/w/one' }), null); // marked projectless
  assert.equal(index.resolve({ id: 'gone', cwd: '/elsewhere/2026/new-chat' }), null);
  assert.equal(index.resolve({ id: 't5', projectId: 'P3', cwd: '/w/one' })?.name, 'new'); // the app-server's own field wins
  assert.equal(new CodexProjects({ codexHome: path.join(home, 'missing') }).index([]).resolve({ id: 'x', cwd: '/w' }), null);
});

test('Codex lists every page of threads once, each with its project', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bridge = new CodexBridge({ codexBin: null, codexHome: home }); bridge.isReady = true;
  const calls: Array<[string, unknown]> = [];
  bridge.send = async (method, params) => {
    calls.push([method, get(params, 'cursor') || null]);
    if (method === 'project/list') return { result: { data: [{ id: 'P', name: 'proj', position: 0, roots: [{ path: '/w/proj' }] }] } };
    if (!get(params, 'cursor')) return { result: { data: [{ id: 'a', name: 'A', cwd: '/w/proj' }, { id: 'b', preview: 'first line\nsecond', cwd: '/docs/2026-01-01/new-chat' }], nextCursor: 'next' } };
    return { result: { data: [{ id: 'a', name: 'A', cwd: '/w/proj' }, { id: 'c', name: 'C', cwd: '/w/proj/sub', parentThreadId: 'a' }] } };
  };
  const sessions = await bridge.listThreads();
  assert.deepEqual(sessions.map(item => [item.id, item.title, item.metadata.group?.name ?? null]), [['a', 'A', 'proj'], ['b', 'first line', null], ['c', 'C', 'proj']]);
  assert.equal(at(sessions, 2).metadata.parentId, 'a');
  assert.deepEqual(calls.filter(([method]) => method === 'thread/list').map(([, cursor]) => cursor), [null, 'next']);
  assert.deepEqual(await bridge.listProjects(), [{ id: 'P', name: 'proj', cwd: '/w/proj' }]);
});

test('chats grow as the list is scrolled; the corner avatar is the same for the same seed', async () => {
  const { renderSidebar, SidebarPrefs, CHAT_ROWS } = await import('../src/client/js/sidebar.js');
  const { avatarSvg } = await import('../src/client/js/avatar.js');
  const prefs = new SidebarPrefs(storage());
  const sessions = Array.from({ length: CHAT_ROWS * 2 + 5 }, (_, index) => session(`c${index}`, { metadata: { group: null } }));
  const count = (html: string) => must(html.match(/data-session=/g)).length;
  let html = renderSidebar(sessions, { engineId: 'x', prefs });
  assert.equal(count(html), CHAT_ROWS); assert.match(html, /data-side-sentinel/);
  prefs.grow(prefs.id('x', '')); assert.equal(count(renderSidebar(sessions, { engineId: 'x', prefs })), CHAT_ROWS * 2);
  prefs.grow(prefs.id('x', '')); html = renderSidebar(sessions, { engineId: 'x', prefs });
  assert.equal(count(html), sessions.length); assert.doesNotMatch(html, /data-side-sentinel/);
  // The open chat is always in the list, however old it is.
  assert.equal(count(renderSidebar(sessions, { engineId: 'y', currentId: `c${CHAT_ROWS + 3}`, prefs })), CHAT_ROWS + 4);
  assert.equal(avatarSvg('seed'), avatarSvg('seed')); assert.notEqual(avatarSvg('seed'), avatarSvg('other'));
  assert.match(avatarSvg(''), /^<svg /); assert.doesNotMatch(avatarSvg('<x>'), /<x>|NaN|undefined/);
});

test('every label the page draws has an English entry (the engine-onboarding prompt aside)', async () => {
  const { untranslated, t } = await import('../src/client/js/i18n.js');
  const root = path.join(__dirname, '..'), keys = new Set<string>();
  // Every page source, whatever its extension (.js, .mjs, .ts), except the dictionary itself and the static files.
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? (item.name === 'public' ? [] : sources(path.join(dir, item.name))) : /\.(m?js|ts)$/.test(item.name) && !/^i18n\./.test(item.name) && !item.name.endsWith('.d.ts') ? [path.join(dir, item.name)] : []);
  const pageFiles = sources(path.join(root, 'src/client'));
  assert.ok(pageFiles.length >= 14, 'the page sources are found');
  for (const file of pageFiles) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(must(match[1]).replace(/\\(.)/g, '$1'));
  }
  const html = fs.readFileSync(path.join(root, 'src/client/index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  for (const match of html.matchAll(/(?:title|aria-label|placeholder)="([^"]*[\u4e00-\u9fff][^"]*)"/g)) keys.add(must(match[1]));
  for (const match of html.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)</g)) keys.add(must(match[1]).trim());
  assert.ok(keys.size > 200);
  assert.deepEqual(untranslated([...keys]), []);
  assert.equal(t('新建聊天'), '新建聊天'); assert.equal(t('· 第 {line} 行', { line: 7 }), '· 第 7 行');
});

test('what the server reports reads naturally in English, names and reasons included', async () => {
  const { english, reportTexts } = await import('../src/client/js/i18n.js');
  assert.equal(english('没有正在执行的任务'), 'Nothing is running');
  assert.equal(english('允许 Claude 使用 Bash？'), 'Allow Claude to use Bash?');
  assert.equal(english('每周 · Opus'), 'Weekly · Opus');
  assert.match(english('这一轮没法插进去（连不上 Codex 桌面版），消息已排队'), /^Couldn't reach the current turn \(Can't reach Codex's desktop app\), so your message is queued$/);
  assert.match(english('暂时无法读取额度：timeout'), /right now: timeout$/);
  assert.equal(english('some engine text'), 'some engine text'); assert.equal(english(''), '');
  assert.equal(english('应用没有在运行'), 'The app is not running');
  assert.equal(english('没有找到输入框（profile 的 composer）'), 'Could not find the message box (composer in profile)');
  assert.equal(english('输入框填不进文字'), 'Could not enter text into the message box');
  assert.equal(english('没有找到停止控件，也按不到 Esc'), 'Could not find the stop button or press Esc');
  assert.equal(english('这个动作（send）的 Windows 支持还没写好'), 'Windows support for "send" is not implemented yet');
  assert.equal(english('profile 里没有 send 的认法'), 'No selector for send in the profile');
  // Every text the server or an adapter can report has an entry (prompts sent to the AI aside).
  const root = path.join(__dirname, '..'), known = new Set(reportTexts()), missing: string[] = [];
  const toAi = /^(请查看并分析附件|用户在工作台拒绝了这个操作|（图片或附件）|（图片）|你发送的图片|新建聊天|新会话|Antigravity 会话|模型|其他|截图|5 小时|每周)$/;
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? (item.name === 'bin' || item.name === 'obj' ? [] : walk(path.join(dir, item.name))) : /\.(js|ts|swift|cs)$/.test(item.name) && !item.name.endsWith('.d.ts') ? [path.join(dir, item.name)] : []);
  const serverFiles = walk(path.join(root, 'src/server'));
  assert.ok(serverFiles.some(file => /server\.[jt]s$/.test(file)) && serverFiles.some(file => file.endsWith('Program.cs')) && serverFiles.length >= 35, 'the server sources are found');
  for (const file of serverFiles) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line) || /console\.(log|error)/.test(line)) continue;
      for (const match of line.replace(/\s\/\/\s.*$/, '').matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
        const text = match[1] ?? match[2] ?? '';
        if (/[\u4e00-\u9fff]/.test(text) && !toAi.test(text) && !known.has(text) && english(text) === text) missing.push(`${path.basename(file)}: ${text}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('a project with a folder gets a "+" for a new chat there, only when the engine can start one in a folder', async () => {
  const { renderSidebar, SidebarPrefs } = await import('../src/client/js/sidebar.js');
  const sessions = [session('a', { cwd: '/w/app' }), session('b', { metadata: { group: { id: 'g', name: 'Hand-made' } } })];
  const html = renderSidebar(sessions, { engineId: 'x', prefs: new SidebarPrefs(null), newChat: true });
  assert.equal(must(html.match(/data-project-new=/g)).length, 1);
  assert.match(html, /data-project-new="repo:\/w\/app" data-cwd="\/w\/app"/);
  assert.doesNotMatch(renderSidebar(sessions, { engineId: 'x', prefs: new SidebarPrefs(null) }), /data-project-new/);
});

test('a desktop with modes shows one mode at a time: its projects, its chats, remembered per engine', async () => {
  const { spacesOf, shownSpace, inSpace, spaceOfItem, renderSpaceSwitch, spaceMenuItems, SidebarPrefs, renderSidebar } = await import('../src/client/js/sidebar.js');
  const spaces = spacesOf({ spaces: [{ id: 'chat', label: 'Claude', unavailable: 'not yet' }, { id: 'code', label: 'Code', default: true }] });
  assert.equal(spacesOf({ spaces: [{ id: 'only', label: 'Only' }] }).length, 0); // one mode is no switch
  assert.equal(shownSpace(spaces, ''), 'code');
  assert.equal(shownSpace(spaces, 'gone'), 'code');
  assert.equal(shownSpace(spaces, 'chat'), 'chat');
  // A session or project without a mode is in the default one.
  const sessions = [session('a', { cwd: '/w/app' }), session('b', { metadata: { space: 'chat', group: { id: 'p9', name: 'Research' } } })];
  assert.deepEqual(inSpace(sessions, spaces, 'code').map(item => item.id), ['a']);
  assert.deepEqual(inSpace(sessions, spaces, 'chat').map(item => item.id), ['b']);
  assert.deepEqual(inSpace([{ id: 'p1' }, { id: 'p9', space: 'chat' }], spaces, 'chat').map(item => item.id), ['p9']);
  assert.equal(spaceOfItem(sessions[1], spaces), 'chat');
  assert.equal(spaceOfItem(sessions[1], []), '');
  const chat = renderSidebar(inSpace(sessions, spaces, 'chat'), { engineId: 'x', space: 'chat', prefs: new SidebarPrefs(null) });
  assert.match(chat, /Research/); assert.doesNotMatch(chat, /data-session="a"/);
  // The switch: a menu button naming the shown mode; its menu has the desktop's words and order,
  // the shown one picked, the reason on one not read yet.
  const html = renderSpaceSwitch(spaces, 'code');
  assert.match(html, /data-space-menu aria-haspopup="listbox"/);
  assert.match(html, /class="space-menu-label">Code</);
  assert.deepEqual(spaceMenuItems(spaces, 'code'), [{ value: 'chat', label: 'Claude', selected: false, description: 'not yet' }, { value: 'code', label: 'Code', selected: true }]);
  assert.equal(renderSpaceSwitch([], ''), '');
  const store = storage(), prefs = new SidebarPrefs(store);
  prefs.setSpace('claude', 'chat');
  assert.equal(new SidebarPrefs(store).space('claude'), 'chat');
  assert.equal(new SidebarPrefs(store).space('codex'), '');
});
