import { t } from './i18n.js';
import { get, isBag } from '../../shared/guards.js';
import type { SessionGroup, SessionMetadata, Space, TimeValue, UnifiedSession } from '../../shared/contract.js';
import type { StoreLike } from './navigation.js';
// The session sidebar every engine shares: a "项目" section (one folder row per project,
// folded until the person opens it, and remembered after that) and a "最近" section below it
// with every chat, newest first, those in a project included (each marked with its project's
// name), as the Codex and Antigravity desktops list them ("Recents", "Conversations"): a chat
// can be found by when it was last used without knowing its project. A search shows only "最近".
// Engines only supply data:
//   session.metadata.group     { id, name, cwd? }  the session's project; null = no project
//   session.metadata.parentId  the session that started this one (drawn under it)
//   plugin.projects()          [{ id, name, cwd }]  every project in the desktop's own order,
//                              including ones without sessions (optional)
// A session with no `group` field at all falls back to its working folder as its project.
// An engine whose desktop has modes (plugin `spaces`: Claude's "Claude" / "Code", Codex's
// "ChatGPT" / "Codex") gets a switch above the list, and the list shows one mode at a time:
//   session.metadata.space / project.space   which mode it is in (or a list: in each of them);
//                                            none = the default mode
//   session.metadata.bySpace                 { <mode>: { group?, rank? } }: where it sits in that
//                                            mode when the desktop shows it differently there (a
//                                            Codex thread is under its project in "Codex" and in
//                                            Recents in "ChatGPT"); rank orders that mode's list
const basename = (value: unknown): string => String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
export const repoKey = (cwd: unknown): string => {
  const norm = String(cwd || '').replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  const s = /^[a-z]:\/+$/i.test(norm) ? `${norm.slice(0, 2)}/` : /^\/+$/.test(norm) ? '/' : norm.replace(/\/+$/, '');
  return s ? `repo:${s}` : '';
};
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ENTITIES[char] ?? char);
// Date.parse(undefined) is NaN, which reads as 0, as before.
const stamp = (value: TimeValue | null | undefined): number => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value)) || 0;

/** A chat as the sidebar reads it: a session, or the part of one a test or a skin gives. */
export type SideSession = Pick<UnifiedSession, 'id'> & Partial<Pick<UnifiedSession, 'title' | 'cwd' | 'updatedAt'>> & { metadata?: SessionMetadata | undefined };
/** A project the engine lists (plugin.projects()). */
export interface ListedProject { id: string; name?: string; cwd?: string; space?: string | string[] }
/** Anything placed in a mode: a session (metadata.space) or a listed project (space). */
export interface SpaceItem { metadata?: SessionMetadata | undefined; space?: string | string[] | undefined }
export interface SideEntry<S extends SideSession = SideSession> { session: S; children: S[] }
export interface SideProject<S extends SideSession = SideSession> { id: string; name: string; cwd: string; items: Array<SideEntry<S>> }
/** A row of "最近": a chat and the project it is in (null: none). */
export interface RecentEntry<S extends SideSession = SideSession> extends SideEntry<S> { project: { id: string; name: string } | null }

export const PROJECT_ROWS = 5, CHAT_ROWS = 30;
export const SIDEBAR_WIDTH = { min: 200, max: 520 };
export const clampSidebarWidth = (width: number, viewport = Infinity): number => Math.round(Math.min(Math.max(SIDEBAR_WIDTH.min, width), Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, viewport - 360))));

