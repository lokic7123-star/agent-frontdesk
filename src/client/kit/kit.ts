// Agent Frontdesk chat kit: the conversation, sidebar and composer every coding agent shares,
// drawn in the "Claude" style (measured from the Claude desktop app, docs/skins/claude/fidelity.md).
// Every engine's page is drawn with it; an engine only supplies data:
//   sessions  metadata.group { id, name, cwd } (its project; null = none), metadata.parentId, metadata.attention,
//             metadata.desktop { model, effort, permissionMode } (what the next turn will use)
//   turns     userPrompt, userImages, messages, timeline, activities (tools, with plan / images),
//             an activity of kind 'summary' whose detail is { recap, ask, actions } for a question card,
//             an activity of kind 'preview' with a url for the card of a page the desktop opened
// and may still register its own `turn:<id>` / `session-list:<id>` / `activity:<kind>` renderers.
import { renderers, escape, icon, markdown, userImages } from '../js/renderers.js';
import { t, say } from '../js/i18n.js';
import { closest, find, findAll } from '../js/dom.js';
import { get, isBag, list, str } from '../../shared/guards.js';
import type { Activity, Approval, CardAction, DesktopSettings, Look, MediaImage, UnifiedSession, WrapUpCard } from '../../shared/contract.js';
import type { Provider, Renderers, SessionListContext, TurnContext } from '../js/renderers.js';
import type { PageTurn } from '../js/store.js';
import type { SideSession } from '../js/sidebar.js';

type Kind = 'command' | 'task' | 'stop' | 'edit' | 'image' | 'fetch' | 'search' | 'read' | 'preview' | 'tool';
const state: { sessions: SideSession[]; currentId: string; newSettings: () => DesktopSettings | null | undefined; look: Look; canPress: () => boolean; pressAction: (action: CardAction) => Promise<boolean>; readCard: (card: WrapUpCard) => Promise<{ actions: string[] } | { error: string }> } = { sessions: [], currentId: '', newSettings: () => null, look: {}, canPress: () => false, pressAction: async () => false, readCard: async () => ({ error: '' }) };
// Object.entries with the keys kept as the record's own keys.
const entries = <K extends string, V>(record: Partial<Record<K, V>>): Array<[K, V]> => { const out: Array<[K, V]> = []; for (const key in record) { const value = record[key]; if (value !== undefined) out.push([key, value]); } return out; };
const selectById = (id: string): HTMLSelectElement | null => { const element = document.getElementById(id); return element instanceof HTMLSelectElement ? element : null; };
const engineId = () => document.documentElement.dataset.engine || '';
// How the engine's desktop writes a conversation, from its plugin's `look` (plugin-contract.md,
// "对话的样子"); left out, a field reads as the Claude desktop does. The kit never asks which engine.
const look = () => state.look || {};
const lookOf = (provider: { look?: Look | undefined } | null | undefined) => { state.look = provider?.look && typeof provider.look === 'object' ? provider.look : {}; };
const basename = (value: unknown): string => String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
const normPath = (value: unknown): string => {
  const s = String(value || '').replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  return /^[a-z]:\/+$/i.test(s) ? `${s.slice(0, 2)}/` : /^\/+$/.test(s) ? '/' : s.replace(/\/+$/, '');
};
const plural = (count: number, one: string, many: string) => count === 1 ? one : `${count} ${many}`;

