// Claude desktop (Code tab) owns its history: an index of desktop sessions under
// ~/Library/Application Support/Claude/claude-code-sessions and one transcript per
// session under ~/.claude/projects. The console reads both read-only. Every message, a new
// chat's first one too, is sent by the desktop app itself (src/server/claude-desktop.ts), so the
// desktop is the one process that runs and writes its sessions. When the desktop cannot take a
// message, nothing is sent and the page says why: no other process is ever started to run a
// turn. The Claude Code CLI is used only to read the model list and usage (control requests
// that send no prompt and keep no session).
// The index, the transcripts and the CLI's answers are Claude's own formats: every record enters
// as unknown and is read through the guards, so a record nobody understands is skipped.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { spawn, execFile, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { UnifiedSession, UnifiedTurn, UnifiedStep, EngineEvents, assignPhases } from './types.js';
import { questionCard, desktopCard } from './core/presentation.js';
import { withAttachments } from './core/attachments.js';
import { promptStarts } from '../shared/turn-match.js';
import { ClaudeDesktop, type DesktopSession } from './claude-desktop.js';
import { newControlsOf, type DesktopFlags, type HelperResult } from './core/desktop-automation.js';
import { globalSocket } from './services/node-websocket.js';
import { arr, bag, errorField, get, list, messageOf, num, parseJson, str, text as asText } from '../shared/guards.js';
import type {
  Approval, CardAction, CardRead, CreateInput, CreateResult, DesktopQueueItem, DesktopSettings, DictationHandlers, DictationReady, DictationStream, EngineEmitter, EngineStatus,
  FileTarget, History, MediaFile, MediaImage, Model, NewOptionsResult, NewPick, PermissionMode, PlanItem, SendInput,
  SessionGroup, TimeValue, UnifiedTurn as Turn, Usage, UsageWindow, WrapUpCard,
} from '../shared/contract.js';