// The modes worth a switch (two or more), the default one, and which one an item is in.
export const spacesOf = (provider: { spaces?: Space[] | undefined } | null | undefined): Space[] => (Array.isArray(provider?.spaces) && provider.spaces.length > 1 ? provider.spaces : []);
export const homeSpace = (spaces: Space[]): string => (spaces.find(item => item.default) || spaces[0])?.id || '';
const spaceList = (item: SpaceItem | null | undefined, spaces: Space[]): string[] => { const own = item?.metadata?.space ?? item?.space; return (Array.isArray(own) ? own.map(String) : own ? [String(own)] : [homeSpace(spaces)]); };
// The mode an item is shown in first (a session open in the page brings its sidebar there).
export const spaceOfItem = (item: SpaceItem | null | undefined, spaces: Space[]): string => (spaces.length ? spaceList(item, spaces)[0] ?? '' : '');
export const isInSpace = (item: SpaceItem | null | undefined, spaces: Space[], space: string): boolean => !spaces.length || spaceList(item, spaces).includes(space);
// The mode shown: the one picked before, while the engine still has it; otherwise the default.
export const shownSpace = (spaces: Space[], picked: string | null | undefined): string => (picked != null && spaces.some(item => item.id === picked) ? picked : homeSpace(spaces));
// The items in a mode, as that mode shows them (bySpace: its project there, its place in the list).
export function inSpace<T extends SpaceItem>(items: T[], spaces: Space[], space: string): T[] {
  if (!spaces.length) return items;
  const shown = items.filter(item => isInSpace(item, spaces, space)).map((item): T => {
    const here = item?.metadata?.bySpace?.[space];
    return here && 'group' in here ? { ...item, metadata: { ...item.metadata, group: here.group } } : item;
  });
  const rank = (item: T) => item?.metadata?.bySpace?.[space]?.rank;
  if (!shown.some(item => typeof rank(item) === 'number')) return shown;
  // An item without a place there (a chat just started from the page, before the desktop lists it) leads.
  return shown.map((item, index) => ({ item, index })).sort((a, b) => (rank(a.item) ?? -Infinity) - (rank(b.item) ?? -Infinity) || a.index - b.index).map(entry => entry.item);
}

// The switch, in the desktop's own order and words (a radio group, as in Claude's "Mode").
export function renderSpaceSwitch(spaces: Space[], current: string, { label = '' } = {}): string {
  if (!spaces.length) return '';
  const shown = spaces.find(item => item.id === current) || spaces[0];
  return `<button type="button" class="space-menu" data-space-menu aria-haspopup="listbox" aria-expanded="false" aria-label="${escape(label || t('模式'))}" title="${escape(label || t('模式'))}"><span class="space-menu-label">${escape(shown?.label)}</span><svg class="space-menu-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg></button>`;
}
// The switch's menu: the desktop's modes in its order, the shown one picked, a mode that cannot
// be read yet with its reason.
export const spaceMenuItems = (spaces: Space[], current: string) => spaces.map(item => ({ value: item.id, label: item.label, selected: item.id === current, ...(item.unavailable ? { description: item.unavailable } : {}) }));

function groupOf(session: SideSession): { id: string; name: string; cwd: string } | null {
  const group = session.metadata?.group;
  if (group === null) return null;
  if (group?.id) return { id: String(group.id), name: String(group.name || basename(group.cwd) || group.id), cwd: group.cwd || '' };
  return session.cwd ? { id: repoKey(session.cwd), name: basename(session.cwd) || session.cwd, cwd: session.cwd } : null;
}

// { projects: [{ id, name, cwd, items: [{ session, children }] }], chats: [{ session, children }],
//   recents: [{ session, children, project }] }
// Projects the engine lists come first, in its order; the rest follow, hand-made groups before
// folders, newest first. Sessions keep the order they were given in (newest first); `recents` is
// every top-level chat in that order, `chats` the ones in no project.
export function organize<S extends SideSession>(sessions: S[] = [], listed: Array<ListedProject | null | undefined> = []): { projects: Array<SideProject<S>>; chats: Array<SideEntry<S>>; recents: Array<RecentEntry<S>> } {
  const ids = new Set(sessions.map(item => item.id));
  const parentOf = (item: S) => { const parent = item.metadata?.parentId; return parent && ids.has(parent) && parent !== item.id ? parent : ''; };
  const isChild = (item: S) => !!parentOf(item);
  const children = new Map<string, S[]>();
  for (const item of sessions) { const parent = parentOf(item); if (!parent) continue; const kids = children.get(parent) || []; children.set(parent, kids); kids.push(item); }
  type Row = SideProject<S> & { listed: boolean };
  const projects = new Map<string, Row>(), chats: Array<SideEntry<S>> = [], recents: Array<RecentEntry<S>> = [];
  for (const project of listed) if (project?.id) projects.set(String(project.id), { id: String(project.id), name: String(project.name || basename(project.cwd) || project.id), cwd: project.cwd || '', listed: true, items: [] });
  for (const session of sessions) {
    if (isChild(session)) continue;
    const entry = { session, children: children.get(session.id) || [] };
    const group = groupOf(session);
    if (!group) { chats.push(entry); recents.push({ ...entry, project: null }); continue; }
    if (!projects.has(group.id)) projects.set(group.id, { ...group, listed: false, items: [] });
    const project = projects.get(group.id);
    if (!project) continue;
    recents.push({ ...entry, project: { id: project.id, name: project.name } });
    if (!project.cwd) project.cwd = group.cwd || session.cwd || '';
    project.items.push(entry);
  }
  const latest = (project: Row) => Math.max(0, ...project.items.map(entry => stamp(entry.session.updatedAt)));
  const manual = (project: Row) => !project.id.startsWith('repo:');
  const all = [...projects.values()];
  const ordered = [...all.filter(project => project.listed), ...all.filter(project => !project.listed).sort((a, b) => (Number(manual(b)) - Number(manual(a))) || (latest(b) - latest(a)))];
  return { projects: ordered.map(({ listed: _listed, ...project }) => project), chats, recents };
}

