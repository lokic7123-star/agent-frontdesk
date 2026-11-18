import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../codex-bridge.js';
import { CodexChatgpt, type ChatgptConversation, type ChatgptProject } from '../services/codex-chatgpt.js';
import { UnifiedSession } from '../types.js';
import { ChatMode, CHAT_CAPABILITIES } from '../services/desktop-chat.js';
import { appPlaces, firstExisting, readAsarFile } from '../services/app-assets.js';
import type { Character, PluginAbout, PluginSetup } from '../../shared/contract.js';
// The Codex character as the ChatGPT desktop app draws it: an 8 x 11 sprite sheet whose
// first frame is the idle pose and whose eighth row is the "typing on a laptop" loop.
const SPRITE = /\/webview\/assets\/codex-spritesheet-v\d+\.[0-9a-f]+\.webp$/;
const CHARACTER: Character = { kind: 'sprite', url: '/api/characters/codex', columns: 8, rows: 11, cell: [192, 208], idle: [0, 0], working: { row: 7, frames: 6 } };
const DEFAULT_ASAR = '/Applications/ChatGPT.app/Contents/Resources/app.asar';
// Who this is, the same whether the agent is on or off (the engine below is registered with it).
const IDENTITY = { id: 'codex', label: 'Codex', description: 'Codex desktop', priority: 10, accent: '#5B7BFA' } as const;
/** The agent as the console lists it before it is set up: found when the desktop app is on this machine (~/.codex alone is the command-line tool's, which the console does not drive). */
export const about: PluginAbout = { ...IDENTITY,
  // The app's own icon, beside its app.asar in the installed app (the host serves it; nothing is copied here).
  appIcon: config => {
    const asar = config.chatgptAppAsar || DEFAULT_ASAR;
    if (process.platform === 'win32') {
      const msixIcon = path.resolve(path.dirname(asar), '..', '..', 'assets', 'icon.png');
      if (fs.existsSync(msixIcon)) return msixIcon;
    }
    return path.join(path.dirname(asar), 'electron.icns');
  },
  detect: config => firstExisting(appPlaces(config.chatgptAppAsar || DEFAULT_ASAR)) };