const NO_CLI = '没有找到 Claude Code 命令行。请先打开一次 Claude 桌面版的 Code 标签页，或设置 CLAUDE_BIN。';
// The command that signs Claude Code in on this machine: the plain one when `claude` is on the
// PATH, else the copy the desktop app installed, by its full path. That path holds the person's
// name and a folder per version, so it is worked out here and never written into a document.
function loginCommand(bin: string | null, env: NodeJS.ProcessEnv = process.env): string {
  // Both separators are accepted so a PATH written for the other platform is still understood,
  // and the comparison normalizes \ so a Windows join matches a /-written candidate.
  const onPath = !!bin && (env['PATH'] || '').split(/[;:]/).some(dir => path.join(dir, 'claude').replace(/\\/g, '/') === bin.replace(/\\/g, '/'));
  return !bin || onPath ? 'claude auth login' : `"${bin}" auth login`;
}
const noSignIn = (bin: string | null): string => `读取不到 Claude Code 的登录信息，请先运行 ${loginCommand(bin)}`;
const loggedOut = (bin: string | null): string => `Claude Code 命令行还没有登录。请在终端运行一次 ${loginCommand(bin)}，然后刷新工作台。`;
// The permission modes Claude Code accepts (claude --help). `label` is the name in the desktop's
// own permission menu: it is what the page shows and what the desktop is asked to pick.
const PERMISSION_MODES: PermissionMode[] = [
  { id: 'manual', label: 'Manual', description: '改文件、跑命令前先问你' },
  { id: 'acceptEdits', label: 'Accept edits', description: '直接改文件，跑命令前先问你' },
  { id: 'plan', label: 'Plan', description: '只读，先给出计划，不改动任何东西' },
  { id: 'auto', label: 'Auto', description: '由 Claude 判断哪些操作需要你确认' },
  { id: 'bypassPermissions', label: 'Bypass permissions', description: '不再询问，直接执行所有操作' },
];
// Effort levels as the desktop's Effort menu names them.
const EFFORT_LABELS: Readonly<Record<string, string>> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };
const effortLabel = (id: string): string | undefined => Object.hasOwn(EFFORT_LABELS, id) ? EFFORT_LABELS[id] : undefined;
const sameModel = (a: unknown, b: unknown): boolean => { const key = (value: unknown) => String(value || '').replace(/^claude-/, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); return !!key(a) && key(a) === key(b); };
const PLAN_TOOLS = /^(mcp__ccd_turn__update_plan|TodoWrite)$/;
const WRAP_UP = 'mcp__ccd_turn__wrap_up';
const ASK_TOOL = 'AskUserQuestion';
// Text the CLI injects into the user role that is not something a person typed.
const INJECTED = /^\s*(<(command-name|command-message|local-command-stdout|local-command-stderr|task-notification|side-sessions-event|system-reminder|ci-monitor-event|bash-input|bash-stdout|bash-stderr)\b|\[Request interrupted by user|Caveat: The messages below)/;

/** One session in the desktop's index (local_*.json), the fields the console reads. */
export interface SessionMeta extends DesktopSession {
  id: string | undefined; scope: string; cwd: string; title: string;
  /** The folder the session was started from: for a session in a worktree, the checkout the worktree came from. */
  originCwd: string;
  model: string; effort: string; permissionMode: string; isArchived: boolean;
  createdAt?: number; lastActivityAt?: number; lastTurnEdgeAt?: number; latestUserFrameAt?: number;
  /** When the desktop last showed this session. */
  lastFocusedAt?: number;
  parentLocalId: string; status: string; needsAction: string; wrapUp: string;
}
/** A transcript, parsed once per change. */
export interface ParsedTranscript {
  file: string; size: number; mtimeMs: number; writtenAt?: number; turns: UnifiedTurn[]; cwd: string; title: string; queue: DesktopQueueItem[]; queuedAt?: number[]; lastStop?: unknown;
  /** Kept only while the transcript is being written (see ClaudeBridge.parse): its records so far, and how far into the file they reach. */
  tail?: { records: unknown[]; offset: number };
}
/** What the stream handler keeps for one followed turn. */
export interface StreamRun {
  emitter: EngineEmitter; interrupted?: boolean; lastMessage: { id: string; text: string } | null; plan: PlanItem[] | null;
  planStep?: { id: string; name: string; input: unknown };
  /** Questions Claude asked (AskUserQuestion), by tool-use id, until answered. */
  asks?: Map<string, unknown[]>;
}
/** A turn the desktop runs for a message from here, followed in its transcript. */
export interface DesktopRun extends StreamRun {
  desktop?: boolean; meta: SessionMeta; finished?: boolean; started?: number | null; steers?: string[]; error?: string;
  finish?: (status: string) => void; timer?: ReturnType<typeof setInterval>; stopRequested?: boolean; stopReason?: unknown; endedAt?: number; waiting?: string;
}
type Route = { error: string } | { desktop: true; meta: SessionMeta; file: string };

// ---------- discovery ----------
function findClaudeBin(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  if (env['CLAUDE_BIN']) return env['CLAUDE_BIN'];
  for (const dir of (env['PATH'] || '').split(path.delimiter)) {
    const file = path.join(dir, 'claude');
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  // The desktop app installs its own copy, one folder per version.
  const root = path.join(home, 'Library/Application Support/Claude/claude-code');
  try {
    const versions = fs.readdirSync(root).filter(name => /^\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.split('.').map(Number).reduce((d, n, i) => d || n - (a.split('.').map(Number)[i] ?? NaN), 0));
    for (const version of versions) {
      for (const build of fs.readdirSync(path.join(root, version))) {
        const file = path.join(root, version, build, 'claude.app/Contents/MacOS/claude');
        if (fs.existsSync(file)) return file;
      }
    }
  } catch {}
  return null;
}

// ---------- pure parsing (covered by tests) ----------
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((block: unknown) => get(block, 'type') === 'text').map((block: unknown) => asText(get(block, 'text') || '')).join('\n') : '';
// With thinking shown as "updates" the desktop replaces Claude's reasoning by short progress
// notes (the reasoning itself is stored empty) and shows them as ordinary text. Those notes are
// what Claude says, so they show; any other thinking stays hidden.
const progressNote = (record: unknown, block: unknown): string => get(block, 'type') === 'thinking' && get(record, 'thinkingDisplay') === 'updates' ? asText(get(block, 'thinking') || '').trim() : '';
// What the person typed: the desktop may put system reminders (linked-session notes and the
// like) in front of it, in the same message, so drop those parts instead of the whole message.
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const typedText = (content: unknown): string => (typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((block: unknown) => get(block, 'type') === 'text').map((block: unknown) => asText(get(block, 'text') || '')) : [])
  .map(said => said.replace(REMINDER, '').trim()).filter(said => said && !INJECTED.test(said)).join('\n');
// A turn starts only with what a person typed (in the desktop app or sent through the SDK).
function isHumanPrompt(record: unknown): boolean {
  if (get(record, 'type') !== 'user' || get(record, 'isMeta') || get(record, 'isSidechain') || get(record, 'isCompactSummary') || get(record, 'isVisibleInTranscriptOnly')) return false;
  const turnOrigin = get(record, 'turnOrigin');
  if (turnOrigin && !(turnOrigin === 'human' || turnOrigin === 'sdk')) return false;
  const kind = get(record, 'origin', 'kind');
  if (kind && kind !== 'human') return false;
  const content = get(record, 'message', 'content');
  if (Array.isArray(content) && content.some((block: unknown) => get(block, 'type') === 'tool_result')) return false;
  const typed = typedText(content);
  const hasImage = Array.isArray(content) && content.some((block: unknown) => get(block, 'type') === 'image');
  if (typed) return true;
  return hasImage && !INJECTED.test(textOf(content).replace(REMINDER, '').trim());
}
// Messages the desktop is holding to put into the running turn: its queue-operation records
// (enqueue, dequeue first-in-first-out, remove). Background-task notices queue there too.
function desktopQueue(records: readonly unknown[]): DesktopQueueItem[] {
  const queue: Array<{ content: string; at: unknown }> = [];
  for (const record of records) {
    if (get(record, 'type') !== 'queue-operation') continue;
    const operation = get(record, 'operation'), content = String(get(record, 'content') ?? '');
    if (operation === 'enqueue') queue.push({ content, at: get(record, 'timestamp') });
    else if (operation === 'dequeue') queue.shift();
    else if (operation === 'remove') { const index = queue.findIndex(item => item.content === content); if (index >= 0) queue.splice(index, 1); }
  }
  return queue.filter(item => !/^\s*<task-notification>/.test(item.content)).map(item => ({ prompt: item.content.replace(REMINDER, '').trim() || '（图片或附件）', at: timeOf(item.at) }));
}
// The step list as the desktop shows it, replayed from its plan tool calls.
function applyPlan(previous: readonly PlanItem[] | null | undefined, name: string, input: unknown = {}): PlanItem[] {
  if (name === 'TodoWrite') return list(get(input, 'todos')).map(todo => ({ content: asText(get(todo, 'content') || get(todo, 'activeForm') || ''), status: asText(get(todo, 'status')) }));
  const items = arr(get(input, 'items'));
  const plan: PlanItem[] = items ? items.map(item => ({ content: asText(get(item, 'content') || ''), status: asText(get(item, 'status') || 'pending') })) : (previous || []).map(step => ({ ...step }));
  if (get(input, 'advance')) {
    const current = plan.findIndex(step => step.status === 'in_progress');
    const now = plan[current];
    if (now) now.status = 'completed';
    const next = plan.find((step, index) => index > current && step.status === 'pending');
    if (next) next.status = 'in_progress';
  }
  for (const index of list(get(input, 'done'))) { const step = plan[Number(index) - 1]; if (step) step.status = 'completed'; }
  const start = get(input, 'start'), started = start ? plan[Number(start) - 1] : undefined;
  if (started) {
    for (const step of plan) if (step.status === 'in_progress') step.status = 'pending';
    started.status = 'in_progress';
  }
  return plan;
}
const finishPlan = (plan: readonly PlanItem[] | null): PlanItem[] => (plan || []).map(step => ({ ...step, status: 'completed' }));
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block: unknown) => get(block, 'type') === 'text').map((block: unknown) => asText(get(block, 'text') || '')).join('\n');
}
const mediaUrl = (sessionId: string, key: string) => `/api/sessions/claude/${sessionId}/media/${key}`;
function imagesOf(sessionId: string, toolUseId: string, content: unknown): MediaImage[] | null {
  if (!Array.isArray(content)) return null;
  const images = content.filter((block: unknown) => get(block, 'type') === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(asText(get(block, 'source', 'media_type') || '')))
    .map((_block: unknown, index: number) => ({ url: mediaUrl(sessionId, `${toolUseId}-${index}`), alt: '截图' }));
  return images.length ? images : null;
}
// The desktop app adds a line per pasted picture ("[Image: source: /path]", "[Image: original
// 3988x1312, …]") to the text it records; the picture itself is shown instead.
const promptText = (said: string): string => said.split('\n').filter(line => !/^\s*\[Image: (source|original)[^\]]*\]\s*$/.test(line)).join('\n').replace(/(\[Image: source: [^\]]*\])+\s*$/, '').trim();
// Lines the transcript keeps for the API layer are large and carry nothing to show.
const SKIPPED = /^\{"type":"(api-request|api-request-blob|api-request-shape|file-history-snapshot|file-history-delta|attachment)"/;
function parseLines(source: string): unknown[] {
  const records: unknown[] = [];
  for (const line of source.split('\n')) {
    if (!line.trim() || SKIPPED.test(line)) continue;
    try { records.push(parseJson(line)); } catch { /* A partial last line or an unknown record: skip it. */ }
  }
  return records;
}
// The records in a stretch of a transcript, and how many of its bytes they account for: every
// whole line, and a last line without its newline when it is a whole record already. A last line
// still being written is left for the next read (`used` stops before it).
function readRecords(chunk: Buffer): { records: unknown[]; used: number } {
  const end = chunk.lastIndexOf(0x0a) + 1;
  const records = parseLines(chunk.toString('utf8', 0, end));
  const rest = chunk.toString('utf8', end);
  if (!rest.trim()) return { records, used: chunk.length };
  if (SKIPPED.test(rest)) return { records, used: end };
  try { records.push(parseJson(rest)); return { records, used: chunk.length }; } catch { return { records, used: end }; }
}
// A time as the record gives it (ISO text or a number), else nothing.
const timeOf = (value: unknown): TimeValue | undefined => typeof value === 'string' || typeof value === 'number' ? value : undefined;
// "448.5k", as the desktop writes token counts.
const tokens = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k` : String(n);
const TASK_STATUS: Readonly<Record<string, string>> = { completed: 'completed', failed: 'failed', killed: 'interrupted', stopped: 'interrupted' };
// Records → unified turns. Thinking blocks never become content.
function buildTurns(records: readonly unknown[], sessionId: string): UnifiedTurn[] {
  const turns: UnifiedTurn[] = [], steps = new Map<string, UnifiedStep>(), background = new Map<string, UnifiedStep>(), notified = new Set<string>();
  let turn: UnifiedTurn | null = null, plan: PlanItem[] | null = null;
  const close = (status: string, evidence: string, at: unknown) => { if (turn && !turn.statusEvidence) { turn.status = status; turn.statusEvidence = evidence; turn.completedAt = timeOf(at) || null; } };
  for (const record of records) {
    if (get(record, 'isSidechain')) continue;
    const uuid = str(get(record, 'uuid')), type = get(record, 'type'), content = get(record, 'message', 'content');
    if (isHumanPrompt(record)) {
      close('completed', 'next_turn', get(record, 'timestamp'));
      const id = uuid || randomUUID();
      const userImages = (uuid && imagesOf(sessionId, uuid, content)) || [];
      const prompt = promptText(typedText(content));
      turn = new UnifiedTurn({ id, userPrompt: prompt || (userImages.length ? '' : '（图片）'), userImages: userImages.map(image => ({ ...image, alt: '你发送的图片' })), timestamp: timeOf(get(record, 'timestamp')), status: 'unknown' });
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    const current: UnifiedTurn = turn;
    const add = (step: UnifiedStep) => { current.steps.push(step); current.timeline.push({ kind: 'activity', id: step.id }); };
    // A background command's end: the desktop lists it as "finished a background task".
    // It arrives as its own message, or queued while Claude was busy.
    const notice = type === 'user' ? textOf(content) : type === 'attachment' && get(record, 'attachment', 'type') === 'queued_command' ? String(get(record, 'attachment', 'prompt') || '') : '';
    const notification = notice.match(/^\s*<task-notification>([\s\S]*)/);
    if (notification) {
      const body = notification[1] || '';
      const field = (name: string) => (body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1] || '';
      const status = (Object.hasOwn(TASK_STATUS, field('status')) ? TASK_STATUS[field('status')] : undefined) || 'completed', origin = background.get(field('task-id'));
      // The same notification can be written twice (queued, then delivered).
      const key = `${field('task-id')}:${field('status')}`;
      if (notified.has(key)) continue;
      notified.add(key);
      if (origin) origin.status = status;
      // Delivered as its own message it wakes Claude for a reply of its own, which the desktop
      // shows without a row; queued into a running turn it is listed with that turn's tools.
      if (type === 'attachment') add(new UnifiedStep({ id: uuid || randomUUID(), type: 'background_task', title: field('summary') || 'Background task finished', status }));
      continue;
    }
    if (type === 'system' && get(record, 'subtype') === 'compact_boundary') {
      const meta = get(record, 'compactMetadata') || {}, saved = num(get(meta, 'cumulativeDroppedTokens')) ?? ((num(get(meta, 'preTokens')) || 0) - (num(get(meta, 'postTokens')) || 0));
      add(new UnifiedStep({ id: uuid || randomUUID(), type: 'notice', title: saved > 0 ? `Compacted session · saved ${tokens(saved)} tokens` : 'Compacted session' }));
      continue;
    }
    if (type === 'system' && get(record, 'subtype') === 'informational' && get(record, 'content')) {
      add(new UnifiedStep({ id: uuid || randomUUID(), type: 'notice', title: 'Claude Code notice', detail: String(get(record, 'content')) }));
      continue;
    }
    if (type === 'assistant') {
      const blocks = list(content);
      for (const [index, block] of blocks.entries()) {
        const note = progressNote(record, block), said = asText(get(block, 'text')).trim();
        if ((get(block, 'type') === 'text' && said) || note) {
          const id = blocks.length > 1 ? `${uuid}:${index}` : asText(uuid);
          current.messages.push({ id, text: note || said, at: timeOf(get(record, 'timestamp')) });
          current.timeline.push({ kind: 'message', id });
        } else if (get(block, 'type') === 'tool_use') {
          const name = asText(get(block, 'name')), input = get(block, 'input') || {}, blockId = asText(get(block, 'id'));
          const step = new UnifiedStep({ id: blockId, type: 'tool_call', name, input, title: asText(get(input, 'description') || ''), status: 'running' });
          if (name === 'Bash') { step.type = 'command'; step.detail = asText(get(input, 'command') || ''); }
          if (name === 'TaskStop') {
            step.type = 'stop_task'; step.title = 'Stopped task';
            const origin = background.get(asText(get(input, 'task_id') || get(input, 'shell_id')));
            if (origin) origin.status = 'interrupted';
          }
          if (PLAN_TOOLS.test(name)) { const next = applyPlan(plan, name, input); plan = next; step.plan = next.map(item => ({ ...item })); step.status = 'completed'; }
          if (name === WRAP_UP) {
            step.status = 'completed';
            // The desktop checks off whatever is left on the step list when a turn wraps up.
            const last = [...current.steps].reverse().find(item => item.plan);
            if (last && plan) { const done = finishPlan(plan); plan = done; last.plan = done.map(item => ({ ...item })); }
          }
          steps.set(blockId, step); add(step);
        }
      }
    } else if (type === 'user' && Array.isArray(content)) {
      for (const block of list(content)) {
        if (get(block, 'type') !== 'tool_result') { if (INJECTED.test(textOf([block])) && /interrupted/.test(asText(get(block, 'text') || ''))) close('interrupted', 'interrupt_marker', get(record, 'timestamp')); continue; }
        const toolUseId = asText(get(block, 'tool_use_id'));
        const step = steps.get(toolUseId);
        if (!step) continue;
        const output = resultText(get(block, 'content'));
        const isError = get(block, 'is_error');
        step.status = isError ? (/^The user doesn't want to proceed with this tool use/.test(output) ? 'interrupted' : 'failed') : 'completed';
        // Still running in the background: it ends with a task notification or TaskStop.
        const backgroundId = !isError && step.type === 'command' && output.match(/running in background with ID: ([\w-]+)/)?.[1];
        if (backgroundId) { step.status = 'running'; step.background = true; background.set(backgroundId, step); }
        if (!step.plan && step.name !== WRAP_UP) step.output = output.slice(0, 16000);
        const images = imagesOf(sessionId, toolUseId, get(block, 'content'));
        if (images) step.images = images;
      }
    } else if (type === 'system' && get(record, 'subtype') === 'stop_hook_summary') {
      close('completed', 'stop_hook', get(record, 'timestamp'));
    }
  }
  for (const item of turns) {
    assignPhases(item);
    if (item.statusEvidence) for (const step of item.steps) if (step.status === 'running' && !step.background) step.status = item.status === 'interrupted' ? 'interrupted' : 'completed';
  }
  return turns;
}
function recentMessages(turns: readonly Pick<Turn, 'messages'>[], limit = 6) {
  return turns.flatMap(turn => turn.messages).slice(-limit).map(message => ({ id: message.id, preview: message.text.replace(/\s+/g, ' ').slice(0, 200), phase: message.phase, at: Date.parse(String(message.at)) || 0 }));
}
// Running when the desktop index says a person's message arrived after the last turn edge.
// The desktop moves that edge not only when a turn ends but also when it pauses mid-step: a
// message queued into the running turn (a steer, from here or its own composer) or a dialog
// waiting for the person (a permission asked by a tool). Paused mid-step, the turn's last reply
// asked for a tool (stop_reason 'tool_use'), and it goes on; a turn ends with a final reply, a
// stop or an error. `midStep`: the transcript shows such a pause, so the edge is not an end.
type Edges = Pick<SessionMeta, 'latestUserFrameAt' | 'lastTurnEdgeAt'>;
function desktopRunning(meta: Edges | null | undefined, midStep = false): boolean {
  if (!meta?.latestUserFrameAt) return false;
  return !meta.lastTurnEdgeAt || meta.latestUserFrameAt > meta.lastTurnEdgeAt || midStep;
}
// A pause mid-step counts for this long after the transcript was last written (a long tool, or
// a dialog nobody answers); a desktop that quit in the middle of a step is not running for ever.
const MID_STEP_MS = 30 * 60000;
// Tools whose call always waits for the person in a dialog of the desktop app's own (computer
// use asking which apps it may control, and the like).
const DIALOG_TOOLS = /^mcp__computer-use__request_/;
// A queued message moves the edge within this long of its enqueue record.
const QUEUE_EDGE_MS = 1500;
/**
 * The step of a running turn that waits for the person in the desktop app, or null. A dialog
 * tool waits from its call on. Any other tool still pending waits on the person when the desktop
 * marked its turn edge after the transcript's last record (it stands still, see desktopRunning),
 * and no queued message (a steer) explains that edge.
 */
function awaitingStep(turn: Turn | undefined, meta: Edges | null | undefined, parsed: { writtenAt?: number; queuedAt?: readonly number[]; lastStop?: unknown }): Turn['steps'][number] | null {
  if (!turn || turn.statusEvidence || parsed.lastStop !== 'tool_use') return null;
  const pending = turn.steps.filter(step => step.status === 'running' && !step.background);
  const dialog = pending.find(step => DIALOG_TOOLS.test(step.name));
  if (dialog) return dialog;
  const edge = meta?.lastTurnEdgeAt || 0;
  if (!pending.length || !edge || edge <= (meta?.latestUserFrameAt || 0) || edge < (parsed.writtenAt || 0)) return null;
  if ((parsed.queuedAt || []).some(at => Math.abs(at - edge) <= QUEUE_EDGE_MS)) return null;
  return pending.at(-1) || null;
}
// The card for it: a dialog tool says what it asks; any other step, that it stands still there.
function awaitingCard(step: Turn['steps'][number]): Approval {
  const apps = list(get(step.input, 'apps')).map(asText).filter(Boolean), reason = asText(get(step.input, 'reason') || '').trim();
  if (DIALOG_TOOLS.test(step.name)) return desktopCard(`desktop:${step.id}`, 'Claude 桌面版在等你批准', `Claude 想用电脑操作${apps.length ? ` ${apps.join('、')}` : ''}${reason ? `：${reason}` : ''}。请在 Claude 桌面版里允许或拒绝，这一轮才会继续。`);
  return desktopCard(`desktop:${step.id}`, 'Claude 桌面版在等你操作', `这一步（${step.title || step.name}）停在桌面版里，可能需要你在那里确认后才会继续。`);
}
// When the desktop queued messages into a turn: its enqueue records, in milliseconds.
function queueTimes(records: readonly unknown[]): number[] {
  return records.filter(record => get(record, 'type') === 'queue-operation' && get(record, 'operation') === 'enqueue').map(record => stampOf(get(record, 'timestamp'))).filter(Boolean);
}
// The index alone can say "running" for hours: it is not always updated after a stop, and a
// change made in the desktop's menus counts as a person's frame though no turn starts. The
// transcript settles it: its last turn ended after that frame (stop hooks ran, or it was
// stopped), or it ended before and nothing was written after the frame for a while. "Written"
// is the time of the last dated record, not the file's: the desktop keeps appending undated
// bookkeeping (mode, cost-state, last-prompt) to a chat that is not running.
const FRAME_GRACE_MS = 90000, TURN_END_SETTLE_MS = 2500;
// Parsed transcripts kept (more sessions than a desktop lists), and how many of them keep their
// records for reading only what is appended (the sessions running at the moment).
const CACHED_TRANSCRIPTS = 400, HOT_TRANSCRIPTS = 3;
const stampOf = (value: unknown): number => typeof value === 'number' ? value : Date.parse(String(value)) || 0;
// The desktop's end-of-turn status (blocked, review ready) asks for a look only until the session is
// opened there after that turn ended; after that the desktop shows no mark, and neither does the console.
const unseen = (meta: Pick<SessionMeta, 'lastTurnEdgeAt' | 'lastFocusedAt'>): boolean => (meta.lastFocusedAt || 0) < (meta.lastTurnEdgeAt || 0);

function sessionRunning(meta: Edges | null | undefined, parsed: { turns?: ReadonlyArray<{ statusEvidence?: string | null; completedAt?: unknown }>; mtimeMs: number; writtenAt?: number; lastStop?: unknown } | null, now = Date.now()): boolean {
  const latest = parsed?.turns?.at(-1);
  const midStep = !!parsed && !latest?.statusEvidence && parsed.lastStop === 'tool_use' && now - (parsed.writtenAt || parsed.mtimeMs) < MID_STEP_MS;
  if (!meta || !desktopRunning(meta, midStep)) return false;
  if (!parsed || !latest?.statusEvidence) return true;
  const frame = meta.latestUserFrameAt || 0;
  if (stampOf(latest.completedAt) >= frame) return false;
  return (parsed.writtenAt ?? parsed.mtimeMs) + 1000 >= frame || now - frame < FRAME_GRACE_MS;
}
function usageOf(response: unknown): Usage {
  const limits = get(response, 'rate_limits') || {};
  const window = (key: string, label: string, minutes: number, item: unknown = get(limits, key)): UsageWindow | null => {
    const utilization = get(item, 'utilization');
    if (!item || typeof utilization !== 'number') return null;
    const used = Math.max(0, Math.min(100, utilization));
    const reset = Date.parse(asText(get(item, 'resets_at') || ''));
    return { id: key, label, windowMinutes: minutes, usedPercent: used, remainingPercent: 100 - used, resetsAt: Number.isFinite(reset) ? Math.round(reset / 1000) : null };
  };
  // The account's own list of limits, as the desktop's usage page draws it: which rows there are
  // depends on the plan (a weekly limit for one model family, e.g. Fable, on some accounts only).
  const listed = list(get(limits, 'limits')).flatMap((item, index): UsageWindow[] => {
    const kind = asText(get(item, 'kind') || ''), weekly = get(item, 'group') !== 'session', percent = get(item, 'percent');
    const scope = get(item, 'scope', 'model', 'display_name') || get(item, 'scope', 'surface', 'display_name') || str(get(item, 'scope', 'surface'));
    const id = kind === 'session' ? 'five_hour' : kind === 'weekly_all' ? 'seven_day' : `limit_${index}`;
    const label = kind === 'session' ? '5 小时' : !weekly ? '额度' : scope ? `每周 · ${scope}` : kind === 'weekly_all' ? '每周' : '每周 · 其他';
    const row = window(id, label, weekly ? 10080 : 300, { utilization: percent, resets_at: get(item, 'resets_at') });
    return row ? [row] : [];
  });
  const windows = listed.length ? listed : [window('five_hour', '5 小时', 300), window('seven_day', '每周', 10080)].filter((item): item is UsageWindow => !!item);
  // An older Claude Code without that list: the shared windows, then the weekly limits it names
  // for one model family.
  if (!listed.length) for (const [index, item] of list(get(limits, 'model_scoped')).entries()) {
    const scoped = window(`model_${index}`, `每周 · ${get(item, 'display_name') || '模型'}`, 10080, item);
    if (scoped) windows.push(scoped);
  }
  return windows.length ? { available: true, windows, plan: str(get(response, 'subscription_type')) || null }
    : { available: false, short: '未公开', reason: 'Claude Code 没有返回额度窗口' };
}
function modelsOf(response: unknown): Model[] {
  return list(get(response, 'models')).filter(model => get(model, 'value') && get(model, 'value') !== 'default').map(model => ({
    id: asText(get(model, 'value')), name: asText(get(model, 'displayName') || get(model, 'value')), description: asText(get(model, 'description') || ''),
    reasoningEfforts: get(model, 'supportsEffort') ? list(get(model, 'supportedEffortLevels')).map(asText) : [], defaultReasoningEffort: 'medium',
  }));
}
// Group label the desktop sidebar uses for a folder: the repository name, else the folder name.
function repoName(remote: unknown, cwd: string): string {
  const match = String(remote || '').trim().match(/([^/:]+?)(\.git)?$/);
  return match?.[1] || path.basename(cwd || '') || '其他';
}

// The origin remote of the repository holding `cwd`, read from its git config (worktrees included).
function originOf(cwd: string): string {
  try {
    let dir = cwd;
    while (dir && !fs.existsSync(path.join(dir, '.git'))) { const up = path.dirname(dir); if (up === dir) return ''; dir = up; }
    let git = path.join(dir, '.git');
    if (fs.statSync(git).isFile()) {
      git = path.resolve(dir, fs.readFileSync(git, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim() || '');
      const common = path.join(git, 'commondir');
      if (fs.existsSync(common)) git = path.resolve(git, fs.readFileSync(common, 'utf8').trim());
    }
    const config = fs.readFileSync(path.join(git, 'config'), 'utf8');
    return config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] || '';
  } catch { return ''; }
}
const errorOf = (err: unknown): Error => err instanceof Error ? err : new Error(String(err));

export interface ClaudeBridgeOptions { home?: string; env?: NodeJS.ProcessEnv; bin?: string | null; claudeHome?: string; desktopHome?: string; desktop?: ClaudeDesktop; tmpDir?: string }
interface AuthState { at: number; loggedIn: boolean; error: string }

// ---------- the bridge ----------
class ClaudeBridge {
  home: string; appDir: string; indexDir: string; projectsDir: string; tmpDir: string; bin: string | null;
  cache: Map<string, ParsedTranscript>; hot: string[] = []; metaCache: Map<string, { mtimeMs: number; meta: SessionMeta }>; repos: Map<string, string>;
  runs: Map<string, DesktopRun>; starts: Map<string, EngineEvents>;
  auth: AuthState | null; modelCache: { at: number; models: Model[] } | null;
  desktop: ClaudeDesktop;
  constructor({ home = os.homedir(), env = process.env, bin, claudeHome, desktopHome, desktop, tmpDir = '/tmp' }: ClaudeBridgeOptions = {}) {
    this.home = home; this.tmpDir = tmpDir;
    this.appDir = desktopHome || path.join(home, 'Library/Application Support/Claude');
    this.indexDir = path.join(this.appDir, 'claude-code-sessions');
    this.projectsDir = path.join(claudeHome || path.join(home, '.claude'), 'projects');
    this.bin = bin === undefined ? findClaudeBin(env, home) : bin;
    this.cache = new Map(); this.metaCache = new Map(); this.repos = new Map();
    this.runs = new Map(); this.starts = new Map();
    this.auth = null; this.modelCache = null;
    this.desktop = desktop || new ClaudeDesktop();
  }

  // Desktop index: one local_*.json per session the desktop shows (read-only).
  desktopIndex(): SessionMeta[] {
    const entries: SessionMeta[] = [];
    let accounts: string[] = [];
    try { accounts = fs.readdirSync(this.indexDir); } catch { return entries; }
    for (const account of accounts) {
      let orgs: string[] = [];
      try { orgs = fs.readdirSync(path.join(this.indexDir, account)); } catch { continue; }
      for (const org of orgs) {
        let files: string[] = [];
        try { files = fs.readdirSync(path.join(this.indexDir, account, org)).filter(file => /^local_[\w-]+\.json$/.test(file)); } catch { continue; }
        for (const file of files) {
          const full = path.join(this.indexDir, account, org, file);
          try {
            const stat = fs.statSync(full), cached = this.metaCache.get(full);
            if (cached?.mtimeMs === stat.mtimeMs) { entries.push(cached.meta); continue; }
            const raw = parseJson(fs.readFileSync(full, 'utf8'));
            const field = (...keys: string[]) => get(raw, ...keys);
            const meta: SessionMeta = {
              localId: str(field('sessionId')), id: str(field('cliSessionId')), scope: `${account}/${org}`, cwd: asText(field('cwd') || field('originCwd') || ''), originCwd: asText(field('originCwd') || field('cwd') || ''), title: asText(field('title') || ''),
              model: asText(field('model') || ''), effort: asText(field('effort') || ''), permissionMode: asText(field('permissionMode') || ''), isArchived: !!field('isArchived'),
              createdAt: num(field('createdAt')), lastActivityAt: num(field('lastActivityAt')), lastTurnEdgeAt: num(field('lastTurnEdgeAt')), latestUserFrameAt: num(field('latestUserFrameAt')), lastFocusedAt: num(field('lastFocusedAt')),
              parentLocalId: asText(field('spawnedFrom', 'sessionId') || ''), status: asText(field('postTurnSummary', 'status_category') || ''), needsAction: asText(field('postTurnSummary', 'needs_action') || ''),
              wrapUp: asText(field('turnWrapUp', 'description') || ''),
            };
            this.metaCache.set(full, { mtimeMs: stat.mtimeMs, meta });
            entries.push(meta);
          } catch { /* Unreadable index entry: skip it. */ }
        }
      }
    }
    return entries.filter(meta => meta.id);
  }
  // Manual sidebar groups the person made in the desktop app (preferences, read-only).
  manualGroups(): Map<string, SessionGroup> {
    try {
      const prefs = get(parseJson(fs.readFileSync(path.join(this.appDir, 'claude_desktop_config.json'), 'utf8')), 'preferences', 'epitaxyPrefs') || {};
      const groups = new Map<string, SessionGroup>();
      for (const scope of Object.values(bag(get(prefs, 'dframe-group-scopes')) || {})) {
        const names = new Map(list(get(scope, 'groups')).map(group => [get(group, 'id'), get(group, 'name')]));
        for (const [key, groupId] of Object.entries(bag(get(scope, 'assignments')) || {})) if (names.has(groupId)) groups.set(key.replace(/^code:/, ''), { id: asText(groupId), name: asText(names.get(groupId)) });
      }
      return groups;
    } catch { return new Map(); }
  }
  repoFor(cwd: string): string {
    if (!cwd) return '其他';
    const known = this.repos.get(cwd);
    if (known !== undefined) return known;
    const name = repoName(originOf(cwd), cwd);
    this.repos.set(cwd, name);
    return name;
  }
  transcriptPath(id: string): string | null {
    if (!/^[\w-]+$/.test(id)) return null;
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(this.projectsDir); } catch { return null; }
    for (const dir of dirs) { const file = path.join(this.projectsDir, dir, `${id}.jsonl`); if (fs.existsSync(file)) return file; }
    return null;
  }
  // Besides its working directory, Claude Code keeps a folder of its own for each session, which its
  // replies name (its scratchpad, a background command's output):
  // /tmp/claude-<uid>/<the transcript's project folder>/<session id>. The desktop opens files there too.
  fileRoots(id: string): string[] {
    const transcript = this.transcriptPath(id), uid = typeof process.getuid === 'function' ? process.getuid() : null;
    return transcript && uid !== null ? [path.join(this.tmpDir, `claude-${uid}`, path.basename(path.dirname(transcript)), id)] : [];
  }
  // A session's transcript as turns, kept until the file changes. The list asks for every session
  // every few seconds (the activity feed), so every session the desktop lists stays in the cache:
  // what is kept is the turns (a few megabytes for the longest), not the file. A transcript that
  // changed since it was read is being written: from then on only what was appended is read and
  // parsed (its records are kept for that, for the few sessions running at a time), instead of
  // tens of megabytes again for every new line.
  parse(id: string): ParsedTranscript | null {
    const file = this.transcriptPath(id);
    if (!file) return null;
    const stat = fs.statSync(file), cached = this.cache.get(id);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    let records: unknown[], offset: number;
    const tail = cached?.file === file ? cached.tail : undefined;
    if (tail && stat.size >= cached!.size && stat.size >= tail.offset) {
      const chunk = Buffer.alloc(stat.size - tail.offset), fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, chunk, 0, chunk.length, tail.offset); } finally { fs.closeSync(fd); }
      const more = readRecords(chunk);
      for (const record of more.records) tail.records.push(record);
      records = tail.records; offset = tail.offset + more.used;
    } else {
      const whole = readRecords(fs.readFileSync(file));
      records = whole.records; offset = whole.used;
    }
    const turns = buildTurns(records, id);
    const last = <T>(pick: (record: unknown) => T | undefined | null | false | ''): T | undefined => { for (let index = records.length - 1; index >= 0; index--) { const found = pick(records[index]); if (found) return found; } return undefined; };
    const cwd = asText(last(record => get(record, 'cwd')) || '');
    const title = asText(last(record => get(record, 'type') === 'custom-title' && get(record, 'customTitle')) || '');
    const entry: ParsedTranscript = { file, size: stat.size, mtimeMs: stat.mtimeMs, writtenAt: last(record => Date.parse(String(get(record, 'timestamp'))) || 0) || 0, turns, cwd, title, queue: desktopQueue(records), queuedAt: queueTimes(records), lastStop: last(record => get(record, 'type') === 'assistant' && !get(record, 'isSidechain') && get(record, 'message', 'stop_reason')) };
    // Changed since it was last read: its records stay for the next append. Only the transcripts
    // changed most recently keep theirs (HOT_TRANSCRIPTS): records are the bulk of the memory.
    if (cached) {
      entry.tail = { records, offset };
      this.hot = [id, ...this.hot.filter(other => other !== id)];
      for (const cold of this.hot.splice(HOT_TRANSCRIPTS)) { const kept = this.cache.get(cold); if (kept) delete kept.tail; }
    }
    this.cache.delete(id); this.cache.set(id, entry);
    if (this.cache.size > CACHED_TRANSCRIPTS) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) { this.cache.delete(oldest); this.hot = this.hot.filter(other => other !== oldest); } }
    return entry;
  }
  metaFor(id: string): SessionMeta | null { return this.desktopIndex().find(meta => meta.id === id) || null; }

  list(): UnifiedSession[] {
    const index = this.desktopIndex().filter(meta => !meta.isArchived);
    const groups = this.manualGroups();
    const byLocal = new Map(index.map(meta => [meta.localId, meta]));
    const sessions: UnifiedSession[] = [];
    for (const meta of index) {
      const id = meta.id;
      if (!id) continue;
      const parsed = this.parse(id);
      const latest = parsed?.turns.at(-1);
      if (!parsed || !latest) continue; // Never-used sessions do not appear.
      const running = sessionRunning(meta, parsed);
      const parent = byLocal.get(meta.parentLocalId);
      const root = parent || meta;
      // A project's folder is the checkout its chats were started from, not a worktree one of them
      // works in: that is what the desktop's Folder menu lists when a new chat starts there.
      const folder = root.originCwd || root.cwd;
      sessions.push(new UnifiedSession({
        id, engine: 'claude', title: meta.title || parsed.title || latest.userPrompt.slice(0, 60),
        updatedAt: new Date(meta.lastActivityAt || parsed.mtimeMs).toISOString(), cwd: meta.cwd || parsed.cwd,
        status: running ? 'busy' : 'idle', isDesktopActive: running,
        metadata: {
          recentMessages: recentMessages(parsed.turns), turnStartedAt: Date.parse(String(latest.timestamp)) || 0,
          latestTurn: latest.statusEvidence ? { id: latest.id, status: latest.status, completedAt: latest.completedAt, statusEvidence: latest.statusEvidence } : undefined,
          group: { ...((root.localId !== undefined && groups.get(root.localId)) || { id: `repo:${this.repoFor(root.cwd)}`, name: this.repoFor(root.cwd) }), cwd: folder },
          parentId: parent?.id || '', attention: !running && unseen(meta) && meta.status && meta.status !== 'completed' ? meta.status : '',
          desktop: { model: meta.model, effort: meta.effort, permissionMode: meta.permissionMode },
        },
      }));
    }
    return sessions.sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt)));
  }

  read(id: string): History {
    const parsed = this.parse(id);
    if (!parsed) throw Object.assign(new Error('找不到这个 Claude 会话的记录'), { status: 404 });
    const meta = this.metaFor(id), running = sessionRunning(meta, parsed);
    const turns = parsed.turns.map(turn => ({ ...turn, steps: turn.steps.map(step => ({ ...step })) }));
    const last = turns.at(-1);
    if (last && !last.statusEvidence) last.status = running ? 'running' : 'unknown';
    const waiting = running ? awaitingStep(last, meta, parsed) : null;
    if (last && waiting) last.approvals = [awaitingCard(waiting)];
    const settings = this.settingsFor(id);
    return {
      session: new UnifiedSession({ id, engine: 'claude', title: meta?.title || parsed.title || turns[0]?.userPrompt.slice(0, 60) || '新会话', updatedAt: new Date(meta?.lastActivityAt || parsed.mtimeMs).toISOString(), cwd: meta?.cwd || parsed.cwd, status: running ? 'busy' : 'idle', isDesktopActive: running, metadata: { model: settings.model, desktop: settings, wrapUp: meta?.wrapUp || '', desktopQueue: running ? parsed.queue : [] } }),
      turns,
    };
  }

  // Sessions sent from here use the desktop's settings for that session, else the latest desktop session's.
  settingsFor(id: string): DesktopSettings & { inherited?: boolean } {
    const index = this.desktopIndex();
    const own = index.find(meta => meta.id === id);
    const source = own || [...index].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0];
    return source ? { model: source.model, effort: source.effort, permissionMode: source.permissionMode, inherited: !own } : {};
  }

  // What was picked in the workbench, in the words of the desktop's own menus, for the desktop
  // to pick there before it sends (src/server/native/claude-desktop.swift).
  // `current`: the session's own settings in the desktop index (ids, as the desktop keeps them).
  // Only a pick that differs from them is passed on: the session's settings follow the session,
  // and a message that changes nothing opens no menu in the desktop. (Comparing here, by id,
  // does not depend on the language the desktop is shown in; the helper comparing its words with
  // the composer's does.) A new chat has no settings yet: everything picked is passed.
  async desktopSettings(input: Partial<SendInput> = {}, current: { model?: string; effort?: string; permissionMode?: string } = {}): Promise<DesktopFlags> {
    const out: DesktopFlags = {};
    const wantedModel = input.model;
    if (wantedModel && wantedModel !== current.model) {
      const models = this.modelCache?.models || await this.getModels().catch((): Model[] => []);
      const model = models.find(item => item.id === wantedModel) || models.find(item => sameModel(item.id, wantedModel) || sameModel(item.name, wantedModel));
      if (!model) throw new Error('没能确定这个模型在 Claude 桌面版里叫什么，没有发送');
      out.model = model.name;
    }
    const wantedEffort = String(input.reasoningEffort || '').toLowerCase();
    const effort = effortLabel(wantedEffort);
    if (effort && wantedEffort !== String(current.effort || '').toLowerCase()) out.effort = effort;
    // ("default" is the old name of "manual", in the console's picks and in the desktop's index.)
    const modeId = (id: string | undefined): string => id === 'default' ? 'manual' : id || '';
    const mode = PERMISSION_MODES.find(item => item.id === modeId(input.permissionMode));
    if (mode && mode.id !== modeId(current.permissionMode)) out.mode = mode.label;
    return out;
  }
  // The other way round: what the desktop's own menus show ({ model: 'Fable 5.2 Medium', mode:
  // 'Auto' }, from its "New session" page) in the console's ids, for its menus to start on.
  // Anything not recognised is left out, never guessed.
  async shownSettings(shown: unknown = {}): Promise<DesktopSettings> {
    const out: DesktopSettings = {}, label = String(get(shown, 'model') || '').trim();
    if (label) {
      const models = this.modelCache?.models || await this.getModels().catch((): Model[] => []);
      const model = models.filter(item => label === item.name || label.startsWith(`${item.name} `)).sort((a, b) => b.name.length - a.name.length)[0];
      if (model) {
        out.model = model.id;
        const rest = label.slice(model.name.length).trim().toLowerCase();
        const effort = Object.keys(EFFORT_LABELS).find(id => id === rest || effortLabel(id)?.toLowerCase() === rest);
        if (effort) out.effort = effort;
      }
    }
    const mode = PERMISSION_MODES.find(item => item.label === get(shown, 'mode'));
    if (mode) out.permissionMode = mode.id;
    return out;
  }
  // The line shown after the desktop changed a session's settings for a message from here.
  settingsNote(result: HelperResult, wanted: DesktopFlags): string {
    const changed = list(result['changed']).map(key => get(wanted, String(key))).filter(Boolean);
    if (!changed.length) return '';
    const notes = list(result['notes']);
    return `已在 Claude 桌面版里把这个会话切换为 ${changed.join(' · ')}${notes.length ? `（桌面版提示：${notes.join(' ')}）` : ''}`;
  }

  // ---------- Claude Code CLI: reads the model list and usage only ----------
  spawnCli(args: string[], cwd?: string): ChildProcessByStdio<Writable, Readable, Readable> {
    if (!this.bin) throw new Error(NO_CLI);
    return spawn(this.bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...args], { cwd: cwd && fs.existsSync(cwd) ? cwd : this.home, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
  }
  // Control requests that send no prompt and keep no session (list_models, get_usage).
  async control(subtypes: string[], timeoutMs = 15000): Promise<Record<string, unknown>> {
    const child = this.spawnCli(['--no-session-persistence'], this.home);
    const results: Record<string, unknown> = {};
    return new Promise((resolve, reject) => {
      let buffer = '', done = false;
      const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); try { child.stdin.end(); child.kill(); } catch {} if (error) reject(error); else resolve(results); };
      const timer = setTimeout(() => finish(new Error('Claude Code 没有及时响应')), timeoutMs);
      child.on('error', finish);
      child.stdout.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk); let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let message: unknown; try { message = parseJson(line); } catch { continue; }
          if (get(message, 'type') !== 'control_response') continue;
          const response = get(message, 'response'), requestId = String(get(response, 'request_id'));
          if (get(response, 'subtype') === 'error') results[requestId] = { error: get(response, 'error') };
          else results[requestId] = get(response, 'response');
          if (subtypes.every(name => name in results)) finish();
        }
      });
      const write = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
      write({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } });
      for (const subtype of subtypes) write({ type: 'control_request', request_id: subtype, request: { subtype } });
    });
  }
  authStatus(): AuthState | { loggedIn: false; error: string } {
    if (!this.bin) return { loggedIn: false, error: NO_CLI };
    if (this.auth && Date.now() - this.auth.at < 60000) return this.auth;
    try {
      // A Windows npm install arrives as claude.cmd, which execFileSync cannot start without a
      // shell; the arguments are fixed words, so a shell only adds the cmd.exe shim.
      const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.bin);
      const loggedIn = !!get(parseJson(execFileSync(this.bin, ['auth', 'status'], { encoding: 'utf8', timeout: 8000, ...(viaShell ? { shell: true } : {}) })), 'loggedIn');
      this.auth = { at: Date.now(), loggedIn, error: loggedIn ? '' : loggedOut(this.bin) };
    } catch (err) { this.auth = { at: Date.now(), loggedIn: false, error: /not logged|login/i.test(String(errorField(err, 'stdout') || messageOf(err))) ? loggedOut(this.bin) : `无法确认 Claude Code 登录状态：${messageOf(err).split('\n')[0]}` }; }
    return this.auth;
  }
  // Connected means the desktop app can take messages from here: that is the only way they go.
  async getStatus(): Promise<EngineStatus> { const state = await this.desktop.check(), stale = this.desktop.staleControls?.() ?? []; return { connected: state.available, error: state.available ? undefined : state.reason, ...(stale.length ? { stale } : {}) }; }
  async getModels(): Promise<Model[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60000) return this.modelCache.models;
    if (!this.authStatus().loggedIn) return [];
    const results = await this.control(['list_models']);
    const models = modelsOf(results['list_models']);
    this.modelCache = { at: Date.now(), models };
    return models;
  }
  async getUsage(): Promise<Usage> {
    const auth = this.authStatus();
    if (!auth.loggedIn) return { available: false, short: this.bin ? '未登录' : '未安装', reason: auth.error };
    const results = await this.control(['get_usage']);
    return usageOf(results['get_usage']);
  }
  async sendBlockedReason(_id?: string | null): Promise<string | undefined> {
    const state = await this.desktop.check();
    return state.available ? '' : state.reason;
  }
  media(sessionId: string, key: string): MediaFile | null {
    const match = /^(.+)-(\d+)$/.exec(key || '');
    const file = match && this.transcriptPath(sessionId);
    if (!match || !file) return null;
    const owner = match[1] || '', position = Number(match[2]);
    // A base64 picture block, as the record holds it.
    const picture = (blocks: unknown): MediaFile | null => {
      const image = list(blocks).filter(item => get(item, 'type') === 'image')[position];
      const data = str(get(image, 'source', 'data'));
      return get(image, 'source', 'type') === 'base64' && data !== undefined ? { type: asText(get(image, 'source', 'media_type')), data: Buffer.from(data, 'base64') } : null;
    };
    // Find the tool result that owns this image without parsing the whole transcript.
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.includes(owner)) continue;
      try {
        const record = parseJson(line), content = get(record, 'message', 'content');
        // A picture the person attached to their own message.
        if (get(record, 'uuid') === owner && get(record, 'type') === 'user' && Array.isArray(content)) {
          const found = picture(content);
          if (found) return found;
          continue;
        }
        if (!line.includes('"tool_result"')) continue;
        for (const block of list(content)) {
          if (get(block, 'type') !== 'tool_result' || get(block, 'tool_use_id') !== owner || !Array.isArray(get(block, 'content'))) continue;
          const found = picture(get(block, 'content'));
          if (found) return found;
        }
      } catch {}
    }
    return null;
  }
  // Claude Code's own sign-in, kept by the CLI in the macOS keychain. This is Claude's own
  // credential (philosophy 2a): read fresh on the server for each dictation, never stored or
  // sent to the page. An expiring token is refreshed by letting the CLI make a call.
  async oauthToken(): Promise<string | null> {
    const read = () => new Promise<unknown>(resolve => execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 15000 }, (err, stdout) => {
      try { resolve(err ? null : get(parseJson(stdout), 'claudeAiOauth') || null); } catch { resolve(null); }
    }));
    let auth = await read();
    const expiresAt = num(get(auth, 'expiresAt'));
    if (expiresAt && expiresAt - Date.now() < 120000) { await this.getUsage().catch(() => {}); auth = await read(); }
    return str(get(auth, 'accessToken')) || null;
  }

  // Whether Claude Code's sign-in is in the keychain at all. Only the entry's attributes are
  // asked for (no -w): the token is not read here, and asking does not bring up a keychain prompt.
  // An entry about to expire is renewed when dictation starts (oauthToken).
  dictationReady(): Promise<DictationReady> {
    return new Promise(resolve => execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { timeout: 5000 }, err =>
      resolve(err ? { ready: false, reason: noSignIn(this.bin) } : { ready: true })));
  }
  // Claude's dictation: the same speech stream Claude Code's voice mode uses. It is the console's
  // default speech service for every agent (BRIDGE_DICTATION_ENGINE); when it cannot start,
  // another agent's or the browser's is used (services/dictation.ts).
  async dictate({ language = 'zh', onText, onError, onEnd }: DictationHandlers): Promise<DictationStream> {
    const token = await this.oauthToken();
    if (!token) throw Object.assign(new Error(noSignIn(this.bin)), { status: 409 });
    const query = new URLSearchParams({ encoding: 'linear16', sample_rate: '16000', channels: '1', endpointing_ms: '300', utterance_end_ms: '1000', language, use_conversation_engine: 'true' });
    // Node's WebSocket takes headers in its second argument (an undici extension the DOM type lacks).
    const Socket = globalSocket();
    if (!Socket) throw new TypeError('Socket is not a constructor');
    const socket = new Socket(`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-app': 'cli', 'User-Agent': 'claude-cli (external, cli)' },
    });
    socket.binaryType = 'arraybuffer';
    const finals: string[] = [], queue: Uint8Array[] = [];
    let interim = '', ended = false, closing = false, keepAlive: ReturnType<typeof setInterval> | undefined, finishTimer: ReturnType<typeof setTimeout> | undefined;
    const heard = () => [...finals, interim].filter(Boolean).join('');
    const end = () => { if (ended) return; ended = true; clearInterval(keepAlive); clearTimeout(finishTimer); if (interim) { finals.push(interim); interim = ''; onText(heard()); } onEnd(); try { socket.close(); } catch {} };
    socket.onopen = () => {
      for (const chunk of queue.splice(0)) socket.send(chunk);
      keepAlive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' })); }, 4000);
      if (closing) socket.send(JSON.stringify({ type: 'CloseStream' }));
    };
    socket.onmessage = event => {
      let message: unknown; try { message = parseJson(String(event.data)); } catch { return; }
      const type = get(message, 'type');
      if (type === 'TranscriptInterim' || type === 'TranscriptText') { interim = asText(get(message, 'data') || ''); onText(heard()); }
      else if (type === 'TranscriptEndpoint') { if (interim) finals.push(interim); interim = ''; onText(heard()); if (closing) end(); }
      else if (type === 'TranscriptError' || type === 'error') onError(asText(get(message, 'description') || get(message, 'message') || get(message, 'error_code') || 'Claude 语音识别失败'));
    };
    socket.onerror = () => { if (!ended) onError('无法连接 Claude 语音识别'); };
    socket.onclose = () => end();
    return {
      send: chunk => { if (ended || closing) return; if (socket.readyState === WebSocket.OPEN) socket.send(chunk); else queue.push(chunk); },
      finish: () => {
        if (closing || ended) return; closing = true;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
        finishTimer = setTimeout(end, 5000);
      },
      cancel: () => { closing = true; ended = true; clearInterval(keepAlive); clearTimeout(finishTimer); try { socket.close(); } catch {} },
    };
  }

  // A new chat starts in the desktop app, like every other message: its own "New session" page
  // takes the first message with what was picked there (newOptions / pickNewOption), so the
  // session exists there, runs there, and keeps the desktop's model and permissions. When the
  // desktop cannot do it, nothing is created and the reason goes back to the page.
  async create(input: CreateInput = {}): Promise<CreateResult> {
    if (!input.prompt && !(input.attachments || []).length) throw Object.assign(new Error('请输入首条消息'), { status: 400 });
    function refuse(reason: string | undefined): never { throw Object.assign(new Error(reason), { status: 409 }); }
    const state = await this.desktop.check();
    if (!state.available) refuse(state.reason);
    const known = new Set(this.desktopIndex().map(meta => meta.localId));
    let wanted: DesktopFlags;
    try { wanted = await this.desktopSettings(input); } catch (err) { refuse(messageOf(err)); }
    const result = await this.desktop.create(input.cwd || '', withAttachments(input.prompt, input.attachments, 'mention'), wanted, input.expect || []);
    if (!result.ok) refuse(result.error || '没能在 Claude 桌面版里新建会话');
    const meta = await this.newDesktopSession(known);
    const id = meta?.id, file = id ? this.transcriptPath(id) : null;
    if (!meta || !id || !file) throw Object.assign(new Error('消息已在 Claude 桌面版里发出，但还没在它的会话列表里看到这个新会话，请到桌面版里查看'), { status: 504 });
    const emitter = new EngineEvents();
    this.starts.set(id, emitter);
    void this.sendViaDesktop(id, { meta, file }, input, emitter, { sent: true, note: this.settingsNote(result, wanted) });
    return { id, cwd: meta.cwd, started: true };
  }
  // What the desktop's "New session" page asks for before the first message (environment,
  // folder, worktree, as the desktop names them), read from the page itself: the desktop decides
  // what is there, and one pick can bring up the next. The desktop stays on that page while the
  // person chooses, and a menu already read for the page as it is now is not opened again
  // (src/server/core/desktop-automation.ts); what was chosen is checked once more when the first
  // message goes out (create, `expect`).
  // `read`: only these menus' options (the rest come with their values only); `fresh`: read again.
  async newOptions({ read = [], fresh = false }: { read?: string[]; fresh?: boolean } = {}): Promise<NewOptionsResult> {
    const state = await this.desktop.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    const result = await this.desktop.newControls(read, { fresh });
    if (!result.ok) throw Object.assign(new Error(result.error || '没能读取 Claude 桌面版的新建会话页'), { status: 409 });
    // `settings`: the model, effort and permission mode that page shows now (a new session starts with them).
    return { controls: newControlsOf(result['controls']), settings: await this.shownSettings(result['shown']) };
  }
  pickNewOption(control: string, option: string): Promise<NewOptionsResult> { return this.pickNewOptions([{ control, option }]); }
  // Several picks in one visit to the page (a project's folder: its environment, then the folder).
  async pickNewOptions(picks: NewPick[]): Promise<NewOptionsResult> {
    const state = await this.desktop.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    const result = await this.desktop.newPick(picks);
    const shownPicked = arr(result['picked']);
    const picked = shownPicked ? shownPicked.map(asText) : result.ok ? picks.map(item => item.control) : [];
    const controls = newControlsOf(result['controls']);
    if (!result.ok) throw Object.assign(new Error(result.error || '没能在 Claude 桌面版的新建会话页上选这一项'), { status: 409, controls: result['controls'] === undefined ? undefined : controls, picked });
    return { controls, picked, settings: await this.shownSettings(result['shown']) };
  }
  keepWarm(): void { this.desktop.keepWarm?.(); }
  // The session the desktop just made: a new entry in its index whose transcript exists.
  async newDesktopSession(known: ReadonlySet<string | undefined>, timeoutMs = 25000): Promise<SessionMeta | null> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const fresh = this.desktopIndex().filter(meta => !known.has(meta.localId) && meta.id && this.transcriptPath(meta.id)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      if (fresh) return fresh;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return null;
  }
  // The run create() started, handed over once to whoever follows it.
  observe(id: string): EngineEmitter {
    const emitter = this.starts.get(id);
    if (!emitter) throw Object.assign(new Error('没有正在执行的任务'), { status: 409 });
    this.starts.delete(id);
    return emitter;
  }
  // Every message goes to a session the desktop has, through the desktop app.
  async route(id: string): Promise<Route> {
    const meta = this.metaFor(id);
    const file = this.transcriptPath(id);
    if (!meta || !meta.title || !file) return { error: '这个会话不在 Claude 桌面版里，只能发给桌面版已有的会话' };
    const state = await this.desktop.check();
    if (!state.available) return { error: state.reason || '' };
    return { desktop: true, meta, file };
  }
  sendMessage(id: string, input: Partial<SendInput> = {}): EngineEvents {
    const emitter = new EngineEvents();
    queueMicrotask(async () => {
      let route: Route;
      try { route = await this.route(id); } catch (err) { route = { error: messageOf(err) }; }
      if ('error' in route) { emitter.emit('error', new Error(route.error)); return; }
      void this.sendViaDesktop(id, route, input, emitter);
    });
    return emitter;
  }
  // The desktop runs the turn; follow it in the transcript it writes, from where it ended.
  // `sent`: the desktop already has the message (a session it has just created with it);
  // `note`: what it changed in its settings for that message.
  async sendViaDesktop(id: string, { meta, file }: { meta: SessionMeta; file: string }, input: Partial<SendInput>, emitter: EngineEmitter, { sent = false, note = '' }: { sent?: boolean; note?: string } = {}): Promise<void> {
    const offset = sent ? 0 : fs.statSync(file).size;
    const run: DesktopRun = { desktop: true, meta, emitter, interrupted: false, lastMessage: null, plan: (this.parse(id)?.turns || []).flatMap(turn => turn.steps).filter(step => step.plan).at(-1)?.plan || null, finished: false, started: null };
    this.runs.set(id, run);
    const message = withAttachments(input.prompt, input.attachments, 'mention');
    const fail = (reason: string) => { if (this.runs.get(id) === run) this.runs.delete(id); emitter.emit('error', new Error(reason)); };
    // Model, effort and permissions picked here are picked in the desktop app before it sends.
    let wanted: DesktopFlags = {};
    if (!sent) { try { wanted = await this.desktopSettings(input, meta); } catch (err) { fail(messageOf(err)); return; } }
    let result: HelperResult = sent ? { ok: true } : await this.desktop.send(meta, message, wanted), joined = false;
    if (sent) await new Promise(resolve => setTimeout(resolve, 50)); // let the caller subscribe first
    // The desktop is still running a turn the page took for finished (its index can mark the
    // turn's edge before the reply has ended). Do what the desktop's own composer does then:
    // hand it the message, which it puts into the running turn.
    if (!sent && !result.ok && result.code === 'busy') { result = await this.desktop.steer(meta, message, wanted); joined = !!result.ok; }
    // Nothing was sent: the helper stops before typing when a setting could not be changed.
    if (!result.ok) { fail(result.error || '桌面代发失败'); return; }
    if (joined) emitter.emit('warning', { message: 'Claude 桌面版里这一轮还没结束，消息已交给桌面版，它会插进正在执行的这一轮', retrying: false });
    const switched = note || this.settingsNote(result, wanted);
    if (switched) emitter.emit('warning', { message: switched, retrying: false });
    const finish = (status: string) => {
      if (run.finished) return;
      run.finished = true; clearInterval(timer);
      if (this.runs.get(id) === run) this.runs.delete(id);
      if (run.waiting) emitter.emit('approval_resolved', { id: run.waiting });
      handle({ type: 'result', subtype: status === 'failed' ? 'error' : 'success', is_error: status === 'failed', result: run.error });
    };
    const handle = createStreamHandler(id, run);
    run.finish = finish;
    // How the desktop's latest reply ended ('tool_use': mid-step, see desktopRunning).
    let position = offset, partial = '', polls = 0, lastStop: unknown = this.parse(id)?.lastStop, edgedBefore = false;
    const ours = (record: unknown) => promptStarts(message, typedText(get(record, 'message', 'content')), 200);
    const timer = run.timer = setInterval(() => {
      if (run.finished) { clearInterval(timer); return; }
      polls++;
      try {
        const size = fs.statSync(file).size;
        if (size > position) {
          const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(size - position);
          fs.readSync(fd, buffer, 0, buffer.length, position); fs.closeSync(fd);
          position = size;
          const lines = (partial + buffer.toString('utf8')).split('\n'); partial = lines.pop() ?? '';
          for (const line of lines) {
            let record: unknown; try { record = parseJson(line); } catch { continue; }
            if (get(record, 'isSidechain')) continue;
            const type = get(record, 'type');
            if (type === 'assistant') lastStop = get(record, 'message', 'stop_reason') ?? lastStop;
            if (!run.started) {
              // Our message, as the desktop wrote it: everything after it belongs to this run.
              // A message that joined a running turn waits in the desktop's queue: only its own record starts this run.
              if (isHumanPrompt(record) && (!joined || ours(record))) { run.started = Date.parse(asText(get(record, 'timestamp'))) || Date.now(); emitter.turnId = str(get(record, 'uuid')) || null; }
              continue;
            }
            if (isHumanPrompt(record)) {
              // A message sent into this turn from here (steer) continues it; any other prompt ends it.
              const typed = typedText(get(record, 'message', 'content')), index = (run.steers || []).findIndex(steered => promptStarts(steered, typed, 200));
              if (index >= 0) { run.steers?.splice(index, 1); continue; }
              finish('completed'); return;
            }
            const interrupted = type === 'user' && /\[Request interrupted by user/.test(textOf(get(record, 'message', 'content')));
            if (interrupted) run.interrupted = true;
            if (type === 'assistant') run.stopReason = get(record, 'message', 'stop_reason') ?? null;
            if (type === 'assistant' || type === 'user') handle(record);
            // The transcript's own end of the turn (stop hooks ran, or the person stopped it). A
            // stop hook can still make Claude go on, so it counts once nothing follows it.
            if (interrupted || (type === 'system' && get(record, 'subtype') === 'stop_hook_summary')) run.endedAt = Date.now();
            else if (type === 'assistant' || type === 'user') run.endedAt = 0;
          }
        }
        if (!run.started) {
          if (joined && desktopRunning(this.metaFor(id), lastStop === 'tool_use')) polls = 0; // still queued behind the running turn
          if (polls > 40) { run.error = 'Claude 桌面版没有收到这条消息'; finish('failed'); }
          return;
        }
        // The desktop index marks the turn's end once the reply is done, but not always after a
        // stop: then the transcript's end record decides. The index's edge counts once it held
        // over two reads, so that what the transcript wrote with it has been read too; mid-step
        // it is a pause, unless the person stopped the turn from here.
        const now = this.metaFor(id);
        // A dialog the desktop waits on the person in: a card in the chat while it is open.
        const parsed = this.parse(id), step = parsed ? awaitingStep(parsed.turns.at(-1), now, parsed) : null;
        const card = step ? awaitingCard(step) : null;
        if (card?.id !== run.waiting) {
          if (run.waiting) emitter.emit('approval_resolved', { id: run.waiting });
          if (card) emitter.emit('approval', card);
          run.waiting = card?.id;
        }
        const edged = !!(now?.lastTurnEdgeAt && now.lastTurnEdgeAt >= run.started && !desktopRunning(now, lastStop === 'tool_use' && !run.stopRequested));
        const indexEnded = edged && edgedBefore; edgedBefore = edged;
        if ((run.endedAt && Date.now() - run.endedAt >= TURN_END_SETTLE_MS) || indexEnded) {
          if (run.stopRequested && !run.interrupted && run.stopReason !== 'end_turn') run.interrupted = true;
          finish(run.interrupted ? 'interrupted' : 'completed');
        }
      } catch (err) { run.error = messageOf(err); finish('failed'); }
    }, 700);
    timer.unref?.();
    emitter.on('interrupt', () => { run.finished = true; clearInterval(timer); if (this.runs.get(id) === run) this.runs.delete(id); });
  }
  // Adds a message to the turn the desktop is running: typed into its composer and sent there,
  // the desktop queues it and puts it in at the next step (or at once with Send now).
  async steer(id: string, input: Partial<SendInput> = {}): Promise<Record<string, never>> {
    const route = await this.route(id);
    if (!('desktop' in route)) throw Object.assign(new Error(route.error || '这个会话不能由 Claude 桌面版插话'), { fallback: 'queue' });
    const message = withAttachments(input.prompt, input.attachments, 'mention');
    const run = this.runs.get(id);
    if (run?.desktop) (run.steers ||= []).push(message);
    const offset = fs.statSync(route.file).size;
    let wanted: DesktopFlags;
    try { wanted = await this.desktopSettings(input, route.meta); } catch (err) { throw Object.assign(errorOf(err), { status: 409 }); }
    const result = await this.desktop.steer(route.meta, message, wanted);
    const drop = () => { const index = run?.steers?.indexOf(message) ?? -1; if (index >= 0) run?.steers?.splice(index, 1); };
    if (!result.ok) { drop(); throw Object.assign(new Error(result.error || '没能由 Claude 桌面版插话'), { status: 409 }); }
    // Confirmed once the desktop records it: queued (enqueue) or already put in (a prompt).
    const seen = await this.waitForRecord(route.file, offset, record => (get(record, 'type') === 'queue-operation' && get(record, 'operation') === 'enqueue') || (isHumanPrompt(record) && promptStarts(message, typedText(get(record, 'message', 'content')), 200)), 12000);
    if (!seen) { drop(); throw Object.assign(new Error('Claude 桌面版没有收到这条插话'), { status: 409 }); }
    return {};
  }
  async sendNow(id: string): Promise<{ status: string }> {
    const meta = this.metaFor(id);
    if (!meta?.title) throw Object.assign(new Error('这个会话不在 Claude 桌面版里'), { status: 404 });
    const result = await this.desktop.sendNow(meta);
    if (!result.ok) throw Object.assign(new Error(result.error || '没能让 Claude 桌面版立即发送'), { status: 409 });
    return { status: 'sent' };
  }
  waitForRecord(file: string, offset: number, match: (record: unknown) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const started = Date.now();
      const timer = setInterval(() => {
        try {
          const size = fs.statSync(file).size;
          if (size > offset) {
            const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(size - offset);
            fs.readSync(fd, buffer, 0, buffer.length, offset); fs.closeSync(fd);
            for (const line of buffer.toString('utf8').split('\n')) { let record: unknown; try { record = parseJson(line); } catch { continue; } if (match(record)) { clearInterval(timer); return resolve(true); } }
          }
        } catch {}
        if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
      }, 400);
      timer.unref?.();
    });
  }
  // The person's pick on a question card: pressed on the desktop's own card (option, then Submit;
  // Skip for "decline"), so the desktop answers Claude. The session's record confirms it.
  async decide(askId: string, decision: string): Promise<void> {
    const found = [...this.runs].find(([, item]) => item.asks?.has(askId));
    const [id, run] = found || [];
    const questions = run?.asks?.get(askId);
    if (!id || !run || !questions) throw Object.assign(new Error('这个问题已经回答过了'), { status: 409 });
    const only = questions[0], option = decision === 'decline' ? null : String(decision).replace(/^option:/, '');
    // A session whose transcript is gone has nothing to confirm the answer in (as before: no record is seen).
    const file = this.transcriptPath(id) ?? '', offset = file && fs.existsSync(file) ? fs.statSync(file).size : 0;
    const result = await this.desktop.answer(run.meta, asText(get(only, 'question') || ''), option);
    if (!result.ok) throw Object.assign(new Error(result.error || '没能在 Claude 桌面版里回答这个问题'), { status: 409 });
    const seen = await this.waitForRecord(file, offset, record => get(record, 'type') === 'user' && list(get(record, 'message', 'content')).some(block => get(block, 'type') === 'tool_result' && get(block, 'tool_use_id') === askId), 12000);
    if (!seen) throw Object.assign(new Error('Claude 桌面版没有记下这个回答，请在桌面端看一下'), { status: 409 });
  }
  // A file from the chat, opened in the desktop: the session is shown there and its link pressed.
  async openFile(id: string, file: FileTarget): Promise<HelperResult> {
    const meta = this.metaFor(id);
    if (!meta) throw Object.assign(new Error('Claude 桌面版里没有这个会话'), { status: 404 });
    const state = await this.desktop.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    const result = await this.desktop.openFile({ title: meta.title, localId: this.desktop.localId(meta), ...file });
    if (!result.ok) throw Object.assign(new Error(result.error || '没能在 Claude 桌面版里打开这个文件'), { status: 409 });
    return result;
  }
  // Takes the person to this session in the desktop app.
  async show(id: string): Promise<HelperResult> {
    const meta = this.metaFor(id);
    if (!meta) throw Object.assign(new Error('Claude 桌面版里没有这个会话'), { status: 404 });
    const state = await this.desktop.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    const result = await this.desktop.showSession({ title: meta.title, localId: this.desktop.localId(meta) });
    if (!result.ok) throw Object.assign(new Error(result.error || '没能在 Claude 桌面版里打开这个会话'), { status: 409 });
    return result;
  }
  // The buttons on the session's wrap-up card that run in the desktop app (commit, open a PR…), as
  // the desktop draws them: their names are the desktop's, not in the record. A card does not change
  // once drawn, so each is read once (a failed read is tried again next time).
  readonly cards = new Map<string, string[]>();
  private async cardSession(id: string): Promise<SessionMeta> {
    const meta = this.metaFor(id);
    if (!meta) throw Object.assign(new Error('Claude 桌面版里没有这个会话'), { status: 404 });
    // A turn the console sent that has not ended (by its record) still runs: the card's buttons come after it.
    if (this.runs.has(id)) throw Object.assign(new Error('这一轮还在 Claude 桌面版里运行，卡片上的按钮要等它结束才能按'), { status: 409 });
    const state = await this.desktop.check();
    if (!state.available) throw Object.assign(new Error(state.reason), { status: 409 });
    return meta;
  }
  async readCard(id: string, card: WrapUpCard): Promise<CardRead> {
    const key = JSON.stringify([id, card.ask, card.recap]), known = this.cards.get(key);
    if (known) return { actions: known };
    const result = await this.desktop.card(await this.cardSession(id), card);
    if (!result.ok) throw Object.assign(new Error(result.error || '没能从 Claude 桌面版读出这张卡片'), { status: 409 });
    const actions = list(get(result, 'actions')).map(item => String(item));
    // A button without a name was not read (the desktop names every button it draws): the read
    // failed, and is neither shown as a blank button nor kept.
    if (actions.some(name => !name.trim())) throw Object.assign(new Error('没能从 Claude 桌面版读出这张卡片'), { status: 409 });
    // None yet may only mean the desktop has not drawn them: an empty read is not kept.
    if (actions.length) this.cards.set(key, actions);
    return { actions };
  }
  // One of them pressed on the desktop's own card, by its place, so the desktop runs it as if the
  // person had clicked there.
  async pressAction(id: string, action: CardAction): Promise<{ pressed: boolean }> {
    const result = await this.desktop.action(await this.cardSession(id), action);
    if (!result.ok) {
      // What the card holds now goes back into the cache, so the page can show it.
      const actions = get(result, 'actions');
      if (Array.isArray(actions) && actions.length && actions.every(item => String(item).trim())) this.cards.set(JSON.stringify([id, action.ask, action.recap]), actions.map(item => String(item)));
      throw Object.assign(new Error(result.error || '没能在 Claude 桌面版里按下这个按钮'), { status: 409 });
    }
    return { pressed: true };
  }
  async interrupt(id: string): Promise<{ pending: boolean }> {
    const run = this.runs.get(id);
    const sessions = this.desktopIndex();
    const meta = sessions.find(session => session.id === id) ?? run?.meta;
    if (!meta?.title) throw Object.assign(new Error('这个会话不在 Claude 桌面版里'), { status: 409 });
    if (sessions.some(session => session.id !== id && session.title === meta.title && !session.isArchived)) {
      throw Object.assign(new Error('Claude 桌面版有同名会话，无法确认要停止的是哪一个'), { status: 409 });
    }
    const result = await this.desktop.stop(meta);
    if (!result.ok) throw Object.assign(new Error(result.error || '没能在 Claude 桌面版里停止'), { status: 409 });
    // Not "stopped" yet: the turn may have finished on its own just then. The transcript
    // decides (the desktop's interrupt marker, or how the last reply ended).
    if (run) run.stopRequested = true;
    return { pending: true };
  }
  dispose(): void { for (const run of this.runs.values()) { run.finished = true; clearInterval(run.timer); } this.runs.clear(); }
}