// Where a new chat can start: every project that has a folder.
export function projectChoices(sessions: SideSession[], listed: ListedProject[]): Array<{ id: string; name: string; cwd: string }> {
  const seen = new Set<string>();
  return organize(sessions, listed).projects.filter(project => project.cwd && !seen.has(repoKey(project.cwd)) && seen.add(repoKey(project.cwd))).map(({ id, name, cwd }) => ({ id, name, cwd }));
}

// Which projects are open and how wide the sidebar is, kept in the browser.
export class SidebarPrefs {
  storage: StoreLike | null | undefined; key = 'desktop-bridge:sidebar:v1';
  open: Set<unknown>; width: number;
  more = new Set<string>(); // "show more" lasts for the visit only
  shown = new Map<string, number>(); // how far "聊天" has been scrolled, per engine (the visit only)
  spaces: Record<string, unknown>; // the mode last shown, per engine
  constructor(storage?: StoreLike | null) {
    this.storage = storage;
    // What this page saved before; read field by field, as anything else may be there.
    let saved: unknown = {};
    try { saved = JSON.parse(storage?.getItem(this.key) || '{}') || {}; } catch {}
    const open = get(saved, 'open'), spaces = get(saved, 'spaces');
    this.open = new Set(Array.isArray(open) ? open : []);
    this.width = Number(get(saved, 'width')) || 0;
    this.spaces = spaces && isBag(spaces) ? { ...spaces } : {};
  }
  space(engine: string): string { const space = this.spaces[engine]; return space ? String(space) : ''; }
  setSpace(engine: string, space: string): void { if (this.spaces[engine] === space) return; this.spaces[engine] = space; this.save(); }
  id(engine: string, project: string): string { return `${engine}\n${project}`; }
  isOpen(engine: string, project: string): boolean { return this.open.has(this.id(engine, project)); }
  toggle(engine: string, project: string): boolean { const id = this.id(engine, project); this.open.has(id) ? this.open.delete(id) : this.open.add(id); this.save(); return this.open.has(id); }
  limit(id: string): number { return this.shown.get(id) || CHAT_ROWS; }
  grow(id: string): void { this.shown.set(id, this.limit(id) + CHAT_ROWS); }
  setWidth(width: number): void { this.width = width; this.save(); }
  save(): void { try { this.storage?.setItem(this.key, JSON.stringify({ open: [...this.open], width: this.width, spaces: this.spaces })); } catch {} }
}

const FOLDER = '<svg class="side-folder is-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><svg class="side-folder is-open" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';

// The disclosure mark before a project's folder: it turns as the project opens.
const CHEVRON = '<svg class="side-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';

const PLUS = '<svg class="side-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

