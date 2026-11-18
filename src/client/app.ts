// The stylesheets, in the cascade order the page has always had (fonts and KaTeX first).
import '@fontsource/inter/latin.css';
import 'katex/dist/katex.min.css';
import './style.css';
import './kit/kit.css';
import './js/wco.js';
import { t, say, locale, language, translateDocument } from './js/i18n.js';
import { DraftBook, ReadMarkers, viewKey, isViewOf, preferredSession, quotaLabel } from './js/navigation.js';
import { createStore } from './js/store.js';
import { request, answer, connect, sessionUrl, type RequestOptions } from './js/api.js';
import { nativeDictation, browserDictation, VoiceUnavailable } from './js/dictation.js';
import { dictationOrder, AUTO_VOICE, BROWSER_VOICE } from '../shared/dictation.js';
import { escape, icon, hydrateIcons, registerRenderer, renderers, markdown, character, quotaMeter, quotaCard, speechLine, windowName, onRenderers, needRenderer } from './js/renderers.js';
import { enhanceSelect, showMenu } from './js/menu.js';
import { renderSidebar, projectChoices, repoKey, SidebarPrefs, clampSidebarWidth, spacesOf, homeSpace, shownSpace, spaceOfItem, isInSpace, inSpace, renderSpaceSwitch, spaceMenuItems } from './js/sidebar.js';
import { avatarSvg, newAvatarSeed } from './js/avatar.js';
import './js/diagrams.js';
import { NewOptions } from './js/new-options.js';
import { agentRows, newAgentsView, AVATAR_TYPES, AVATAR_MAX_BYTES } from './js/agents.js';
import { fileActions, actionButtons, filePopover } from './js/file-actions.js';
import { byId, closest, find, findAll, nodeOf } from './js/dom.js';
import { get, isBag, messageOf, str } from '../shared/guards.js';
import type { ConversationStore, PageTurn } from './js/store.js';
import type { DictationSession } from './js/dictation.js';
import type { DraftAttachment } from './js/navigation.js';
import type { SideSession } from './js/sidebar.js';
import type { Provider } from './js/renderers.js';
import type { ActivityEntry, ActivityNotice, ActivitySnapshot, AgentBusy, AgentEntry, CardAction, CardRead, CreateResult, DictationInfo, DictationSkip, DictationSource, EngineManifest, EngineStatus, EnginesResponse, FilePreview, Model, Project, QueuedMessage, SessionHistoryResponse, SessionMetadata, Space, Usage, UnifiedSession, WrapUpCard } from '../shared/contract.js';

// The page's elements by id (index.html), each with the kind it is there. `$` checks the kind,
// so markup that changes shows up as an error where it is looked up.
const ELEMENTS = {
  'add-engine': HTMLButtonElement,
  'agents-content': HTMLDivElement,
  'agents-dialog': HTMLDialogElement,
  'attach': HTMLButtonElement,
  'attachments': HTMLDivElement,
  'close-agents': HTMLButtonElement,
  'close-image-viewer': HTMLButtonElement,
  'close-info': HTMLButtonElement,
  'close-onboard': HTMLButtonElement,
  'close-settings': HTMLButtonElement,
  'close-sidebar': HTMLButtonElement,
  'close-usage': HTMLButtonElement,
  'composer': HTMLFormElement,
  'composer-context': HTMLSpanElement,
  'conversation': HTMLElement,
  'copy-onboard': HTMLButtonElement,
  'copy-skill-path': HTMLButtonElement,
  'dictate': HTMLButtonElement,
  'dismiss-notice': HTMLButtonElement,
  'drop-zone': HTMLDivElement,
  'effort': HTMLSelectElement,
  'engine-dock': HTMLElement,
  'engine-label': HTMLSpanElement,
  'file-input': HTMLInputElement,
  'image-viewer': HTMLDialogElement,
  'image-viewer-img': HTMLImageElement,
  'image-viewer-open': HTMLAnchorElement,
  'info-content': HTMLDivElement,
  'info-dialog': HTMLDialogElement,
  'jump-bottom': HTMLButtonElement,
  'model': HTMLSelectElement,
  'new-chat': HTMLButtonElement,
  'new-target': HTMLButtonElement,
  'new-target-name': HTMLSpanElement,
  'new-target-path': HTMLInputElement,
  'new-target-row': HTMLDivElement,
  'notice': HTMLDivElement,
  'notice-text': HTMLSpanElement,
  'onboard-dialog': HTMLDialogElement,
  'onboard-path': HTMLParagraphElement,
  'onboard-prompt': HTMLPreElement,
  'open-profile': HTMLButtonElement,
  'open-settings': HTMLButtonElement,
  'permission': HTMLSelectElement,
  'prompt': HTMLTextAreaElement,
  'queue': HTMLButtonElement,
  'queue-list': HTMLDivElement,
  'refresh': HTMLButtonElement,
  'run-state': HTMLDivElement,
  'send': HTMLButtonElement,
  'send-blocked': HTMLDivElement,
  'send-blocked-text': HTMLSpanElement,
  'session-count': HTMLSpanElement,
  'session-cwd': HTMLSpanElement,
  'session-info': HTMLButtonElement,
  'show-desktop': HTMLButtonElement,
  'show-desktop-label': HTMLSpanElement,
  'session-list': HTMLElement,
  'session-search': HTMLInputElement,
  'session-sync': HTMLSpanElement,
  'session-title': HTMLHeadingElement,
  'settings-content': HTMLDivElement,
  'settings-dialog': HTMLDialogElement,
  'side-body': HTMLDivElement,
  'side-close': HTMLButtonElement,
  'side-copy': HTMLButtonElement,
  'side-file-actions': HTMLSpanElement,
  'side-meta': HTMLParagraphElement,
  'side-mode': HTMLButtonElement,
  'side-panel': HTMLElement,
  'side-resize': HTMLDivElement,
  'side-tabs': HTMLDivElement,
  'sidebar': HTMLElement,
  'sidebar-agent': HTMLSpanElement,
  'sidebar-face': HTMLSpanElement,
  'sidebar-resize': HTMLDivElement,
  'sidebar-scrim': HTMLButtonElement,
  'space-switch': HTMLDivElement,
  'stop': HTMLButtonElement,
  'timeline': HTMLDivElement,
  'toggle-panel': HTMLButtonElement,
  'toggle-rail': HTMLButtonElement,
  'toggle-sidebar': HTMLButtonElement,
  'usage-content': HTMLDivElement,
  'usage-dialog': HTMLDialogElement,
  'user-avatar': HTMLSpanElement,
  'workspace': HTMLElement,
} as const;
type Elements = typeof ELEMENTS;
type ElementId = keyof Elements;
function $<K extends ElementId>(id: K): InstanceType<Elements[K]>;
function $(id: ElementId): HTMLElement { return byId(id, ELEMENTS[id]); }
// Reading either storage can throw (a sandboxed page, storage turned off): then there is none.
const storageFor = (name: 'localStorage' | 'sessionStorage'): Storage | null => { try { return name === 'localStorage' ? window.localStorage : window.sessionStorage; } catch { return null; } };
const drafts = new DraftBook(storageFor('sessionStorage'));
const markers = new ReadMarkers(storageFor('localStorage'));
/**
 * The chat the page shows: one the server listed or read (UnifiedSession), or, while it is being
 * read, a stand-in with only its id, title and engine.
 */
type PageSession = Pick<UnifiedSession, 'id'> & Partial<Omit<UnifiedSession, 'id'>>;
/** A chat left open in another view, kept to come back to without a reload. */
interface CachedView { session: PageSession | null; store: ConversationStore; node: HTMLElement; rendered: Map<string | null, string>; scrollTop: number; follow: boolean }
/** `label`: the speech service that is listening, as the run-state line names it. */
interface Dictating { session: DictationSession; owner: string; stopping: boolean; label: string }
interface AppState {
  projectDir: string; notices: ActivityNotice[]; httpsPort: number | null; voice: DictationInfo; dictation: Dictating | null;
  activity: ActivityEntry[]; usage: Record<string, Usage>; usageLoaded: boolean; overview: EventSource | null; lastSessions: Record<string, string>;
  controller: AbortController | null; motion: Animation | null; refreshing: boolean; engines: EngineManifest[];
  /** Every agent the console knows, switched on (it is in `engines` then) or off. */
  agents: AgentEntry[];
  /** Each engine's chats as listed, plus a chat just created here (only some fields known yet). */
  sessions: Record<string, PageSession[]>; projects: Record<string, Project[]>; models: Record<string, Model[]>; statuses: Record<string, EngineStatus>;
  engine: string; session: PageSession | null; store: ConversationStore; stream: EventSource | null; view: number;
  loading: boolean; submitting: boolean; creating: boolean; uploading: number; attachments: DraftAttachment[];
  follow: boolean; dirty: boolean; ready: boolean; defaultCwd: string; refreshErrors: Record<string, string>;
  /** Set once the manifest is read (undefined before, as it always was). */
  fileManager?: string;
}
const views = new Map<string, CachedView>(), sending = new Set<string>(), stopping = new Set<string>(), uploads = new Map<string, number>();
// What this page saved: engine → the chat last open there.
const readLastSessions = (): Record<string, string> => { try { return JSON.parse(storageFor('sessionStorage')?.getItem('desktop-bridge:last-sessions') || '{}'); } catch { return {}; } };
const state: AppState = { projectDir: '', notices: [], httpsPort: null, voice: { preferred: '', sources: [] }, dictation: null, activity: [], usage: {}, usageLoaded: false, overview: null, lastSessions: readLastSessions(), controller: null, motion: null, refreshing: false, engines: [], agents: [], sessions: {}, projects: {}, models: {}, statuses: {}, engine: '', session: null, store: createStore(), stream: null, view: 0, loading: false, submitting: false, creating: false, uploading: 0, attachments: [], follow: true, dirty: false, ready: false, defaultCwd: '', refreshErrors: {} };
const engine = (id?: string | null): EngineManifest | undefined => state.engines.find(item => item.id === (id || state.engine));
const currentKey = () => viewKey(state.engine, state.session?.id);
// Only called with a chat open (sending, stopping, queue and approval buttons belong to one).
const endpoint = () => sessionUrl(state.engine, state.session?.id ?? '');
// The name of a caught error (AbortError, NotAllowedError…); undefined for anything without one.
// A data-* value of an element found by that attribute ([data-session] and so on), so it is there.
const data = (element: HTMLElement, key: string): string => element.dataset[key] ?? '';
const errorName = (err: unknown) => str(get(err, 'name'));
const notify = (message: string) => { $('notice-text').textContent = message; $('notice').hidden = !message; };
const blockedReason = () => state.session?.sendBlocked || capsOf()?.sendBlocked || '';
const sidePrefs = new SidebarPrefs(storageFor('localStorage'));
// The desktop's mode the sidebar shows for an engine (plugin `spaces`; '' when it has none), and
// that mode's entry ({ id, label, unavailable? }).
const spaceId = (id = state.engine) => { const spaces = spacesOf(engine(id)); return spaces.length ? shownSpace(spaces, sidePrefs.space(id)) : ''; };
const space = (id = state.engine) => spacesOf(engine(id)).find(item => item.id === spaceId(id)) || null;
// What the engine can do here: its own capabilities, narrowed by the desktop mode the chat is in
// (or, with no chat open, the mode shown; plugin `spaces[].capabilities`) and by the chat itself.
const capsOf = () => {
  const spaces = spacesOf(engine()), mode = state.session && spaces.length ? spaces.find(item => item.id === spaceOfItem(state.session, spaces)) : space();
  return { ...(engine()?.capabilities || {}), ...(mode?.capabilities || {}), ...(state.session?.capabilities || {}) };
};
// A new chat in a mode other than the default one is made in that mode (`space`), in one of its
// projects when started from that project's "+" (newProject: { engine, space, id, name }).
interface NewProject { engine: string; space: string; id: string; name: string }
let newProject: NewProject | null = null;
const newInMode = () => { const spaces = spacesOf(engine()); return spaces.length && spaceId() !== homeSpace(spaces) ? spaceId() : ''; };
const aimedProject = () => (newProject && newProject.engine === state.engine && newProject.space === spaceId() ? newProject : null);
// The sidebar's "+" on projects, for the mode shown: in folders (true), in any of the mode's own
// projects ('any': a mode whose projects are not folders) or none.
const projectPlus = () => { if (noNewReason()) return false; const caps = { ...(engine()?.capabilities || {}), ...(space()?.capabilities || {}) }; return caps.cwd === false ? (newInMode() ? 'any' : false) : !!caps.cwd; };
// Why a new chat cannot start in the mode shown ('' when it can).
const noNewReason = () => space()?.unavailable || space()?.noNew || '';
// Where a new chat can go: the projects of the mode new chats start in (the default one).
const newChoices = () => { const spaces = spacesOf(engine()), home = homeSpace(spaces); return projectChoices(inSpace(state.sessions[state.engine] || [], spaces, home), inSpace(state.projects[state.engine] || [], spaces, home)); };
// Opening a session shows the mode it is in.
const followSpace = (id: string, session: PageSession | null) => { const spaces = spacesOf(engine(id)); if (spaces.length && session && !isInSpace(session, spaces, spaceId(id))) sidePrefs.setSpace(id, spaceOfItem(session, spaces)); };
// Where each engine's next new chat starts (a project's folder; '' = the engine's default folder).
// What this page saved: engine → { cwd }.
const newTargets: Record<string, { cwd: string }> = (() => { try { return JSON.parse(storageFor('localStorage')?.getItem('desktop-bridge:new-targets') || '{}') || {}; } catch { return {}; } })();
// Only what the person picked here goes with the message. A menu the page filled in by itself
// (showing the session's desktop setting) sends nothing, so the desktop keeps whatever it has
// now, even if it changed since this page last read it. `data-picked` marks a person's pick.
type Menu = 'model' | 'effort' | 'permission';
const picked = (id: Menu) => $(id).dataset.picked && !$(id).hidden ? $(id).value || undefined : undefined;
const options = () => ({ model: picked('model'), reasoningEffort: picked('effort'), permissionMode: picked('permission') });
// A change the page made itself carries `data-auto` on the menu while it is dispatched.
const notePick = (id: Menu) => { if ($(id).dataset.auto) delete $(id).dataset.picked; else $(id).dataset.picked = '1'; };
let restoredKey: string | null = null;

