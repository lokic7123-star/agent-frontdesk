import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ClaudeBridge, PERMISSION_MODES } from '../claude-bridge.js';
import { ClaudeChats, type ClaudeChat, type ClaudeChatProject } from '../services/claude-chats.js';
import { UnifiedSession } from '../types.js';
import { ChatMode, CHAT_CAPABILITIES, type ModeChat } from '../services/desktop-chat.js';
import { appPlaces, firstExisting, readAsarFile } from '../services/app-assets.js';
import { registerTool, type ToolSummary } from '../services/tool-catalog.js';
import { get, list, parseJson, text } from '../../shared/guards.js';
import type { Character, PluginAbout, PluginSetup } from '../../shared/contract.js';

// Claude's own art and type, read at runtime from the installed desktop app (never vendored):
// the pixel Clawd from the app's sprite data, and the Anthropic Sans faces the Code tab uses.
const DEFAULT_ASAR = '/Applications/Claude.app/Contents/Resources/app.asar';
let APP_ASAR = DEFAULT_ASAR;
const FONTS: Readonly<Record<string, RegExp>> = {
  'claude-font-text': /main_window\/assets\/AnthropicSansMicro-Text-Variable-[^/]+\.woff2$/,
  'claude-font-roman': /main_window\/assets\/AnthropicSans-Roman-Variable-[^/]+\.woff2$/,
  'claude-font-italic': /main_window\/assets\/AnthropicSans-Italic-Variable-[^/]+\.woff2$/,
};
// "Laptop": Clawd idle in frame 0, typing on a laptop in frames 18–33.
const IDLE_FRAME = 0, WORK_FRAMES = [18, 34];
interface Clawd { svg: Buffer; columns: number; cell: [number, number]; version: string }
function clawdSprite(): Clawd | null {
  const source = readAsarFile(APP_ASAR, /main_window\/assets\/clawdQuestEngine-[^/]+\.js$/)?.data.toString();
  if (!source) return null;
  const start = source.search(/[,; ]te=\{/), end = source.indexOf('function ne(e)');
  if (start < 0 || end < 0) return null;
  // The table is plain data ({ w, h, palette, base, deltas }); read it as JSON-like literal without running app code.
  const literal = source.slice(start + 4, source.lastIndexOf('}}', end) + 2);
  const match = literal.match(/Laptop:\{cat:"[^"]*",w:(\d+),h:(\d+),fps:\d+,palette:(\[[^\]]*\]),base:"([^"]*)",deltas:"([^"]*)"\.split\("\("\)/);
  if (!match) return null;
  const [, w, h, palette = '[]', base = '', deltas = ''] = match;
  // The palette is the app's own data: a list of colours, read as such.
  const width = Number(w), height = Number(h), colors = list(parseJson(palette)), steps = deltas.split('(');
  const pixels = Uint8Array.from([...base].map(c => c === '.' ? 255 : parseInt(c, 36)));
  const frames = [pixels.slice()];
  for (const delta of steps) {
    if (delta) for (const change of delta.split(',')) { const at = change.length - 1; pixels[parseInt(change.slice(0, at), 36)] = change[at] === '.' ? 255 : parseInt(change[at] ?? '', 36); }
    frames.push(pixels.slice());
  }
  const work = frames.slice(WORK_FRAMES[0], WORK_FRAMES[1]);
  const columns = work.length;
  // Pixels outside the frame read as transparent (255), as an index past a typed array's end did.
  const at = (frame: Uint8Array, index: number): number => frame[index] ?? 255;
  const runs = (frame: Uint8Array, ox: number, oy: number) => {
    let out = '';
    for (let y = 0; y < height; y++) for (let x = 0; x < width;) {
      const value = at(frame, y * width + x);
      if (value === 255) { x++; continue; }
      let run = 1; while (x + run < width && at(frame, y * width + x + run) === value) run++;
      out += `<rect x="${ox + x}" y="${oy + y}" width="${run}" height="1" fill="${colors[value] || '#d97757'}"/>`;
      x += run;
    }
    return out;
  };
  // Frames sit in the corner of a wide cell (room for the laptop), which looks crooked inside a
  // round avatar. Trim to the drawn pixels and centre them in a square cell; the working frames
  // share one box so the animation does not jitter.
  const box = (frames: Uint8Array[]) => {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (const frame of frames) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (at(frame, y * width + x) === 255) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return x1 < 0 ? { x0: 0, y0: 0, w: width, h: height } : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };
  const idle = frames[IDLE_FRAME] ?? pixels; // frame 0 is always there (the base drawing)
  const idleBox = box([idle]), workBox = box(work);
  const size = Math.max(idleBox.w, idleBox.h, workBox.w, workBox.h) + 4;
  const place = (b: { x0: number; y0: number; w: number; h: number }, row: number): [number, number] => [Math.floor((size - b.w) / 2) - b.x0, row * size + Math.floor((size - b.h) / 2) - b.y0];
  const [ix, iy] = place(idleBox, 0), [wx, wy] = place(workBox, 1);
  const body = runs(idle, ix, iy) + work.map((frame, index) => runs(frame, index * size + wx, wy)).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${columns * size} ${size * 2}" width="${columns * size * 8}" height="${size * 16}" shape-rendering="crispEdges"><!-- Clawd, drawn from the installed Claude app's own sprite data at runtime --> ${body}</svg>`;
  // The version changes with the drawing, so a browser never pairs a cached old sheet with new cell sizes.
  return { svg: Buffer.from(svg), columns, cell: [size, size], version: createHash('sha1').update(svg).digest('hex').slice(0, 10) };
}

// Who this is, the same whether the agent is on or off (the engine below is registered with it).
const IDENTITY = { id: 'claude', label: 'Claude', description: 'Claude desktop', priority: 20, accent: '#D97757' } as const;
/** The agent as the console lists it before it is set up: found when the Claude desktop app, or the data it keeps, is on this machine. */
export const about: PluginAbout = { ...IDENTITY, character: { kind: 'image', url: '/assets/characters/claude.svg', pixelated: true },
  detect: config => firstExisting([...appPlaces(config.claudeAppAsar || DEFAULT_ASAR), config.claudeDesktopHome]) };
/** The wrap-up card (recap, question, buttons) as the record has it. App buttons' names are the desktop's own and are read from it (readCard). */
export const wrapUpOf = (input: unknown): ToolSummary => ({ type: 'summary', summary: String(get(input, 'recap') || '本轮总结'), detail: JSON.stringify({ recap: get(input, 'recap') || '', ask: get(input, 'ask') || '', actions: list(get(input, 'actions')).map(action => { const app = String(get(action, 'action') || ''); return { label: String(get(action, 'label') || '') || app, app }; }).filter(action => action.label) }) });
/** A dev server or page the desktop opened in its own Browser pane: a card with the address (its result names it, see presentation.ts). */
export const previewOf = (input: unknown): ToolSummary => ({ type: 'preview', summary: `Started preview · ${text(get(input, 'name') || get(input, 'url') || 'preview')}`, detail: JSON.stringify(input, null, 2) });
export const setup: PluginSetup = ({ config = {}, registerEngine, registerAsset }) => {
  APP_ASAR = config.claudeAppAsar || DEFAULT_ASAR;
  const bridge = new ClaudeBridge({ bin: config.claudeBin, claudeHome: config.claudeHome, desktopHome: config.claudeDesktopHome });
  // The desktop's "Claude" mode: its chats and pinned projects, from the app's own saved lists.
  const chats = new ClaudeChats({ desktopHome: bridge.appDir });
  const ELSEWHERE = 'Claude 模式聊天的正文不在本机，要从 Claude 桌面版的界面读';
  const chatSessions = (): { chats: ClaudeChat[]; projects: ClaudeChatProject[] } => { try { return chats.read(); } catch { return { chats: [], projects: [] }; } };
  // Its chats are read, started and answered in the desktop's own window (src/server/services/desktop-chat.ts).
  const mode = new ChatMode({ automation: bridge.desktop, space: 'chat', label: 'Claude 桌面版', list: () => chatSessions().chats, idFrom: /\/chat\/([0-9a-f-]{36})/, waitSeconds: 0, pollMs: 3000, watchVisible: true });
  const isChat = (id: string | null) => mode.has(id);
  const asSession = (chat: ModeChat, projects: readonly ClaudeChatProject[]) => new UnifiedSession({ id: chat.id, engine: 'claude', title: chat.title, updatedAt: chat.updatedAt, sendBlocked: ELSEWHERE,
    metadata: { space: 'chat', contentUnavailable: ELSEWHERE, group: chat.projectId ? { id: chat.projectId, name: text(projects.find(project => project.id === chat.projectId)?.name || chat['projectName'] || '') } : null } });
  // Not while it is answering, and only what the mode takes (no attachments, its own settings).
  const chatOnly = 'Claude 模式的聊天在回复时不能插话，消息已排队，等这条回复结束再发';
  let sprite: Clawd | null | undefined;
  const loadSprite = (): Clawd | null => { if (sprite === undefined) { try { sprite = fs.existsSync(APP_ASAR) ? clawdSprite() : null; } catch { sprite = null; } } return sprite; };
  registerAsset?.('claude', () => { const art = loadSprite(); return art && { type: 'image/svg+xml', data: art.svg }; });
  for (const [name, pattern] of Object.entries(FONTS)) {
    registerAsset?.(name, () => { try { const file = fs.existsSync(APP_ASAR) && readAsarFile(APP_ASAR, pattern); return file ? { type: 'font/woff2', data: file.data } : null; } catch { return null; } });
  }
  // Claude-only tools: its end-of-turn card, its step list, and the preview card of its Browser pane.
  const disposers = [
    registerTool({ match: /^mcp__ccd_turn__wrap_up$/, map: wrapUpOf }),
    registerTool({ match: /^(mcp__ccd_turn__update_plan|TodoWrite)$/, map: () => ({ type: 'tool_call', summary: '更新任务清单', detail: '' }) }),
    registerTool({ match: /^mcp__Claude_Browser__preview_start$/, map: previewOf }),
  ];
  registerEngine({
    ...IDENTITY, prefix: 'CL',
    character: (): Character => {
      const art = loadSprite();
      return art ? { kind: 'sprite', url: `/api/characters/claude?v=${art.version}`, columns: art.columns, rows: 2, cell: art.cell, idle: [0, 0], working: { row: 1, frames: art.columns } } : { kind: 'image', url: '/assets/characters/claude.svg', pixelated: true };
    },
    // The skin adds only Claude's typeface and Clawd to the shared chat kit.
    permissionModes: PERMISSION_MODES,
    // The desktop's two modes, as its sidebar switch names them ("Mode": Claude / Code). Code
    // sessions are read from their transcripts; Claude-mode chats and pinned projects from the
    // lists the desktop keeps on disk (src/server/services/claude-chats.ts), without their messages.
    // Its chats have no folder, and the mode's own model and settings apply: the console's
    // folder, model, permission and attachment controls do not show there (CHAT_CAPABILITIES).
    spaces: [
      { id: 'chat', label: 'Claude', capabilities: { ...CHAT_CAPABILITIES, interrupt: true } },
      { id: 'code', label: 'Code', default: true },
    ],
    skin: { stylesheet: '/skins/claude/skin.css' },
    // The kit's defaults are the Claude desktop's way of writing a conversation (plugin-contract.md, "对话的样子").
    look: {},
    // Approvals are asked and answered in the desktop app: it runs every turn.
    capabilities: { attachments: true, cwd: true, models: true, reasoning: true, interrupt: true, desktopInterrupt: true, approvals: false, dictation: true, send: true, steer: true, cardActions: true,
      // A new chat is created by its first message, in the desktop app's own "New session" page,
      // with what that page asks for picked there first (newOptions). A chat started from a
      // project's "+" has its folder picked there too: the page shows a Folder menu once its
      // Environment is "This computer" (newFolder, the desktop's own names).
      createRequiresPrompt: true, newOptions: true, openFile: true, showInDesktop: true, newFolder: { control: 'Folder', via: { control: 'Environment', option: 'This computer' } } },
    status: () => bridge.getStatus(), models: () => bridge.getModels(), usage: () => bridge.getUsage(),
    dictate: options => bridge.dictate(options), dictationReady: () => bridge.dictationReady(),
    list: async () => { const { projects } = chatSessions(); return [...await bridge.list(), ...mode.chats().map(chat => asSession(chat, projects))]; },
    projects: () => chatSessions().projects.map(project => ({ id: project.id, name: project.name, cwd: '', space: 'chat' })),
    // A Claude-mode chat: its messages read from the desktop's window.
    read: async id => {
      const chat = mode.get(id);
      if (!chat) return bridge.read(id);
      return mode.read(asSession(chat, chatSessions().projects), chat.updatedAt);
    },
    media: (id, key) => bridge.media(id, key),
    // A new chat in the Claude mode (input.space), in one of its projects or in none.
    create: input => (input.space === 'chat' ? mode.create(input, chatSessions().projects.find(project => project.id === input.projectId) || null) : bridge.create(input)),
    observe: id => (isChat(id) ? mode.observe(id) : bridge.observe(id)),
    newOptions: options => bridge.newOptions(options), pickNewOption: (control, option) => bridge.pickNewOption(control, option),
    pickNewOptions: picks => bridge.pickNewOptions(picks), keepWarm: () => bridge.keepWarm(),
    send: (id, input) => (isChat(id) ? mode.send(id, input) : bridge.sendMessage(id, input)),
    openFile: (id, file) => bridge.openFile(id, file),
    fileRoots: id => (isChat(id) ? [] : bridge.fileRoots(id)),
    show: id => (isChat(id) ? mode.show(id) : bridge.show(id)),
    // The desktop's own buttons on a wrap-up card (commit, open a PR…), pressed on that card.
    readCard: (id, card) => { if (isChat(id)) throw Object.assign(new Error('这个操作只能在桌面版里点'), { status: 501 }); return bridge.readCard(id, card); },
    pressAction: (id, action) => { if (isChat(id)) throw Object.assign(new Error('这个操作只能在桌面版里点'), { status: 501 }); return bridge.pressAction(id, action); },
    interrupt: id => (isChat(id) ? mode.interrupt(id) : bridge.interrupt(id)),
    // Claude's own questions (a card in the chat) are answered on the desktop's card.
    decide: (id, decision) => bridge.decide(id, decision),
    steer: (id, input) => { if (isChat(id)) throw Object.assign(new Error(chatOnly), { fallback: 'queue' }); return bridge.steer(id, input); },
    sendNow: id => bridge.sendNow(id),
    blocked: id => (id && isChat(id) ? '' : bridge.sendBlockedReason(id)),
  });
  return () => { bridge.dispose(); for (const dispose of disposers) dispose(); };
};
