import { marked, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import { drawIcons } from './icons.js';
import { t, say, locale } from './i18n.js';
import { previewText } from './message-inbox.js';
import { find } from './dom.js';
import type { Activity, Character, EngineManifest, MediaImage, PresentedArtifact, UnifiedSession, Usage, UsageWindow } from '../../shared/contract.js';
import type { PageTurn } from './store.js';
import type { ListedProject, SideSession } from './sidebar.js';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ENTITIES[char] ?? char);
export const icon = (name: string): string => `<i data-lucide="${escape(name)}" aria-hidden="true"></i>`;
/** What the page draws an engine's face and name from (its manifest, or a part of it). */
export type Provider = Partial<Pick<EngineManifest, 'iconUrl' | 'prefix' | 'label' | 'character' | 'look'>>;
export function brandIcon(provider: Provider = {}): string {
  const url = provider.iconUrl;
  return typeof url === 'string' && characterUrl(url) ? `<img class="ai-brand-icon" src="${escape(url)}" alt="" aria-hidden="true">` : `<span class="brand-fallback">${escape(provider.prefix || provider.label?.slice(0, 2) || 'AI')}</span>`;
}
const characterUrl = (url: unknown): url is string => typeof url === 'string' && /^\/(assets\/characters|api\/characters)\/[\w.-]+(\?v=[\w-]+)?$/.test(url);
// The engine's own character (falls back to its app icon). `working` makes it move.
export function character(provider: Provider = {}, { working = false } = {}): string {
  const art = provider.character;
  // A picture of the person's own for while it works (settings): shown in place of the face then.
  const workUrl = art?.workingUrl && characterUrl(art.workingUrl) ? art.workingUrl : '';
  const work = workUrl ? `<img class="character-image is-fill character-working" src="${escape(workUrl)}" alt="">` : '';
  const classes = `character${working ? ' is-working' : ''}${work ? ' has-working' : ''}`;
  if (art?.kind === 'sprite' && characterUrl(art.url)) {
    const at = (index: number, count: number) => `${count > 1 ? (index / (count - 1)) * 100 : 0}%`;
    const style = [
      `--sheet:url('${art.url}')`, `--sheet-size:${art.columns * 100}% ${art.rows * 100}%`,
      `--idle-x:${at(art.idle?.[0] || 0, art.columns)}`, `--idle-y:${at(art.idle?.[1] || 0, art.rows)}`,
      `--work-y:${at(art.working?.row || 0, art.rows)}`, `--work-end:${((art.working?.frames || 1) / (art.columns - 1)) * 100}%`, `--work-frames:${art.working?.frames || 1}`, `--cell-ratio:${art.cell ? `${art.cell[0]} / ${art.cell[1]}` : '1'}`,
    ].join(';');
    return `<span class="${classes} character-sprite" style="${escape(style)}" aria-hidden="true"><span class="sprite-frame"></span>${work}</span>`;
  }
  // A picture of the person's own fills the round face; the apps' own art sits inside it.
  if (art?.kind === 'image' && characterUrl(art.url)) return `<span class="${classes}" aria-hidden="true"><img class="character-image${art.fill ? ' is-fill' : art.pixelated ? ' is-pixelated' : ''}" src="${escape(art.url)}" alt="">${work}</span>`;
  return `<span class="${classes}" aria-hidden="true">${brandIcon(provider)}${work}</span>`;
}