function relativeTime(value: unknown): string {
  // new Date() of anything else (undefined, an object) is an invalid date, which reads as ''.
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : typeof value === 'number' || typeof value === 'string' ? value : NaN);
  if (!Number.isFinite(+date)) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  return days < 1 ? t('今天') : days === 1 ? t('昨天') : days < 7 ? t('{days}天', { days }) : date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
}
function sidebar(open: boolean): void {
  const wasOpen = document.body.classList.contains('sidebar-open');
  if (matchMedia('(max-width:767px)').matches) {
    document.body.classList.toggle('sidebar-open', open);
    $('sidebar-scrim').hidden = !open;
    $('workspace').inert = open;
  } else document.body.classList.toggle('sidebar-hidden', !open);
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
  $('sidebar').inert = !open;
  if (matchMedia('(max-width:767px)').matches && (open || wasOpen)) (open ? $('close-sidebar') : $('toggle-sidebar')).focus();
}
function activityFor(engineId: string, id: string): ActivityEntry | undefined { return state.activity.find(item => item.engine === engineId && item.sessionId === id); }
function markCurrentRead() {
  if (!state.session || state.loading || document.hidden) return;
  markers.mark(state.engine, state.session.id);
}
// The agent rail: each engine as a contact in a chat app. Its character, its name, a bar per
// quota window, the count of unread replies on the avatar's corner, and a speech bubble that types
// out the first sentence of whatever it last said (never tool calls). Updated per engine so one
// AI's typing animation is not restarted by another's change.
const dockMarkup = new Map(), counted = new Map<string, number>(), staged = new Map<string, string>();
// How long a line stays up in the compact rail: long enough to read it, then it leaves by itself.
const lingerMs = (text: string) => Math.min(9000, Math.max(4500, 2600 + Array.from(text).length * 110)), LEAVE_MS = 300;
// When this page first showed each of an agent's latest lines. A line reaches the page some
// seconds after it was said, so its time up is counted from here; one said over a minute ago is
// history (the page was opened later) and does not pop up at all. The last few are kept, so a line
// that gives way to "thinking" for a moment and comes back is not taken for a new one.
const heard = new Map<string, Map<string, number>>(), NEWS_MS = 60000, HEARD_MAX = 12;
// Whether a balloon is up in the compact rail, and which agent the rail last showed as open.
let dockTimer = 0, balloonsUp = false, railEngine = '';
interface Speech { text: string; key: string; live: boolean; at: number; warn?: boolean; until?: number }
function speechFor(provider: EngineManifest, running: boolean, usage: Usage | undefined): Speech {
  // While it works it speaks for a running chat, and only what that turn said, or what any of
  // its chats said just now (a chat that finished while another still works); idle, only what
  // it said in the last two hours. Never another chat's old line under a working avatar.
  const runs = state.activity.filter(item => item.engine === provider.id && item.running), now = Date.now();
  const current = (item: ActivityNotice) => runs.some(run => run.sessionId === item.sessionId && run.startedAt && item.at >= run.startedAt);
  const notice = [...state.notices].reverse().find(item => item.engine === provider.id && (running
    ? current(item) || now - item.at < NEWS_MS
    : now - item.at < 2 * 3600000));
  if (notice) return { text: speechLine(notice.preview, 40), key: notice.id, live: true, at: notice.at, ...(running && !current(notice) ? { until: notice.at + NEWS_MS } : {}) };
  if (running) return { text: t('正在思考…'), key: 'thinking', live: false, at: 0 };
  if (state.usageLoaded && usage && !usage.available && usage.short) return { text: say(usage.short), key: `short:${usage.short}`, live: false, warn: true, at: 0 };
  return { text: t('在这儿，随时可以开始'), key: 'idle', live: false, at: 0 };
}
function quotaSummary(usage: Usage | undefined): string {
  if (!state.usageLoaded) return t('正在读取额度');
  if (!usage?.available) return say(usage?.reason?.split('\n')[0]) || t('额度未公开');
  // An available quota always has its windows (UsageService); a missing percent rounds to NaN, as before.
  return (usage.windows || []).map(window => t('{label} 剩 {percent}%', { label: windowName(window), percent: Math.round(window.remainingPercent ?? NaN) })).join(' · ');
}
// The rail is wide (every agent's last line always in view) or compact (a bubble pops out beside
// the avatar while the AI works or has just spoken); narrow windows are always compact.
const railWide = () => document.documentElement.dataset.rail === 'wide';
const clock = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
// Unread replies: their count on the avatar's corner, as a chat app marks a friend's new
// messages; "!" when a turn failed.
const unreadBadge = (count: number, failed: boolean, grew: boolean) => `<span class="unread-badge${failed ? ' is-failed' : ''}${grew ? ' is-new' : ''}" aria-hidden="true">${failed ? '!' : count > 99 ? '99+' : count}</span>`;
const WORK_RING = '<svg class="work-ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22.5" pathLength="100"/></svg>';
const TYPING = '<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
// An agent that left the console leaves the rail: its tile shrinks away and is no longer found as an agent.
function retireTile(tile: HTMLElement): void {
  delete tile.dataset['engine']; tile.inert = true;
  const gone = () => tile.remove();
  if (matchMedia('(prefers-reduced-motion:reduce)').matches || !tile.animate) { gone(); return; }
  tile.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.7)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
  // (By the clock, not by the animation's end: a page in the background does not run animations, and the tile must still go.)
  setTimeout(gone, 200);
}
// Whether the rail has been drawn once: an agent that appears after that has just been switched on, and steps in.
let dockDrawn = false;
function renderDock() {
  const dock = $('engine-dock');
  if (!dock.querySelector('[data-engine]')) dock.innerHTML = '';
  const here = new Set(state.engines.map(item => item.id));
  for (const tile of findAll(dock, '[data-engine]')) if (!here.has(data(tile, 'engine'))) retireTile(tile);
  // With no agent on, the "+" is where to start.
  $('add-engine').classList.toggle('is-inviting', state.ready && !state.engines.length);
  const wide = railWide();
  let nextExpiry = Infinity, anyBalloon = false;
  state.engines.forEach((provider, index) => {
    const activity = state.activity.filter(item => item.engine === provider.id);
    const running = activity.some(item => item.running), unread = activity.filter(item => markers.unread(item));
    const usage = state.usage[provider.id], quota = quotaSummary(usage);
    const speech = speechFor(provider, running, usage);
    if (speech.until) nextExpiry = Math.min(nextExpiry, speech.until);
    // Compact: a line the AI has just said floats up beside its face as a small balloon, long
    // enough to be read, then leaves; while it works with nothing new to say, the balloon is a
    // chip of three dots tucked against the face. Wide: its line stays, in the rail itself.
    const now = Date.now(), lines = heard.get(provider.id) ?? new Map<string, number>(), unheard = speech.live && !lines.has(speech.key);
    if (unheard) { lines.set(speech.key, now); heard.set(provider.id, lines); for (const old of lines.keys()) { if (lines.size <= HEARD_MAX) break; lines.delete(old); } }
    const first = lines.get(speech.key) ?? now;
    const left = speech.live && first - speech.at < NEWS_MS ? first + lingerMs(speech.text) - now : 0;
    const open = wide || left > 0, chip = !open && running;
    if (!wide && left > 0) { nextExpiry = Math.min(nextExpiry, now + left + LEAVE_MS); anyBalloon = true; }
    // The balloon pops in only when it appears or changes, not each time the rail is drawn again.
    const stage = wide ? '' : open ? `open:${speech.key}` : chip ? 'chip' : '';
    const entered = !!stage && staged.get(provider.id) !== stage && dockMarkup.has(provider.id);
    staged.set(provider.id, stage);
    // A line is typed out the first time the page hears it, never again.
    const typing = unheard && dockMarkup.has(provider.id);
    // The count pops only when it has grown, not each time the rail is drawn again.
    const grew = unread.length > (counted.get(provider.id) ?? 0) && dockMarkup.has(provider.id);
    counted.set(provider.id, unread.length);
    // Whether this AI can be reached right now: a small dot on the corner of its avatar.
    const reach = state.statuses[provider.id];
    // (Reachable, but the desktop app has changed under the console's description of it: some
    // controls are found by their names only, which another language of the desktop would not have.)
    const stale = reach?.connected ? reach.stale ?? [] : [];
    const link = !reach ? null : reach.connected ? stale.length ? { kind: 'limited', text: t('桌面版界面有改动') } : { kind: 'on', text: t('引擎已就绪') } : reach.error ? { kind: 'limited', text: t('仅可查看历史') } : { kind: 'off', text: t('引擎未连接') };
    const reachNote = reach?.error ? say(reach.error) : stale.length ? t('{n} 个控件的认法要更新：{keys}', { n: stale.length, keys: stale.join(', ') }) : '';
    const status = running ? t('正在工作') : unread.length ? t('{n} 条新消息', { n: unread.length }) : t('就绪');
    const name = escape(provider.label), key = `<kbd>⌥${index + 1}</kbd>`;
    // The hover card: who this is, whether it can be reached, then every quota window by name.
    const head = `<span class="card-head"><span class="card-name">${name}</span>${key}</span><span class="card-status">${link ? `<span class="status-dot is-${link.kind}"></span>${escape(reachNote ? `${link.text} · ${reachNote}` : link.text)} · ` : ''}${escape(status)}</span>${speech.live ? `<span class="card-said">${escape(speech.text)}<time>${escape(clock(speech.at))}</time></span>` : ''}<span class="card-rule"></span>`;
    // Drawn once as it stays (what the rail is compared by) and once with what happens only now:
    // the line typed out a character at a time, the count and the balloon popping in.
    const letters = () => Array.from(speech.text).map((char, at) => `<span style="--i:${at}">${escape(char)}</span>`).join('');
    const draw = (typing: boolean, grew: boolean, entered: boolean) => `<button class="engine-switch${running ? ' is-working' : ''}${unread.length ? ' is-unread' : ''}" data-engine="${escape(provider.id)}" style="--hue:${escape(provider.accent || 'var(--accent)')}" aria-pressed="${state.engine === provider.id}" aria-label="${t('切换到')} ${name}, ${link ? `${escape(link.text)}, ` : ''}${escape(status)}, ${escape(quota)}" aria-keyshortcuts="Alt+${index + 1}">
      <span class="engine-avatar">${running ? WORK_RING : ''}${character(provider, { working: running })}${unread.length ? unreadBadge(unread.length, unread.some(item => item.outcome === 'failed'), grew) : ''}${link ? `<span class="link-dot is-${link.kind}" aria-hidden="true"></span>` : ''}</span>
      <span class="engine-meta"><span class="engine-name">${name}</span>${key}${speech.live ? `<time class="engine-time">${escape(clock(speech.at))}</time>` : ''}</span>
      <span class="speech-bubble${open ? ' is-shown' : chip ? ' is-chip' : ''}${entered ? ' is-entering' : ''}${speech.warn ? ' is-warning' : ''}${speech.live ? '' : ' is-quiet'}">${chip ? TYPING : ''}<span class="speech-text${typing ? ' is-typing' : ''}" aria-live="${running ? 'polite' : 'off'}">${typing ? letters() : escape(speech.text)}${speech.key === 'thinking' ? TYPING : ''}</span></span>
      ${quotaMeter(usage)}
      ${quotaCard(usage, state.usageLoaded, head)}
    </button>`;
    const previous = dockMarkup.get(provider.id), plain = draw(false, false, false), markup = typing || grew || entered ? draw(typing, grew, entered) : plain;
    const node = find($('engine-dock'), `[data-engine="${CSS.escape(provider.id)}"]`);
    if (node && previous === plain && !typing && !grew && !entered) return;
    const focused = document.activeElement === node;
    const template = document.createElement('template'); template.innerHTML = markup.trim();
    // The markup is one <button>.
    const next = template.content.firstElementChild;
    if (!(next instanceof HTMLElement)) return;
    if (node) node.replaceWith(next); else { if (dockDrawn) next.classList.add('is-joining'); dock.append(next); }
    dockMarkup.set(provider.id, plain);
    // The balloon leaves by itself when its time is up (style.css, bubble-leave).
    if (!wide && open) find(next, '.speech-bubble')?.style.setProperty('--left', `${Math.max(0, Math.round(left))}ms`);
    if (focused) next.focus({ preventScroll: true });
  });
  balloonsUp = anyBalloon;
  // The tiles stand in the agents' order (one switched on later takes its own place, not the end).
  state.engines.forEach((provider, index) => {
    const tile = find(dock, `[data-engine="${CSS.escape(provider.id)}"]`), at = findAll(dock, '[data-engine]')[index];
    if (tile && at && tile !== at) dock.insertBefore(tile, at);
  });
  if (state.ready) dockDrawn = true;
  // The agent whose window is open stays in view when the rail has more agents than fit.
  if (railEngine !== state.engine) { railEngine = state.engine; find($('engine-dock'), '.engine-switch[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  placeDock();
  clearTimeout(dockTimer);
  if (Number.isFinite(nextExpiry)) dockTimer = window.setTimeout(renderDock, Math.max(200, nextExpiry - Date.now() + 50));
}
// Balloons and cards are placed against the page (position: fixed) from where their agent sits,
// not inside the rail: so the rail can scroll when it holds more agents than fit, nothing it
// scrolls is cut off, and a card near the bottom moves up to stay on the page. An agent scrolled
// out of the rail shows neither. A card too tall for the page drops its reset lines to fit.
// Everything is read first and written after, so the page is laid out once however many agents.
function placeDock(): void {
  const rail = $('engine-dock').getBoundingClientRect();
  const tiles = findAll($('engine-dock'), '.engine-switch').map(tile => ({ tile, box: tile.getBoundingClientRect(), card: find(tile, '.quota-card') }));
  for (const { tile, box, card } of tiles) {
    tile.style.setProperty('--tile-x', `${Math.round(box.left)}px`); tile.style.setProperty('--tile-y', `${Math.round(box.top)}px`); tile.style.setProperty('--tile-w', `${Math.round(box.width)}px`);
    // (Shown or hidden before its card is measured: a hidden card has no height to place it by.)
    tile.classList.toggle('is-offstage', box.bottom < rail.top + 16 || box.top > rail.bottom - 16);
    card?.classList.remove('is-dense');
  }
  // (A card's own height stops at the page's; what it holds is measured, to know it does not fit.)
  const room = innerHeight - 16, heights = tiles.map(({ card }) => card ? Math.max(card.offsetHeight, card.scrollHeight) : 0);
  tiles.forEach(({ tile, box, card }, at) => {
    let height = heights[at] ?? 0;
    if (card && height > room) { card.classList.add('is-dense'); height = card.offsetHeight; }
    tile.style.setProperty('--card-y', `${Math.round(Math.max(8, Math.min(box.top, innerHeight - height - 8)))}px`);
  });
}
$('engine-dock').addEventListener('scroll', placeDock, { passive: true });
addEventListener('resize', () => requestAnimationFrame(placeDock));
// A balloon never stands between the pointer and what is under it: it fades as the pointer comes
// near (it takes no clicks either way), and comes back when the pointer moves on.
document.addEventListener('pointermove', event => {
  if (!balloonsUp) return;
  for (const bubble of findAll($('engine-dock'), '.speech-bubble.is-shown, .speech-bubble.is-yielding')) {
    const box = bubble.getBoundingClientRect();
    bubble.classList.toggle('is-yielding', event.clientX > box.left - 10 && event.clientX < box.right + 10 && event.clientY > box.top - 10 && event.clientY < box.bottom + 10);
  }
}, { passive: true });
// The list is the shared sidebar (js/sidebar.ts): projects, then every chat newest first ("最近"). A skin may still
// draw its own with a `session-list:<id>` renderer; `renderDefault()` gives it the shared one.
let listMarkup: string | null = null;
function renderSessionList() {
  const query = $('session-search').value.trim().toLocaleLowerCase();
  const spaces = spacesOf(engine()), shown = spaceId(), mode = space();
  setHTML($('space-switch'), renderSpaceSwitch(spaces, shown, { label: t('{name} 的模式', { name: engine()?.label || '' }) }));
  $('space-switch').hidden = !spaces.length; $('sidebar-agent').hidden = !!spaces.length;
  const sessions = inSpace(state.sessions[state.engine] || [], spaces, shown).filter(item => `${item.title} ${item.cwd} ${item.metadata?.group?.name || ''}`.toLocaleLowerCase().includes(query));
  $('session-count').textContent = String(sessions.length);
  const error = state.refreshErrors[state.engine] || (mode?.unavailable && !sessions.length ? mode.unavailable : ''), projects = inSpace(state.projects[state.engine] || [], spaces, shown);
  // A chat has news when it finished or said something since it was last opened here, or when the
  // desktop marks it for a look (metadata.attention) and it has not been opened here since.
  const status = (item: PageSession) => {
    const activity = activityFor(state.engine, item.id), flagged = !!item.metadata?.attention && markers.unread({ engine: state.engine, sessionId: item.id, completedAt: Date.parse(String(item.updatedAt)) || 0 });
    return { running: activity ? activity.running : item.status === 'busy', unread: !!(activity && markers.unread(activity)) || flagged, draft: !!drafts.get(viewKey(state.engine, item.id)).text };
  };
  const renderDefault = () => renderSidebar(sessions, { projects, engineId: state.engine, space: shown, currentId: state.session?.id || '', query, status, time: item => relativeTime(item.updatedAt), prefs: sidePrefs, newChat: projectPlus() });
  const skinList = renderers.get(`session-list:${state.engine}`) || renderers.get('session-list:kit');
  const markup = sessions.length || (!query && projects.length)
    ? (skinList ? skinList(sessions, { currentId: state.session?.id, query, escape, icon, relativeTime, provider: engine(), status, projects, renderDefault }) : renderDefault())
    : `<p class="quiet-state">${escape(say(error) || (query ? t('没有匹配的聊天') : t('还没有聊天，从新建聊天开始')))}</p>`;
  if (markup === listMarkup) return;
  const focused = closest(document.activeElement, '#session-list [data-session], #session-list [data-project-toggle], #session-list [data-project-new], #session-list [data-side-more]');
  const key = focused && ['session', 'projectToggle', 'projectNew', 'sideMore'].map(name => [name, focused.dataset[name]] as const).find(([, value]) => value != null);
  listMarkup = markup; $('session-list').innerHTML = markup; hydrateIcons($('session-list'));
  if (key) [...$('session-list').querySelectorAll('button')].find(node => node.dataset[key[0]] === key[1])?.focus({ preventScroll: true });
  const sentinel = find($('session-list'), '[data-side-sentinel]');
  if (sentinel) listGrowth.observe(sentinel);
}
// Scrolling to the end of "最近" brings in the next batch of older chats, as the desktop apps do.
const listGrowth = new IntersectionObserver(entries => {
  const hit = entries.find(entry => entry.isIntersecting); if (!hit) return;
  // The sentinel is found by its data-side-sentinel, so it always has one.
  const id = hit.target instanceof HTMLElement ? hit.target.dataset['sideSentinel'] : undefined;
  listGrowth.unobserve(hit.target); if (id !== undefined) sidePrefs.grow(id); renderSessionList();
}, { root: $('session-list'), rootMargin: '0px 0px 240px 0px' });
function saveDraft() {
  if (!state.engine) return;
  drafts.set(currentKey(), { text: $('prompt').value, attachments: state.attachments, picks: { model: picked('model') || '', effort: picked('effort') || '' }, selectionStart: $('prompt').selectionStart, selectionEnd: $('prompt').selectionEnd });
}
function restoreDraft() {
  const draft = drafts.get(currentKey());
  $('prompt').value = draft.text || ''; state.attachments = draft.attachments || [];
  // Picks belong to the chat they were made in; only a person's own picks come back with the draft.
  const picks = draft.picks || {};
  if (restoredKey !== currentKey()) { restoredKey = currentKey(); delete $('permission').dataset.picked; }
  delete $('model').dataset.picked; delete $('effort').dataset.picked;
  $('model').value = ''; renderModels();
  if (picks.model && [...$('model').options].some(option => option.value === picks.model)) { $('model').value = picks.model; $('model').dataset.picked = '1'; }
  renderEffort();
  if (picks.effort && [...$('effort').options].some(option => option.value === picks.effort)) { $('effort').value = picks.effort; $('effort').dataset.picked = '1'; }
  $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min(200, $('prompt').scrollHeight)}px`;
  if (draft.selectionStart != null) $('prompt').setSelectionRange(draft.selectionStart, draft.selectionEnd ?? draft.selectionStart);
  renderAttachments();
}
function rememberView() {
  cancelDictation(); saveDraft(); state.motion?.cancel();
  if (!state.session || state.loading) return;
  const key = currentKey(); views.delete(key);
  views.set(key, { session: state.session, store: state.store, node: $('timeline'), rendered: renderedTurns, scrollTop: $('conversation').scrollTop, follow: state.follow });
  while (views.size > 12) { const oldest = views.keys().next().value; if (oldest === undefined) break; views.delete(oldest); }
}
function animateView() {
  state.motion?.cancel();
  if (matchMedia('(prefers-reduced-motion:reduce)').matches || !$('timeline').animate) return;
  state.motion = $('timeline').animate([{ opacity: .55, transform: 'translateX(6px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function renderUsage() {
  $('usage-content').innerHTML = state.engines.map(provider => `<section class="usage-engine" style="--hue:${escape(provider.accent || 'var(--accent)')}"><h3><span class="usage-face">${character(provider)}</span>${escape(provider.label)}${typeof state.usage[provider.id]?.plan === 'string' ? `<span class="count-chip">${escape(state.usage[provider.id]?.plan)}</span>` : ''}</h3>${quotaCard(state.usage[provider.id], state.usageLoaded).replace('class="quota-card"', 'class="quota-card is-inline"')}</section>`).join('');
}
async function loadUsage() {
  try { state.usage = await request('/api/usage'); state.usageLoaded = true; renderDock(); if ($('usage-dialog').open) renderUsage(); }
  catch { state.usageLoaded = true; renderDock(); }
}
function connectOverview() {
  state.overview?.close();
  const source = new EventSource('/api/activity/events'); state.overview = source;
  source.addEventListener('activity', event => { const snapshot = JSON.parse(event.data); state.activity = snapshot.sessions || []; state.notices = snapshot.notices || []; markCurrentRead(); renderDock(); renderSessionList(); });
  // An agent was switched on or off (here or on another page): the rail and the lists follow.
  source.addEventListener('engines', () => { void syncEngines(); });
}
function renderHeader() {
  // Skins scope their CSS to html[data-engine="<id>"]; the dock and dialogs stay shared.
  if (state.engine) document.documentElement.dataset.engine = state.engine; else delete document.documentElement.dataset.engine;
  // With no agent switched on there is no desktop to show: the page is the list of agents to switch on (style.css).
  document.documentElement.dataset.agents = state.ready && !state.engines.length ? 'none' : 'some';
  // Engines on the shared chat kit (src/client/kit) get its layout; their brand colour drives its accents.
  const accent = engine()?.accent;
  if (accent) document.documentElement.style.setProperty('--engine-accent', accent); else document.documentElement.style.removeProperty('--engine-accent');
  $('session-title').textContent = state.session?.title || t('新建聊天');
  $('session-cwd').textContent = state.session?.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '';
  $('session-cwd').title = state.session?.cwd || '';
  $('engine-label').textContent = engine()?.label || '';
  // The sidebar's head says whose chats these are; the header's button names the app it opens.
  $('sidebar-agent').textContent = engine()?.label || ''; setHTML($('sidebar-face'), engine() ? character(engine()) : '');
  $('show-desktop-label').textContent = t('在 {name} 打开', { name: engine()?.label || t('桌面版') });
  $('prompt').placeholder = blockedReason() && state.session ? t('此会话当前只读') : `${t('发消息给')} ${engine()?.label || 'AI'}…`;
  $('show-desktop').hidden = !state.session || !capsOf().showInDesktop;
  $('session-sync').innerHTML = state.refreshing ? ("<span class=\"activity-spinner\" aria-hidden=\"true\"></span><span>" + t('同步中') + "</span>") : '';
}
function renderModels() {
  const current = $('model').value;
  const models = state.models[state.engine] || [];
  $('model').innerHTML = `<option value="">${t('桌面端默认模型')}</option>${models.map(model => `<option value="${escape(model.id)}" data-hint="${escape(model.hint || '')}" data-description="${escape(model.description || '')}">${escape(model.name)}</option>`).join('')}`;
  if (models.some(model => model.id === current)) $('model').value = current;
  $('model').disabled = !models.length || !capsOf().models;
  $('model').title = models.length ? t('选择下一次任务的模型') : t('使用引擎自身的默认模型');
  renderEffort(); renderPermissions();
}
// Permission modes the engine declares (plugin `permissionModes`); "" keeps the desktop's setting.
function renderPermissions() {
  const modes = capsOf().permissions === false ? [] : engine()?.permissionModes || [];
  $('permission').dataset.mode = capsOf().permissions === false ? 'off' : 'on';
  const previous = $('permission').value;
  $('permission').hidden = !modes.length;
  $('permission').innerHTML = modes.length ? `<option value="">${t('桌面端设置')}</option>${modes.map(mode => `<option value="${escape(mode.id)}" data-description="${escape(say(mode.description || ''))}">${escape(mode.label)}</option>`).join('')}` : '';
  $('permission').value = modes.some(mode => mode.id === previous) ? previous : '';
}
function renderEffort() {
  const model = (state.models[state.engine] || []).find(model => model.id === $('model').value);
  const efforts = model?.reasoningEfforts || [];
  const previous = $('effort').value;
  $('effort').hidden = !capsOf().reasoning || !efforts.length;
  $('effort').dataset.mode = capsOf().reasoning === false ? 'off' : 'on';
  $('effort').innerHTML = efforts.map(effort => `<option value="${escape(effort)}">${escape(effort)}</option>`).join('');
  $('effort').value = efforts.includes(previous) ? previous : model?.defaultReasoningEffort || efforts[0] || '';
}
function renderControls() {
  state.submitting = sending.has(currentKey()); state.uploading = uploads.get(currentKey()) || 0;
  const active = state.store.active;
  const caps = capsOf();
  const desktopActive = caps.desktopInterrupt && (active || (!state.store.turns.length && state.session?.isDesktopActive));
  const canStop = caps.interrupt && (active?.source === 'console' || desktopActive);
  const stopRequested = stopping.has(currentKey());
  // While a turn runs the composer stays usable: Enter adds the message to the running turn
  // (engines that can take it) or queues it for when the turn ends; Tab always queues.
  const typed = !!($('prompt').value.trim() || state.attachments.length);
  $('send').hidden = !!canStop && !typed;
  $('stop').hidden = !canStop;
  $('queue').hidden = !active || !typed;
  $('queue').disabled = state.submitting || stopRequested || state.uploading > 0;
  const sendLabel = !active ? t('发送消息') : capsOf().steer ? t('插入正在执行的这一轮（Enter）') : t('排队，这一轮结束后发送（Enter）');
  if ($('send').title !== sendLabel) { $('send').title = sendLabel; $('send').setAttribute('aria-label', sendLabel); }
  $('stop').disabled = stopRequested;
  const blocked = state.session ? blockedReason() : capsOf()?.sendBlocked || noNewReason();
  $('send-blocked').hidden = !blocked; $('send-blocked-text').textContent = say(blocked);
  $('composer').classList.toggle('is-blocked', !!blocked);
  $('send').disabled = !!blocked || !state.ready || !state.engine || state.loading || state.submitting || stopRequested || state.creating || state.uploading > 0 || !typed;
  $('attach').disabled = !!blocked || !capsOf().attachments || state.uploading > 0;
  const dictating = !!state.dictation;
  const voice = voicePlan();
  $('dictate').disabled = !dictating && (!!blocked || !state.engine || state.loading || (!voice.source && !voice.browser));
  $('dictate').setAttribute('aria-pressed', String(dictating));
  $('dictate').classList.toggle('is-recording', dictating && !state.dictation?.stopping);
  $('dictate').classList.toggle('is-finishing', !!state.dictation?.stopping);
  const source = state.dictation?.label || voice.label;
  $('dictate').title = dictating ? t('结束语音输入') : voice.label ? `${t('语音输入 ·')} ${voice.label}` : `${t('语音输入不可用：')}${voice.why}`;
  $('prompt').disabled = !!blocked || state.loading || !state.ready || state.creating;
  $('model').disabled = !!blocked || !(state.models[state.engine] || []).length || !capsOf().models;
  // A mode whose own model applies (a chat mode) shows no model, effort or permission menus.
  $('model').hidden = capsOf().models === false;
  // The effort and permission menus follow the mode too (they are rebuilt when it changes).
  if (capsOf().reasoning === false ? !$('effort').hidden : $('effort').hidden && $('effort').dataset.mode === 'off') renderEffort();
  if ((capsOf().permissions === false) !== ($('permission').dataset.mode === 'off')) renderPermissions();
  setHTML($('run-state'), state.dictation ? `<span class="recording-dot" aria-hidden="true"></span>${state.dictation.stopping ? t('正在整理识别结果…') : `${t('正在听写 ·')} ${escape(source)} ${t('· 再点话筒结束，Esc 取消')}`}` : stopRequested ? t('正在停止…') : state.uploading ? t('正在上传附件…') : state.creating ? t('正在新建聊天…') : state.submitting ? t('正在发送…') : (active || desktopActive) ? `<span class="activity-spinner" aria-hidden="true"></span>${active?.approvals?.length ? t('等待操作批准') : active?.status === 'reconnecting' ? t('正在确认引擎状态') : t('正在执行')}${!canStop ? t(' · 请在桌面端停止任务') : ''}` : '');
  renderQueue();
  $('composer-context').textContent = state.session?.cwd ? `${t('工作目录 ·')} ${state.session.cwd.split(/[\\/]/).filter(Boolean).at(-1)}` : t('任务由 {name} 执行', { name: engine()?.label || t('桌面引擎') });
  $('new-chat').disabled = !state.engines.length || !!noNewReason();
  renderNewTarget();
}
// A new chat is the empty composer itself, as in the desktop apps: pick the project it belongs
// to under the composer, type, send. The session is created by that first message. An engine
// whose desktop page asks for its own choices first (newOptions) has them as cards instead.
const folderName = (path: string) => String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || path || '';
const sameRepo = (a: string | undefined, b: string | undefined): boolean => { const ka = repoKey(a); return !!ka && ka === repoKey(b); };
const newOptions = new NewOptions({ onChange: () => renderNewOptions() });
// What a new chat's first message will run with: the settings the engine's desktop page shows
// now, when it reports them (null: not known, so the menus name no model of their own).
const newSettings = () => !state.session && newOptions.engine === state.engine ? newOptions.settings : null;
let chatKit: { sync(): void } | null = null;
function renderNewOptions() {
  // Drawn by emptyView() for engines with new-chat choices; absent otherwise.
  const box = document.getElementById('new-options');
  if (!box) return;
  // An engine with page choices (newOptions) shows them as cards; one that only reports what its
  // page will start with (newSettings) is read the same way and shows no card.
  if (!state.session && (capsOf().newOptions || capsOf().newSettings) && newOptions.engine !== state.engine) { newOptions.open(state.engine); return; }
  setHTML(box, newOptions.html(engine()?.label || 'AI')); hydrateIcons(box);
  chatKit?.sync(); // the page's own model and permissions may have been read just now
}
function newTarget() {
  if (!capsOf().cwd || capsOf().newOptions) return null;
  const choices = newChoices();
  const cwd = newTargets[state.engine]?.cwd || '';
  const project = choices.find(item => sameRepo(item.cwd, cwd));
  return { cwd, project, name: project?.name || folderName(cwd), choices };
}
function setNewTarget(cwd: string): void {
  newTargets[state.engine] = { cwd };
  try { storageFor('localStorage')?.setItem('desktop-bridge:new-targets', JSON.stringify(newTargets)); } catch {}
  renderNewTarget();
}
function renderNewTarget() {
  const target = state.session ? null : newTarget();
  $('new-target-row').hidden = !target;
  if (!target) { $('new-target-path').hidden = true; $('new-target').hidden = false; return; }
  $('new-target-name').textContent = target.cwd ? target.name : t('不指定项目');
  $('new-target').title = target.cwd || `${t('在默认文件夹里开始：')}${state.defaultCwd}`;
  $('new-target').disabled = state.creating;
}
function pickNewTarget() {
  const target = newTarget(); if (!target) return;
  const known = target.choices.some(item => sameRepo(item.cwd, target.cwd));
  showMenu($('new-target'), [
    ...target.choices.map(item => ({ group: t('项目'), value: item.cwd, label: item.name, description: item.cwd, selected: sameRepo(item.cwd, target.cwd) })),
    ...(target.cwd && !known ? [{ group: t('其他'), value: target.cwd, label: folderName(target.cwd), description: target.cwd, selected: true }] : []),
    { group: t('其他'), value: '', label: t('不指定项目'), description: state.defaultCwd, selected: !target.cwd },
    { group: t('其他'), value: '\0custom', label: t('其他文件夹…') },
  ], { label: t('新聊天所在的项目'), onPick: item => {
    if (item.value !== '\0custom') return setNewTarget(item.value);
    $('new-target').hidden = true; $('new-target-path').hidden = false; $('new-target-path').value = target.cwd || state.defaultCwd; $('new-target-path').focus(); $('new-target-path').select();
  } });
}
// `project` ({ id, name, cwd }): started from that project's "+" in the sidebar.
function newChat(project: { id: string; name: string; cwd?: string | undefined } | null = null): void {
  if (!state.engines.length) return;
  if (noNewReason()) { notify(say(noNewReason())); return; }
  const caps = capsOf() || {};
  // In a mode of its own (a chat mode), the project is one of that mode's: picked on its page.
  newProject = newInMode() && project ? { engine: state.engine, space: spaceId(), id: project.id, name: project.name } : null;
  // Starting from inside a project (or from its "+") keeps the new chat in that project.
  const here = project?.cwd || state.session?.cwd;
  if (here && caps.cwd && !caps.newOptions && (project || newChoices().some(item => sameRepo(item.cwd, here)))) newTargets[state.engine] = { cwd: here };
  // An engine whose desktop page asks for the folder itself has it picked there.
  newOptions.aim(project?.cwd && caps.newOptions && caps.newFolder ? { ...caps.newFolder, ...project, cwd: project.cwd, engine: state.engine } : null);
  // What was read and chosen last time shows at once; the desktop's page is read again behind it.
  if (caps.newOptions || caps.newSettings) newOptions.open(state.engine);
  switchEngine(state.engine, { restore: false });
  if (matchMedia('(max-width:767px)').matches) sidebar(false);
  renderControls(); $('prompt').focus();
}
function emptyView() {
  // No agent is switched on: the page offers the ones the console knows, each with its switch.
  if (state.ready && !state.engines.length) return `<div class="empty-conversation agents-welcome"><img class="welcome-logo" src="/assets/logo/logo-128.png" width="56" height="56" alt=""><h2>${t('先接上一个 Agent')}</h2><p>${t('Agent Frontdesk 是桌面版 AI 的远程窗口。打开一个 Agent 的开关，就能在这里看它的聊天、给它发消息，任务仍由它的桌面版执行。')}</p><div id="welcome-agents">${agentsMarkup()}</div>${onboardEntry()}</div>`;
  // The agent's own character greets an empty chat, in every engine.
  const face = `<span class="empty-face">${character(engine() || {})}</span>`;
  if (!state.session) {
    const caps = capsOf() || {}, mode = space();
    // A desktop mode the console cannot read yet: say so, and read nothing from the desktop's new-chat page.
    if (mode?.unavailable || mode?.noNew) return `<div class="empty-conversation">${face}<div class="workspace-label">${icon('messages-square')}<span>${escape(engine()?.label || '')} · ${escape(mode.label)}</span></div><h2>${mode.unavailable ? t('{name} 模式还没有接入', { name: escape(mode.label) }) : escape(mode.label)}</h2><p>${escape(say(mode.unavailable || mode.noNew))}</p></div>`;
    if (newInMode()) {
      const inProject = aimedProject();
      return `<div class="empty-conversation">${face}<div class="workspace-label">${icon('messages-square')}<span>${escape(engine()?.label || '')} · ${escape(mode?.label || '')}</span></div><h2>${inProject ? t('在「{name}」里开始新聊天', { name: escape(inProject.name) }) : t('和 {name} 开始新聊天', { name: escape(mode?.label || 'AI') })}</h2><p>${t('发出第一条消息，聊天就在桌面版的「{mode}」模式里建好，用桌面版那里的模型和设置。', { mode: escape(mode?.label || '') })}</p></div>`;
    }
    const hint = caps.newOptions ? t('先一项项选好桌面版新建页要的设置，再发出第一条消息，聊天就在桌面版里建好了。') : caps.cwd ? t('在输入框下面选好项目，发出第一条消息，聊天就建好了。') : t('发出第一条消息，聊天就建好了。');
    return `<div class="empty-conversation">${face}<div class="workspace-label">${icon('messages-square')}<span>${escape(engine()?.label || t('本地引擎'))} ${t('工作台')}</span></div><h2>${t('和 {name} 开始新聊天', { name: escape(engine()?.label || 'AI') })}</h2><p>${hint}</p>${caps.newOptions || caps.newSettings ? '<div id="new-options"></div>' : ''}</div>`;
  }
  // A chat the desktop lists whose messages are not on this computer in a form the console can read.
  const elsewhere = state.session.metadata?.contentUnavailable;
  if (elsewhere) return `<div class="empty-conversation">${face}<div class="workspace-label">${icon('messages-square')}<span>${escape(engine()?.label || '')}${space() ? ` · ${escape(space()?.label)}` : ''}</span></div><h2>${escape(state.session?.title || t('聊天'))}</h2><p>${escape(say(elsewhere))}</p></div>`;
  return `<div class="empty-conversation">${face}<div class="workspace-label">${icon('messages-square')}<span>${escape(engine()?.label || t('本地引擎'))} ${t('工作台')}</span></div><h2>${t('从一条消息开始')}</h2><p>${t('说说你想完成的事。回复、执行进度和产物都会留在这里。')}</p><div class="empty-note">${icon('folder-open')}<span>${t('文件编辑留在原工作区，聊天负责调度与交付')}</span></div></div>`;
}
let renderedTurns = new Map();
function renderConversation() {
  const container = $('conversation');
  const open = new Set(findAll($('timeline'), 'details[open]').map(element => element.dataset['disclosure']));
  const scrollTop = container.scrollTop;
  const focused = closest(document.activeElement, '[data-disclosure]')?.dataset['disclosure'];
  if (state.loading || !state.store.turns.length) {
    renderedTurns.clear();
    $('timeline').innerHTML = state.loading ? ("<p class=\"quiet-state\" role=\"status\">" + t('正在读取聊天记录…') + "</p>") : emptyView();
    renderNewOptions();
  } else {
    const ids = new Set(state.store.turns.map(turn => turn.id));
    for (const node of childrenOf($('timeline'))) if (!node.dataset['turn'] || !ids.has(node.dataset['turn'])) node.remove();
    const nodes = new Map(childrenOf($('timeline')).map(node => [node.dataset['turn'], node]));
    const drawTurn = renderers.get(`turn:${state.engine}`) || renderers.get('turn:kit');
    for (const turn of state.store.turns) {
      const html = drawTurn ? drawTurn(turn, { label: engine()?.label || '', provider: engine() || {}, markdown, character, escape, icon }) : '';
      const node = turn.id ? nodes.get(turn.id) : undefined;
      if (renderedTurns.get(turn.id) !== html || !node) {
        const template = document.createElement('template'); template.innerHTML = html;
        // A turn renderer returns one <article>.
        const next = template.content.firstElementChild;
        if (next) { if (node) node.replaceWith(next); else $('timeline').append(next); }
        renderedTurns.set(turn.id, html);
      }
    }
    for (const id of renderedTurns.keys()) if (!ids.has(id)) renderedTurns.delete(id);
  }
  for (const element of $('timeline').querySelectorAll('details')) if (open.has(element.dataset['disclosure'])) element.open = true;
  hydrateIcons();
  if (focused) findAll($('timeline'), '[data-disclosure]').find(node => node.dataset['disclosure'] === focused)?.querySelector('summary')?.focus({ preventScroll: true });
  if (state.follow) container.scrollTop = container.scrollHeight; else container.scrollTop = scrollTop;
  $('jump-bottom').hidden = state.follow || !state.store.turns.length;
  renderControls();
}
let renderPending = false;
function scheduleRender() { if (renderPending) return; renderPending = true; requestAnimationFrame(() => { renderPending = false; renderConversation(); }); }
// Code colouring and math arrive after the page (js/renderers.ts): what was drawn without them is
// drawn again, the conversation and a Markdown file in the side panel. Nearly every chat has code,
// so its library is fetched as soon as the page is idle, before the first chat needs it.
onRenderers(() => { scheduleRender(); drawPanel(); });
(window.requestIdleCallback || ((run: () => void) => window.setTimeout(run, 300)))(() => needRenderer('code'));
// Replaces an element's markup only when it changed, so running spinners keep their place
// instead of restarting on every keystroke.
function setHTML(element: HTMLElement, html: string): void { if (element.dataset.html !== html) { element.dataset.html = html; element.innerHTML = html; } }
// What the desktop holds for the running turn, as read from its record (each item's prompt is text).
const queueItems = (items: unknown[]) => items.map(item => ({ ...(isBag(item) ? item : {}), prompt: str(get(item, 'prompt')) ?? '' }));
// The page's element children (the timeline holds only HTML elements).
const childrenOf = (element: HTMLElement) => [...element.children].filter(node => node instanceof HTMLElement);
const fileSize = (bytes: number | undefined) => !bytes ? '' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
function renderQueue() {
  const items = state.store.queue || [], held = state.session?.metadata?.desktopQueue || [];
  $('queue-list').hidden = !items.length && !held.length;
  // Messages the desktop app is holding for the running turn (sent there, or steered from here).
  const desktop = held.map(item => `<div class="queue-item is-desktop"><span class="queue-label">${escape(engine()?.defaultLabel || engine()?.label || t('桌面版'))} ${t('排队中')}</span><span class="queue-text" title="${escape(item.prompt)}">${escape(item.prompt)}</span><button type="button" class="queue-now" data-send-now aria-label="${t('立即发送这条消息')}">${t('立即发送')}</button></div>`).join('');
  // Each waiting message can still join the running turn, go back to the composer, or be dropped.
  const canSteer = !!capsOf().steer && !!state.store.active;
  const html = desktop + items.map(item => `<div class="queue-item"><span class="queue-label">${t('排队中')}</span><span class="queue-text" title="${escape(item.prompt)}">${escape(item.prompt.replace(/\s+/g, ' '))}${item.attachments ? ` · ${t('{n} 个附件', { n: item.attachments })}` : ''}</span>${canSteer ? `<button type="button" class="queue-now" data-queue-steer="${escape(item.id)}" title="${t('插入正在执行的这一轮')}">${t('插入')}</button>` : ''}<button type="button" class="icon-button" data-queue-edit="${escape(item.id)}" aria-label="${t('编辑这条排队消息')}" title="${t('编辑：放回输入框')}">${icon('pencil')}</button><button type="button" class="icon-button" data-dequeue="${escape(item.id)}" aria-label="${t('取消这条排队消息')}" title="${t('取消')}">${icon('x')}</button></div>`).join('');
  if ($('queue-list').dataset.html !== html) { setHTML($('queue-list'), html); hydrateIcons($('queue-list')); }
}
function renderAttachments() {
  $('attachments').hidden = !state.attachments.length;
  // Pictures show as thumbnails, other files as a named chip, as the desktop composers do.
  const picture = (item: DraftAttachment) => /^image\/(png|jpeg|gif|webp)$/.test(item.mimetype || '') && /^\/uploads\/[\w.-]+$/.test(item.url || '');
  $('attachments').innerHTML = state.attachments.map((item, index) => picture(item)
    ? `<div class="attachment-thumb" title="${escape(item.originalname)}"><img src="${escape(item.url)}" alt="${escape(item.originalname)}" data-viewer-src="${escape(item.url)}"><button type="button" class="icon-button" data-remove="${index}" aria-label="${t('移除')} ${escape(item.originalname)}">${icon('x')}</button></div>`
    : `<div class="attachment-chip" title="${escape(item.originalname)}">${icon('file-text')}<span class="attachment-name">${escape(item.originalname)}</span><span class="attachment-size">${escape(fileSize(item.size))}</span><button type="button" class="icon-button" data-remove="${index}" aria-label="${t('移除')} ${escape(item.originalname)}">${icon('x')}</button></div>`).join('');
  hydrateIcons(); renderControls();
}
async function refresh() {
  // engine → its chats (or { error }), and engine → its projects.
  const [data, projects] = await Promise.all([request<Record<string, UnifiedSession[] | { error?: string }>>('/api/sessions'), request<Record<string, Project[]>>('/api/projects').catch((): Record<string, Project[]> => ({}))]);
  for (const item of state.engines) {
    const listed = projects[item.id];
    if (Array.isArray(listed)) state.projects[item.id] = listed;
    const result = data[item.id];
    state.refreshErrors[item.id] = Array.isArray(result) ? '' : result?.error || '';
    if (Array.isArray(result)) state.sessions[item.id] = result;
  }
  renderSessionList(); renderNewTarget();
}
// The desktop apps are used alongside this page, so their lists move on without it: chats started
// or renamed there show up when the person next touches the navigation (the sidebar, the engine
// dock) or comes back to the page, without a reload. At most one read every few seconds.
let listsReadAt = 0, listsReading = false;
function refreshSoon(): void {
  if (!state.ready || listsReading || document.hidden || Date.now() - listsReadAt < 4000) return;
  listsReading = true;
  refresh().catch(() => {}).finally(() => { listsReading = false; listsReadAt = Date.now(); });
}
function closeStream() { state.stream?.close(); state.stream = null; }
function subscribe(view: number): void {
  closeStream();
  const id = state.session?.id;
  if (id === undefined) return; // only called with a chat open
  state.stream = connect(state.engine, id, state.store.cursor, {
    event(event) { if (view !== state.view || event.type === 'assistant.notice') return; if (event.type === 'queue.updated') { state.store.queue = event.data.items || []; renderControls(); return; } if (event.type === 'desktop.queue') { if (state.session) state.session = { ...state.session, metadata: { ...state.session.metadata, desktopQueue: queueItems(event.data.items || []) } }; renderControls(); return; } if (event.type === 'session.snapshot') { state.store.reconcile(event.data); state.session = { id, ...state.session, ...event.data.session, sendBlocked: event.data.session?.sendBlocked || state.session?.sendBlocked || '' }; state.store.cursor = event.id; renderHeader(); renderControls(); } else state.store.apply(event); state.store.revision = (state.store.revision || 0) + 1; scheduleRender(); if (['run.completed', 'run.failed', 'run.interrupted'].includes(event.type)) refresh().catch(() => {}); },
    ready(data) { if (view !== state.view) return; if (data.activeTurn) { state.store.restore(data.activeTurn); state.store.revision = (state.store.revision || 0) + 1; } state.store.cursor = data.cursor; renderControls(); scheduleRender(); },
    reset() { if (view === state.view) { state.store.cursor = ''; selectSession(id, { force: true }); } },
    // (Through setHTML, so the line goes when the controls are next drawn: on reconnecting, or when the chat is left.)
    error() { if (view === state.view) setHTML($('run-state'), escape(t('连接暂时中断，正在重连…'))); },
  });
}
async function selectSession(id: string, { engineId = state.engine, route = true, force = false } = {}): Promise<void> {
  if (!engine(engineId)) return;
  if (!force && state.engine === engineId && state.session?.id === id && !state.loading) { markCurrentRead(); renderDock(); return; }
  rememberView(); state.controller?.abort(); closeStream();
  const view = ++state.view, key = viewKey(engineId, id), cached = views.get(key);
  state.engine = engineId; state.loading = !cached; state.refreshing = !!cached;
  state.store = cached?.store || createStore();
  state.session = cached?.session || (state.sessions[engineId] || []).find(item => item.id === id) || { id, title: t('聊天'), engine: engineId };
  followSpace(engineId, state.session);
  state.follow = cached?.follow ?? true;
  renderedTurns = cached?.rendered || new Map();
  const node = cached?.node || Object.assign(document.createElement('div'), { id: 'timeline', className: 'timeline' });
  if ($('timeline') !== node) $('timeline').replaceWith(node);
  state.lastSessions[engineId] = id;
  try { storageFor('sessionStorage')?.setItem('desktop-bridge:last-sessions', JSON.stringify(state.lastSessions)); } catch {}
  restoreDraft(); markCurrentRead(); notify('');
  renderHeader(); renderDock(); renderSessionList(); renderConversation();
  if (cached && !cached.follow) $('conversation').scrollTop = cached.scrollTop;
  sidebar(!matchMedia('(max-width:767px)').matches); animateView();
  if (route) { const hash = `#${encodeURIComponent(engineId)}/${encodeURIComponent(id)}`; if (location.hash !== hash) historyPush(hash); }
  if (cached) subscribe(view);
  const controller = new AbortController(); state.controller = controller;
  const previousRevision = state.store.revision || 0;
  try {
    const history = await request<SessionHistoryResponse>(sessionUrl(engineId, id), { signal: controller.signal });
    if (view !== state.view) return;
    state.session = history.session;
    // Messages read from the desktop's own window (a cloud chat mode): say a partial read plainly.
    const page = history.session?.metadata?.readFromDesktop;
    if (typeof page === 'object' && page.total) notify(t('长对话只从桌面版读到了 {read} / {total} 条消息', { read: page.read, total: page.total }));
    if (!cached) state.store.load(history);
    else if ((state.store.revision || 0) === previousRevision) {
      state.store.reconcile(history); state.store.cursor = history.cursor || '';
      if (history.activeTurn) state.store.restore(history.activeTurn);
    }
    if (!cached) subscribe(view);
  } catch (err) { if (view === state.view && errorName(err) !== 'AbortError') notify(`${t('读取失败：')}${messageOf(err)}`); }
  finally { if (view === state.view) { state.loading = false; state.refreshing = false; markCurrentRead(); renderDock(); renderHeader(); renderSessionList(); renderConversation(); } }
}
function historyPush(route: string): void { window.history.pushState(null, '', route); }
function switchEngine(id: string, { restore = true, route = true } = {}): Promise<void> | void {
  if (!engine(id)) return;
  // Coming back to an engine reopens a chat from the mode its sidebar shows, as the desktop would.
  const spaces = spacesOf(engine(id)), pool = inSpace(state.sessions[id] || [], spaces, spaceId(id));
  let preferred = restore ? preferredSession(id, pool, state.lastSessions[id], state.activity, markers) : null;
  if (preferred && spaces.length && !isInSpace((state.sessions[id] || []).find(item => item.id === preferred) || {}, spaces, spaceId(id))) preferred = pool[0]?.id || null;
  if (preferred) return selectSession(preferred, { engineId: id, route });
  if (state.engine === id && !state.session && state.ready) { renderDock(); return; }
  rememberView(); state.controller?.abort(); ++state.view; closeStream();
  state.engine = id; state.session = null; state.store = createStore(); state.loading = false; state.refreshing = false; state.follow = true;
  renderedTurns = new Map(); $('timeline').replaceWith(Object.assign(document.createElement('div'), { id: 'timeline', className: 'timeline' }));
  restoreDraft(); renderHeader(); renderDock(); renderSessionList(); renderConversation(); animateView();
  if (route) historyPush(`#${encodeURIComponent(id)}`);
}
async function sendMessage(event?: Event | null, queue = false): Promise<void> {
  event?.preventDefault();
  if ($('send').disabled || state.submitting) return;
  if (!state.session) return sendFirst();
  // During a running turn: join it (steer) where the engine can, otherwise wait for it (queue).
  const mode = state.store.active ? (queue || !capsOf().steer ? 'queue' : 'steer') : undefined;
  cancelDictation();
  const view = state.view, url = endpoint(), owner = currentKey();
  saveDraft();
  const originalInput = $('prompt').value;
  const prompt = originalInput.trim(), attachments = [...state.attachments];
  sending.add(owner); renderControls(); notify('');
  try {
    const result = await request<{ status?: string; reason?: string } | null>(`${url}/messages`, { method: 'POST', body: JSON.stringify({ prompt, attachments, cwd: state.session.cwd || undefined, mode, ...options() }) });
    if (mode === 'steer' && result?.status === 'queued' && view === state.view) notify(`${say(result.reason) || t('这一轮没法插进去，消息已排队')}${t('，可以在队列里再点“插入”')}`);
    drafts.clearSent(owner, originalInput, attachments);
    if (owner !== currentKey()) return;
    if ($('prompt').value === originalInput) { $('prompt').value = ''; $('prompt').style.height = ''; }
    const sent = new Set(attachments.map(item => item.filename));
    state.attachments = state.attachments.filter(item => !sent.has(item.filename)); state.follow = true; saveDraft(); renderAttachments(); renderSessionList();
  } catch (err) { if (view === state.view) notify(`${t('发送失败：')}${messageOf(err)}`); }
  finally { sending.delete(owner); if (owner === currentKey()) renderControls(); }
}
// The first message of a new chat: create the session where the person chose, then send into it
// (engines that start the first turn themselves take the message with the creation).
async function sendFirst() {
  const provider = engine(), owner = currentKey(), view = state.view;
  if (!provider) return; // the send button is off without an engine
  if (state.creating) return;
  // The cards may be showing what was read last time, with the desktop's page being read again
  // behind them: the message waits for that answer (a moment), so the model and permissions it
  // goes out with are the page's own now.
  if ((capsOf().newOptions || capsOf().newSettings) && newOptions.engine === provider.id && newOptions.checking) {
    state.creating = true; renderControls();
    try { await newOptions.checked(); } finally { state.creating = false; }
    renderControls();
    if (owner !== currentKey() || view !== state.view) return;
  }
  cancelDictation(); saveDraft();
  const originalInput = $('prompt').value, prompt = originalInput.trim(), attachments = [...state.attachments], chosen = options();
  const direct = !!capsOf().createRequiresPrompt;
  if (direct && !prompt && !attachments.length) return notify(t('请先输入第一条消息'));
  // With desktop-side choices (newOptions) the desktop's page says where the chat goes.
  // A chat started from a project's "+" also names that folder, so the desktop checks it is picked.
  const target = newTarget(), aimed = capsOf().newOptions ? newOptions.target : null;
  const cwd = target?.cwd || aimed?.cwd || undefined, title = (prompt.split('\n')[0] ?? '').slice(0, 80);
  state.creating = true; sending.add(owner); renderControls(); notify('');
  // The created chat (POST /api/sessions/:engine answers with it; trust boundary as in request()).
  let session: (CreateResult & { title?: string; metadata?: SessionMetadata }) | undefined;
  try {
    const mode = newInMode(), inProject = aimedProject();
    const where = mode ? { space: mode, ...(inProject ? { projectId: inProject.id } : {}) } : {};
    // What the cards show as chosen goes with the message: the desktop checks its page against it.
    const expect = !mode && capsOf().newOptions && newOptions.engine === provider.id ? newOptions.expect() : [];
    session = await request<CreateResult & { title?: string; metadata?: SessionMetadata }>(`/api/sessions/${encodeURIComponent(provider.id)}`, { method: 'POST', body: JSON.stringify({ cwd, ...chosen, ...where, ...(expect.length ? { expect } : {}), ...(direct ? { prompt, attachments } : { title: title || undefined }) }) });
    const group = mode ? (inProject ? { id: inProject.id, name: inProject.name, cwd: '' } : null) : target?.project ? { id: target.project.id, name: target.project.name, cwd: target.project.cwd } : aimed?.id ? { id: aimed.id, name: aimed.name ?? '', cwd: aimed.cwd } : capsOf().cwd && !capsOf().newOptions ? null : undefined;
    newProject = null;
    newOptions.sent();
    (state.sessions[provider.id] ||= []).unshift({ ...session, title: session.title || title || t('新建聊天'), updatedAt: new Date().toISOString(), cwd: session.cwd || cwd || '', engine: provider.id, metadata: { ...session.metadata, ...(mode ? { space: mode } : {}), ...(group === undefined ? {} : { group }) } });
    drafts.clearSent(owner, originalInput, attachments);
    if (view === state.view) {
      $('prompt').value = ''; $('prompt').style.height = ''; state.attachments = []; saveDraft();
      await selectSession(session.id, { engineId: provider.id });
      // What was picked for the first message stays picked in the new chat.
      for (const [id, value] of [['model', chosen.model], ['effort', chosen.reasoningEffort], ['permission', chosen.permissionMode]] satisfies Array<[Menu, string | undefined]>) if (value && [...$(id).options].some(option => option.value === value)) { $(id).value = value; $(id).dispatchEvent(new Event('change', { bubbles: true })); }
    } else renderSessionList();
    if (!direct) await request(`${sessionUrl(provider.id, session.id)}/messages`, { method: 'POST', body: JSON.stringify({ prompt, attachments, cwd: session.cwd || cwd, ...chosen }) });
  } catch (err) {
    notify(session ? `${t('聊天已建好，但第一条消息没发出去：')}${messageOf(err)}` : `${t('新建聊天失败：')}${messageOf(err)}`);
    // The desktop's page may not be what the cards show any more: read it again.
    if (!session && capsOf().newOptions && newOptions.engine === provider.id) void newOptions.refresh();
    if (view === state.view || state.session?.id === session?.id) { if (!$('prompt').value) { $('prompt').value = originalInput; $('prompt').dispatchEvent(new Event('input')); } }
  } finally { state.creating = false; sending.delete(owner); renderControls(); }
}
// Which speech-to-text the microphone will use for the chat on screen: the first agent service
// that says it can start, in the order of shared/dictation.ts, else the browser's recognizer.
// `why`: what stands in the way when there is none (shown on the disabled microphone).
const browserVoice = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
const sourceName = (item: { label: string }) => t('{name} 语音识别', { name: item.label });
const unavailable = (item: { label: string; reason?: string }) => item.reason ? t('{name}不可用（{reason}）', { name: sourceName(item), reason: say(item.reason) }) : t('{name}不可用', { name: sourceName(item) });
const skipsText = (skipped: Array<{ label: string; reason?: string }>) => skipped.map(unavailable).join(t('；'));
function voicePlan(pick = voicePick): { source: DictationSource | null; browser: boolean; label: string; why: string } {
  const sources = state.voice.sources;
  const order = dictationOrder(sources.map(item => item.engine), { prefer: pick, preferred: state.voice.preferred, current: state.engine });
  const tried = order.map(id => sources.find(item => item.engine === id)).filter((item): item is DictationSource => !!item);
  const source = tried.find(item => item.ready) || null, browser = browserVoice();
  const why = [...tried.map(unavailable), t('当前浏览器不支持语音识别')].join(t('；'));
  return { source, browser, label: source ? sourceName(source) : browser ? t('浏览器语音识别') : '', why };
}
// The person's pick of speech service, kept in this browser like the other settings.
const VOICE_KEY = 'desktop-bridge:voice';
let voicePick = (() => { try { return storageFor('localStorage')?.getItem(VOICE_KEY) || AUTO_VOICE; } catch { return AUTO_VOICE; } })();
function pickVoice(value: string) { voicePick = value; try { storageFor('localStorage')?.setItem(VOICE_KEY, value); } catch {} renderControls(); }
// Whether each service can start changes on its own (a sign-in, an app opened): asked again when
// the page comes back into view, after a service could not start, and when settings open.
async function loadVoice(): Promise<void> {
  try { state.voice = await request<DictationInfo>('/api/dictation'); } catch { return; }
  renderControls();
  if ($('settings-dialog').open) renderVoiceSetting();
}
// Dictated text replaces the selection it started from and keeps updating in place.
async function toggleDictation() {
  if (state.dictation) return finishDictation();
  // Microphones exist only on secure origins: https, or http on localhost.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    const secure = state.httpsPort ? `https://${location.hostname}:${state.httpsPort}${location.pathname}${location.hash}` : '';
    return notify(secure
      ? `${t('语音输入需要安全连接。请改用')} ${secure} ${t('打开（首次需在浏览器里信任本机证书），或在这台 Mac 上用 http://localhost:')}${location.port} ${t('打开。')}`
      : `${t('浏览器只允许 https 或 localhost 页面使用麦克风。请在这台 Mac 上用 http://localhost:')}${location.port} ${t('打开，或用 HOST=0.0.0.0 启动服务以启用 HTTPS。')}`);
  }
  const prompt = $('prompt'), owner = currentKey();
  const before = prompt.value.slice(0, prompt.selectionStart), after = prompt.value.slice(prompt.selectionEnd);
  const joiner = before && !/\s$/.test(before) && /[A-Za-z0-9]$/.test(before) ? ' ' : '';
  const apply = (text: string | undefined) => {
    if (owner !== currentKey()) return;
    prompt.value = before + (text ? joiner + text : '') + after;
    const caret = prompt.value.length - after.length;
    prompt.setSelectionRange(caret, caret);
    prompt.style.height = 'auto'; prompt.style.height = `${Math.min(200, prompt.scrollHeight)}px`;
    saveDraft(); renderControls();
  };
  const handlers = {
    onText: apply,
    onError: (message: string) => notify(`${t('语音输入：')}${message}`),
    onEnd: () => { if (state.dictation?.session === session) { state.dictation = null; $('dictate').style.removeProperty('--level'); renderControls(); } },
    onLevel: (level: number) => $('dictate').style.setProperty('--level', Math.min(1, level * 3).toFixed(2)),
  };
  const plan = voicePlan();
  // Read through a function: the session is set and cleared by callbacks while this waits.
  const listening = (): Dictating | null => state.dictation;
  const listen = async (session: DictationSession, label: string) => {
    state.dictation = { session, owner, stopping: false, label }; renderControls();
    const started = await session.start();
    if (started && state.dictation?.session === session) { state.dictation.label = sourceName(started); renderControls(); }
    return started;
  };
  let session: DictationSession = plan.source ? nativeDictation(state.engine, handlers, { prefer: voicePick }) : browserDictation(handlers);
  notify('');
  try {
    let skipped: DictationSkip[] = [];
    try { skipped = (await listen(session, plan.label))?.skipped || []; }
    catch (err) {
      // No agent's service could start (signed out, app closed…): the browser's recognizer, if it has one.
      if (!(err instanceof VoiceUnavailable) || !plan.browser) throw err;
      skipped = err.skipped; void loadVoice();
      session = browserDictation(handlers);
      await listen(session, t('浏览器语音识别'));
    }
    if (skipped.length) { notify(`${t('语音输入：')}${skipsText(skipped)}${t('，已改用')}${listening()?.label || ''}`); void loadVoice(); }
  } catch (err) {
    if (listening()?.session === session) state.dictation = null;
    renderControls();
    notify(errorName(err) === 'NotAllowedError' ? t('语音输入：没有麦克风权限，请在浏览器地址栏允许使用麦克风') : err instanceof VoiceUnavailable && err.skipped.length ? `${t('语音输入：')}${skipsText(err.skipped)}` : `${t('语音输入：')}${messageOf(err)}`);
  }
}
async function finishDictation() {
  if (!state.dictation || state.dictation.stopping) return;
  state.dictation.stopping = true; renderControls();
  await state.dictation.session.stop();
}
function cancelDictation() {
  const current = state.dictation; if (!current) return;
  state.dictation = null; current.session.cancel(); renderControls();
}
async function stop() {
  const session = state.session;
  if (!session || $('stop').hidden || $('stop').disabled) return;
  const owner = currentKey(), view = state.view;
  const native = state.store.active?.source !== 'console';
  stopping.add(owner); renderControls();
  try {
    await request(`${endpoint()}/interrupt`, { method: 'POST' });
    if (native && view === state.view) await selectSession(session.id, { force: true, route: false });
  }
  catch (err) { if (view === state.view) notify(messageOf(err)); return; }
  finally { stopping.delete(owner); renderControls(); }
}
// Files go up as soon as they are picked, into the draft of the chat they were picked in (the
// person may have moved on before the upload ends). Uploads still on their way count towards
// the limit, so several picks in a row cannot go past it.
const uploadingFiles = new Map<string, number>();
async function uploadFiles(files: File[]): Promise<void> {
  if (!files.length || !capsOf().attachments) return;
  const owner = currentKey(), form = new FormData(); saveDraft();
  if (state.attachments.length + (uploadingFiles.get(owner) || 0) + files.length > 10) return notify(t('每条消息最多添加 10 个附件'));
  for (const file of files) form.append('files', file);
  uploads.set(owner, (uploads.get(owner) || 0) + 1); uploadingFiles.set(owner, (uploadingFiles.get(owner) || 0) + files.length); renderControls();
  try {
    const response = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || t('上传失败'));
    drafts.append(owner, data.files);
    if (owner === currentKey()) state.attachments.push(...data.files);
  } catch (err) { notify(messageOf(err)); }
  finally { uploads.set(owner, Math.max(0, (uploads.get(owner) || 1) - 1)); uploadingFiles.set(owner, Math.max(0, (uploadingFiles.get(owner) || 0) - files.length)); renderAttachments(); }
}
async function copy(text: string, button?: HTMLElement | null): Promise<void> {
  try { await navigator.clipboard.writeText(text); if (button) { button.innerHTML = icon('check'); button.title = t('已复制'); hydrateIcons(); } }
  catch { notify(t('无法写入剪贴板，请在会话信息中手动复制')); }
}
function showInfo() {
  const session = state.session;
  $('info-content').innerHTML = session ? `<dl><dt>${t('引擎')}</dt><dd>${escape(engine()?.label)}</dd><dt>${t('会话 ID')}</dt><dd>${escape(session.id)}</dd><dt>${t('工作目录')}</dt><dd>${escape(session.cwd || t('由桌面端管理'))}</dd><dt>${t('模型')}</dt><dd>${escape(session.metadata?.modelId || session.metadata?.model || t('桌面端默认模型'))}</dd>${session.metadata?.desktop?.model ? `<dt>${t('Web 端沿用的桌面设置')}</dt><dd>${escape([session.metadata.desktop.model, session.metadata.desktop.effort && `${t('推理')} ${session.metadata.desktop.effort}`, session.metadata.desktop.permissionMode && `${t('权限')} ${session.metadata.desktop.permissionMode}`].filter(Boolean).join(' · '))}${session.metadata.desktop.inherited ? t('（取自最近使用的桌面会话）') : ''}</dd>` : ''}<dt>${t('桌面端')}</dt><dd>${session.isDesktopActive ? t('活跃') : t('历史会话')}</dd></dl>` : ("<p>" + t('选择会话后查看工作目录与模型信息') + "</p>");
  $('info-dialog').showModal();
}
async function followRoute() {
  let provider, session;
  try { [provider, session] = location.hash.slice(1).split('/').map(decodeURIComponent); } catch { return; }
  if (provider && engine(provider)) {
    if (session) await selectSession(session, { engineId: provider, route: false });
    else await switchEngine(provider, { route: false });
  } else await switchEngine(state.engine);
}
$('engine-dock').addEventListener('click', event => { const button = closest(event.target, '[data-engine]'); if (button) switchEngine(data(button, 'engine')); });
$('session-search').addEventListener('input', renderSessionList);
// The mode switch is a menu, as the desktops' own: picking a mode shows its projects and chats;
// the open chat stays open only if it is in that mode.
function pickSpace(id: string): void {
  if (id === spaceId()) return;
  sidePrefs.setSpace(state.engine, id);
  const spaces = spacesOf(engine());
  if (state.session && !isInSpace(state.session, spaces, id)) switchEngine(state.engine, { restore: false });
  else { renderSessionList(); renderControls(); if (!state.session) renderConversation(); }
}
$('space-switch').addEventListener('click', event => {
  const button = closest(event.target, '[data-space-menu]');
  if (!button) return;
  button.setAttribute('aria-expanded', 'true');
  showMenu(button, spaceMenuItems(spacesOf(engine()), spaceId()), { label: button.getAttribute('aria-label') || '', onPick: item => pickSpace(item.value), onClose: () => button.setAttribute('aria-expanded', 'false') });
});
$('space-switch').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !closest(event.target, '[data-space-menu]')) return;
  event.preventDefault(); closest(event.target, '[data-space-menu]')?.click();
});
$('session-list').addEventListener('click', event => {
  const toggle = closest(event.target, '[data-project-toggle]'), more = closest(event.target, '[data-side-more]'), button = closest(event.target, '[data-session]'), plus = closest(event.target, '[data-project-new]');
  if (plus) newChat({ id: data(plus, 'projectNew'), name: plus.closest('.side-project')?.querySelector('.side-label')?.textContent || '', cwd: plus.dataset['cwd'] });
  else if (toggle) { sidePrefs.toggle(state.engine, data(toggle, 'projectToggle')); renderSessionList(); }
  else if (more) { const id = data(more, 'sideMore'); if (sidePrefs.more.has(id)) sidePrefs.more.delete(id); else sidePrefs.more.add(id); renderSessionList(); }
  else if (button) selectSession(data(button, 'session'));
});
// Drag the sidebar's right edge to resize it (arrow keys on the focused handle; double-click resets).
const applySidebarWidth = () => { if (sidePrefs.width) document.documentElement.style.setProperty('--sidebar-width', `${clampSidebarWidth(sidePrefs.width, innerWidth)}px`); else document.documentElement.style.removeProperty('--sidebar-width'); };
applySidebarWidth();
$('sidebar-resize').addEventListener('pointerdown', event => {
  if (event.button) return;
  event.preventDefault(); $('sidebar-resize').setPointerCapture(event.pointerId); document.body.classList.add('is-resizing');
  const left = $('sidebar').getBoundingClientRect().left;
  const move = (moved: PointerEvent) => { sidePrefs.width = clampSidebarWidth(moved.clientX - left, innerWidth); applySidebarWidth(); };
  const up = () => { $('sidebar-resize').removeEventListener('pointermove', move); document.body.classList.remove('is-resizing'); sidePrefs.save(); };
  $('sidebar-resize').addEventListener('pointermove', move); $('sidebar-resize').addEventListener('pointerup', up, { once: true }); $('sidebar-resize').addEventListener('pointercancel', up, { once: true });
});
$('sidebar-resize').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); sidePrefs.setWidth(clampSidebarWidth($('sidebar').getBoundingClientRect().width + (event.key === 'ArrowRight' ? 16 : -16), innerWidth)); applySidebarWidth();
});
$('sidebar-resize').addEventListener('dblclick', () => { sidePrefs.setWidth(0); applySidebarWidth(); });
addEventListener('resize', applySidebarWidth);
$('new-target').addEventListener('click', pickNewTarget);
$('new-target-path').addEventListener('keydown', event => {
  if (!['Enter', 'Escape'].includes(event.key) || event.isComposing) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === 'Enter') {
    const trimmed = $('new-target-path').value.trim();
    setNewTarget(/^[a-zA-Z]:[\\/]+$/.test(trimmed) ? trimmed.slice(0, 3) : trimmed.replace(/(.)[\\/]+$/, '$1'));
  }
  $('new-target-path').hidden = true; $('new-target').hidden = false; $('new-target').focus();
});
$('new-target-path').addEventListener('blur', () => { $('new-target-path').hidden = true; $('new-target').hidden = false; });
$('refresh').addEventListener('click', async () => { $('refresh').disabled = true; try { await refresh(); } catch (err) { notify(messageOf(err)); } finally { $('refresh').disabled = false; } });
$('new-chat').addEventListener('click', () => newChat());
for (const id of ['sidebar', 'engine-dock'] as const) $(id).addEventListener('click', event => { if (!closest(event.target, '#refresh')) refreshSoon(); });
window.addEventListener('focus', refreshSoon);
// Takes the person to this chat in the desktop app (capabilities.showInDesktop): the header's
// button, and the one on a card for what can only be done there (Approval: 'desktop').
async function showInDesktop(button: HTMLButtonElement): Promise<void> {
  if (!state.session) return;
  const view = state.view; button.disabled = true;
  try { await request(`${endpoint()}/show`, { method: 'POST' }); }
  catch (err) { if (view === state.view) notify(messageOf(err)); }
  finally { button.disabled = false; }
}
$('show-desktop').addEventListener('click', () => showInDesktop($('show-desktop') as HTMLButtonElement));
$('toggle-sidebar').addEventListener('click', () => sidebar(matchMedia('(max-width:767px)').matches ? !document.body.classList.contains('sidebar-open') : document.body.classList.contains('sidebar-hidden')));
for (const id of ['close-sidebar', 'sidebar-scrim'] as const) $(id).addEventListener('click', () => sidebar(false));
$('dismiss-notice').addEventListener('click', () => notify(''));
$('session-info').addEventListener('click', showInfo);
$('close-info').addEventListener('click', () => $('info-dialog').close());
$('model').addEventListener('change', () => { notePick('model'); renderEffort(); saveDraft(); });
$('effort').addEventListener('change', () => { notePick('effort'); saveDraft(); });
$('permission').addEventListener('change', () => notePick('permission'));
$('composer').addEventListener('submit', sendMessage);
$('stop').addEventListener('click', stop);
$('prompt').addEventListener('input', () => { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min(200, $('prompt').scrollHeight)}px`; saveDraft(); renderControls(); });
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
  else if (event.key === 'Tab' && !event.shiftKey && state.store.active && !$('queue').hidden && !$('queue').disabled) { event.preventDefault(); sendMessage(null, true); }
});
$('queue').addEventListener('click', () => sendMessage(null, true));
$('queue-list').addEventListener('click', async event => {
  const button = closest(event.target, '[data-dequeue]', HTMLButtonElement);
  const now = closest(event.target, '[data-send-now]', HTMLButtonElement);
  if (now) {
    now.disabled = true;
    try { await request(`${endpoint()}/send-now`, { method: 'POST' }); }
    catch (err) { notify(messageOf(err)); now.disabled = false; }
    return;
  }
  const steer = closest(event.target, '[data-queue-steer]', HTMLButtonElement), edit = closest(event.target, '[data-queue-edit]', HTMLButtonElement);
  if (steer) {
    steer.disabled = true;
    try { await request(`${endpoint()}/queue/${encodeURIComponent(data(steer, 'queueSteer'))}/steer`, { method: 'POST' }); notify(''); }
    catch (err) { notify(messageOf(err)); steer.disabled = false; }
    return;
  }
  if (edit) {
    // Back into the composer (ahead of anything typed since), with its attachments.
    edit.disabled = true;
    try {
      // The removed message, with its attachments (RunService.dequeue).
      const item = await request<{ prompt: string; attachments?: DraftAttachment[] }>(`${endpoint()}/queue/${encodeURIComponent(data(edit, 'queueEdit'))}`, { method: 'DELETE' });
      const prompt = $('prompt'), typed = prompt.value.trim();
      prompt.value = typed ? `${item.prompt}\n\n${prompt.value}` : item.prompt;
      const have = new Set(state.attachments.map(file => file.filename));
      state.attachments.push(...(item.attachments || []).filter(file => !have.has(file.filename)));
      prompt.dispatchEvent(new Event('input')); renderAttachments();
      prompt.focus(); prompt.setSelectionRange(item.prompt.length, item.prompt.length);
    } catch (err) { notify(messageOf(err)); edit.disabled = false; }
    return;
  }
  if (!button) return;
  button.disabled = true;
  try { await request(`${endpoint()}/queue/${encodeURIComponent(data(button, 'dequeue'))}`, { method: 'DELETE' }); }
  catch (err) { notify(messageOf(err)); button.disabled = false; }
});
$('attach').addEventListener('click', () => $('file-input').click());
$('dictate').addEventListener('click', toggleDictation);
$('file-input').addEventListener('change', () => { const input = $('file-input'); uploadFiles([...input.files || []]); input.value = ''; });
$('attachments').addEventListener('click', event => { const image = closest(event.target, 'img[data-viewer-src]'); if (image) { openImage(data(image, 'viewerSrc')); return; } const button = closest(event.target, '[data-remove]'); if (button) { state.attachments.splice(Number(button.dataset.remove), 1); saveDraft(); renderAttachments(); } });
$('prompt').addEventListener('paste', event => { const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { event.preventDefault(); uploadFiles(files); } });
let dragDepth = 0;
$('workspace').addEventListener('dragenter', event => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); dragDepth++; $('drop-zone').hidden = false; });
$('workspace').addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
$('workspace').addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop-zone').hidden = true; } });
$('workspace').addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-zone').hidden = true; uploadFiles([...event.dataTransfer?.files || []]); });
$('conversation').addEventListener('scroll', () => { const node = $('conversation'); state.follow = node.scrollHeight - node.scrollTop - node.clientHeight < 100; $('jump-bottom').hidden = state.follow; }, { passive: true });
// Any image in the conversation (tool screenshots, generated images, uploads) opens in a viewer
// on the page. Capture phase, so a thumbnail inside a collapsible row does not toggle the row.
const viewableImage = (target: EventTarget | null) => {
  const image = target instanceof Element ? target.closest('#timeline img') : null;
  const src = closest(image, '[data-viewer-src]')?.dataset['viewerSrc'] || image?.getAttribute('src') || '';
  return image && /^\/(api\/sessions\/[^/]+\/[^/]+\/media\/|uploads\/)/.test(src) ? src : '';
};
function openImage(src: string): void {
  $('image-viewer-img').src = src; $('image-viewer-open').href = src;
  if (!$('image-viewer').open) $('image-viewer').showModal();
}
// Listen on the scroll container: the timeline element itself is swapped per session.
// Side panel: files named in replies open here, read-only, beside the conversation (over it on
// narrow screens). Each opened file is a tab; Markdown shows rendered with its source a click away.
/** A file open in the side panel, from the chat it was named in. */
interface PanelTab { target: string; label: string; line: number; source: boolean; file: FilePreview | null; error: string; engine: string; session: string; scroll?: number }
const panel: { tabs: PanelTab[]; active: number; open: boolean; width: number } = { tabs: [], active: -1, open: false, width: 520 };
try { const saved: unknown = JSON.parse(storageFor('localStorage')?.getItem('desktop-bridge:side-panel') || '{}'), width = get(saved, 'width'); if (typeof width === 'number' && width) panel.width = width; } catch {}
const savePanel = () => { try { storageFor('localStorage')?.setItem('desktop-bridge:side-panel', JSON.stringify({ width: panel.width })); } catch {} };
const isMarkdown = (path: string | undefined) => /\.(md|mdx|markdown)$/i.test(path || '');
const fileName = (target: string) => target.replace(/:(\d+)(:\d+)?$/, '').split(/[\\/]/).filter(Boolean).at(-1) || target;
function setPanel(open: boolean): void {
  panel.open = open;
  $('side-panel').hidden = !open;
  $('side-panel').style.setProperty('--side-width', `${panel.width}px`);
  $('toggle-panel').setAttribute('aria-expanded', String(open));
  $('toggle-panel').setAttribute('aria-label', open ? t('关闭侧边栏') : t('打开侧边栏'));
  document.body.classList.toggle('has-side-panel', open);
  if (open) drawPanel();
}
function drawPanel() {
  const tab = panel.tabs[panel.active];
  $('side-tabs').innerHTML = panel.tabs.map((item, index) => `<div class="side-tab${index === panel.active ? ' is-active' : ''}" role="presentation"><button type="button" role="tab" aria-selected="${index === panel.active}" data-side-tab="${index}" title="${escape(item.target)}">${escape(fileName(item.target))}</button><button type="button" class="side-tab-close" data-side-close="${index}" aria-label="${t('关闭')} ${escape(fileName(item.target))}">${icon('x')}</button></div>`).join('');
  $('side-copy').hidden = !tab; $('side-mode').hidden = !tab?.file || !isMarkdown(tab.file.path);
  if (!tab) {
    $('side-meta').textContent = ''; $('side-file-actions').innerHTML = '';
    $('side-body').innerHTML = `<div class="side-empty">${icon('file-text')}<p>${t('点击回复里的文件链接，在这里预览')}</p><p class="side-hint">${t('只读预览，文件在原工作区里不会被改动')}</p></div>`;
    hydrateIcons($('side-panel')); return;
  }
  $('side-copy').dataset.path = tab.target;
  $('side-file-actions').innerHTML = actionButtons(fileActions({ fileManager: state.fileManager, engine: engine(tab.engine) }), 'icon-button');
  const label = tab.source ? t('查看排版') : t('查看源码');
  $('side-mode').setAttribute('aria-label', label); $('side-mode').title = label; $('side-mode').innerHTML = icon(tab.source ? 'book-open' : 'code');
  const file = tab.file;
  $('side-meta').textContent = tab.error || (!file ? t('正在读取…') : file.entries ? `${file.path} · ${t('{n} 项', { n: file.size })}${file.truncated ? t(' · 只显示开头部分') : ''}` : `${file.path} · ${file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`}${file.truncated ? t(' · 只显示开头部分') : ''}${tab.line ? ` ${t('· 第 {line} 行', { line: tab.line })}` : ''}`);
  if (!file) $('side-body').innerHTML = '';
  else if (file.entries) $('side-body').innerHTML = `<ul class="side-dir">${file.entries.map(entry => { const target = `${file.path}${entry.name}${entry.dir ? '/' : ''}`; return `<li><a class="file-link" href="#" data-file-path="${escape(target)}" title="${escape(target)}">${icon(entry.dir ? 'folder' : 'file')}<span>${escape(entry.name)}${entry.dir ? '/' : ''}</span></a></li>`; }).join('') || `<li class="side-hint">${t('空文件夹')}</li>`}</ul>`;
  else if (file.image) $('side-body').innerHTML = `<img class="side-image" src="${escape(file.image)}" alt="${escape(file.path)}">`;
  else if (isMarkdown(file.path) && !tab.source) $('side-body').innerHTML = `<div class="side-markdown assistant-message">${markdown(file.text)}</div>`;
  else {
    // A preview is a folder, an image or text (previewFile), so here it has text.
    const lines = (file.text ?? '').replace(/\n$/, '').split('\n');
    $('side-body').innerHTML = `<pre class="side-code">${lines.map((text, index) => `<span class="file-line${index + 1 === tab.line ? ' is-target' : ''}" data-line="${index + 1}">${escape(text) || ' '}</span>`).join('')}</pre>`;
  }
  hydrateIcons($('side-panel'));
  const target = $('side-body').querySelector('.is-target');
  if (target) target.scrollIntoView({ block: 'center' }); else $('side-body').scrollTop = tab.scroll || 0;
}
async function openFile(target: string, label = ''): Promise<void> {
  const line = Number(/:(\d+)(?::\d+)?$/.exec(target)?.[1] || 0);
  const owner = { engine: state.engine, session: state.session?.id || '' };
  const showing = panel.tabs[panel.active];
  if (showing) showing.scroll = $('side-body').scrollTop;
  let index = panel.tabs.findIndex(item => item.target === target && item.engine === owner.engine && item.session === owner.session);
  if (index < 0) {
    panel.tabs.push({ target, label, line, source: line > 0, file: null, error: '', ...owner });
    if (panel.tabs.length > 8) panel.tabs.shift();
    index = panel.tabs.length - 1;
  }
  panel.active = index; setPanel(true);
  const tab = panel.tabs[index];
  if (!tab || tab.file) return;
  try {
    tab.file = await request<FilePreview>(`/api/sessions/${encodeURIComponent(tab.engine)}/${encodeURIComponent(tab.session)}/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: target }) });
  } catch (err) { tab.error = messageOf(err) || t('读取文件失败'); }
  if (panel.tabs[panel.active] === tab) drawPanel();
}
// The file shown where the person works with it: selected in the file manager, or opened in the
// engine's desktop app, in the chat it came from (see js/file-actions.ts).
async function revealFile(where: string, { target, label = '', engine: id = state.engine, session = state.session?.id || '' }: { target: string; label?: string; engine?: string; session?: string }): Promise<void> {
  try {
    const result = await request<{ pressed?: boolean }>(`${sessionUrl(id, session)}/reveal`, { method: 'POST', body: JSON.stringify({ path: target, where, label }) });
    if (where === 'desktop' && result.pressed === false) notify(t('已在 {name} 里打开这个聊天，但没找到这个文件的链接', { name: engine(id)?.label || 'AI' }));
  } catch (err) { notify(messageOf(err)); }
}
filePopover({
  within: [$('conversation')],
  actions: () => state.session ? fileActions({ fileManager: state.fileManager, engine: engine() }) : [],
  run: (where, link) => revealFile(where, { target: data(link, 'filePath'), label: (link.textContent || '').trim() }),
});
$('side-file-actions').addEventListener('click', event => {
  const button = closest(event.target, '[data-file-action]'), tab = panel.tabs[panel.active];
  if (button && tab) revealFile(data(button, 'fileAction'), tab);
});
$('toggle-panel').addEventListener('click', () => setPanel(!panel.open));
$('side-close').addEventListener('click', () => { setPanel(false); $('toggle-panel').focus(); });
$('side-mode').addEventListener('click', () => { const tab = panel.tabs[panel.active]; if (tab) { tab.source = !tab.source; tab.scroll = 0; drawPanel(); } });
$('side-copy').addEventListener('click', () => copy($('side-copy').dataset.path || '', $('side-copy')));
$('side-tabs').addEventListener('click', event => {
  const close = closest(event.target, '[data-side-close]'), pick = closest(event.target, '[data-side-tab]');
  const showing = panel.tabs[panel.active];
  if (showing) showing.scroll = $('side-body').scrollTop;
  if (close) {
    const index = Number(close.dataset.sideClose);
    panel.tabs.splice(index, 1);
    if (panel.active >= index) panel.active = Math.max(0, panel.active - 1);
    if (!panel.tabs.length) panel.active = -1;
    drawPanel();
  } else if (pick) { panel.active = Number(pick.dataset.sideTab); drawPanel(); }
});
$('side-panel').addEventListener('keydown', event => { if (event.key === 'Escape') { setPanel(false); $('toggle-panel').focus(); } });
// Links inside a previewed Markdown file open the file they name, in a new tab.
$('side-body').addEventListener('click', event => {
  const link = closest(event.target, '[data-file-path]');
  if (link && !event.metaKey && !event.ctrlKey) { event.preventDefault(); openFile(data(link, 'filePath')); }
});
// Drag the left edge to resize; arrow keys do the same on the focused handle.
const clampWidth = (width: number) => Math.round(Math.min(Math.max(320, width), Math.max(360, innerWidth - 480)));
$('side-resize').addEventListener('pointerdown', event => {
  event.preventDefault(); $('side-resize').setPointerCapture(event.pointerId); document.body.classList.add('is-resizing');
  const move = (moved: PointerEvent) => { panel.width = clampWidth(innerWidth - moved.clientX); $('side-panel').style.setProperty('--side-width', `${panel.width}px`); };
  const up = () => { $('side-resize').removeEventListener('pointermove', move); document.body.classList.remove('is-resizing'); savePanel(); };
  $('side-resize').addEventListener('pointermove', move); $('side-resize').addEventListener('pointerup', up, { once: true });
});
$('side-resize').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); panel.width = clampWidth(panel.width + (event.key === 'ArrowLeft' ? 24 : -24));
  $('side-panel').style.setProperty('--side-width', `${panel.width}px`); savePanel();
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === '\\') { event.preventDefault(); setPanel(!panel.open); } });
$('conversation').addEventListener('click', event => {
  const fileLink = closest(event.target, '[data-file-path]');
  if (fileLink && !event.metaKey && !event.ctrlKey) { event.preventDefault(); event.stopPropagation(); openFile(data(fileLink, 'filePath'), (fileLink.textContent || '').trim()); return; }
  const src = viewableImage(event.target);
  if (!src || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault(); event.stopPropagation();
  openImage(src);
}, true);
$('image-viewer').addEventListener('click', event => { if (!closest(event.target, '.image-viewer-actions')) $('image-viewer').close(); });
$('close-image-viewer').addEventListener('click', () => $('image-viewer').close());
$('image-viewer').addEventListener('close', () => { $('image-viewer-img').removeAttribute('src'); });
$('jump-bottom').addEventListener('click', () => { state.follow = true; $('conversation').scrollTop = $('conversation').scrollHeight; $('jump-bottom').hidden = true; });
$('conversation').addEventListener('click', async event => {
  const button = closest(event.target, 'button', HTMLButtonElement); if (!button) return;
  if (button.dataset.action === 'new-chat') newChat();
  if (button.hasAttribute('data-copy-path')) copy(data(button, 'copyPath'), button);
  if (button.dataset.copyTurn) copy(state.store.turns.find(turn => turn.id === button.dataset.copyTurn)?.messages.filter(item => item.phase !== 'commentary').map(item => item.text).join('\n\n') || '', button);
  if (button.dataset.approval && button.dataset.decision === 'desktop') { await showInDesktop(button); return; }
  if (button.dataset.approval) { button.disabled = true; try { await request(`${endpoint()}/approvals/${encodeURIComponent(button.dataset.approval)}`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision }) }); } catch (err) { notify(messageOf(err)); button.disabled = false; } }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.dictation) { event.preventDefault(); cancelDictation(); return; }
  if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) sidebar(false);
  if (event.altKey && /^Digit[1-9]$/.test(event.code) && !event.isComposing) { const provider = state.engines[Number(event.code.slice(-1)) - 1]; if (provider) { event.preventDefault(); switchEngine(provider.id); } return; }
  if (!(event.metaKey || event.ctrlKey)) return;
  // ⌘N / Ctrl+N belong to the browser (a new window) and never reach the page, so a new
  // chat is ⌘⇧O / Ctrl+Shift+O, which browsers let a page take.
  if (event.key.toLowerCase() === 'k' && !event.shiftKey) { event.preventDefault(); sidebar(true); $('session-search').focus(); }
  if (event.key.toLowerCase() === 'o' && event.shiftKey) { event.preventDefault(); newChat(); }
});
// Shortcut hints in the keys of this computer: ⌘ on a Mac, Ctrl elsewhere.
if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  for (const kbd of document.querySelectorAll<HTMLElement>('kbd[data-keys]')) kbd.textContent = (kbd.dataset.keys || '').replace('mod', 'Ctrl').replace('shift', 'Shift');
}
window.addEventListener('popstate', followRoute);
window.addEventListener('pageshow', event => { if (event.persisted) { connectOverview(); if (state.session) selectSession(state.session.id, { force: true, route: false }); loadUsage(); } });
window.addEventListener('pagehide', () => { saveDraft(); closeStream(); state.overview?.close(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { markCurrentRead(); renderDock(); renderSessionList(); loadUsage(); refreshSoon(); void loadVoice(); } });
matchMedia('(max-width:767px)').addEventListener('change', () => { document.body.classList.remove('sidebar-open', 'sidebar-hidden'); $('sidebar-scrim').hidden = true; $('workspace').inert = false; const bar = find(document, '.control-bar'); if (bar) bar.inert = false; $('sidebar').inert = matchMedia('(max-width:767px)').matches; });

// The "+" after the dock: a prompt anyone can give their own desktop AI so it joins this
// console the same way the existing engines do (see skills/add-desktop-engine).
// The guide is written once, in English (an agent reads it, whatever language the person uses).
const skillPath = (dir: string): string => {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir}${sep}skills${sep}add-desktop-engine${sep}SKILL.md`;
};
function onboardingPrompt() {
  if (language === 'en') return onboardingPromptEn();
  const dir = state.projectDir || '<工作台项目目录>', skill = skillPath(dir);
  const joined = state.engines.map(item => item.label).join('、') || '无';
  return `你是我这台电脑上的桌面版 AI。请把你自己接入我本机的「Agent Frontdesk」统一工作台，做到和工作台里的 Claude、Codex 一样：我能在工作台里看你的历史、给你发消息、停止、插话、排队、改模型和推理强度、新建聊天、回答你的提问卡片，而这一切都由你的桌面版自己执行，桌面版里实时看得到。

- 项目目录：${dir}
- 工作台地址：${location.origin}（目前已接入：${joined}）
- 操作手册（skill）：${skill}

你不用做页面。左栏的项目和聊天、右栏的文件预览、左边 Agent 栏的角色 / 对话框 / 额度、新建聊天和在项目里新建、回复里的代码 / 公式 / 图表 / 工具调用 / 步骤清单 / 卡片、输入框下面的模型 / 推理强度 / 权限、发送 / 停止 / 插话 / 排队，都已经是现成的共用件。你只做三件事：只读地接自己的数据；为每个动作选好把消息送进你桌面版的通道；在插件里声明你能做什么。

请用你平时的工作方式来做：开始前用你自带的任务清单 / 计划功能列出步骤，做完一步更新一步；自己跑命令、打开页面看效果，不要只读代码就说完成。

请这样做：
1. 先完整读手册（英文），以及 references/ 下的设计哲学、选通道、能力链路、插件契约、验收清单，再读 docs/architecture.md。插件用 TypeScript 写在 src/server/plugins/<你的引擎 id>.plugin.ts，导出 about（名字、主色、应用图标，以及只探测这台电脑上有没有你的桌面版的 detect，不能有副作用）和 setup（启用时才运行，停用时要能把它起的东西全部放掉）；数据适配写在 src/server/ 下，形状以 src/shared/contract.ts 为准，字段写错构建就会失败。照着和你最像的现有插件写（全走辅助程序的 Claude、官方接口加窗口间通道的 Codex、全走本机服务的 Antigravity）。开发时用 npm run dev（改前端即时生效，改服务端自动重启）。
2. 摸清你在本机的数据（只读，不改）：会话记录、项目归属和顺序、"正在跑"和"结束了"的原生证据、每个会话的模型 / 推理强度 / 权限、步骤清单和提问卡片在记录里的样子。
3. 选通道，写成表放进 docs/skins/<你的引擎 id>/progress.md：发送、插话、停止、改设置、新建、回答卡片、打开文件各走哪条路，附证据。每条都要满足：这一轮由你的桌面版自己的进程执行、桌面版里马上显示为我本人发的、不用别人的令牌。优先用你桌面版进程对外的接口（像 Codex 的 app-server 队列、Antigravity 的 language server），其次是桌面版窗口之间的协调通道（像 Codex 的 IPC），都不行才用工作台共用的辅助功能驱动（像 Claude），只写步骤和控件名，不重写动作。绝不另起一个 CLI 进程去跑这一轮；通道做不到就不发，并说明原因（插话做不到就退回排队）。
4. 按手册的阶段做：只读能看 → 发送和实时 → 停止、插话、排队 → 设置跟着走 → 新建 → 卡片和文件 → 长得像。每个阶段打开页面看一遍。
5. 我在工作台改了的模型 / 推理强度 / 权限，要先在你的桌面版里改过去再发；改不成就不发。不要做只读模式，也不要因为会话正在桌面版里运行就禁止发送：我自己保证不会两边同时写。
6. 不读取其他程序的私有令牌或密钥；你自己官方 CLI 的登录凭据可以在服务端现读现用（例如额度），但不能进页面、日志、测试和文件。需要我授权的事（例如辅助功能权限）先问我。你的桌面版有自家的语音识别时，接上 dictate 和 dictationReady，话筒就多一个可用的来源。
7. 想更像你的桌面版，只填插件的 look、改套件的 --kit-* 变量，你独有的东西用渲染器补；不复制套件样式，不在共用代码里写死你的名字。除非我明确要求一比一还原，否则不用截图对比。
8. 做完后运行 npm run build、npm test 和 npm run check（含类型检查），都要通过；按手册第 4 步用最便宜的模型真实走一遍（先问我同意）：发一条、换模型再发、运行中插话和停止、作答一次卡片，确认桌面版里都看得到；按验收清单逐项核对。结束前关掉你开的后台进程。
9. 最后告诉我：改了哪些文件；通道表；哪些做到了，哪些做不到以及原因；共用件不够用、需要新增的地方；我还需要做什么（例如登录、授权、重启工作台服务后在 Agent 栏的「+」里把你打开、删掉测试会话）。

如果工作台里已经有你（${joined}），这次按验收清单补齐缺的数据和能力。`;
}
// The same prompt for a person using Frontdesk in English; it points at the English guide.
function onboardingPromptEn() {
  const dir = state.projectDir || '<Frontdesk project folder>', skill = skillPath(dir);
  const joined = state.engines.map(item => item.label).join(', ') || 'none';
  return `You are the desktop AI on this computer. Please connect yourself to "Agent Frontdesk", the console on this machine, so that you can do everything Claude and Codex already do there: I can read your history in Frontdesk, send you messages, stop you, steer a running turn, queue messages, change the model and reasoning effort, start new chats and answer your question cards, while every bit of it is carried out by your own desktop app and shows up there live.

- Project folder: ${dir}
- Frontdesk: ${location.origin} (connected so far: ${joined})
- Guide (skill): ${skill}

You do not build pages. The left sidebar of projects and chats, the right-hand file preview, the agent rail's character / speech bubble / quota, new chats and new chats in a project, code / maths / diagrams / tool calls / step lists / cards in replies, the model / reasoning effort / permission menus under the composer, and send / stop / steer / queue are all shared parts already. You do three things: connect your own data, read-only; pick, for each action, the channel that carries messages into your desktop app; and declare in your plugin what you can do.

Work the way you normally do: before you start, list the steps with your own task list or plan feature and update it as each one finishes; run commands and open the page to look at the result yourself, and never call something done from reading code alone.

Please:
1. Read the whole guide first, plus the philosophy, choosing channels, capability paths, plugin contract and acceptance checklist under references/, then docs/architecture.md. Write your plugin in TypeScript as src/server/plugins/<your engine id>.plugin.ts, exporting about (your name, colour and app icon, and a detect that only looks whether your desktop app is on this machine, with no side effects) and setup (run only when you are switched on, and able to release everything it started when you are switched off); your data adapter goes under src/server/. The shapes come from src/shared/contract.ts, and a wrong field fails the build. Model your work on the existing plugin most like you (Claude: everything through the accessibility helper; Codex: an official interface plus the window-to-window channel; Antigravity: everything through a local service). While you work, run npm run dev (page changes show at once, server changes restart it).
2. Find out your data on this machine (read-only, change nothing): session records, project membership and order, the native evidence for "running" and "ended", each session's model / reasoning effort / permissions, what step lists and question cards look like in the record.
3. Pick the channels and put them in a table in docs/skins/<your engine id>/progress.md: which route sending, steering, stopping, changing settings, new chats, answering cards and opening files each take, with evidence. Every one must meet three conditions: the turn is run by your desktop app's own process, your desktop app shows the message right away as my own, and no one else's token is used. Prefer an interface your desktop process exposes (like Codex's app-server queue or Antigravity's language server), then the channel between your desktop's own windows (like Codex's IPC), and only then the shared accessibility driver (like Claude), writing only your steps and control names, never the actions again. Never start a separate CLI process to run the turn; when a channel cannot do something, do not send, and say why (a steer that cannot join falls back to the queue).
4. Build in the guide's stages: read-only and visible → sending and live updates → stop, steer, queue → settings follow the message → new chats → cards and files → looking like yourself. Open the page and look after each stage.
5. When I change the model / reasoning effort / permissions in Frontdesk, change it in your desktop app first, then send; if it cannot be changed, do not send. Do not add a read-only mode, and do not block sending because a session is running in the desktop app: I make sure I never write from both places at once.
6. Do not read other programs' private tokens or keys; your own official CLI's sign-in credentials may be read on the server at the moment of use (for quota, say), but never in the page, logs, tests or files. Ask me first for anything that needs my authorization (Accessibility permission, for example). If your desktop app has its own speech-to-text, wire up dictate and dictationReady: the microphone gains one more source it can use.
7. To look more like your desktop app, only fill in the plugin's look field and the kit's --kit-* variables, and register renderers for what only you have; do not copy the kit's styles or hard-code your name in shared code. Unless I explicitly ask for a one-to-one match, no screenshot comparison is needed.
8. When done, run npm run build, npm test and npm run check (which includes the type check); all must pass; following step 4 of the guide, try it for real with the cheapest model (ask me first): send one message, change the model and send again, steer and stop a running turn, answer one card, and confirm all of it shows in your desktop app; go through the acceptance checklist item by item. Close any background processes you started before you finish.
9. Finally tell me: which files you changed; the channel table; what works and what does not, and why; where the shared parts fell short and need a new extension point; what I still need to do (sign in, authorize, restart the Frontdesk server and switch you on under the rail's "+", delete test chats, for example).

If you are already in Frontdesk (${joined}), this time fill in the data and capabilities the acceptance checklist says are missing.`;
}
// A wrap-up card's app button (commit, open a PR…), pressed on the desktop's own card in this chat.
async function pressAction(action: CardAction): Promise<boolean> {
  if (!state.session) return false;
  const name = engine()?.label || t('桌面版');
  try {
    await request(`${endpoint()}/actions`, { method: 'POST', body: JSON.stringify(action) });
    notify(t('已在 {name} 里按下「{label}」', { name, label: action.label }));
    return true;
  } catch (err) { notify(messageOf(err)); return false; }
}
// The desktop's own buttons on a wrap-up card, read from the desktop once per card.
async function readCard(card: WrapUpCard): Promise<CardRead | { error: string }> {
  if (!state.session) return { error: t('这个操作只能在桌面版里点') };
  try { return await request<CardRead>(`${endpoint()}/card`, { method: 'POST', body: JSON.stringify(card) }); }
  catch (err) { return { error: messageOf(err) }; }
}
function openOnboard(): void {
  for (const id of ['agents-dialog', 'settings-dialog'] as const) if ($(id).open) $(id).close();
  $('onboard-prompt').textContent = onboardingPrompt();
  $('onboard-path').textContent = `${t('手册位置：')}${skillPath(state.projectDir || `<${t('工作台项目目录')}>`)}`;
  $('copy-skill-path').disabled = !state.projectDir;
  $('copy-onboard').textContent = t('复制提示词');
  $('onboard-dialog').showModal();
}
$('close-onboard').addEventListener('click', () => $('onboard-dialog').close());
$('copy-onboard').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('onboard-prompt').textContent); $('copy-onboard').textContent = t('已复制'); }
  catch { const range = document.createRange(); range.selectNodeContents($('onboard-prompt')); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); $('copy-onboard').textContent = t('已选中，按 ⌘C 复制'); }
});
$('copy-skill-path').addEventListener('click', async () => {
  if (!state.projectDir) return;
  try { await navigator.clipboard.writeText(skillPath(state.projectDir)); $('copy-skill-path').textContent = t('已复制路径'); setTimeout(() => { $('copy-skill-path').textContent = t('复制手册路径'); }, 1600); } catch {}
});