// What a tool did, in the desktop's words.
function toolKind(item: Activity): Kind {
  if (item.kind === 'command') return 'command';
  if (item.kind === 'background_task') return 'task';
  if (item.kind === 'stop_task') return 'stop';
  if (item.kind === 'file_change') return 'edit';
  if (item.kind === 'image_view') return 'image';
  if (item.kind === 'preview') return 'preview';
  if (item.kind === 'web_search') return /^Fetched/.test(item.title) ? 'fetch' : 'search';
  if (/^Read ·/.test(item.title)) return 'read';
  if (/^Searched ·/.test(item.title)) return 'search';
  return 'tool';
}
const target = (item: Activity) => basename(item.title.split(' · ').slice(1).join(' · ')) || '';
function rowTitle(item: Activity): string {
  const kind = toolKind(item), name = target(item);
  const running = item.status === 'running';
  // A running command reads as what it is doing (its description), as on the desktop.
  if (kind === 'command') return running ? (item.title && !/^Ran command/.test(item.title) ? item.title : 'Running a command') : 'Ran a command';
  if (kind === 'task' || kind === 'stop') return item.title;
  if (kind === 'read') return `${running ? 'Reading' : 'Read'} ${name || 'a file'}`;
  if (kind === 'edit') return `${running ? 'Editing' : 'Edited'} ${name || 'a file'}`;
  if (kind === 'search') return running ? 'Searching' : `Searched ${name ? `for ${name}` : ''}`.trim();
  if (kind === 'fetch') return running ? 'Fetching' : `Fetched ${item.title.replace(/^Fetched · /, '')}`;
  if (kind === 'image') return `Viewed ${name || 'an image'}`;
  if (kind === 'preview') return running ? 'Starting preview' : 'Started preview';
  if (/^Called · /.test(item.title)) return `${running ? 'Calling' : 'Called'} ${item.title.slice(9)}`;
  return say(item.title);
}
// Codex names what a run of work did without counts ("Ran commands, read files, edited a file").
function codexCaption(items: Activity[]): string {
  const counts: Partial<Record<Kind, number>> = {};
  for (const item of items) counts[toolKind(item)] = (counts[toolKind(item)] || 0) + 1;
  const words: Record<Kind, (n: number) => string> = {
    command: n => n === 1 ? 'ran a command' : 'ran commands', read: () => 'read files', edit: n => n === 1 ? 'edited a file' : 'edited files',
    search: () => 'searched the web', fetch: () => 'searched the web', tool: n => n === 1 ? 'called a tool' : 'called tools',
    image: n => n === 1 ? 'viewed an image' : `viewed ${n} images`, task: n => n === 1 ? 'ran a command' : 'ran commands', stop: () => 'stopped a task',
    preview: n => n === 1 ? 'started a preview' : 'started previews',
  };
  const text = [...new Set(entries(counts).map(([kind, count]) => words[kind](count)))].join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function groupCaption(items: Activity[]): string {
  const running = items.find(item => item.status === 'running');
  if (running) return rowTitle(running);
  if (look().toolCaption === 'kinds') return codexCaption(items);
  // A lone command reads "Ran <program>…", as the desktop shortens it.
  const only = items.length === 1 ? items[0] : undefined;
  if (only && toolKind(only) === 'command' && only.detail && only.status === 'completed') return `Ran ${(only.detail.trim().split(/\s+/)[0] ?? '').slice(0, 32)}…`;
  if (only && only.status === 'completed') return rowTitle(only);
  const counts: Partial<Record<Kind, number>> = {};
  for (const item of items) counts[toolKind(item)] = (counts[toolKind(item)] || 0) + 1;
  // Every kind has its words (a full Record), so a new kind without them fails the type check.
  const words: Record<Kind, (n: number) => string> = {
    command: n => `ran ${plural(n, 'a command', 'commands')}`, read: n => `read ${plural(n, 'a file', 'files')}`,
    edit: n => `edited ${plural(n, 'a file', 'files')}`, search: n => `searched ${plural(n, 'once', 'times')}`,
    fetch: n => `fetched ${plural(n, 'a page', 'pages')}`, tool: n => `used ${plural(n, 'a tool', 'tools')}`,
    task: n => `finished ${plural(n, 'a background task', 'background tasks')}`, stop: n => `stopped ${plural(n, 'task', 'tasks')}`,
    image: n => `viewed ${plural(n, 'an image', 'images')}`, preview: n => `started ${plural(n, 'preview', 'previews')}`,
  };
  // Each kind carries its own outcome note: "Ran a command (1 stopped), finished a background task (1 stopped)".
  const note = (kind: Kind) => {
    const of = (status: string) => items.filter(item => toolKind(item) === kind && item.status === status).length;
    const notes = [of('failed') && `${of('failed')} failed`, of('interrupted') && `${of('interrupted')} stopped`].filter(Boolean);
    return notes.length ? ` (${notes.join(', ')})` : '';
  };
  const text = entries(counts).map(([kind, count]) => words[kind](count) + note(kind)).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const thumbs = (images: MediaImage[]) => {
  if (!images.length) return '';
  const shown = images.slice(-3), more = images.length - shown.length;
  return `<span class="kit-thumbs">${more ? `<span class="kit-more">+${more}</span>` : ''}${shown.map(image => `<img src="${escape(image.url)}" alt="" loading="lazy">`).join('')}</span>`;
};
function toolRow(item: Activity): string {
  const command = item.kind === 'command' && item.detail;
  const images = (item.images || []).map(image => `<a class="kit-shot" href="${escape(image.url)}" target="_blank" rel="noopener"><img src="${escape(image.url)}" alt="${escape(image.alt || t('截图'))}" loading="lazy"></a>`).join('');
  const body = `${command ? `<pre class="kit-command"><span class="kit-prompt">$ </span>${escape(item.detail)}</pre>` : item.detail && item.kind !== 'command' ? `<pre class="kit-input">${escape(item.detail)}</pre>` : ''}${item.output ? `<pre class="kit-output">${escape(item.output)}</pre>` : ''}${images ? `<div class="kit-shots">${images}</div>` : ''}`;
  return `<details class="kit-tool is-${escape(item.status)}" data-disclosure="activity:${escape(item.id)}"><summary><span>${escape(rowTitle(item))}</span>${item.status === 'failed' ? '<span class="kit-failed">failed</span>' : ''}${icon('chevron-down')}</summary>${body || '<p class="kit-empty">No output</p>'}</details>`;
}
// A page the desktop opened in its Browser pane: its name and address, opened with a click (the
// desktop's card, without the thumbnail the desktop captures itself).
function previewCard(item: Activity): string {
  const url = item.url || '';
  let where = url;
  try { where = new URL(url).host || url; } catch { /* shown as written */ }
  const name = item.title.split(' · ').slice(1).join(' · ') || where;
  return `<a class="kit-preview" href="${escape(url)}" target="_blank" rel="noopener"><span class="kit-preview-text"><span class="kit-preview-name">${escape(name)}</span><span class="kit-preview-where">${escape(where)}, opened in Browser</span></span><span class="kit-preview-open">Open</span></a>`;
}
function toolGroup(items: Activity[]): string {
  const running = items.some(item => item.status === 'running');
  const images = items.flatMap(item => item.images || []);
  return `<details class="kit-tools${running ? ' is-running' : ''}" data-disclosure="tools:${escape(items[0]?.id)}"><summary>${running ? ("<span class=\"kit-dots\" aria-label=\"" + t('正在运行') + "\"><i></i><i></i><i></i></span>") : ''}<span class="kit-caption">${escape(groupCaption(items))}</span>${icon('chevron-right')}${thumbs(images)}</summary><div class="kit-tool-card">${items.map(toolRow).join('')}</div></details>`;
}
function planCard(item: Activity, live: boolean): string {
  const steps = item.plan || [], marks: Record<string, string> = { completed: t('已完成'), in_progress: t('进行中'), pending: t('待办') };
  return `<div class="plan-card kit-plan${live ? '' : ' is-settled'}" data-plan="${escape(item.id)}"><ol>${steps.map(step => `<li class="is-${escape(step.status)}"><span class="kit-mark" aria-hidden="true"></span><span>${escape(step.content)}</span><span class="sr-only">${marks[step.status] || ''}</span></li>`).join('')}</ol></div>`;
}
// detail is the desktop's wrap-up as JSON ({ recap, ask, actions }), read field by field.
// The desktop's own buttons (commit, open a PR…) are named by the desktop, not in the record, and
// it draws only those it can run then: with capabilities.cardActions they are read from the desktop
// once per card (cards, by the card's id) and drawn as read; until then the record's names wait,
// off. Without the capability they stay off, under the record's names.
type CardState = { actions: string[] } | { error: string; at?: number } | 'reading';
const cards = new Map<string, CardState>();
const cardItems = new Map<string, Activity>();
function wrapUpCard(item: Activity): string {
  let data: unknown = {};
  try { data = JSON.parse(item.detail || '{}'); } catch {}
  const recap = get(data, 'recap') || item.title, ask = get(data, 'ask'), actions = list(get(data, 'actions'));
  // With no question and no buttons the desktop draws no box: the recap is only the session's
  // status line. Show the card only when the turn leaves the person something to answer.
  if (!ask && !actions.length) return '';
  const entries = actions.map(action => (typeof action === 'string' ? { label: action, app: '' } : { label: String(get(action, 'label') || ''), app: String(get(action, 'app') || '') }));
  const replies = entries.filter(entry => !entry.app).map(entry => entry.label);
  const pressable = state.canPress() && entries.some(entry => entry.app);
  const read = pressable ? cards.get(item.id) : undefined;
  if (pressable) cardItems.set(item.id, item);
  let index = 0;
  const button = (html: string) => html.replace('class="kit-action"', `class="kit-action${index++ ? '' : ' is-primary'}"`);
  let appsDrawn = false;
  const parts = entries.flatMap(entry => {
    // A reply button sends its words as the next message, as on the desktop.
    if (!entry.app) return [button(`<button type="button" class="kit-action" data-kit-reply="${escape(entry.label)}">${escape(entry.label)}</button>`)];
    if (!pressable) return [button(`<button type="button" class="kit-action" disabled title="${t('这个操作只能在桌面版里点')}">${escape(entry.label)}</button>`)];
    // The desktop's buttons go where its first one is in the record, all of them, as read.
    if (appsDrawn) return [];
    appsDrawn = true;
    if (read && read !== 'reading' && 'actions' in read) return read.actions.map((name, at) => button(`<button type="button" class="kit-action" data-kit-action="${escape(name)}" data-kit-index="${at}">${escape(name)}</button>`));
    const why = read && read !== 'reading' && 'error' in read ? read.error : t('正在从桌面版读这张卡片的按钮…');
    return entries.filter(other => other.app).map(other => button(`<button type="button" class="kit-action is-reading" disabled title="${escape(why)}">${escape(other.label)}</button>`));
  });
  return `<div class="kit-wrapup" data-wrapup="${escape(item.id)}" data-ask="${escape(ask || '')}" data-recap="${escape(get(data, 'recap') || '')}" data-replies="${escape(JSON.stringify(replies))}"${pressable && (!read || (read !== 'reading' && 'error' in read)) ? ' data-card-unread' : ''}><p class="kit-recap">${escape(recap)}</p>${ask ? `<p class="kit-ask">${escape(ask)}</p>` : ''}${parts.length ? `<div class="kit-actions">${parts.join('')}</div>` : ''}</div>`;
}
const cardOf = (node: HTMLElement): WrapUpCard => {
  let replies: unknown = [];
  try { replies = JSON.parse(node.dataset['replies'] || '[]'); } catch {}
  return { ask: node.dataset['ask'] ?? '', recap: node.dataset['recap'] ?? '', replies: list(replies).map(item => String(item)) };
};
// Redraw a card in place (history turns are not redrawn on their own).
function redrawCard(id: string) {
  const item = cardItems.get(id), node = document.querySelector<HTMLElement>(`[data-wrapup="${CSS.escape(id)}"]`);
  if (item && node) node.outerHTML = wrapUpCard(item);
}
// The newest turn's card is read from the desktop once it is on the page (older cards keep no
// buttons, as on the desktop).
// A read that failed (the turn was still running, say) or found none of the desktop's buttons yet
// (the desktop draws them a moment after its turn ends) is tried again on its own, CARD_RETRY_MS
// apart, CARD_TRIES times in all; an empty read after that is the desktop's answer (no buttons).
const CARD_RETRY_MS = 10000, CARD_TRIES = 4;
const cardTries = new Map<string, number>();
function readCards() {
  for (const node of findAll(document, '.kit-turn:last-of-type [data-card-unread]')) {
    const id = node.dataset['wrapup'] ?? '';
    const known = cards.get(id);
    if (!id || (known && (known === 'reading' || !('error' in known) || Date.now() - (known.at ?? 0) < CARD_RETRY_MS))) continue;
    cards.set(id, 'reading');
    const tries = (cardTries.get(id) ?? 0) + 1;
    cardTries.set(id, tries);
    void state.readCard(cardOf(node)).then(result => {
      const again = tries < CARD_TRIES && ('error' in result || !result.actions.length);
      if (again) {
        cards.set(id, { error: 'error' in result ? result.error : t('正在从桌面版读这张卡片的按钮…'), at: Date.now() });
        window.setTimeout(readCards, CARD_RETRY_MS + 100);
      } else cards.set(id, 'error' in result ? { ...result, at: Date.now() } : result);
      redrawCard(id);
    });
  }
}
// Times as the desktops write them: Claude "3 minutes ago", Antigravity "2d ago",
// and "Worked for 23m 28s" between a turn's work and its answer (Codex, Antigravity).
const timeOf = (value: unknown): number => value == null || value === '' ? NaN : typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
function elapsed(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number, string]> = [['year', 31536000, 'y'], ['month', 2592000, 'mo'], ['week', 604800, 'w'], ['day', 86400, 'd'], ['hour', 3600, 'h'], ['minute', 60, 'm']];
const longAgo = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
function ago(value: unknown, short = look().ago === 'short'): string {
  const at = timeOf(value);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  for (const [unit, size, letter] of UNITS) {
    if (short && unit === 'week') continue;
    // Rounded, as the desktops do: a day and a half reads "2d ago".
    if (seconds >= size) { const count = Math.round(seconds / size); return short ? `${count}${letter} ago` : longAgo.format(-count, unit); }
  }
  return short ? 'now' : 'just now';
}
const stamp = (value: unknown) => { const at = timeOf(value); return Number.isFinite(at) ? `<time class="kit-time" data-ago="${escape(new Date(at).toISOString())}" datetime="${escape(new Date(at).toISOString())}" title="${escape(new Date(at).toLocaleString())}">${escape(ago(at))}</time>` : ''; };
function turnElapsed(turn: PageTurn, active: boolean): number {
  if (!active && turn.workedMs) return turn.workedMs;
  if (!active && turn.durationMs) return turn.durationMs;
  const start = timeOf(turn.timestamp), end = active ? Date.now() : timeOf(turn.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
}
// Codex's turn diff card: "Edited 3 files", one row per file with its added and removed lines.
interface Change { path: string; added: number; removed: number }
function diffCard(changes: Change[]): string {
  const cwd = normPath(state.sessions.find(item => item.id === state.currentId)?.cwd || '');
  const prefix = cwd ? (cwd.endsWith('/') ? cwd : `${cwd}/`) : '';
  const shown = (path: string) => {
    const clean = normPath(path);
    return prefix && clean.startsWith(prefix) ? clean.slice(prefix.length) : path;
  };
  const row = (change: Change) => `<li><a class="file-link kit-diff-file" href="#" data-file-path="${escape(change.path)}" title="${escape(change.path)}">${escape(shown(change.path))}</a><span class="kit-diff-count">${change.added ? `<ins>+${change.added}</ins>` : ''}${change.removed ? `<del>-${change.removed}</del>` : ''}</span></li>`;
  const title = changes.length === 1 ? `Edited ${basename(changes[0]?.path)}` : `Edited ${changes.length} files`;
  const head = changes.slice(0, 4), rest = changes.slice(4);
  return `<div class="kit-diff"><div class="kit-diff-head">${escape(title)}</div><ul>${head.map(row).join('')}</ul>${rest.length ? `<details class="kit-diff-more" data-disclosure="diff:${escape(changes[0]?.path)}"><summary><span class="when-closed">${escape(rest.length === 1 ? 'Show 1 more file' : `Show ${rest.length} more files`)}</span><span class="when-open">Collapse files</span></summary><ul>${rest.map(row).join('')}</ul></details>` : ''}</div>`;
}
function turnChanges(activities: Activity[]): Change[] {
  const byPath = new Map<string, Change>();
  for (const item of activities) for (const change of item.changes || []) {
    const key = normPath(change.path);
    const entry = byPath.get(key) || { path: change.path, added: 0, removed: 0 };
    entry.added += change.added || 0; entry.removed += change.removed || 0; byPath.set(key, entry);
  }
  return [...byPath.values()];
}
const decisions: Record<string, string> = { accept: t('允许'), decline: t('拒绝'), cancel: t('取消'), desktop: t('回到桌面端') };
// A choice is a known decision ('accept') or the desktop's own option ({ id, label }).
const choiceOf = (decision: Approval['decisions'][number]): { id: string; label: string } => typeof decision === 'string' ? { id: decision, label: decisions[decision] || decision } : { id: String(decision?.id ?? ''), label: say(String(decision?.label ?? '')) };
const approval = (item: Approval) => `<div class="approval"><h3>${escape(say(item.title))}</h3>${item.detail ? `<p>${escape(say(item.detail))}</p>` : ''}<div class="approval-actions">${item.decisions.map(choiceOf).map((choice, index) => `<button class="${choice.id === 'accept' || choice.id === 'desktop' || (!index && typeof item.decisions[0] !== 'string') ? 'primary-button' : 'secondary-button'}" data-approval="${escape(item.id)}" data-decision="${escape(choice.id)}">${escape(choice.label)}</button>`).join('')}</div></div>`;

function renderKitTurn(turn: PageTurn, context: Partial<TurnContext> = {}): string {
  lookOf(context.provider);
  const style = look(), worksAbove = style.worked === 'fold';
  const text = (value: string) => markdown(value);
  const messages = turn.messages || [];
  const activities = (turn.activities || []).filter(item => item.kind !== 'reasoning');
  const byId = new Map(activities.map(item => [item.id, item]));
  const active = ['running', 'reconnecting'].includes(turn.status);
  const plans = activities.filter(item => item.plan?.length), latestPlan = plans.at(-1);
  const parts: string[] = [], seen = new Set<string>(), wrapUps: Activity[] = [];
  // The answer that closes the turn: everything before it is the turn's work.
  const answer = active ? null : messages.filter(item => item.phase === 'final_answer' && item.text).at(-1) || null;
  let answerAt = -1, foldFrom = 0;
  let group: Activity[] = [];
  // A preview's card sits above the run of tools that started it, which still lists it ("started preview").
  const flush = () => { if (group.length) parts.push(...group.filter(item => item.kind === 'preview' && item.url).map(previewCard), toolGroup(group)); group = []; };
  const order = (turn.timeline || []).length ? turn.timeline : [...activities.map(item => ({ kind: 'activity' as const, id: item.id })), ...messages.map(item => ({ kind: 'message' as const, id: item.id }))];
  for (const entry of order) {
    if (entry.kind === 'message') {
      const message = messages.find(item => item.id === entry.id);
      if (!message?.text) continue;
      flush(); seen.add(message.id);
      if (message === answer) answerAt = parts.length;
      parts.push(`<div class="kit-text assistant-message" data-message="${escape(message.id)}">${text(message.text)}</div>`);
    } else if (entry.kind === 'activity') {
      const item = byId.get(entry.id);
      if (!item || item.plan?.length) continue; // The latest plan is drawn once, below.
      if (item.kind === 'summary') { flush(); wrapUps.push(item); continue; }
      // A message the person added while the turn ran sits where it joined, as their bubble.
      if (item.kind === 'user_message') { flush(); parts.push(`<div class="kit-steer"><div class="user-message">${escape(item.title)}</div></div>`); continue; }
      // Session notices (compaction, Claude Code notices) sit between the tool rows as one line.
      if (item.kind === 'notice') {
        flush();
        parts.push(item.detail
          ? `<details class="kit-notice" data-disclosure="notice:${escape(item.id)}"><summary>${escape(item.title)}${icon('chevron-right')}</summary><p>${escape(item.detail)}</p></details>`
          : `<p class="kit-notice">${escape(item.title)}</p>`);
        // Antigravity times (and folds) only the work after a message delivered mid-turn.
        if (item.title === 'Message from System') foldFrom = parts.length;
        continue;
      }
      group.push(item);
    }
  }
  flush();
  for (const message of messages) if (message.text && !seen.has(message.id)) { if (message === answer) answerAt = parts.length; parts.push(`<div class="kit-text assistant-message" data-message="${escape(message.id)}">${text(message.text)}</div>`); }
  // Codex and Antigravity fold the work above the answer under "Worked for …"; while the turn
  // runs Codex heads it with "Working for …", and a stopped turn ends with "You stopped after …".
  if (worksAbove) {
    const took = turnElapsed(turn, active);
    if (active && style.workingLive) parts.unshift(`<p class="kit-worked is-live" data-working-since="${escape(new Date(timeOf(turn.timestamp) || Date.now()).toISOString())}">${took ? `Working for ${elapsed(took)}` : 'Working'}</p>`);
    else if (!active && turn.status === 'interrupted' && style.workingLive) parts.push(`<p class="kit-worked">${took ? `You stopped after ${elapsed(took)}` : 'You stopped'}</p>`);
    else if (!active && answerAt > foldFrom) {
      const work = parts.splice(foldFrom, answerAt - foldFrom);
      parts.splice(foldFrom, 0, `<details class="kit-worked" data-disclosure="worked:${escape(turn.id)}"><summary><span>${took ? `Worked for ${elapsed(took)}` : 'Worked'}</span>${icon('chevron-right')}</summary><div class="kit-worked-body">${work.join('')}</div></details>`);
    } else if (!active && answerAt === foldFrom && foldFrom > 0 && took) parts.splice(foldFrom, 0, `<p class="kit-worked">Worked for ${elapsed(took)}</p>`);
    else if (!active && answerAt === 0 && took && style.workingLive) parts.unshift(`<p class="kit-worked">Worked for ${elapsed(took)}</p>`);
  }
  const changes = style.diffCard && !active ? turnChanges(activities) : [];
  const changed = new Set(changes.map(item => normPath(item.path)).filter(Boolean));
  const artifacts = (turn.artifacts || []).filter(item => { const p = normPath(item.path); return !p || !changed.has(p); });
  const thinking = active && !activities.some(item => item.status === 'running');
  // renderers.ts registers 'artifact' itself, so the fallback is always there.
  const artifact: Renderers['artifact'] = item => (renderers.get(`artifact:${item.kind}`) || renderers.get('artifact') || (() => ''))(item);
  const confirmed = !!turn.statusEvidence || turn.source === 'console';
  // One small character per reply, beside the AI's part of the turn (the 对话头像 setting hides it).
  const speaks = parts.length || active || (turn.approvals || []).length || latestPlan || wrapUps.length || artifacts.length || changes.length || turn.error || ['failed', 'interrupted'].includes(turn.status);
  const lastWrapUp = wrapUps.at(-1);
  const receipt = confirmed && ['failed', 'interrupted'].includes(turn.status) ? `<p class="kit-status">${turn.status === 'failed' ? 'Failed' : 'Interrupted'}</p>` : '';
  return `<article class="turn kit-turn" data-turn="${escape(turn.id)}">
    ${turn.userPrompt || turn.userImages?.length ? `<div class="kit-user">${userImages(turn.userImages)}${turn.userPrompt ? `<div class="user-message">${escape(turn.userPrompt)}</div>` : ''}${style.userTime === false ? '' : `<div class="kit-user-meta">${stamp(turn.timestamp)}</div>`}</div>` : ''}
    ${speaks ? `<div class="kit-reply${active ? ' is-working' : ''}">
    ${context.character ? `<span class="turn-avatar" aria-hidden="true">${context.character(context.provider || {}, { working: active })}</span>` : ''}
    <div class="kit-body">
      ${parts.join('')}
      ${latestPlan ? planCard(latestPlan, active) : ''}
      ${lastWrapUp ? wrapUpCard(lastWrapUp) : ''}
      ${(turn.approvals || []).map(approval).join('')}
      ${thinking ? `<div class="kit-thinking"><span class="kit-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${turn.status === 'reconnecting' ? t('正在重新确认任务状态') : 'Thinking'}</span></div>` : ''}
      ${changes.length ? diffCard(changes) : ''}
      ${artifacts.length ? `<div class="artifact-grid">${artifacts.map(artifact).join('')}</div>` : ''}
      ${turn.warning && active ? `<p class="connection-note">${escape(say(turn.warning))}</p>` : ''}
      ${turn.error && confirmed ? `<p class="turn-error">${escape(say(turn.error))}</p>` : ''}
      ${receipt}
      ${messages.length && !active ? `<div class="kit-turn-actions">${style.replyTime === 'before' ? stamp(turn.completedAt || turn.timestamp) : ''}<button class="icon-button copy-reply" data-copy-turn="${escape(turn.id)}" aria-label="${t('复制回答')}">${icon('copy')}</button>${(style.replyTime || 'after') === 'after' ? stamp(turn.completedAt || turn.timestamp) : ''}</div>` : ''}
    </div>
    </div>` : ''}
  </article>`;
}

// The sidebar is the shared one (js/sidebar.ts); the kit only notes which session is
// open, for the composer's model label and the diff card.
function renderSessions(sessions: SideSession[], { currentId, renderDefault, provider }: SessionListContext): string {
  lookOf(provider);
  state.sessions = sessions; state.currentId = currentId || ''; syncModelLabel();
  return renderDefault();
}

// Below the composer the desktop shows the session's model, effort and permission mode.
const titleCase = (value: unknown) => String(value || '').replace(/^\w/, char => char.toUpperCase());
function modelName(id: unknown): string {
  const key = String(id || '').replace(new RegExp(`^${engineId()}-`), '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const model = document.getElementById('model'), options = model instanceof HTMLSelectElement ? [...model.options] : [];
  const option = options.find(item => item.value && (item.value === id || (item.textContent || '').replace(/[^a-z0-9]/gi, '').toLowerCase() === key));
  return option?.textContent || '';
}
const defaultLabels: Record<string, string> = {}; // each engine's first listed model, shown when a session has no recorded model
// A new chat has no record yet. It starts with whatever the desktop's new-chat page shows, so the
// menus show that when the engine reports it (newSettings) and name no model when it does not:
// a model shown here that the desktop is not on would be sent nowhere and mislead.
const isNew = () => !state.currentId;
const defaultLabel = () => defaultLabels[engineId()] || '';
// The desktop always shows a concrete model and effort, both of which can be changed. Until the
// person picks something themselves, select this session's desktop model and effort so the
// shared effort menu appears and the next turn runs exactly as it would on the desktop.
const auto: { session: string | null; busy: boolean } = { session: null, busy: false };
const showAuto = (select: HTMLSelectElement | null, value: string) => {
  if (!select || select.hidden || select.dataset.picked || select.value === value || ![...select.options].some(item => item.value === value)) return;
  select.dataset.auto = '1';
  try { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); } finally { delete select.dataset.auto; }
};
// Menus the person has not touched (`data-picked`, set by the page) show the desktop's current
// setting and follow it when it changes; such a value is display only and is not sent.
function pickDesktopDefaults(select: HTMLSelectElement, effort: HTMLSelectElement | null, desktop: DesktopSettings): void {
  if (auto.busy) return;
  auto.session = `${engineId()}:${state.currentId || ''}`;
  auto.busy = true;
  try {
    // A desktop model the list does not have is not replaced by another one.
    const name = modelName(desktop.model) || (desktop.model || isNew() ? '' : defaultLabel());
    const option = [...select.options].find(item => item.value && item.textContent === name);
    if (option) showAuto(select, option.value); else if (isNew()) showAuto(select, '');
    if (!select.dataset.picked) showAuto(effort, String(desktop.effort || '').toLowerCase());
    // The permission mode the desktop runs this session with ("default" is the old name of "manual").
    showAuto(selectById('permission'), desktop.permissionMode === 'default' ? 'manual' : String(desktop.permissionMode || ''));
  } finally { auto.busy = false; }
}
// Effort names read as the desktop writes them ("Medium", not "medium").
function titleEfforts(): void {
  for (const option of selectById('effort')?.options || []) {
    const label = option.value === 'xhigh' ? 'Extra' : titleCase(option.value);
    if (option.textContent !== label) option.textContent = label;
  }
}
function syncModelLabel(): void {
  const select = selectById('model'), effort = selectById('effort');
  const button = find(document, '.select-button[data-for="model"]');
  if (!select || !button) return;
  const first = find(select, 'option[value=""]', HTMLOptionElement);
  const session = state.sessions.find(item => item.id === state.currentId);
  // metadata.modelId is an extra no engine writes today, read before metadata.model as it always was.
  const modelId = session?.metadata?.['modelId'];
  const desktop: DesktopSettings = session?.metadata?.desktop || (isNew() ? state.newSettings() || {} : { model: modelId ? String(modelId) : session?.metadata?.model ?? undefined });
  if (first && !first.dataset.original) first.dataset.original = first.textContent;
  // The desktop composer is a single line that grows.
  const prompt = document.getElementById('prompt');
  if (prompt instanceof HTMLTextAreaElement) {
    if (prompt.getAttribute('rows') !== '1') { prompt.setAttribute('rows', '1'); prompt.style.height = 'auto'; prompt.style.height = `${Math.min(200, prompt.scrollHeight)}px`; }
  }
  const name = modelName(desktop.model) || (isNew() ? first?.dataset.original : defaultLabel());
  if (first && name && first.textContent !== name) first.textContent = name;
  delete button.dataset.effort;
  pickDesktopDefaults(select, effort, desktop);
  titleEfforts();
  placeSettings(true);
}
// Model, effort and permission sit in one row under the composer, right-aligned, as on the
// desktop. Their buttons move into that row while the kit is on and back when it is off.
function placeSettings(on: boolean): void {
  const area = find(document, '.composer-area');
  let row = document.getElementById('kit-settings');
  if (on && !row && area) row = area.appendChild(Object.assign(document.createElement('div'), { id: 'kit-settings', className: 'kit-settings' }));
  for (const id of ['model', 'effort', 'permission']) {
    const select = document.getElementById(id), button = find(document, `.select-button[data-for="${id}"]`);
    if (!select || !button) continue;
    if (on && row && button.parentElement !== row) row.append(button);
    if (!on && button.previousElementSibling !== select) select.after(button);
  }
  if (row) row.hidden = !on;
}
// The model menu as the desktop draws it: names only, a check on the current model.
function decorateMenu(menu: HTMLElement): void {
  if (menu.dataset.kit) return;
  // The permission menu lists the real modes only: the desktop's own mode is already selected.
  if (menu.dataset.for === 'permission') { menu.dataset.kit = 'true'; const first = find(menu, '.menu-option'); if (first) first.hidden = true; return; }
  if (menu.dataset.for !== 'model') return;
  menu.dataset.kit = 'true';
  const options = findAll(menu, '.menu-option');
  // The first entry is the shared "default model" choice relabelled with the desktop's model.
  // When that model is also listed by name, show the named one (it carries the check) only.
  const first = options[0]?.querySelector('.menu-label')?.textContent;
  const head = options[0];
  if (head && first && options.slice(1).some(option => option.querySelector('.menu-label')?.textContent === first)) head.hidden = true;
}

export interface KitHost {
  registerRenderer<K extends keyof Renderers>(kind: K, renderer: Renderers[K]): void;
  newSettings?: () => DesktopSettings | null | undefined;
  /** Whether the open chat's engine presses wrap-up app buttons in its desktop (capabilities.cardActions). */
  canPress?: () => boolean;
  /** Press one in the desktop; true once it was pressed (the host reports a failure itself). */
  pressAction?: (action: CardAction) => Promise<boolean>;
  /** Read the desktop's own buttons on a card: their names, in order, or why they could not be read. */
  readCard?: (card: WrapUpCard) => Promise<{ actions: string[] } | { error: string }>;
}
export function setup({ registerRenderer, newSettings, canPress, pressAction, readCard }: KitHost): { sync(): void } {
  if (newSettings) state.newSettings = newSettings;
  if (canPress) state.canPress = canPress;
  if (pressAction) state.pressAction = pressAction;
  if (readCard) state.readCard = readCard;
  // A card drawn on the page is read from the desktop once it is the newest turn's. The page swaps
  // #timeline for each chat it shows (a view is kept per chat), so the conversation around it is watched.
  const conversation = document.getElementById('conversation') ?? document.body;
  new MutationObserver(readCards).observe(conversation, { childList: true, subtree: true });
  registerRenderer('turn:kit', (turn, context) => renderKitTurn(turn, context));
  registerRenderer('session-list:kit', (sessions, context) => renderSessions(sessions, context));
  registerRenderer('activity:summary', item => wrapUpCard(item));
  // Copy a code block's text, or a writing block's markdown.
  document.addEventListener('click', event => {
    const button = closest(event.target, '[data-copy-code]');
    if (!button) return;
    const block = button.closest<HTMLElement>('.kit-code, .md-writing');
    const code = block?.classList.contains('md-writing') ? block.dataset['writingSource'] ?? '' : find(block, 'pre')?.innerText || '';
    navigator.clipboard?.writeText(code).then(() => { button.classList.add('is-copied'); window.setTimeout(() => button.classList.remove('is-copied'), 1200); }).catch(() => {});
  });
  // Relative times and the running "Working for" count keep moving between re-renders.
  setInterval(() => {
    for (const node of findAll(document, '.kit-time[data-ago]')) { const next = ago(node.dataset.ago); if (node.textContent !== next) node.textContent = next; }
    for (const node of findAll(document, '[data-working-since]')) { const took = Date.now() - timeOf(node.dataset.workingSince); if (took > 0) node.textContent = `Working for ${elapsed(took)}`; }
  }, 1000);
  // Wrap-up reply buttons answer the question by sending their words.
  document.addEventListener('click', event => {
    const button = closest(event.target, '[data-kit-reply]');
    const prompt = document.getElementById('prompt'), send = document.getElementById('send');
    if (!button || !(prompt instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement)) return;
    // Fill the composer first: the send button only enables once there is text. If the turn
    // cannot be sent right now (a run is still going), the words wait in the composer.
    prompt.value = button.dataset['kitReply'] ?? '';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    if (!send.disabled) send.click(); else prompt.focus();
  });
  // Wrap-up app buttons are pressed on the desktop's own card, by their place among the desktop's
  // own buttons; the button waits until it has been.
  document.addEventListener('click', event => {
    const button = closest(event.target, '[data-kit-action]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const card = button.closest<HTMLElement>('[data-wrapup]');
    if (!card) return;
    button.disabled = true; button.classList.add('is-pressing');
    void state.pressAction({ ...cardOf(card), index: Number(button.dataset['kitIndex'] ?? 0), label: button.dataset['kitAction'] ?? '' })
      .then(pressed => {
        button.classList.remove('is-pressing');
        if (pressed) { button.classList.add('is-pressed'); return; }
        // What the desktop's card holds may have changed: read it again.
        const id = card.dataset['wrapup'] ?? '';
        cards.delete(id); cardTries.delete(id); redrawCard(id); readCards();
      });
  });
  const select = selectById('model');
  if (select) new MutationObserver(syncModelLabel).observe(select, { childList: true, subtree: true });
  select?.addEventListener('change', syncModelLabel);
  const effortSelect = selectById('effort');
  if (effortSelect) new MutationObserver(titleEfforts).observe(effortSelect, { childList: true });
  titleEfforts();
  new MutationObserver(syncModelLabel).observe(document.documentElement, { attributes: true, attributeFilter: ['data-engine'] });
  addEventListener('hashchange', () => { state.currentId = decodeURIComponent(location.hash.split('/')[1] || ''); syncModelLabel(); });
  new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && node.classList.contains('menu-popover')) decorateMenu(node); }).observe(document.body, { childList: true });
  // { <engine>: Model[] }, read field by field.
  fetch('/api/models').then(response => response.json()).then((models: unknown) => { for (const [id, items] of Object.entries(isBag(models) ? models : {})) defaultLabels[id] = str(get(items, 0, 'name')) || ''; syncModelLabel(); }).catch(() => {});
  return { sync: syncModelLabel };
}