// Transcript records (as the desktop writes them) → console events. Exported for the tests.
function createStreamHandler(sessionId: string, run: StreamRun): (message: unknown) => void {
  const { emitter } = run;
  const toolNames = new Map<string, string>();
  const finalize = () => { if (run.lastMessage) emitter.emit('item_completed', { item: { type: 'agentMessage', id: run.lastMessage.id, text: run.lastMessage.text, phase: 'final_answer' } }); };
  return message => {
    const type = get(message, 'type'), uuid = get(message, 'uuid');
    if (type === 'system' && get(message, 'subtype') === 'init' && get(message, 'session_id')) emitter.turnId = emitter.turnId || null;
    if (type === 'assistant') {
      const blocks = list(get(message, 'message', 'content'));
      for (const [index, block] of blocks.entries()) {
        const said = asText(get(block, 'text')).trim(), note = progressNote(message, block);
        if (get(block, 'type') === 'text' && said) {
          const id = blocks.length > 1 ? `${uuid}:${index}` : asText(uuid || `${get(message, 'message', 'id')}:${index}`);
          if (run.lastMessage && run.lastMessage.id !== id) run.lastMessage = null;
          run.lastMessage = { id, text: said };
          emitter.emit('item_completed', { item: { type: 'agentMessage', id, text: said, phase: 'commentary' } });
        } else if (note) {
          const id = blocks.length > 1 ? `${uuid}:${index}` : asText(uuid);
          emitter.emit('item_completed', { item: { type: 'agentMessage', id, text: note, phase: 'commentary' } });
        } else if (get(block, 'type') === 'thinking') emitter.emit('delta', { type: 'reasoning' });
        else if (get(block, 'type') === 'tool_use') {
          run.lastMessage = null;
          const blockId = asText(get(block, 'id')), name = asText(get(block, 'name')), input = get(block, 'input');
          toolNames.set(blockId, name);
          const plan = PLAN_TOOLS.test(name) ? (run.plan = applyPlan(run.plan, name, input)) : undefined;
          if (plan) run.planStep = { id: blockId, name, input: input || {} };
          if (name === WRAP_UP && run.plan && run.planStep) {
            run.plan = finishPlan(run.plan);
            emitter.emit('delta', { type: 'tool_call', ...run.planStep, plan: run.plan.map(step => ({ ...step })) });
          }
          emitter.emit('delta', { type: 'tool_call', id: blockId, name, input: input || {}, ...(plan ? { plan: plan.map(step => ({ ...step })) } : {}) });
          // Claude's question to the person: a card in the chat, answered in the desktop app's own card.
          const questions = arr(get(input, 'questions'));
          if (name === ASK_TOOL && questions) {
            (run.asks ||= new Map()).set(blockId, questions);
            emitter.emit('approval', questionCard(blockId, questions.map(item => ({ question: asText(get(item, 'question')), multi: !!get(item, 'multiSelect'), options: list(get(item, 'options')).map(option => ({ id: String(get(option, 'label')), label: asText(get(option, 'label')) })) })), 'Claude', { desktop: true }));
          }
        }
      }
    } else if (type === 'user' && Array.isArray(get(message, 'message', 'content'))) {
      for (const block of list(get(message, 'message', 'content'))) {
        if (get(block, 'type') !== 'tool_result') continue;
        const toolUseId = asText(get(block, 'tool_use_id'));
        if (run.asks?.delete(toolUseId)) emitter.emit('approval_resolved', { id: toolUseId });
        const name = toolNames.get(toolUseId);
        emitter.emit('delta', { type: 'tool_result', id: toolUseId, output: PLAN_TOOLS.test(name || '') || name === WRAP_UP ? '' : resultText(get(block, 'content')).slice(0, 16000), isError: !!get(block, 'is_error'), images: imagesOf(sessionId, toolUseId, get(block, 'content')) || undefined });
      }
    } else if (type === 'result') {
      finalize();
      const status = run.interrupted ? 'interrupted' : get(message, 'is_error') || /^error/.test(asText(get(message, 'subtype') || '')) ? 'failed' : 'completed';
      emitter.emit('completed', { turn: { status, error: status === 'failed' ? { message: asText(get(message, 'result') || arr(get(message, 'errors'))?.join('\n') || 'Claude Code 报告执行失败') } : undefined } });
    }
  };
}

export { PERMISSION_MODES, ClaudeBridge, findClaudeBin, isHumanPrompt, applyPlan, parseLines, buildTurns, recentMessages, desktopRunning, sessionRunning, awaitingStep, usageOf, modelsOf, repoName, createStreamHandler, loginCommand };