// ---------- agents on and off ----------
// An agent is a plugin on the server: switched on, it is set up there (its bridge starts, its
// engine joins the lists) and takes its place in the rail; switched off, it is taken away and the
// page lets go of everything it showed of it. Its desktop app is never touched by either. The
// switches are in the rail's "+" dialog, in settings, and on the page shown while none is on;
// right-clicking an agent in the rail removes it too. Another page that switches one is followed
// through the overview stream (connectOverview).
const agentsView = newAgentsView();
// In settings each row can also be edited and dragged (the name, faces and order the person gives an agent).
const agentsMarkup = (editable = false) => agentRows(state.agents, { view: agentsView, statuses: state.statuses, editable, icon, face: (entry, working) => character(engine(entry.id) || entry, { working }) });
// An AI that is not in the list connects itself, from the prompt this opens.
const onboardEntry = () => `<button type="button" class="agent-more" data-open-onboard>${icon('plus')}<span class="agent-text"><span class="agent-name">${t('接入其他桌面 AI')}</span><span class="agent-note">${t('列表里没有的，把一段提示词发给它，它会照着手册自己接进来')}</span></span>${icon('chevron-right')}</button>`;
function renderAgents(): void {
  // The control that has the keyboard keeps it when its row is drawn again, and a name being
  // typed keeps what was typed so far (the rows are drawn again whenever an agent's state changes).
  const focused = closest(document.activeElement, '[data-agent-toggle], [data-agent-edit], [data-agent-label], [data-agent-move]'), holder = focused?.closest('#agents-content, #settings-agents, #welcome-agents')?.id;
  const typing = focused instanceof HTMLInputElement && focused.dataset.agentLabel !== undefined ? { value: focused.value, start: focused.selectionStart, end: focused.selectionEnd } : null;
  const selector = focused ? ['agentToggle', 'agentEdit', 'agentLabel', 'agentMove'].flatMap(key => focused.dataset[key] === undefined ? [] : [`[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(focused.dataset[key] || '')}"]${key === 'agentMove' ? `[data-step="${CSS.escape(focused.dataset['step'] || '')}"]` : ''}`])[0] : '';
  if ($('agents-dialog').open) { setHTML($('agents-content'), agentsMarkup() + onboardEntry()); hydrateIcons($('agents-content')); }
  for (const id of ['settings-agents', 'welcome-agents']) { const box = document.getElementById(id); if (box) { setHTML(box, agentsMarkup(id === 'settings-agents')); hydrateIcons(box); } }
  if (focused && holder && selector && !focused.isConnected) {
    const again = find(document.getElementById(holder), selector);
    if (again instanceof HTMLInputElement && typing) { again.value = typing.value; again.setSelectionRange(typing.start, typing.end); }
    if (again instanceof HTMLButtonElement && again.disabled) find(document.getElementById(holder), `[data-agent-editor] [data-agent-move]:not([disabled])`)?.focus({ preventScroll: true });
    else again?.focus({ preventScroll: true });
  }
}
function openAgents(): void {
  if (!$('agents-dialog').open) $('agents-dialog').showModal();
  renderAgents();
  // What the dialog says is read again as it opens: whether each desktop app is here, and whether it answers.
  void syncEngines();
  request<Record<string, EngineStatus>>('/api/status').then(statuses => { state.statuses = statuses; renderDock(); renderAgents(); }, () => {});
}
// An engine's stylesheet and page modules, loaded once (an agent switched off and on again has them already).
const skinsLoaded = new Set<string>();
async function loadSkin(item: EngineManifest): Promise<void> {
  const stylesheet = item.skin?.stylesheet;
  if (typeof stylesheet === 'string' && /^\/skins\/[\w-]+\/[\w.-]+\.css$/.test(stylesheet) && !skinsLoaded.has(stylesheet)) { skinsLoaded.add(stylesheet); document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: stylesheet })); }
  for (const moduleUrl of [...(item.uiModules || []), ...(item.skin?.module ? [item.skin.module] : [])]) {
    if (!/^\/skins\/[\w-]+\/[\w.-]+\.mjs$/.test(moduleUrl) || skinsLoaded.has(`${item.id} ${moduleUrl}`)) continue;
    skinsLoaded.add(`${item.id} ${moduleUrl}`);
    try { const plugin = await import(/* @vite-ignore */ moduleUrl); plugin.setup?.({ registerRenderer, engine: item.id, helpers: { escape, icon, markdown, character } }); }
    catch (err) { console.error(`Skin module failed: ${moduleUrl}`, err); }
  }
}
// Every engine's chats and projects, whether it can be reached, and its models.
async function loadLists(): Promise<void> {
  const results = await Promise.allSettled([refresh(), request<Record<string, EngineStatus>>('/api/status'), request<Record<string, Model[] | unknown>>('/api/models')]);
  if (results[0].status === 'rejected') notify(`${t('读取会话失败：')}${messageOf(results[0].reason)}`);
  if (results[1].status === 'fulfilled') state.statuses = results[1].value;
  if (results[2].status === 'fulfilled') { const models = results[2].value; for (const item of state.engines) { const listed = models[item.id]; state.models[item.id] = Array.isArray(listed) ? listed : []; } }
}
// Everything the page holds of an engine that left: its lists, the chats kept open, what it said
// in the rail, files of its chats in the side panel. What the person wrote stays (drafts, the chat
// last open, which projects were folded): if the agent is switched on again it is as they left it.
function forgetEngine(id: string): void {
  delete state.sessions[id]; delete state.projects[id]; delete state.models[id]; delete state.statuses[id]; delete state.usage[id]; delete state.refreshErrors[id];
  for (const key of [...views.keys()]) if (isViewOf(id, key)) views.delete(key);
  for (const book of [dockMarkup, counted, staged, heard]) book.delete(id);
  state.activity = state.activity.filter(item => item.engine !== id); state.notices = state.notices.filter(item => item.engine !== id);
  const showing = panel.tabs[panel.active];
  panel.tabs = panel.tabs.filter(tab => tab.engine !== id); panel.active = showing && panel.tabs.includes(showing) ? panel.tabs.indexOf(showing) : panel.tabs.length - 1;
  if (panel.open) drawPanel();
  if (newProject?.engine === id) newProject = null;
  if (newOptions.engine === id) newOptions.reset(null);
  newOptions.kept.delete(id);
}
// No agent is left: no chat, no engine, the page shown is the one that offers the agents (emptyView).
function leaveAgents(): void {
  rememberView(); state.controller?.abort(); ++state.view; closeStream();
  state.engine = ''; state.session = null; state.store = createStore(); state.loading = false; state.refreshing = false; state.follow = true;
  renderedTurns = new Map(); $('timeline').replaceWith(Object.assign(document.createElement('div'), { id: 'timeline', className: 'timeline' }));
  $('prompt').value = ''; state.attachments = []; notify(''); setPanel(false);
  if (matchMedia('(max-width:767px)').matches) sidebar(false);
  window.history.replaceState(null, '', location.pathname + location.search);
}
// The page is brought in line with the server's agents: the ones that came are loaded and take
// their place, the ones that left are let go of. One at a time, in the order asked, so the answer
// to the latest change is the one that stays.
const seenOf = (manifest: EnginesResponse) => JSON.stringify([manifest.engines, manifest.agents, manifest.dictation]);
let enginesSeen = '', syncing: Promise<void> = Promise.resolve();
function syncEngines(given?: EnginesResponse): Promise<void> {
  const next = syncing.then(() => applyEngines(given));
  syncing = next.catch(() => {});
  return next;
}
async function applyEngines(given?: EnginesResponse): Promise<void> {
  const manifest = given || await request<EnginesResponse>('/api/engines');
  if (!Array.isArray(manifest.engines)) return;
  if (seenOf(manifest) === enginesSeen) { renderAgents(); return; }
  enginesSeen = seenOf(manifest);
  const before = state.engines.map(item => item.id), now = new Set(manifest.engines.map(item => item.id));
  const added = manifest.engines.filter(item => !before.includes(item.id)), removed = before.filter(id => !now.has(id)), first = !before.length;
  state.engines = manifest.engines; state.agents = manifest.agents || []; state.voice = manifest.dictation;
  for (const item of added) await loadSkin(item);
  if (removed.length) cancelDictation();
  // The agent whose chat was open has left: the first one still here takes the page, or none does.
  if (!engine(state.engine)) {
    const stays = state.engines[0];
    if (stays) await switchEngine(stays.id); else leaveAgents();
  }
  for (const id of removed) forgetEngine(id);
  renderHeader(); renderDock(); renderSessionList(); renderControls(); renderAgents();
  if (!state.session) renderConversation();
  if ($('usage-dialog').open) renderUsage();
  if (!added.length) return;
  // The agents that came: their chats, whether their desktop answers, their models and quota.
  await loadLists(); loadUsage();
  if (added.some(item => item.id === state.engine)) { renderModels(); renderHeader(); renderControls(); }
  renderDock(); renderAgents();
  // The first agent to be switched on opens where the person left it, as the page does when it loads.
  if (first && engine(state.engine) && !state.session && !$('prompt').value.trim()) await switchEngine(state.engine);
}
async function toggleAgent(id: string, on: boolean, force = false): Promise<void> {
  if (agentsView.pending.has(id)) return;
  agentsView.pending.set(id, on); agentsView.errors.delete(id); agentsView.ask = null; renderAgents();
  // Outside the dialogs (the rail's menu) there is no row to say what went wrong: the notice does.
  const inDialog = () => $('agents-dialog').open || $('settings-dialog').open || !state.engines.length;
  try {
    const result = await answer<Partial<EnginesResponse> & { error?: string; busy?: AgentBusy }>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled: on, ...(force ? { force: true } : {}) }) });
    agentsView.pending.delete(id);
    const busy = result.data.busy;
    // The console still holds work for it: say what would be dropped, and wait for the person's word.
    if (result.status === 409 && busy) { agentsView.ask = { id, busy: { running: Number(busy.running) || 0, queued: Number(busy.queued) || 0 } }; if (inDialog()) renderAgents(); else openAgents(); return; }
    if (!result.ok) { const reason = result.data.error || `Request failed (${result.status})`; agentsView.errors.set(id, reason); if (!inDialog()) notify(say(reason)); }
    const { engines, agents } = result.data;
    if (engines && agents) await syncEngines({ defaultCwd: state.defaultCwd, projectDir: state.projectDir, httpsPort: state.httpsPort, fileManager: state.fileManager || '', dictation: state.voice, ...result.data, engines, agents });
    else renderAgents();
  } catch (err) { agentsView.pending.delete(id); agentsView.errors.set(id, messageOf(err)); if (inDialog()) renderAgents(); else notify(messageOf(err)); }
}
// An agent's name, faces and place in the rail, changed in settings (the console's own parts:
// the desktop apps are not touched). Each change goes to the server, which every page follows.
async function editAgent(id: string, what: string, url: string, options: RequestOptions): Promise<void> {
  if (agentsView.saving.has(id)) return;
  agentsView.saving.set(id, what); agentsView.editErrors.delete(id); renderAgents();
  try {
    const result = await answer<Partial<EnginesResponse> & { error?: string }>(url, options);
    agentsView.saving.delete(id);
    if (!result.ok) agentsView.editErrors.set(id, result.data.error || `Request failed (${result.status})`);
    const { engines, agents } = result.data;
    if (result.ok && engines && agents) await syncEngines({ defaultCwd: state.defaultCwd, projectDir: state.projectDir, httpsPort: state.httpsPort, fileManager: state.fileManager || '', dictation: state.voice, ...result.data, engines, agents });
    else renderAgents();
  } catch (err) { agentsView.saving.delete(id); agentsView.editErrors.set(id, messageOf(err)); renderAgents(); }
}
const agentPath = (id: string) => `/api/agents/${encodeURIComponent(id)}`;
const renameAgent = (id: string, label: string | null) => {
  const current = state.agents.find(item => item.id === id)?.custom?.label || '';
  if ((label || '').trim() === current) return;
  void editAgent(id, 'label', agentPath(id), { method: 'PATCH', body: JSON.stringify({ label }) });
};
const reorderAgents = (id: string, order: string[]) => void editAgent(id, 'order', '/api/agents/order', { method: 'PUT', body: JSON.stringify({ order }) });
// Moved to `to` (an index in the list as it is shown).
function moveAgent(id: string, to: number): void {
  const ids = state.agents.map(item => item.id), from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || to === from) return;
  ids.splice(from, 1); ids.splice(to, 0, id);
  reorderAgents(id, ids);
}
// A picture for a face: a still one is cropped to a centred square no larger than 256 pixels (a
// face is at most 72 across), which also leaves behind what the file says about where it was
// taken; a moving one (GIF, animated PNG or WebP) is sent as it is, or it would stop moving.
const moving = (bytes: Uint8Array, type: string): boolean => {
  if (type === 'image/gif') return true;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  return type === 'image/png' ? head.slice(0, head.indexOf('IDAT') >>> 0).includes('acTL') : type === 'image/webp' && head.includes('ANIM');
};
async function avatarBody(file: File): Promise<Blob> {
  if (!AVATAR_TYPES.includes(file.type)) throw new Error(t('只支持 PNG、JPEG、GIF、WebP 图片'));
  if (moving(new Uint8Array(await file.arrayBuffer()), file.type)) { if (file.size > AVATAR_MAX_BYTES) throw new Error(t('图片不能超过 2 MB')); return file; }
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(t('这张图片读不出来')); }
  const side = Math.min(bitmap.width, bitmap.height), size = Math.min(256, side), canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')?.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(t('这张图片读不出来'));
  return blob;
}
async function uploadAvatar(id: string, slot: string, file: File): Promise<void> {
  let body: Blob;
  try { body = await avatarBody(file); } catch (err) { agentsView.editErrors.set(id, messageOf(err)); renderAgents(); return; }
  await editAgent(id, slot, `${agentPath(id)}/avatar/${encodeURIComponent(slot)}`, { method: 'PUT', body, headers: { 'Content-Type': body.type || 'application/octet-stream' } });
}
document.addEventListener('click', event => {
  const edit = closest(event.target, '[data-agent-edit]'), reset = closest(event.target, '[data-agent-reset]'), move = closest(event.target, '[data-agent-move]'), unname = closest(event.target, '[data-agent-label-reset]');
  if (edit) { const id = data(edit, 'agentEdit'); agentsView.editing = agentsView.editing === id ? null : id; agentsView.editErrors.delete(id); renderAgents(); }
  else if (reset) { const id = data(reset, 'agentReset'), slot = data(reset, 'slot'); void editAgent(id, slot, `${agentPath(id)}/avatar/${encodeURIComponent(slot)}`, { method: 'DELETE' }); }
  else if (move) { const id = data(move, 'agentMove'); moveAgent(id, state.agents.findIndex(item => item.id === id) + Number(data(move, 'step'))); }
  else if (unname) renameAgent(data(unname, 'agentLabelReset'), null);
});
document.addEventListener('change', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.agentUpload !== undefined) { const file = target.files?.[0]; target.value = ''; if (file) void uploadAvatar(target.dataset.agentUpload, target.dataset.slot || '', file); }
  else if (target.dataset.agentLabel !== undefined) renameAgent(target.dataset.agentLabel, target.value);
});
document.addEventListener('keydown', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.dataset.agentLabel === undefined) return;
  // Enter keeps the name; Escape puts back the one kept, without closing the dialog.
  if (event.key === 'Enter') { event.preventDefault(); renameAgent(target.dataset.agentLabel, target.value); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); target.value = state.agents.find(item => item.id === target.dataset.agentLabel)?.custom?.label || ''; }
});
// Dragging a row by its handle into the rail's order (settings): where it would land is drawn as a
// line above or below the row under the pointer.
let draggingAgent = '';
const dropPlace = (event: DragEvent): { row: HTMLElement; after: boolean } | null => {
  const row = closest(event.target, '#settings-agents .agent-row');
  if (!row || !draggingAgent) return null;
  const box = row.getBoundingClientRect();
  return { row, after: event.clientY > box.top + box.height / 2 };
};
const clearDrop = () => { for (const row of findAll(document, '#settings-agents .agent-row')) row.classList.remove('is-drop-before', 'is-drop-after', 'is-dragging'); };
document.addEventListener('dragstart', event => {
  const grip = closest(event.target, '[data-agent-grip]');
  if (!grip) return;
  draggingAgent = data(grip, 'agentGrip');
  const row = grip.closest('.agent-row');
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', draggingAgent); if (row) event.dataTransfer.setDragImage(row, 24, 24); }
  requestAnimationFrame(() => row?.classList.add('is-dragging'));
});
document.addEventListener('dragover', event => {
  const place = dropPlace(event);
  if (!place) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  for (const row of findAll(document, '#settings-agents .agent-row')) { row.classList.toggle('is-drop-before', row === place.row && !place.after); row.classList.toggle('is-drop-after', row === place.row && place.after); }
});
document.addEventListener('drop', event => {
  const place = dropPlace(event), id = draggingAgent;
  if (!place) return;
  event.preventDefault(); clearDrop(); draggingAgent = '';
  const ids = state.agents.map(item => item.id).filter(item => item !== id), at = ids.indexOf(data(place.row, 'agent'));
  if (at < 0) return;
  ids.splice(at + (place.after ? 1 : 0), 0, id);
  if (ids.join() !== state.agents.map(item => item.id).join()) reorderAgents(id, ids);
});
document.addEventListener('dragend', () => { draggingAgent = ''; clearDrop(); });
$('add-engine').addEventListener('click', openAgents);
$('close-agents').addEventListener('click', () => $('agents-dialog').close());
$('agents-dialog').addEventListener('close', () => { agentsView.ask = null; });
document.addEventListener('click', event => {
  const toggle = closest(event.target, '[data-agent-toggle]'), force = closest(event.target, '[data-agent-force]');
  if (toggle) void toggleAgent(data(toggle, 'agentToggle'), toggle.getAttribute('aria-checked') !== 'true');
  else if (force) void toggleAgent(data(force, 'agentForce'), false, true);
  else if (closest(event.target, '[data-agent-cancel]')) { agentsView.ask = null; renderAgents(); }
  else if (closest(event.target, '[data-open-onboard]')) openOnboard();
});
// Right-click an agent in the rail: take it out of the rail, or open the list of agents.
$('engine-dock').addEventListener('contextmenu', event => {
  const tile = closest(event.target, '[data-engine]');
  if (!tile) return;
  event.preventDefault();
  const id = data(tile, 'engine'), name = engine(id)?.label || id;
  showMenu(tile, [...(state.agents.some(item => item.id === id) ? [{ value: 'off', label: t('从 Agent 栏移除') }] : []), { value: 'manage', label: t('管理 Agent…') }],
    { label: name, at: { x: event.clientX, y: event.clientY }, onPick: item => { if (item.value === 'off') void toggleAgent(id, false); else openAgents(); } });
});