// An engine may name its quota windows; the common names are known in both languages.
export const windowName = (window: UsageWindow): string => window.label ? t(window.label) : ((window.windowMinutes ?? 0) >= 1440 ? t('每周') : window.windowMinutes ? `${Math.round(window.windowMinutes / 60)} ${t('小时')}` : t('额度'));
// A missing percent (null) counts as 0, as Math.min(100, null) always did.
const remaining = (window: UsageWindow): number => Math.round(Math.max(0, Math.min(100, window.remainingPercent ?? 0)));
// Remaining quota as one segmented bar under the engine's face, a segment per window the engine
// reports (an account may have several: 5 hours, weekly, per model…), in the engine's own colour.
// A window that is nearly empty turns red. The hover card names each one.
export const METER_BARS = 8;
export function quotaMeter(usage: Usage | null | undefined): string {
  const windows = usage?.available ? (usage.windows || []).slice(0, METER_BARS) : [];
  if (!windows.length) return '<span class="quota-meter is-empty" aria-hidden="true"><span class="meter-bar"></span></span>';
  return `<span class="quota-meter" aria-hidden="true">${windows.map(window => { const percent = remaining(window); return `<span class="meter-bar${percent <= 15 ? ' is-low' : ''}"><i style="width:${Math.max(percent, 4)}%"></i></span>`; }).join('')}</span>`;
}
const resetText = (seconds: number | null | undefined): string => {
  if (!seconds) return '';
  const at = new Date(seconds * 1000), minutes = Math.round((at.getTime() - Date.now()) / 60000);
  if (minutes <= 0) return t('即将重置');
  if (minutes < 60) return t('{n} 分钟后重置', { n: minutes });
  if (minutes < 24 * 60) return t('{n} 小时后重置', { n: Math.round(minutes / 60) });
  return t('{time} 重置', { time: `${at.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}` });
};
// The hover card: each window by name, with its value, a bar in the engine's colour and its reset.
// `head`: markup the dock puts above the windows (who this is and whether it can be reached).
export function quotaCard(usage: Usage | null | undefined, loaded = true, head = ''): string {
  const windows = usage?.available ? (usage.windows || []) : [];
  if (!windows.length) return `<span class="quota-card">${head}<span class="quota-card-note">${escape(!loaded ? t('正在读取额度…') : say(usage?.reason?.split('\n')[0]) || t('额度未公开'))}</span></span>`;
  // Every window the engine reports: which ones an account has is the engine's to say.
  const shown = windows.slice(0, 8);
  return `<span class="quota-card">${head}${shown.map(window => {
    const percent = remaining(window);
    return `<span class="quota-row ${percent <= 15 ? 'is-low' : 'is-ok'}"><span class="quota-row-head"><span class="quota-name">${escape(windowName(window))}</span><span class="quota-value">${percent}<small>%</small></span></span><span class="quota-bar"><span style="width:${percent}%"></span></span>${window.resetsAt ? `<span class="quota-reset">${escape(resetText(window.resetsAt))}</span>` : ''}</span>`;
  }).join('')}</span>`;
}

// The first sentence of a message, shortened for a speech bubble.
export function speechLine(text: unknown, length = 30): string {
  const plain = previewText(text, 400);
  const sentence = plain.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+|\s(?=[-•*]\s)/).find(part => part.trim()) || plain;
  return previewText(sentence, length);
}

/** What a skin's turn renderer gets besides the turn. */
export interface TurnContext { label: string; provider: Provider; markdown: typeof markdown; character: typeof character; escape: typeof escape; icon: typeof icon }
/** How the sidebar marks one chat. */
export interface SessionMarks { running: boolean; unread: boolean; draft: boolean }
/** What a skin's chat list renderer gets besides the chats. */
export interface SessionListContext { currentId: string | undefined; query: string; escape: typeof escape; icon: typeof icon; relativeTime(value: unknown): string; provider: EngineManifest | undefined; status(session: SideSession): SessionMarks; projects: ListedProject[]; renderDefault(): string }
export type ActivityRenderer = (item: Activity) => string;
export type ArtifactRenderer = (item: PresentedArtifact) => string;
/**
 * The renderers by kind: the built-in ones, and any a skin or the chat kit registers for an
 * engine (`turn:<engine>`), an activity kind (`activity:<kind>`) or an artifact kind.
 */