export const setup: PluginSetup = ({ config, registerEngine, registerAsset }) => {
  const archive = config.chatgptAppAsar || DEFAULT_ASAR;
  let sprite: Buffer | null | undefined;
  const loadSprite = (): Buffer | null => {
    if (sprite === undefined) { try { sprite = fs.existsSync(archive) ? readAsarFile(archive, SPRITE)?.data || null : null; } catch { sprite = null; } }
    return sprite;
  };
  registerAsset?.('codex', () => { const data = loadSprite(); return data && { type: 'image/webp', data }; });
  const bridge = new CodexBridge(config);
  // The desktop's "ChatGPT" mode: its Recents and projects, from the app's own files.
  const chatgpt = new CodexChatgpt({ codexHome: config.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex') });
  const ELSEWHERE = 'ChatGPT 对话的正文不在本机，要从 Codex 桌面版的界面读';
  const mode = (): { conversations: ChatgptConversation[]; projects: ChatgptProject[] } => { try { return chatgpt.read(); } catch { return { conversations: [], projects: [] }; } };
  // Its conversations are read, started and answered in the desktop's own window (src/server/services/desktop-chat.ts).
  const chats = new ChatMode({ automation: bridge.ui, space: 'chatgpt', label: 'Codex 桌面版', list: () => mode().conversations.filter(item => !item.local) });
  const remote = (id: string) => chats.get(id);
  const asSession = (item: { id: string; title: string; updatedAt: string }, rank: number) => new UnifiedSession({ id: item.id, engine: 'codex', title: item.title, updatedAt: item.updatedAt, sendBlocked: ELSEWHERE,
    metadata: { space: 'chatgpt', contentUnavailable: ELSEWHERE, group: null, bySpace: { chatgpt: { rank } } } });
  // Codex threads in both modes: under their project in "Codex", in Recents (by recency) in "ChatGPT".
  // Both modes order them as the desktop's Recents does (its catalog's recency), not by the thread's
  // own update time, so the console's "最近" matches the desktop's.
  const listAll = async () => {
    const [threads, { conversations }] = [await bridge.listThreads(), mode()];
    const rank = new Map(conversations.map((item, index) => [item.id, index]));
    const recency = new Map(conversations.map(item => [item.id, Date.parse(item.updatedAt) || 0]));
    // (A thread the catalog does not list yet keeps its own time, so a new one still comes first.)
    const when = (thread: UnifiedSession) => recency.get(thread.id) || (typeof thread.updatedAt === 'number' ? thread.updatedAt * (thread.updatedAt < 1e12 ? 1000 : 1) : Date.parse(String(thread.updatedAt)) || 0);
    for (const thread of threads) {
      const codex = { rank: -when(thread) };
      thread.metadata = rank.has(thread.id)
        ? { ...thread.metadata, space: ['codex', 'chatgpt'], bySpace: { chatgpt: { group: null, rank: rank.get(thread.id) }, codex } }
        : { ...thread.metadata, bySpace: { ...thread.metadata?.bySpace, codex } };
    }
    return [...threads, ...chats.chats().map(item => asSession(item, rank.get(item.id) ?? -1))];
  };
  registerEngine({
    ...IDENTITY, prefix: 'CX', character: () => (loadSprite() ? CHARACTER : null),
    // Every turn runs in the Codex desktop app (see CodexBridge); what it waits on the person for is
    // shown here too, and a new chat is started by its first message on the desktop's New chat page.
    // The desktop's two modes ("Switch mode": ChatGPT / Codex). Codex threads come from the
    // app-server; the ChatGPT mode's Recents and projects from the desktop's own files
    // (src/server/services/codex-chatgpt.ts), without the ChatGPT conversations' messages.
    spaces: [
      { id: 'chatgpt', label: 'ChatGPT', capabilities: CHAT_CAPABILITIES },
      { id: 'codex', label: 'Codex', default: true },
    ],
    capabilities: { attachments: true, cwd: true, models: true, reasoning: true, interrupt: true, approvals: true, steer: true, createRequiresPrompt: true,
      // The New chat page's own model and effort, read from it: a new chat's menus start on them.
      newSettings: true, openFile: true, showInDesktop: true },
    // How the Codex desktop writes a conversation (plugin-contract.md, "对话的样子"): the work folds
    // under "Worked for …" ("Working for …" live, "You stopped after …"), tool runs are named by kind,
    // code blocks have a header, a turn's edits end in a diff card, and no times are shown.
    look: { worked: 'fold', workingLive: true, toolCaption: 'kinds', diffCard: true, userTime: false, replyTime: 'none' },
    usage: () => bridge.getUsage(),
    status: () => bridge.getStatus(), models: () => bridge.getModels(),
    list: listAll,
    projects: async () => [...await bridge.listProjects(), ...mode().projects.map(project => ({ ...project, space: 'chatgpt' }))],
    // A ChatGPT conversation: its messages read from the desktop's window.
    read: id => { const item = remote(id); return item ? chats.read(asSession(item, 0), item.updatedAt) : bridge.getThread(id); },
    blocked: () => '',
    // A new conversation in the ChatGPT mode (input.space), in one of its projects or in none.
    create: input => (input.space === 'chatgpt' ? chats.create(input, mode().projects.find(project => project.id === input.projectId) || null) : bridge.create(input)),
    observe: id => (remote(id) ? chats.observe(id) : bridge.observe(id)),
    newSettings: () => bridge.newSettings(), keepWarm: () => bridge.ui.keepWarm?.(),
    send: (id, input) => (remote(id) ? chats.send(id, input) : bridge.startTurn({ ...input, threadId: id })),
    openFile: (id, file) => bridge.openFile(id, file),
    show: id => (remote(id) ? chats.show(id) : bridge.show(id)),
    interrupt: (id, emitter) => { if (remote(id)) throw Object.assign(new Error('ChatGPT 对话的回复请在 Codex 桌面版里停止'), { status: 501 }); return bridge.interruptTurn(id, emitter); },
    // The emitter the console passes is not needed: a steered message goes to the window that owns the thread.
    steer: (id, input) => { if (remote(id)) throw Object.assign(new Error('ChatGPT 对话在回复时不能插话，消息已排队，等这条回复结束再发'), { fallback: 'queue' }); return bridge.steerTurn(id, input); },
    // What the desktop waits on the person for (its question, a command, a file change) is a card
    // in the chat, answered through the window that owns the thread.
    decide: (id, decision) => bridge.decide(id, decision),
  });
  return () => bridge.dispose();
};