// Appearance: theme (system / light / dark) and where the dock's speech bubble sits.
const readSetting = (key: string, fallback: string, allowed: string[]): string => { try { const value = storageFor('localStorage')?.getItem(key); return value !== null && value !== undefined && allowed.includes(value) ? value : fallback; } catch { return fallback; } };
// Every setting: its group title, storage key and choices. The settings panel is drawn from
// this list, so a new setting is one more entry here.
interface Setting { key: string; title: string; fallback: string; control?: 'select'; choices: Array<[string, string]>; /** A line under the choices, when there is something to explain about the one picked. */ note?: () => string }
const SETTINGS: Setting[] = [
  // Each language under its own name; a list, so more can be added.
  { key: 'lang', title: t('语言'), fallback: language, control: 'select', choices: [['zh', '中文'], ['en', 'English']] },
  { key: 'theme', title: t('主题'), fallback: 'system', choices: [['system', t('跟随系统')], ['light', t('浅色')], ['dark', t('深色')]] },
  // The agent rail: compact (a bubble pops out when an AI speaks) or wide (its last line stays in view).
  { key: 'bubble', title: t('Agent 栏'), fallback: 'below', choices: [['below', t('紧凑')], ['side', t('展开')]], note: () => appearance.bubble === 'side' && !railWide() ? t('窗口宽度超过 1100 像素时才会展开') : '' },
  // A small character beside each of the AI's replies, so several agents read like a group chat.
  { key: 'avatars', title: t('回复旁的头像'), fallback: 'on', choices: [['on', t('显示')], ['off', t('不显示')]] },
];
// Every setting's value, by key (each one is read above, so each key is there).
const appearance: Record<string, string> = Object.fromEntries(SETTINGS.map(item => [item.key, readSetting(`desktop-bridge:${item.key}`, item.fallback, item.choices.map(([value]) => value))]));
function applyAppearance() {
  if (appearance.theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.bubble = appearance.bubble;
  applyRail();
  document.documentElement.dataset.avatars = appearance.avatars;
  try { for (const item of SETTINGS) storageFor('localStorage')?.setItem(`desktop-bridge:${item.key}`, appearance[item.key] ?? item.fallback); } catch {}
  dockMarkup.clear(); renderDock();
}
// The rail is wide only when chosen and the window has room for it.
function applyRail(): boolean {
  const rail = appearance.bubble === 'side' && innerWidth > 1100 ? 'wide' : 'compact', changed = document.documentElement.dataset.rail !== rail;
  document.documentElement.dataset.rail = rail;
  const label = appearance.bubble === 'side' ? t('收起 Agent 栏') : t('展开 Agent 栏');
  $('toggle-rail').setAttribute('aria-pressed', String(appearance.bubble === 'side')); $('toggle-rail').setAttribute('aria-label', label); $('toggle-rail').title = label;
  return changed;
}
addEventListener('resize', () => { if (applyRail()) { dockMarkup.clear(); renderDock(); } });
// The rail's corner: the person's avatar opens a small menu (quota for now, more later);
// the gear opens settings, one row per setting with its choices on the right.
let avatarSeed = (() => { try { return storageFor('localStorage')?.getItem('desktop-bridge:avatar') || ''; } catch { return ''; } })();
function drawAvatar(reroll = false) {
  if (reroll || !avatarSeed) { avatarSeed = newAvatarSeed(); try { storageFor('localStorage')?.setItem('desktop-bridge:avatar', avatarSeed); } catch {} }
  $('user-avatar').innerHTML = avatarSvg(avatarSeed);
}
const PROFILE_MENU = [
  { value: 'usage', label: t('额度'), run: () => { renderUsage(); $('usage-dialog').showModal(); } },
];
function renderSettings() {
  // The person's own avatar is a setting too: a row with the face and a button that draws another.
  const avatarRow = `<fieldset class="setting-group"><legend>${t('头像')}</legend><div class="setting-action"><span class="user-avatar" aria-hidden="true">${avatarSvg(avatarSeed)}</span><button type="button" class="secondary-button" data-setting-action="avatar">${t('换一个')}</button></div></fieldset>`;
  const control = (item: Setting) => item.control === 'select'
    ? `<select id="setting-${escape(item.key)}" class="subtle-select" data-setting-select="${escape(item.key)}" aria-label="${escape(item.title)}">${item.choices.map(([value, label]) => `<option value="${escape(value)}"${appearance[item.key] === value ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>`
    : `<div class="setting-choices" role="radiogroup" aria-label="${escape(item.title)}">${item.choices.map(([value, label]) => `<button type="button" role="radio" class="setting-choice" data-setting="${escape(item.key)}" data-value="${escape(value)}" aria-checked="${appearance[item.key] === value}">${escape(label)}</button>`).join('')}</div>`;
  // Which agents are on is the console's first setting: the same switches as the rail's "+".
  const agentsGroup = `<fieldset class="setting-group is-stacked"><legend>Agent</legend><div id="settings-agents">${agentsMarkup(true)}</div><button type="button" class="text-button" data-open-onboard>${t('接入其他桌面 AI…')}</button></fieldset>`;
  $('settings-content').innerHTML = agentsGroup + avatarRow + SETTINGS.map(item => `<fieldset class="setting-group"><legend>${escape(item.title)}</legend>${control(item)}${item.note?.() ? `<p class="field-help setting-note">${escape(item.note())}</p>` : ''}</fieldset>`).join('') + '<fieldset class="setting-group" id="settings-voice"></fieldset>';
  renderVoiceSetting();
  for (const select of $('settings-content').querySelectorAll('select')) enhanceSelect(select, { variant: 'field' });
  hydrateIcons($('settings-content'));
}
// Which speech-to-text the microphone uses: "automatic" (the order of shared/dictation.ts), one
// agent's own service first, or the browser's recognizer. The line under it says what that comes to now.
function renderVoiceSetting() {
  const group = find($('settings-content'), '#settings-voice');
  if (!group) return;
  const choices: Array<[string, string]> = [[AUTO_VOICE, t('自动')], ...state.voice.sources.map((item): [string, string] => [item.engine, `${sourceName(item)}${item.ready ? '' : t('（现在不可用）')}`]), [BROWSER_VOICE, `${t('浏览器语音识别')}${browserVoice() ? '' : t('（现在不可用）')}`]];
  const picked = choices.some(([value]) => value === voicePick) ? voicePick : AUTO_VOICE, plan = voicePlan(picked);
  const note = plan.label ? `${t('现在会用：')}${plan.label}${plan.source || picked === BROWSER_VOICE || !state.voice.sources.length ? '' : t('（各 Agent 的语音识别都不可用）')}` : `${t('语音输入不可用：')}${plan.why}`;
  group.innerHTML = `<legend>${t('语音输入')}</legend><select class="subtle-select" data-voice-select aria-label="${escape(t('语音输入'))}">${choices.map(([value, label]) => `<option value="${escape(value)}"${value === picked ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select><p class="field-help setting-note">${escape(note)}</p>`;
  const select = find(group, 'select');
  if (select instanceof HTMLSelectElement) enhanceSelect(select, { variant: 'field' });
}
function changeSetting(key: string, value: string): boolean {
  if (appearance[key] === value) return false;
  appearance[key] = value; applyAppearance();
  // Every label on the page is written in the chosen language as it is drawn, so a change of
  // language starts the page again; open chats and drafts are kept by the browser.
  if (key === 'lang') { saveDraft(); location.reload(); return false; }
  return true;
}
$('open-profile').addEventListener('click', () => showMenu($('open-profile'), PROFILE_MENU, { label: t('我的'), onPick: item => item.run() }));
$('open-settings').addEventListener('click', () => { renderSettings(); $('settings-dialog').showModal(); void loadVoice(); });
$('toggle-rail').addEventListener('click', () => { changeSetting('bubble', appearance.bubble === 'side' ? 'below' : 'side'); });
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { agentsView.editing = null; agentsView.editErrors.clear(); });
$('close-usage').addEventListener('click', () => $('usage-dialog').close());
$('settings-content').addEventListener('click', event => {
  if (closest(event.target, '[data-setting-action="avatar"]')) { drawAvatar(true); renderSettings(); find($('settings-content'), '[data-setting-action]')?.focus(); return; }
  const choice = closest(event.target, '[data-setting]');
  if (choice && changeSetting(data(choice, 'setting'), data(choice, 'value'))) { renderSettings(); find($('settings-content'), `[data-setting="${choice.dataset['setting']}"][aria-checked="true"]`)?.focus(); }
});
$('settings-content').addEventListener('change', event => {
  const voice = closest(event.target, '[data-voice-select]', HTMLSelectElement);
  if (voice) { pickVoice(voice.value); renderVoiceSetting(); return; }
  const select = closest(event.target, '[data-setting-select]', HTMLSelectElement); if (select) changeSetting(data(select, 'settingSelect'), select.value);
});
// The new chat's cards: a pick is made in the desktop app, which answers with what comes next.
// (On the conversation, not the timeline: the timeline element is replaced as views change.)
$('conversation').addEventListener('click', event => {
  const option = closest(event.target, '[data-new-option]'), edit = closest(event.target, '[data-new-edit]');
  if (option) newOptions.pick(data(option, 'newControl'), data(option, 'newOption'));
  else if (edit) newOptions.edit(data(edit, 'newEdit'));
  else if (closest(event.target, '[data-new-reload]')) newOptions.reload();
});
// A click on the dimmed area around any dialog closes it, like its close button.
document.addEventListener('click', event => {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});

async function init() {
  translateDocument();
  applyAppearance(); drawAvatar();
  for (const id of ['model', 'effort', 'permission'] as const) enhanceSelect($(id));
  hydrateIcons(); renderControls();
  try {
    const manifest = await request<EnginesResponse>('/api/engines');
    state.engines = manifest.engines; state.agents = manifest.agents || []; state.defaultCwd = manifest.defaultCwd; state.projectDir = manifest.projectDir || ''; state.fileManager = manifest.fileManager || ''; state.voice = manifest.dictation; state.httpsPort = manifest.httpsPort;
    enginesSeen = seenOf(manifest);
    try { chatKit = (await import('./kit/kit.js')).setup({ registerRenderer, newSettings, canPress: () => !!state.session && !!capsOf().cardActions, pressAction, readCard }); } catch (err) { console.error('Chat kit failed to load', err); }
    for (const item of state.engines) await loadSkin(item);
    state.engine = state.engines[0]?.id || ''; state.ready = true;
    restoreDraft(); renderDock(); renderHeader(); renderConversation(); connectOverview(); loadUsage(); sidebar(!matchMedia('(max-width:767px)').matches);
    await loadLists();
    restoreDraft(); renderHeader(); renderControls(); await followRoute();
    setInterval(loadUsage, 60000);
  } catch (err) { notify(`${t('无法连接工作台：')}${messageOf(err)}`); $('timeline').innerHTML = ("<p class=\"quiet-state\">" + t('服务暂时不可用，恢复后刷新页面继续') + "</p>"); }
}
init();