export interface Renderers {
  activity: ActivityRenderer;
  plan: ActivityRenderer;
  artifact: ArtifactRenderer;
  [kind: `activity:${string}`]: ActivityRenderer;
  [kind: `artifact:${string}`]: ArtifactRenderer;
  [kind: `turn:${string}`]: (turn: PageTurn, context: TurnContext) => string;
  [kind: `session-list:${string}`]: (sessions: SideSession[], context: SessionListContext) => string;
}
const registry: Partial<Renderers> = {};
export const renderers = {
  get<K extends keyof Renderers>(kind: K): Renderers[K] | undefined { return Object.hasOwn(registry, kind) ? registry[kind] : undefined; },
};
export function registerRenderer<K extends keyof Renderers>(kind: K, renderer: Renderers[K]): void { registry[kind] = renderer; }
// CommonMark refuses `**原因：**正文` (a closing ** after punctuation, followed by a letter),
// which is the normal way CJK text is written. Resolve strong emphasis outside code first.
export function emphasizeCjk(text: unknown): string {
  return String(text || '').split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => index % 2 ? part
    : part.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, (match: string, inner: string, offset: number, whole: string) => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(inner + (whole[offset - 1] || '') + (whole[offset + match.length] || '')) ? `<strong>${inner}</strong>` : match)).join('');
}
// A local file an agent names in its reply: a link to it, or inline code such as `lib/a.js:42`.
// A link (`{ link: true }`) may also name a folder (`docs/`) or a file without an extension
// (`Makefile`): the agent chose to link it, as the desktop shows. Inline code is a file when
// - it is a bare name with a known extension (`app.ts`; `console.log` or `main` stay code),
// - it is a path whose file has any extension (`logs/4130.log`, `~/.codex/config.toml`) or is a
//   dotfile (`video/.gitignore`), or
// - it is an absolute path on this machine (`/Users/…`, `/private/tmp/…`, `~/…`), of any shape.
// So `origin/main`, `/api/activity` or `thread/start` stay code, and a bare folder (`docs/`) too.
const FILE_EXT = /\.(c|cc|cpp|cs|css|csv|cjs|go|h|hpp|html?|ini|java|jsx?|json|kt|lock|log|m|md|mdx|mjs|php|py|rb|rs|scss|sh|sql|svelte|svg|swift|toml|tsx?|txt|vue|xml|ya?ml|zsh|png|jpe?g|gif|webp)$/i;
const PATH_SHAPE = /^(~\/|\/|[a-zA-Z]:\/|\.{1,2}\/)?[\w@.+-]+(\/[\w@.+-]+)*\/?$/;
const LOCAL_ROOT = /^(~\/|[a-zA-Z]:\/|\/(Users|Volumes|Applications|Library|private|tmp|var|opt|etc|home)\/)./;
const PATH_FILE = /\/(\.[\w-]+|[\w@+-][\w@.+-]*\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,8})$/i;
const decodeSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
export function filePathOf(value: unknown, { link = false } = {}): string {
  const raw = String(value || '').trim();
  const stripped = /^file:\/\//i.test(raw)
    ? decodeSafe(raw).replace(/^file:\/\/(?:localhost(?=\/))?/i, '').replace(/^\/+(?=[a-zA-Z]:[\\/])/, '')
    : raw;
  const text = /^[a-zA-Z]:[\\/]/.test(stripped) || (stripped.includes('\\') && !stripped.includes(' '))
    ? stripped.replace(/\\/g, '/')
    : stripped;
  const bare = text.replace(/:(\d+)(:\d+)?$/, '');
  if (!text || text.length > 400 || /:\/\//.test(bare) || /^[a-z]{2,}:/i.test(bare)) return '';
  if ((link || FILE_EXT.test(bare)) && /^[a-zA-Z]:\/[^\r\n\0]+$/.test(bare)) return text;
  if (/\s/.test(bare) || !PATH_SHAPE.test(bare) || /^\.+\/?$/.test(bare)) return '';
  if (link) return text;
  if (bare.endsWith('/')) return LOCAL_ROOT.test(bare) ? text : '';
  return FILE_EXT.test(bare) || LOCAL_ROOT.test(bare) || PATH_FILE.test(bare) ? text : '';
}
// A link's own way of naming a line (`a.ts#L42`, `a.ts#L42-L50`) is read as `a.ts:42`.
const lineAnchor = (href: string) => href.replace(/#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, ':$1');
const fileLink = (target: string, label: string | null) => { const link = document.createElement('a'); link.className = 'file-link'; link.href = '#'; link.dataset.filePath = target; link.title = `${t('预览')} ${target}`; link.dataset.ext = target.endsWith('/') ? '' : (/\.([a-z0-9]+)(?::\d+)*$/i.exec(target)?.[1] || '').slice(0, 4); link.textContent = label; return link; };
// Text that arrives cut short — a reply still streaming, or a record that shortened a long
// message — can end inside a code block. Closing it keeps that block from swallowing the rest.
export function closeFences(text: string): string {
  let open: string | null = null;
  for (const line of String(text).split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    const marks = fence[1] ?? '', rest = fence[2] ?? '';
    if (!open) { if (!(marks[0] === '`' && rest.includes('`'))) open = marks; }
    else if (marks[0] === open[0] && marks.length >= open.length && !rest.trim()) open = null;
  }
  return open ? `${text}\n${open}` : text;
}
// "<truncated N bytes>" is how an engine's record marks text it left out. Each side is rendered on
// its own, so the cut cannot break the formatting around it, and the gap shows as a small note.
const CUT = /<truncated (\d+) bytes>/;
export function markdown(text: unknown): string {
  const parts = String(text ?? '').split(new RegExp(CUT.source, 'g'));
  if (parts.length === 1) return renderMarkdown(parts[0] ?? '');
  return parts.map((part, index) => index % 2 ? `<p class="md-cut">${t('已省略 {n} 字节', { n: Number(part).toLocaleString() })}</p>` : renderMarkdown(part)).join('');
}
// Math the way the desktops draw it (KaTeX): $…$ and \(…\) inline, $$…$$ and \[…\] on lines of
// their own (Codex writes the backslash forms). A dollar sign followed by a space, or a closing one
// followed by a digit, is money, not math ($5 and $10).
const MATH_INLINE = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/, MATH_BLOCK = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;
const MATH_DELIMITED = /^\\\(([\s\S]+?)\\\)|^\\\[([\s\S]+?)\\\]/;
const firstOf = (src: string, ...marks: string[]): number | undefined => {
  const found = marks.map(mark => src.indexOf(mark)).filter(index => index >= 0);
  return found.length ? Math.min(...found) : undefined;
};
// Where a formula on lines of its own may begin: not inside a code block (an odd number of fence
// lines before it), which the paragraph it follows would otherwise be cut short at.
function mathBlockStart(src: string): number | undefined {
  const lines = /(^|\n) {0,3}(\$\$|\\\[|```|~~~)/g;
  let fence = '';
  for (let match; (match = lines.exec(src));) {
    const mark = match[2] || '';
    if (mark === '```' || mark === '~~~') fence = !fence ? mark : fence === mark ? '' : fence;
    else if (!fence) return match.index;
  }
  return undefined;
}
const mathSlot = (tex: string, display: boolean) => `<span class="md-math" data-display="${display ? 1 : 0}" data-tex="${escape(tex.trim())}"></span>`;
let markedReady = false;
function setUpMarked() {
  if (markedReady) return;
  markedReady = true;
  const math: TokenizerAndRendererExtension[] = [
    { name: 'mathBlock', level: 'block', start: mathBlockStart, tokenizer(src) { const match = MATH_BLOCK.exec(src); if (match) return { type: 'mathBlock', raw: match[0], tex: match[1] ?? match[2] }; return undefined; }, renderer: token => `<p>${mathSlot(String(token['tex']), true)}</p>` },
    { name: 'mathInline', level: 'inline', start: src => firstOf(src, '$', '\\(', '\\['), tokenizer(src) {
      const delimited = MATH_DELIMITED.exec(src); if (delimited) return { type: 'mathInline', raw: delimited[0], tex: delimited[1] ?? delimited[2], display: delimited[2] != null };
      const block = /^\$\$((?:\\.|[^\\$])+?)\$\$/.exec(src); if (block) return { type: 'mathInline', raw: block[0], tex: block[1], display: true };
      const match = MATH_INLINE.exec(src); if (match) return { type: 'mathInline', raw: match[0], tex: match[1] }; return undefined;
    }, renderer: token => mathSlot(String(token['tex']), !!token['display']) },
  ];
  marked.use({ extensions: [...math, writingExtension] });
}
/** The math a reply holds, as the page reads it: each formula's TeX and whether it is shown on a line of its own. */
export function mathIn(text: string): Array<{ tex: string; display: boolean }> {
  setUpMarked();
  const found: Array<{ tex: string; display: boolean }> = [];
  marked.walkTokens(marked.lexer(text), token => {
    if (token.type === 'mathBlock' || token.type === 'mathInline') found.push({ tex: String(token['tex']).trim(), display: token.type === 'mathBlock' || !!token['display'] });
  });
  return found;
}
// Codex writes a draft meant to be used as is (an email, a message, a document) as a writing block:
//   :::writing{variant="email" id="12345" title="…" subject="…" recipient="…"}
//   …markdown…
//   :::
// The desktop draws it as a card of its own (its words, as the desktop writes them): the title (or
// "Document" / "Email") above the text,
// an email's fields above its body, and a button that copies the block's markdown. A fence inside
// it does not close it, and one still being written runs to the end of the text.
const WRITING_OPEN = /^ {0,3}:::writing(?:\{([^}\n]*)\})?[ \t]*(?:\n|$)/;
export function writingBlock(src: string): { raw: string; attributes: Record<string, string>; body: string } | null {
  const open = WRITING_OPEN.exec(src);
  if (!open) return null;
  const attributes: Record<string, string> = {};
  for (const [, name, value] of (open[1] || '').matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) if (name) attributes[name] = value ?? '';
  const lines = src.slice(open[0].length).split('\n'), body: string[] = [];
  let fence: string | null = null, used = open[0].length, closed = false;
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    used += line.length + (last ? 0 : 1);
    const marks = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marks) { const [, run = '', rest = ''] = marks; if (!fence) { if (!(run[0] === '`' && rest.includes('`'))) fence = run; } else if (run[0] === fence[0] && run.length >= fence.length && !rest.trim()) fence = null; }
    else if (!fence && line.trim() === ':::') { closed = true; break; }
    body.push(line);
  }
  if (!closed && body.length && body[body.length - 1] === '') body.pop();
  return { raw: src.slice(0, used), attributes, body: body.join('\n') };
}
const writingExtension: TokenizerAndRendererExtension = {
  name: 'writingBlock', level: 'block',
  start: src => src.match(/(^|\n) {0,3}:::writing/)?.index,
  tokenizer(src) {
    const block = writingBlock(src);
    if (!block) return undefined;
    return { type: 'writingBlock', raw: block.raw, attributes: block.attributes, body: block.body, tokens: this.lexer.blockTokens(block.body, []) };
  },
  renderer(token) {
    const attributes = (token['attributes'] || {}) as Record<string, string>;
    const data = (name: string, value: string | undefined) => value ? ` data-writing-${name}="${escape(value)}"` : '';
    return `<div class="md-writing"${data('variant', attributes['variant'] || 'standard')}${data('title', attributes['title'])}${data('subject', attributes['subject'])}${data('recipient', attributes['recipient'])}${data('cc', attributes['cc'])}${data('bcc', attributes['bcc'])}${data('source', String(token['body'] || ''))}><div class="md-writing-body">${this.parser.parse(token.tokens || [])}</div></div>`;
  },
};
// The card around a writing block, drawn after sanitizing (its copy button is not allowed in a reply).
function writingCard(box: HTMLElement): void {
  const variant = box.dataset['writingVariant'] || 'standard', email = variant === 'email';
  const head = document.createElement('div'); head.className = 'md-writing-head';
  const title = box.dataset['writingTitle'] || (email ? box.dataset['writingSubject'] : '') || (email ? 'Email' : 'Document');
  head.innerHTML = `<span class="md-writing-title">${icon(email ? 'mail' : 'file-text')}<span>${escape(title)}</span></span><button type="button" class="icon-button" data-copy-code aria-label="${escape(t('复制'))}" title="${escape(t('复制'))}">${icon('copy')}</button>`;
  box.prepend(head);
  if (!email) return;
  const fields = [['recipient', 'To'], ['cc', 'Cc'], ['bcc', 'Bcc'], ['subject', 'Subject']] as const;
  const rows = fields.filter(([name]) => box.dataset[`writing${name[0]?.toUpperCase()}${name.slice(1)}`]);
  if (!rows.length) return;
  const list = document.createElement('dl'); list.className = 'md-writing-fields';
  for (const [name, label] of rows) {
    const row = document.createElement('div'), term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = label; value.textContent = box.dataset[`writing${name[0]?.toUpperCase()}${name.slice(1)}`] || '';
    row.append(term, value); list.append(row);
  }
  head.after(list);
}
// Links to a local file may be written file:///… or as a Windows drive path, which the sanitizer would otherwise drop.
const URI_SAFE = /^(?:(?:https?|mailto|file):|[a-z]:[\\/]|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
const decoded = (href: string) => { try { return decodeURI(href); } catch { return href; } };
// The two libraries that draw code in colour (highlight.js) and math (KaTeX) are a large part of
// what the page would otherwise load at once, and math is rare: each is a chunk of its own,
// fetched when a message first needs it. Until it is there the code is plain and the math is its
// source; once it arrives everything is rendered again (onRenderers). A failed fetch is tried
// again the next time something needs it.
type Highlighter = typeof import('@highlightjs/cdn-assets/es/highlight.min.js').default;
type Katex = typeof import('katex').default;
let hljs: Highlighter | null = null, katex: Katex | null = null;
const fetching: { code?: Promise<void> | undefined; math?: Promise<void> | undefined } = {};
const watchers = new Set<() => void>();
/** `listener` runs when a library has arrived and what was rendered without it should be rendered again. */
export function onRenderers(listener: () => void): void { watchers.add(listener); }
function arrived(): void { rendered.clear(); renderedSize = 0; for (const listener of watchers) listener(); }
export function needRenderer(kind: 'code' | 'math'): void {
  if (fetching[kind]) return;
  fetching[kind] = (kind === 'code'
    ? import('@highlightjs/cdn-assets/es/highlight.min.js').then(module => { hljs = module.default; })
    : import('katex').then(module => { katex = module.default; })
  ).then(arrived, () => { fetching[kind] = undefined; });
}
// A fenced code block as the desktops draw one: its language and a copy button above it, the code
// coloured by language (highlight.js) when the language is named and known.
function codeBlock(pre: HTMLPreElement): void {
  const code = find(pre, 'code'), lang = /\blanguage-([\w+#.-]+)/.exec(code?.className || '')?.[1] || '';
  if (code && lang && !hljs) needRenderer('code');
  else if (code && lang && hljs?.getLanguage(lang)) {
    try { code.innerHTML = hljs.highlight(code.textContent || '', { language: lang, ignoreIllegals: true }).value; code.classList.add('hljs'); } catch {}
  }
  const box = document.createElement('div'); box.className = 'kit-code md-code';
  box.innerHTML = `<div class="kit-code-head"><span>${escape(lang || 'text')}</span><button type="button" class="icon-button" data-copy-code aria-label="${escape(t('复制代码'))}" title="${escape(t('复制代码'))}">${icon('copy')}</button></div>`;
  pre.replaceWith(box); box.append(pre);
}
// Without a DOM to sanitize in (DOMPurify.isSupported is false, as under node's tests), the text
// is shown escaped, as it was when the page had no marked or DOMPurify.
// A message's markup is worked out once: the conversation is drawn again for every event of a
// running turn, and all but the message being written are the same text as the frame before.
// Kept by text, the ones shown most recently staying (RENDERED_MAX texts, RENDERED_CHARS in all).
const rendered = new Map<string, string>(), RENDERED_MAX = 1500, RENDERED_CHARS = 12_000_000;
let renderedSize = 0;
function renderMarkdown(text: string): string {
  if (!DOMPurify.isSupported) return `<p>${escape(text).replace(/\n/g, '<br>')}</p>`;
  const kept = rendered.get(text);
  if (kept !== undefined) { rendered.delete(text); rendered.set(text, kept); return kept; }
  const html = drawMarkdown(text);
  rendered.set(text, html); renderedSize += text.length + html.length;
  for (const [old, markup] of rendered) {
    if (old === text || (rendered.size <= RENDERED_MAX && renderedSize <= RENDERED_CHARS)) break;
    rendered.delete(old); renderedSize -= old.length + markup.length;
  }
  return html;
}
function drawMarkdown(text: string): string {
  setUpMarked();
  const html = DOMPurify.sanitize(marked.parse(emphasizeCjk(closeFences(text)), { gfm: true, breaks: false, async: false }), {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'video', 'audio'], FORBID_ATTR: ['style'], ALLOWED_URI_REGEXP: URI_SAFE,
  });
  const template = document.createElement('template'); template.innerHTML = html;
  for (const link of template.content.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (!/^(https?:\/\/|mailto:|#|\/uploads\/)/i.test(href)) {
      const target = filePathOf(lineAnchor(decoded(href)), { link: true });
      if (target) { link.replaceWith(fileLink(target, link.textContent)); continue; }
      const code = document.createElement('code'); code.textContent = link.textContent; code.title = href; link.replaceWith(code);
    } else {
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      // A source the reply cites (a desktop chat read from its page: [site](url "citation")) is the desktop's chip.
      if (link.title === 'citation') { link.className = 'md-cite'; link.title = href; }
    }
  }
  // Inline code that is a file path opens the file too (code blocks stay as they are).
  for (const code of template.content.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const target = filePathOf(code.textContent);
    if (target) { const link = fileLink(target, ''); code.replaceWith(link); link.append(code); }
  }
  // Diagram blocks become placeholders that diagrams.ts draws; the source stays as the fallback.
  for (const code of template.content.querySelectorAll('pre > code.language-mermaid')) {
    const figure = document.createElement('figure'); figure.className = 'md-diagram';
    const source = document.createElement('pre'); source.className = 'md-diagram-source';
    source.append(code.cloneNode(true)); figure.append(source); code.parentElement?.replaceWith(figure);
  }
  // GitHub-style callouts: a quote that opens with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION].
  for (const quote of template.content.querySelectorAll('blockquote')) {
    const lead = find(quote, ':scope > p'), node = lead?.firstChild;
    const kind = node instanceof Text && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(node.data);
    if (!kind || !lead) continue;
    node.data = node.data.slice(kind[0].length);
    if (lead.firstChild?.nodeName === 'BR') lead.firstChild.remove();
    const name = (kind[1] ?? '').toLowerCase(), title = document.createElement('p');
    title.className = 'md-alert-title'; title.textContent = ALERTS[name] ?? null;
    quote.classList.add('md-alert', `md-alert-${name}`); quote.prepend(title);
    if (!lead.textContent.trim() && !lead.children.length) lead.remove();
  }
  for (const pre of template.content.querySelectorAll('pre')) if (!pre.closest('.md-diagram') && pre.querySelector(':scope > code')) codeBlock(pre);
  for (const box of template.content.querySelectorAll<HTMLElement>('.md-writing')) writingCard(box);
  // Math is drawn after sanitizing (KaTeX's own markup needs its inline sizes); KaTeX escapes the
  // source itself and runs untrusted (no \href, \url…). Without KaTeX the source stays as written.
  for (const slot of template.content.querySelectorAll<HTMLElement>('.md-math')) {
    const tex = slot.dataset.tex || '', display = slot.dataset.display === '1';
    if (!katex) { needRenderer('math'); slot.textContent = display ? `$$${tex}$$` : `$${tex}$`; continue; }
    try { slot.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, output: 'htmlAndMathml' }); if (display) slot.classList.add('is-display'); }
    catch { slot.textContent = display ? `$$${tex}$$` : `$${tex}$`; }
  }
  // Remote tracking images and inline SVG never load as a side effect of a message.
  for (const image of template.content.querySelectorAll('img')) {
    const src = image.getAttribute('src') || '';
    if (!src.startsWith('/uploads/')) { const label = document.createElement('span'); label.textContent = image.alt || t('图片'); image.replaceWith(label); }
  }
  return template.innerHTML;
}
const ALERTS: Record<string, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
const artifact: ArtifactRenderer = item => `<div class="artifact">${icon('file-text')}<div class="artifact-content"><div class="artifact-title">${escape(item.title)}</div><div class="artifact-path" title="${escape(item.path || item.summary)}">${escape(item.summary || item.path || t('生成产物'))}</div></div>${item.url?.startsWith('/uploads/') ? `<a class="icon-button" href="${escape(item.url)}" download aria-label="${t('下载')} ${escape(item.title)}">${icon('download')}</a>` : `<button class="icon-button" data-copy-path="${escape(item.path)}" aria-label="${t('复制 {name} 的路径', { name: escape(item.title) })}">${icon('copy')}</button>`}</div>`;
registerRenderer('artifact', artifact);
// Pictures attached to a person's message; clicking one opens the page's image viewer.
export const userImages = (images: MediaImage[] | null | undefined): string => images?.length ? `<div class="user-images">${images.map(image => `<img class="user-image" src="${escape(image.url)}" alt="${escape(image.alt || t('图片'))}" loading="lazy">`).join('')}</div>` : '';
// Turns <i data-lucide> placeholders into icons. An icon already drawn is left alone: the
// library would otherwise swap every icon on the page for a new node on each call, and a
// click whose press and release land on two different nodes never arrives (buttons went
// dead under the pointer while a reply was streaming).
//
// lucide's createIcons takes no root (the page passed one, which it ignored): it draws every
// placeholder in the document. Only the drawn icons under root are renamed below, as before.
export function hydrateIcons(root: ParentNode = document): void {
  if (!root.querySelector?.('i[data-lucide]')) return;
  drawIcons(() => hydrateIcons());
  for (const drawn of root.querySelectorAll<SVGElement>('svg[data-lucide]')) { drawn.dataset.icon = drawn.dataset.lucide; drawn.removeAttribute('data-lucide'); }
}