// The list's markup. `status(session)` → { running, unread, draft }; `time(session)` → short text.
// `newChat`: the engine can start a chat in a folder, so each project with one gets a "+" (shown
// on hover, like the desktop apps) that starts a new chat there; 'any': in every project (a mode
// whose projects are not folders, as Claude's and ChatGPT's chat projects).
// `space`: the mode shown (only for remembering how far its "最近" list has grown).
export interface SidebarOptions<S extends SideSession> { projects?: ListedProject[]; engineId?: string; space?: string; currentId?: string; query?: string; status?: (session: S) => Partial<{ running: boolean; unread: boolean; draft: boolean }> | null | undefined; time?: (session: S) => string; prefs?: SidebarPrefs; newChat?: boolean | 'any' }
export function renderSidebar<S extends SideSession>(sessions: S[], { projects: listed = [], engineId = '', space = '', currentId = '', query = '', status = () => ({}), time = () => '', prefs = new SidebarPrefs(null), newChat = false }: SidebarOptions<S> = {}): string {
  const tree = organize(sessions, listed);
  const row = (session: S, child = false, project: RecentEntry['project'] = null) => {
    const flags = status(session) || {};
    const unread = !flags.running && !!flags.unread;
    const mark = flags.running ? ("<span class=\"side-dot is-running\" aria-label=\"" + t('正在运行') + "\"></span>")
      : unread ? ("<span class=\"side-dot is-attention\" aria-label=\"" + t('需要查看') + "\"></span>")
      : `<time class="side-time">${escape(time(session))}</time>`;
    return `<button type="button" class="session-row side-row${child ? ' is-child' : ''}${flags.running ? ' is-running' : ''}${unread ? ' is-unread' : ''}" data-session="${escape(session.id)}" aria-current="${currentId === session.id}" title="${escape(session.title || '')}"><span class="session-name">${escape(session.title || t('未命名聊天'))}</span>${project ? `<span class="side-project-tag" title="${escape(project.name)}">${escape(project.name)}</span>` : ''}${flags.draft ? ("<span class=\"draft-label\">" + t('草稿') + "</span>") : ''}${mark}</button>`;
  };
  const holds = (entry: SideEntry<S>) => entry.session.id === currentId || entry.children.some(kid => kid.id === currentId);
  // A long list shows its newest rows and a "show more" line; the open session always stays in view.
  const rows = (entries: Array<SideEntry<S>>, limit: number, moreId: string) => {
    const all = query || prefs.more.has(moreId) || entries.length <= limit;
    const shown = all ? entries : entries.filter((entry, index) => index < limit || holds(entry));
    const html = shown.map(entry => row(entry.session) + entry.children.map(kid => row(kid, true)).join('')).join('');
    return html + (entries.length > limit && !query ? `<button type="button" class="side-more" data-side-more="${escape(moreId)}">${all ? t('收起') : `${t('显示更多')} (${entries.length - shown.length})`}</button>` : '');
  };
  // "最近" is one long list: it grows as its end scrolls into view (the page watches the sentinel).
  // It reaches down to the open chat only when that chat is in no project (one in a project is
  // in view under it already).
  const recents = (entries: Array<RecentEntry<S>>) => {
    const id = prefs.id(engineId, space ? `\0${space}` : ''), limit = query ? entries.length : Math.max(prefs.limit(id), entries.findIndex(entry => !entry.project && holds(entry)) + 1);
    return entries.slice(0, limit).map(entry => row(entry.session, false, entry.project) + entry.children.map(kid => row(kid, true)).join('')).join('') + (entries.length > limit ? `<div class="side-sentinel" data-side-sentinel="${escape(id)}" aria-hidden="true"></div>` : '');
  };
  const project = (item: SideProject<S>) => {
    const open = !!query || prefs.isOpen(engineId, item.id);
    const plus = newChat && (item.cwd || newChat === 'any') ? `<button type="button" class="side-project-new" data-project-new="${escape(item.id)}" data-cwd="${escape(item.cwd)}" title="${escape(t('在「{name}」里新建聊天', { name: item.name }))}" aria-label="${escape(t('在「{name}」里新建聊天', { name: item.name }))}">${PLUS}</button>` : '';
    return `<section class="side-project${open ? ' is-open' : ''}${item.items.some(holds) ? ' has-current' : ''}${plus ? ' can-new' : ''}" data-project="${escape(item.id)}"><div class="side-project-bar"><button type="button" class="side-project-head" data-project-toggle="${escape(item.id)}" aria-expanded="${open}" title="${escape(item.cwd || item.name)}">${CHEVRON}${FOLDER}<span class="side-label">${escape(item.name)}</span></button>${plus}</div>${open ? `<div class="side-project-rows">${item.items.length ? rows(item.items, PROJECT_ROWS, prefs.id(engineId, item.id)) : ("<p class=\"side-empty-row\">" + t('还没有聊天') + "</p>")}</div>` : ''}</section>`;
  };
  return `${tree.projects.length && !query ? `<div class="side-section" data-side-section="projects"><h2 class="side-heading">${t('项目')}</h2>${tree.projects.map(project).join('')}</div>` : ''}${tree.recents.length ? `<div class="side-section" data-side-section="recents"><h2 class="side-heading">${t('最近')}</h2>${recents(tree.recents)}</div>` : ''}`;
}
