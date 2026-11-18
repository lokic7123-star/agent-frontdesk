import os from 'node:os';
import path from 'node:path';
import { registerTool, type ToolSummary } from '../services/tool-catalog.js';
import { AntigravityBridge } from '../antigravity-bridge.js';
import { get } from '../../shared/guards.js';
import { appPlaces, firstExisting } from '../services/app-assets.js';
import type { Character, PluginAbout, PluginSetup } from '../../shared/contract.js';
const text = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
// A tool call's arguments, as Antigravity records them (its own names).
const arg = (input: unknown, name: string): unknown => get(input, name);
// Antigravity's own tools, summarised the way its desktop names them.
const TOOLS: Array<[RegExp, (input: unknown) => ToolSummary]> = [
  [/^task_boundary$/, input => ({ type: 'tool_call', summary: text(arg(input, 'TaskStatus') || arg(input, 'TaskName')) || 'Task update', detail: text(arg(input, 'TaskSummary')) })],
  [/^notify_user$/, () => ({ type: 'tool_call', summary: 'Notified user', detail: '' })],
  [/^manage_task$/, input => ({ type: 'tool_call', summary: `Task · ${text([arg(input, 'Action'), String(arg(input, 'TaskId') || '').split('/').at(-1)].filter(Boolean).join(' ')) || 'tasks'}`, detail: '' })],
  [/^schedule$/, input => ({ type: 'tool_call', summary: `Scheduled · ${text(arg(input, 'Prompt')) || 'follow-up'}`, detail: arg(input, 'DurationSeconds') ? `${arg(input, 'DurationSeconds')}s` : '' })],
  [/^generate_image$/, input => ({ type: 'tool_call', summary: `Generated image · ${text(arg(input, 'ImageName')) || 'image'}`, detail: text(arg(input, 'Prompt')) })],
  [/^send_message$/, input => ({ type: 'tool_call', summary: `Message · ${text(arg(input, 'Recipient')) || 'agent'}`, detail: text(arg(input, 'Message')) })],
  [/^browser_subagent$/, input => ({ type: 'tool_call', summary: `Browser · ${text(arg(input, 'TaskName') || arg(input, 'RecordingName')) || 'task'}`, detail: text(arg(input, 'Task')) })],
  [/^command_status$/, () => ({ type: 'tool_call', summary: 'Checked command', detail: '' })],
  [/^send_command_input$/, input => ({ type: 'tool_call', summary: 'Sent input to command', detail: text(arg(input, 'Input')) })],
];
// Who this is, the same whether the agent is on or off (the engine below is registered with it).
const IDENTITY = { id: 'antigravity', label: 'Antigravity', description: 'Antigravity desktop', priority: 30, accent: '#4285F4' } as const;
const CHARACTER: Character = { kind: 'image', url: '/assets/characters/antigravity.svg', standIn: true };
const winAsar = () => path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'resources', 'app.asar');
/** The agent as the console lists it before it is set up: found when Antigravity's data folder, or the app, is on this machine. */
export const about: PluginAbout = { ...IDENTITY, character: CHARACTER,
  // The app's own icon, read from the installed app (the host serves it; nothing is copied here).
  // Windows keeps it inside resources\app.asar as /icon.png (readAppIcon reads an .asar too);
  // the .env (ANTIGRAVITY_APP_ICON) wins everywhere.
  appIcon: () => process.env.ANTIGRAVITY_APP_ICON
    || (process.platform === 'win32' ? winAsar() : '/Applications/Antigravity.app/Contents/Resources/icon.icns'),
  detect: config => firstExisting([...appPlaces(process.platform === 'win32'
    ? winAsar()
    : '/Applications/Antigravity.app/Contents/Resources/app.asar'), config.agyHome]) };
export const setup: PluginSetup = ({ config, registerEngine }) => {
  // Where Antigravity keeps its data: always set by the server's configuration (config.ts).
  const agyHome = config.agyHome;
  if (!agyHome) throw new Error('antigravity plugin: config.agyHome is not set'); // a setup error, never shown to a person
  const bridge = new AntigravityBridge({ ...config, agyHome });
  const disposers = TOOLS.map(([match, map]) => registerTool({ match, map }));
  registerEngine({
    ...IDENTITY, prefix: 'AG', character: CHARACTER,
    // How the Antigravity desktop writes a conversation (plugin-contract.md, "对话的样子").
    look: { worked: 'fold', ago: 'short', replyTime: 'before' },
    capabilities: { dictation: true, attachments: true, models: true, interrupt: true, createRequiresPrompt: true, send: true, steer: true,
      // A new chat can start in a folder (the language server takes the workspace), and what the
      // agent waits on the person for (a permission, its own question) is answered from a card in the chat.
      cwd: true, approvals: true, openFile: true },
    usage: () => bridge.getUsage(),
    dictate: options => bridge.dictate(options), dictationReady: () => bridge.dictationReady(),
    status: () => bridge.getStatus(), models: () => bridge.getModels(),
    list: () => bridge.listConversations(), read: id => bridge.getConversationHistory(id),
    // agentapi creates and starts a conversation in a single operation.
    create: input => bridge.newConversation(input),
    observe: id => bridge.observe(id),
    steer: (id, input) => bridge.steer(id, input),
    // The language server's cancel, the call behind the desktop's stop button.
    openFile: (id, file) => bridge.openFile(id, file),
    // The documents the agent writes for a chat (its "artifacts") live in brain/<id>, outside the workspace.
    fileRoots: id => bridge.fileRoots(id),
    interrupt: id => bridge.interrupt(id),
    decide: (id, decision) => bridge.decide(id, decision),
    media: (id, key) => bridge.media(id, key),
    send: (id, input) => bridge.sendMessage({ ...input, conversationId: id }),
    blocked: () => bridge.sendBlockedReason(),
  });
  return () => { bridge.dispose(); for (const dispose of disposers) dispose(); };
};
