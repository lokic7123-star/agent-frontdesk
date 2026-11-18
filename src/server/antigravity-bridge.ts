// Antigravity owns its history (conversation_summaries.db + brain/<id>/transcript.jsonl).
// The console reads both read-only and writes only through Antigravity's own channels: agentapi
// starts a conversation, the language server's SendUserCascadeMessage (what the desktop's composer
// calls) sends the person's messages into it, and the same server stops a turn, lists the models
// and tells how a turn ended. Its request fields are read from the protobuf descriptors inside the
// language_server binary (not a public interface): confirm them again after an Antigravity upgrade.
// Its records and answers are its own formats: they enter as unknown and are read through the
// guards, so a record nobody understands is skipped.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import EventEmitter from 'node:events';
import { UnifiedSession, UnifiedTurn, UnifiedStep, EngineEvents, assignPhases } from './types.js';
import { questionCard } from './core/presentation.js';
import { withAttachments } from './core/attachments.js';
import { loadConfig } from './config.js';
import { tailJsonl } from './services/jsonl-tail.js';
import { readSqlite } from './services/sqlite-reader.js';
import { bag, errorField, get, isBag, list, messageOf, parseJson, str, text as asText, type Bag } from '../shared/guards.js';
import type {
  Approval, BridgeConfig, CreateInput, CreateResult, DictationHandlers, DictationReady, DictationStream, EngineEmitter, EngineStatus,
  FileTarget, MediaFile, Model, RecentMessage, SendInput, TimeValue, Usage, UsageWindow, UnifiedStep as Step,
} from '../shared/contract.js';

// Values documented by `agentapi new-conversation --model=<flash_lite|flash|pro|model_id>`.
const MODEL_ALIASES: Model[] = [
  { id: 'pro', name: 'Gemini Pro' },
  { id: 'flash', name: 'Gemini Flash' },
  { id: 'flash_lite', name: 'Gemini Flash Lite' },
];
const NO_AGENTAPI = '未发现 agentapi，请确认已安装 Antigravity 或设置 AGENTAPI_BIN';
const NO_LS = '未找到正在运行的 Antigravity。请打开 Antigravity 桌面端后重试。';

/** A transcript record, or one rewritten from the language server's steps: Antigravity's own fields. */
export type AgRecord = { readonly [field: string]: unknown };
/** The configuration the bridge needs: where Antigravity keeps its data, at least. */
export type AntigravityConfig = Partial<BridgeConfig> & Pick<BridgeConfig, 'agyHome'>;
interface LsEnv { ANTIGRAVITY_LS_ADDRESS: string; ANTIGRAVITY_CSRF_TOKEN: string }
interface ParsedHistory { key?: string; turns: UnifiedTurn[]; model: string; modelId: unknown }
interface AgAsk { conversationId: string; index: number; kind: string; body: unknown; command: string; trajectoryId: string }
type Outcome = { status: string; error?: { message: string } };
/** What openFile runs (execFile, or a stand-in in tests). */
export type OpenRunner = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null) => void) => unknown;

// Antigravity records tool arguments as JSON-encoded strings ("\"ls -la\"").
function decodeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && /^["[{]/.test(value)) { try { decoded[key] = parseJson(value); continue; } catch {} }
    decoded[key] = value;
  }
  return decoded;
}
function toolOutput(content: unknown): string {
  return String(content || '').replace(/^Created At: .*\n(Completed At: .*\n)?/, '').trim();
}
// A file the agent wrote, listed with the turn as Antigravity lists it (its own scratch files aside).
// The live run (watchTurn) and the record (parseRecords) use this one rule.
function editedFile(step: Pick<Step, 'type' | 'paths'>): string {
  const target = step.paths?.[0];
  return step.type === 'file_change' && target && !target.includes(`${path.sep}.system_generated${path.sep}`) ? target : '';
}
function stepOf(tool: unknown, id: string): UnifiedStep {
  const input = decodeArgs(get(tool, 'args'));
  const name = asText(get(tool, 'name'));
  const file = input['Path'] || input['TargetFile'] || input['AbsolutePath'];
  const type = name === 'run_command' ? 'command' : /^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content)$/.test(name) ? 'file_change' : 'tool_call';
  return new UnifiedStep({
    id, type, name, input,
    title: typeof input['toolSummary'] === 'string' ? input['toolSummary'] : '',
    detail: type === 'command' ? asText(input['CommandLine'] || '') : '',
    paths: file ? [String(file)] : null,
    status: 'running',
  });
}
// A time from the database as ISO text; one it cannot read is now. (null is the epoch, as `new Date(null)` is.)
const dateOf = (value: unknown): Date => new Date(value instanceof Date || typeof value === 'string' || typeof value === 'number' ? value : value === null ? 0 : NaN);
const toIso = (value: unknown): string => { const date = dateOf(value); return Number.isFinite(+date) ? date.toISOString() : new Date().toISOString(); };
// A time as the record gives it (ISO text or a number), else nothing.
const timeOf = (value: unknown): TimeValue | undefined => typeof value === 'string' || typeof value === 'number' ? value : undefined;
function workspaceOf(uris: unknown): string {
  try {
    const first = list(parseJson(String(uris || '[]')))[0];
    if (typeof first !== 'string') return '';
    if (!first.startsWith('file://')) return first || '';
    // A file URL without a drive letter is refused by fileURLToPath on Windows (POSIX-style
    // records kept from elsewhere); its decoded path is still better than nothing.
    try { return fileURLToPath(first); } catch { return decodeURIComponent(new URL(first).pathname); }
  } catch { return ''; }
}

// The language server's own record of a conversation (GetCascadeTrajectorySteps), rewritten as the
// transcript's records so one parser reads both. Older conversations have no transcript file at all.
const TRACE = !!process.env.AGY_TRACE;
const stepKind = (step: unknown): string => String(get(step, 'type') || '').replace('CORTEX_STEP_TYPE_', '');
const stepStatus = (step: unknown): string => String(get(step, 'status') || '').replace('CORTEX_STEP_STATUS_', '');
const SETTLED = new Set(['DONE', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'CLEARED']);
// Only an error the desktop shows the person counts; the rest are notes to the model, which retries.
const shownError = (step: unknown): unknown => stepKind(step) === 'ERROR_MESSAGE' && get(step, 'errorMessage', 'shouldShowUser') ? get(step, 'errorMessage', 'error') || {} : null;
const errorText = (error: unknown): string => [get(error, 'userErrorMessage'), get(error, 'shortError')].filter(Boolean).join(' ').trim() || 'Agent execution terminated due to error.';
function stepOutput(step: unknown): string {
  const body = get(step, 'runCommand', 'combinedOutput', 'full') ?? get(step, 'commandStatus', 'combined') ?? get(step, 'sendCommandInput', 'output', 'full') ?? get(step, 'grepSearch', 'rawOutput') ?? '';
  return String(body || '');
}
function recordsOfStep(step: unknown, index: number): AgRecord[] {
  const kind = stepKind(step), status = stepStatus(step), meta = get(step, 'metadata') || {};
  const base = { step_index: index, created_at: get(meta, 'createdAt'), status };
  if (kind === 'USER_INPUT') return [{ ...base, type: 'USER_INPUT', content: get(step, 'userInput', 'userResponse') ?? list(get(step, 'userInput', 'items')).map(item => asText(get(item, 'text') || '')).join('') }];
  if (kind === 'PLANNER_RESPONSE') {
    const reply = get(step, 'plannerResponse') || {};
    const calls = list(get(reply, 'toolCalls')).map(call => { let args: unknown = {}; try { args = parseJson(String(get(call, 'argumentsJson') || '{}')); } catch {} return { id: get(call, 'id'), name: get(call, 'name'), args }; });
    return [{ ...base, type: 'PLANNER_RESPONSE', content: get(reply, 'modifiedResponse') || get(reply, 'response') || '', thinking: get(reply, 'thinking') ? '1' : undefined, tool_calls: calls, model: get(meta, 'requestedModel', 'model') }];
  }
  if (kind === 'ERROR_MESSAGE') { const error = shownError(step); return error ? [{ ...base, type: 'ERROR_MESSAGE', content: errorText(error) }] : []; }
  const toolCallId = get(meta, 'toolCall', 'id');
  if (!toolCallId) return [];
  const records: AgRecord[] = [{ ...base, type: 'GENERIC', tool_call_id: toolCallId, content: stepOutput(step) }];
  // Earlier versions spoke to the person through a tool: its text is the agent's message.
  const note = get(step, 'notifyUser', 'notificationContent');
  if (note) records.push({ ...base, step_index: `${index}n`, type: 'PLANNER_RESPONSE', content: note });
  return records;
}

// Interim updates carry the whole dictation so far, but a final update after a pause
// carries only its own segment; keep what came before it. Also drop the spaces the
// recognizer leaves between CJK characters.
const CJK = '\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef';
const tidy = (said: unknown): string => String(said || '').replace(new RegExp(`(?<=[${CJK}])\\s+|\\s+(?=[${CJK}])`, 'g'), '').trim();
function mergeTranscript(previous: string, next: string, final: boolean): string {
  const before = tidy(previous), current = tidy(next);
  if (!final || !before || current.startsWith(before) || before.length <= current.length) return current;
  const anchor = current.slice(0, Math.min(2, current.length));
  const at = anchor ? before.lastIndexOf(anchor) : -1;
  return at > 0 ? before.slice(0, at) + current : before.endsWith(current) ? before : before + current;
}

// Response layouts differ between versions, so collect every model entry carrying quotaInfo.
function quotaOf(status: unknown, current = ''): Usage {
  const windows: Array<UsageWindow & { label: string; remainingPercent: number }> = [], seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((item: unknown) => visit(item)); return; }
    const quota = get(node, 'quotaInfo') || get(node, 'quota_info');
    const fraction = get(quota, 'remainingFraction') ?? get(quota, 'remaining_fraction');
    const label = String(get(node, 'label') || get(node, 'displayName') || get(node, 'modelOrAlias', 'model') || get(node, 'model') || '模型');
    const resetText = get(quota, 'resetTime') || get(quota, 'reset_time');
    if (quota && (typeof fraction === 'number' || resetText) && !seen.has(label)) {
      seen.add(label);
      const remaining = Math.max(0, Math.min(100, (typeof fraction === 'number' ? fraction : 0) * 100));
      const reset = Date.parse(String(resetText || ''));
      windows.push({ id: label, label, remainingPercent: remaining, usedPercent: 100 - remaining, windowMinutes: null, resetsAt: Number.isFinite(reset) ? Math.round(reset / 1000) : null });
    }
    if (isBag(node)) for (const value of Object.values(node)) visit(value);
  };
  visit(status);
  // Protobuf omits a zero remainingFraction: a reset time alone means the quota is used up.
  windows.sort((a, b) => (Number(b.label === current) - Number(a.label === current)) || b.remainingPercent - a.remainingPercent);
  return { available: !!windows.length, windows, reason: windows.length ? undefined : 'Antigravity 没有返回模型额度' };
}

const errorOf = (err: unknown): Error => err instanceof Error ? err : new Error(String(err));
// The fields an error from ls() carries (status, code, detail), read without assuming its shape.
const lsDetail = (err: unknown): string => asText(errorField(err, 'detail') || messageOf(err));
const lsStatus = (err: unknown): number => Number(errorField(err, 'status')) || 502;

class AntigravityBridge extends EventEmitter {
  home: string; config: AntigravityConfig; agyDir: string; dbPath: string; brainDir: string; binPath: string | null | undefined;
  env: NodeJS.ProcessEnv; activeWatchers: Map<string, { cleanup: () => void; emitter: EngineEmitter }>; historyCache: Map<string, ParsedHistory>;
  fetch: typeof fetch; stopping: Set<string>; watchMs: number; settleMs: number; giveUpMs: number;
  catalog: { at: number; models: Model[] } | null; lastModels: Map<string, string>; asks: Map<string, AgAsk>;
  recentCache?: Map<string, { key: string; messages: RecentMessage[] }>;
  constructor(config: AntigravityConfig = loadConfig(), env: NodeJS.ProcessEnv = process.env) {
    super();
    this.home = os.homedir();
    this.config = config;
    this.agyDir = config.agyHome;
    this.dbPath = path.join(this.agyDir, 'conversation_summaries.db');
    this.brainDir = path.join(this.agyDir, 'brain');
    this.binPath = config.agentapiBin;
    this.env = env;
    this.activeWatchers = new Map();
    this.historyCache = new Map();
    this.fetch = (...args) => fetch(...args); // replaced in tests
    this.stopping = new Set(); // conversations the console asked to stop
    this.watchMs = 1200; this.settleMs = 2500; this.giveUpMs = 45000; // shortened in tests
    this.catalog = null; // the desktop's model list, kept for a minute
    this.lastModels = new Map(); // conversation → the model it last used, once read
    this.asks = new Map(); // what the agent is waiting on the person for, by card id
  }

  // One call to the language server the desktop app runs (the app's own channel).
  async ls(method: string, body: unknown = {}, { timeout = 15000 }: { timeout?: number } = {}): Promise<unknown> {
    const ls = this.lsEnv();
    if (!ls) throw Object.assign(new Error(NO_LS), { status: 503 });
    const response = await this.fetch(`http://${ls.ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': ls.ANTIGRAVITY_CSRF_TOKEN }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const detail = await response.json().then((data: unknown) => get(data, 'message') || '', () => '');
      throw Object.assign(new Error(`language server ${response.status}${detail ? `: ${detail}` : ''}`), { status: 502, code: response.status, detail });
    }
    return response.json();
  }

  // Address and CSRF token of the running language server. Antigravity injects them
  // into processes it starts; otherwise the app's own daemon record holds them
  // (daemon/hub_<port>.json, rewritten on every launch, so it is read each time).
  lsEnv(): LsEnv | null {
    const address = this.env['ANTIGRAVITY_LS_ADDRESS'], token = this.env['ANTIGRAVITY_CSRF_TOKEN'];
    if (address && token) {
      return { ANTIGRAVITY_LS_ADDRESS: address, ANTIGRAVITY_CSRF_TOKEN: token };
    }
    const dir = path.join(this.agyDir, 'daemon');
    let records: string[] = [];
    try { records = fs.readdirSync(dir).filter(file => /^hub_\d+\.json$/.test(file)).map(file => path.join(dir, file)); } catch { return null; }
    const live = records.map(file => {
      try {
        const data = parseJson(fs.readFileSync(file, 'utf8')), pid = get(data, 'pid');
        // process.kill takes a number only; any other pid is not a live process (it threw before).
        if (typeof pid !== 'number') return null;
        process.kill(pid, 0);
        const port = get(data, 'httpPort'), csrf = get(data, 'csrfToken');
        return port && csrf ? { port, csrf, mtime: fs.statSync(file).mtimeMs } : null;
      } catch { return null; }
    }).filter(item => item !== null).sort((a, b) => b.mtime - a.mtime)[0];
    return live ? { ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${live.port}`, ANTIGRAVITY_CSRF_TOKEN: String(live.csrf) } : null;
  }

  // Why sending is impossible right now, or '' when agentapi can reach the app.
  sendBlockedReason(): string {
    if (!this.binPath) return NO_AGENTAPI;
    return this.lsEnv() ? '' : NO_LS;
  }

  // Antigravity writes each conversation twice: transcript.jsonl shortens long messages and tool
  // output ("<truncated N bytes>"), transcript_full.jsonl keeps them whole, as its desktop shows them.
  // Same records, same order; the full one is read whenever it exists.
  transcriptPath(id: string): string {
    const logs = path.join(this.brainDir, id, '.system_generated/logs');
    const full = path.join(logs, 'transcript_full.jsonl'), short = path.join(logs, 'transcript.jsonl');
    return fs.existsSync(full) || !fs.existsSync(short) ? full : short;
  }

  // A picture in the conversation's upload folder, by file name ('' when it is not one).
  uploadOf(conversationId: string, name: string): string {
    if (!/^[\w-]{1,200}$/.test(conversationId) || !/^[\w.-]{1,200}\.(png|jpe?g|gif|webp)$/i.test(name) || name.includes('..')) return '';
    return path.join(this.brainDir, conversationId, '.user_uploaded', name);
  }
  media(conversationId: string, key: string): MediaFile | null {
    const file = this.uploadOf(conversationId, key);
    if (!file || !fs.existsSync(file)) return null;
    const types: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    // uploadOf admits only these extensions.
    const type = types[path.extname(file).slice(1).toLowerCase()] || '';
    return { type, data: fs.readFileSync(file) };
  }

  cleanUserPrompt(raw: unknown): string {
    if (!raw) return '';
    const request = String(raw).match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
    const clean = request ? request[1] || '' : String(raw).replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/gi, '');
    return clean.trim();
  }

  async getStatus(): Promise<EngineStatus> {
    const reason = this.sendBlockedReason();
    return { connected: fs.existsSync(this.dbPath) && !reason, canSend: !reason, error: reason, engine: 'antigravity', appDataDir: this.agyDir };
  }

  summaries(): Bag[] {
    if (!fs.existsSync(this.dbPath)) return [];
    return readSqlite(this.dbPath, 'SELECT conversation_id, title, preview, last_modified_time, workspace_uris, not_fully_idle, killed, status, step_count, last_user_input_time, last_user_input_step_index FROM conversation_summaries WHERE nesting_depth = 0 ORDER BY last_modified_time DESC LIMIT 200;');
  }

  sessionOf(item: Bag): UnifiedSession {
    return new UnifiedSession({
      id: asText(item['conversation_id']),
      engine: 'antigravity',
      title: asText(item['title'] || item['preview'] || 'Antigravity 会话'),
      updatedAt: toIso(item['last_modified_time']),
      cwd: workspaceOf(item['workspace_uris']),
      status: Number(item['not_fully_idle']) && !Number(item['killed']) ? 'busy' : 'idle',
      isDesktopActive: !!Number(item['not_fully_idle']),
      sendBlocked: this.sendBlockedReason(),
      // When the running turn began: the avatar's bubble shows only what was said since.
      metadata: { status: item['status'], turnStartedAt: Date.parse(String(item['last_user_input_time'])) > 0 ? toIso(item['last_user_input_time']) : undefined },
    });
  }

  // The last things each conversation's agent said, read from the transcript tail.
  recentMessages(id: string): RecentMessage[] {
    const file = this.transcriptPath(id);
    let stat; try { stat = fs.statSync(file); } catch { return []; }
    this.recentCache ||= new Map();
    const key = `${stat.size}:${stat.mtimeMs}`, cached = this.recentCache.get(file);
    if (cached?.key === key) return cached.messages;
    const start = Math.max(0, stat.size - 64 * 1024), fd = fs.openSync(file, 'r');
    let tail = '';
    try { const buffer = Buffer.alloc(stat.size - start); fs.readSync(fd, buffer, 0, buffer.length, start); tail = buffer.toString('utf8'); } finally { fs.closeSync(fd); }
    const lines = tail.split('\n'); if (start) lines.shift();
    const messages: RecentMessage[] = [];
    for (const line of lines) {
      let record: unknown; try { record = parseJson(line); } catch { continue; }
      const content = str(get(record, 'content'));
      if (get(record, 'type') === 'PLANNER_RESPONSE' && content?.trim()) messages.push({ id: `message-${get(record, 'step_index')}`, preview: content.replace(/\s+/g, ' ').trim().slice(0, 200), phase: 'commentary', at: Date.parse(String(get(record, 'created_at'))) || 0 });
    }
    const recent = messages.slice(-8);
    this.recentCache.set(file, { key, messages: recent });
    return recent;
  }

  async listConversations(): Promise<UnifiedSession[]> {
    return this.summaries().map(item => {
      const session = this.sessionOf(item), id = asText(item['conversation_id']);
      const model = this.lastModels.get(id);
      session.metadata = { ...session.metadata, recentMessages: this.recentMessages(id), ...(model !== undefined ? { model } : {}) };
      return session;
    });
  }

  async parseTranscript(file: string): Promise<ParsedHistory> {
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    const records = (async function* () { for await (const line of lines) { if (!line.trim()) continue; try { yield parseJson(line); } catch {} } })();
    return this.parseRecords(records, path.basename(path.resolve(file, '../../..')));
  }

  // Transcript records (from the file, or rewritten from the language server's steps) → turns.
  async parseRecords(records: AsyncIterable<unknown>, conversationId = ''): Promise<ParsedHistory> {
    const turns: UnifiedTurn[] = [];
    let turn: UnifiedTurn | null = null, model = '', modelId: unknown = '', pending: UnifiedStep[] = [], since: unknown = null, failure: unknown = null;
    const said = new Map<string, unknown>();
    const close = () => {
      if (!turn) return;
      // An error with nothing after it ended the turn, as the desktop shows it.
      if (failure) {
        const id = `error-${get(failure, 'step_index')}`;
        turn.steps.push(new UnifiedStep({ id, type: 'notice', title: 'Agent execution terminated due to error', detail: String(get(failure, 'content') || get(failure, 'error') || '').replace(/^Error:\s*/, '').slice(0, 4000), status: 'failed' }));
        turn.timeline.push({ kind: 'activity', id });
        Object.assign(turn, { status: 'failed', statusEvidence: 'error_message', completedAt: timeOf(get(failure, 'created_at')) || turn.completedAt });
      }
      for (const step of turn.steps) if (step.status === 'running') step.status = failure ? 'interrupted' : 'completed';
      assignPhases(turn);
      // The desktop's "Worked for": from the last prompt (the person's or a system message)
      // to the final answer.
      const answer = turn.messages.filter(item => item.phase === 'final_answer').at(-1);
      const start = Date.parse(String(since || turn.timestamp)), end = Date.parse(String((answer && said.get(answer.id)) || ''));
      if (start && end >= start) turn.workedMs = end - start;
      turns.push(turn); turn = null; pending = []; since = null; failure = null; said.clear();
    };
    for await (const record of records) {
      const type = get(record, 'type'), content = get(record, 'content'), stepIndex = get(record, 'step_index');
      if (type === 'USER_INPUT') {
        const change = typeof content === 'string' && content.match(/Model Selection`?\s+from\s+.+?\s+to\s+(.*?)\.\s+No need/i);
        if (change) model = (change[1] || '').trim();
        close();
        // Pictures the person attached: the desktop keeps them in the conversation's own folder,
        // and they are served from there (media()). One kept elsewhere is only counted.
        const images = list(get(record, 'media')).filter(item => /^image\//.test(asText(get(item, 'mime_type') || '')));
        const shown = images.filter(item => conversationId && this.uploadOf(conversationId, path.basename(String(get(item, 'uri') || ''))) === get(item, 'uri'));
        const rest = images.length - shown.length;
        turn = new UnifiedTurn({
          id: `turn-${stepIndex}`,
          userPrompt: [rest ? `[图片 ×${rest}]` : '', this.cleanUserPrompt(content)].filter(Boolean).join(' '),
          userImages: shown.map(item => ({ url: `/api/sessions/antigravity/${conversationId}/media/${path.basename(String(get(item, 'uri')))}`, alt: '' })),
          timestamp: timeOf(get(record, 'created_at')), status: 'completed',
        });
      } else if (turn && type === 'SYSTEM_MESSAGE') {
        // A message delivered into the running conversation (the desktop folds it under
        // "Message from System"); work after it is timed from it.
        const message = String(content || '').match(/content=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/)?.[1] || '';
        const id = `system-${stepIndex}`;
        turn.steps.push(new UnifiedStep({ id, type: 'notice', title: 'Message from System', detail: message.trim().slice(0, 4000), status: 'completed' }));
        turn.timeline.push({ kind: 'activity', id });
        since = get(record, 'created_at'); failure = null;
      } else if (turn && type === 'ERROR_MESSAGE') {
        failure = record;
      } else if (turn && type === 'PLANNER_RESPONSE') {
        const current: UnifiedTurn = turn;
        failure = null;
        const requested = get(record, 'model');
        if (requested) modelId = requested;
        const tools = list(get(record, 'tool_calls'));
        tools.forEach((tool, index) => {
          const step = stepOf(tool, asText(get(tool, 'id')) || `tool-${stepIndex}-${index}`);
          current.steps.push(step); pending.push(step);
          current.timeline.push({ kind: 'activity', id: step.id });
          const target = editedFile(step);
          if (target && !current.artifacts.some(item => item.path === target)) current.artifacts.push({ path: target });
        });
        const reply = str(content);
        if (reply?.trim()) {
          const id = `message-${stepIndex}`;
          current.messages.push({ id, phase: 'commentary', text: reply });
          said.set(id, get(record, 'created_at'));
          // The text in a response precedes the tools it calls.
          const at = current.timeline.length - tools.length;
          current.timeline.splice(at, 0, { kind: 'message', id });
        }
        current.completedAt = timeOf(get(record, 'created_at')) ?? null;
      } else if (turn && type === 'GENERIC' && pending.length) {
        const status = get(record, 'status'), callId = get(record, 'tool_call_id');
        if (status === 'RUNNING') continue;
        // The language server names the call a result answers; the transcript lists them in order.
        const at = callId ? pending.findIndex(step => step.id === callId) : 0;
        if (at < 0) continue;
        const [step] = pending.splice(at, 1);
        if (!step) continue;
        step.output = toolOutput(content).slice(0, 16000);
        step.status = status === 'ERROR' ? 'failed' : status === 'CANCELED' || status === 'INTERRUPTED' ? 'interrupted' : 'completed';
      }
    }
    close();
    return { turns, model, modelId };
  }

  // A conversation the desktop keeps without a transcript file (older ones): read from the
  // language server, which is where the desktop itself reads it. Needs the app running.
  async remoteHistory(id: string, row: Bag | undefined): Promise<ParsedHistory> {
    const key = `${row?.['step_count']}:${row?.['last_modified_time']}`, cached = this.historyCache.get(`ls:${id}`);
    if (cached?.key === key) return cached;
    const steps = list(get(await this.ls('GetCascadeTrajectorySteps', { cascadeId: id }, { timeout: 30000 }), 'steps'));
    const records = (async function* () { for (const [index, step] of steps.entries()) yield* recordsOfStep(step, index); })();
    const parsed = { key, ...(await this.parseRecords(records, id)) };
    this.historyCache.set(`ls:${id}`, parsed);
    return parsed;
  }

  async getConversationHistory(conversationId: string): Promise<{ session: UnifiedSession; turns: UnifiedTurn[] }> {
    const file = this.transcriptPath(conversationId);
    const row = this.summaries().find(item => item['conversation_id'] === conversationId);
    let parsed: ParsedHistory;
    if (!fs.existsSync(file)) {
      if (!row) throw Object.assign(new Error(`Transcript not found for conversation ${conversationId}`), { status: 404 });
      try { parsed = await this.remoteHistory(conversationId, row); } catch { parsed = { turns: [], model: '', modelId: '' }; }
    } else {
      const stat = fs.statSync(file), key = `${stat.size}:${stat.mtimeMs}`;
      const cached = this.historyCache.get(file);
      if (cached?.key === key) parsed = cached;
      else {
        parsed = { key, ...(await this.parseTranscript(file)) };
        this.historyCache.set(file, parsed);
      }
    }
    while (this.historyCache.size > 24) { const oldest = this.historyCache.keys().next().value; if (oldest === undefined) break; this.historyCache.delete(oldest); }
    const turns = structuredClone(parsed.turns);
    const session = row ? this.sessionOf(row) : new UnifiedSession({ id: conversationId, engine: 'antigravity', title: turns[0]?.userPrompt?.slice(0, 40) || 'Antigravity 会话', sendBlocked: this.sendBlockedReason() });
    // The model this conversation last used, under the name the desktop's picker shows: the
    // console's model menu starts on it (the list carries it too once it has been read).
    const model = parsed.model || this.catalog?.models.find(item => item.id === parsed.modelId)?.name || '';
    if (model) this.lastModels.set(conversationId, model);
    session.metadata = { ...session.metadata, model };
    return { session, turns };
  }

  // Per-model quota from the language server Antigravity itself runs. Reachable only
  // with the address and CSRF token Antigravity injects into processes it starts.
  async getUsage(): Promise<Usage> {
    const reason = this.sendBlockedReason();
    if (reason) return { available: false, reason, short: reason === NO_LS ? '未运行' : '未安装' };
    const status = await this.ls('GetUserStatus', {}, { timeout: 10000 });
    // Lead with the model of the most recent conversation, as the desktop picker does.
    let current = '';
    try { const latest = this.summaries()[0]; if (latest) current = (await this.getConversationHistory(asText(latest['conversation_id']))).session.metadata.model || ''; } catch {}
    return quotaOf(status, current);
  }

  // Its speech service lives in the language server, which runs only while the desktop app does.
  dictationReady(): DictationReady { return this.lsEnv() ? { ready: true } : { ready: false, reason: NO_LS }; }
  // Antigravity's own speech-to-text: a Connect server stream that reports the running
  // transcript, fed by unary SendAudioChunk calls.
  async dictate({ onText, onError, onEnd }: DictationHandlers): Promise<DictationStream> {
    const ls = this.lsEnv();
    if (!ls) throw Object.assign(new Error(this.sendBlockedReason() || NO_LS), { status: 409 });
    const base = `http://${ls.ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/`;
    const headers = { 'x-codeium-csrf-token': ls.ANTIGRAVITY_CSRF_TOKEN };
    const unary = (method: string, body: unknown) => fetch(base + method, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
      .then(response => { if (!response.ok) throw new Error(`${method} ${response.status}`); });
    const request = JSON.stringify({ mimeType: 'audio/l16;rate=16000', continuous: false });
    const envelope = Buffer.alloc(5 + Buffer.byteLength(request)); envelope.writeUInt32BE(Buffer.byteLength(request), 1); envelope.write(request, 5);
    const controller = new AbortController();
    const response = await fetch(base + 'StreamAudioTranscription', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1' }, body: envelope, signal: controller.signal });
    if (!response.ok) throw new Error(`Antigravity 语音识别不可用 (${response.status})`);
    let sessionId: unknown = null, sequence = 0, ended = false, finishing = false, chain = Promise.resolve(), latest = '';
    const queue: Uint8Array[] = [];
    const end = () => { if (ended) return; ended = true; onEnd(); controller.abort(); };
    const push = (chunk: Uint8Array) => { const sequenceNumber = sequence++; chain = chain.then(() => unary('SendAudioChunk', { sessionId, data: Buffer.from(chunk).toString('base64'), sequenceNumber })).catch(err => onError(messageOf(err))); };
    void (async () => {
      try {
        const body = response.body;
        // A streaming answer always has a body; without one there is nothing to read.
        if (!body) throw new Error(`Antigravity 语音识别不可用 (${response.status})`);
        const reader = body.getReader();
        let buffer: Buffer = Buffer.alloc(0);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
          while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
            const flags = buffer[0] ?? 0, length = buffer.readUInt32BE(1);
            let message: unknown = {}; try { message = parseJson(buffer.subarray(5, 5 + length).toString('utf8')); } catch {}
            buffer = buffer.subarray(5 + length);
            if (flags & 2) { if (get(message, 'error')) onError(asText(get(message, 'error', 'message') || 'Antigravity 语音识别失败')); continue; }
            const ready = get(message, 'ready', 'sessionId');
            if (ready && !sessionId) {
              sessionId = ready;
              for (const chunk of queue.splice(0)) push(chunk);
              if (finishing) chain = chain.then(() => unary('EndAudioSession', { sessionId }));
            }
            const transcription = get(message, 'transcription');
            if (transcription) { latest = mergeTranscript(latest, asText(get(transcription, 'text') || ''), !!get(transcription, 'isFinal')); onText(latest); }
            if (get(message, 'complete')) end();
          }
        }
      } catch (err) { if (!ended && errorField(err, 'name') !== 'AbortError') onError(messageOf(err)); }
      end();
    })();
    return {
      send: chunk => { if (ended || finishing) return; if (sessionId) push(chunk); else queue.push(chunk); },
      finish: () => {
        if (finishing || ended) return; finishing = true;
        if (sessionId) chain = chain.then(() => unary('EndAudioSession', { sessionId })).catch(err => onError(messageOf(err)));
        setTimeout(end, 8000).unref?.();
      },
      cancel: () => { ended = true; if (sessionId) unary('EndAudioSession', { sessionId }).catch(() => {}); controller.abort(); },
    };
  }

  // The models the desktop's own picker offers (its labels, its ids), in its order. The short
  // aliases agentapi documents stand in while the app is not running.
  async getModels(): Promise<Model[]> {
    const configured = this.config.catalogs?.['antigravity'];
    if (configured) return configured;
    if (this.catalog && Date.now() - this.catalog.at < 60000) return this.catalog.models;
    try {
      const data = await this.ls('GetCascadeModelConfigData');
      const models = list(get(data, 'clientModelConfigs')).filter(item => !get(item, 'disabled') && get(item, 'label') && get(item, 'modelOrAlias', 'model'))
        .map(item => ({ id: asText(get(item, 'modelOrAlias', 'model')), name: asText(get(item, 'label')), agentId: asText(get(item, 'modelId') || '') }));
      if (models.length) this.catalog = { at: Date.now(), models };
    } catch {}
    return this.catalog?.models || MODEL_ALIASES;
  }

  // The desktop's channel takes text: attachments go in as the shared notes (core/attachments.ts).
  buildAgyPrompt(prompt: string | undefined, attachments: SendInput['attachments'] | undefined): string | undefined {
    return attachments?.length ? withAttachments(prompt, attachments) : prompt;
  }

  agentapi(args: string[]): Promise<{ data: unknown; stdout: string }> {
    return new Promise((resolve, reject) => {
      const bin = this.binPath;
      // Callers check sendBlockedReason() first; without agentapi there is nothing to run.
      if (!bin) { reject(new Error(NO_AGENTAPI)); return; }
      // Windows ships agentapi as a .bat, which execFile cannot start without a shell; the
      // arguments are flags and ids the caller controls, so the shell adds only cmd.exe's shim.
      const viaShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(bin);
      execFile(bin, args, { env: { ...this.env, ...this.lsEnv() }, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...(viaShell ? { shell: true } : {}) }, (err, stdout, stderr) => {
        let data: unknown = null;
        try { data = parseJson(String(stdout).trim()); } catch {}
        const failed = get(data, 'error');
        if (err || failed) return reject(new Error(String(failed || String(stderr).trim() || err?.message)));
        resolve({ data, stdout: String(stdout) });
      });
    });
  }

  // A message goes in as the person's own, the way the desktop's composer sends it: the language
  // server's SendUserCascadeMessage with the IDE as its origin, so the conversation records it as
  // USER_INPUT and the desktop shows it as the person's message. (agentapi send-message is for
  // agents messaging each other: it arrives as a SYSTEM_MESSAGE "not actually sent by the user",
  // which the desktop folds under "Message from System" and the model does not take as a request.)
  // `steer`: join the running turn at its next model call; when the agent is idle the message is
  // taken at once all the same. `model`: one the person picked in the console, by the desktop's
  // id; it rides in the message's own config, as a pick in the desktop's menu does.
  async sendUserMessage(conversationId: string, message: string | undefined, { steer = false, model = '' }: { steer?: boolean; model?: string } = {}): Promise<void> {
    if (!this.binPath || !this.lsEnv()) throw Object.assign(new Error(this.sendBlockedReason() || NO_LS), { status: 503 });
    if (model && !/^MODEL_[A-Z0-9_]+$/.test(model)) throw Object.assign(new Error('Antigravity 桌面端现在没有提供这个模型，消息没有发出'), { status: 400 });
    const body = { cascadeId: conversationId, items: [{ text: message }], messageOrigin: 'AGENT_MESSAGE_ORIGIN_IDE',
      ...(steer ? { deliveryStrategy: 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION' } : {}),
      ...(model ? { cascadeConfig: { plannerConfig: { requestedModel: { model } } } } : {}) };
    try { await this.ls('SendUserCascadeMessage', body, { timeout: 30000 }); }
    catch (err) {
      const code = errorField(err, 'code'), detail = errorField(err, 'detail');
      if (!code) throw err;
      throw Object.assign(new Error(`Antigravity 没有接收这条消息（${code}${detail ? `：${detail}` : ''}）`), { status: 502 });
    }
  }

  row(conversationId: string): Bag | null {
    try { return readSqlite(this.dbPath, 'SELECT not_fully_idle, step_count, last_user_input_step_index FROM conversation_summaries WHERE conversation_id = ? LIMIT 1', [conversationId])[0] || null; }
    catch { return null; }
  }

  sendMessage({ conversationId, prompt, attachments, model }: Partial<SendInput> & { conversationId: string }): EngineEvents {
    const emitter = new EngineEvents();
    queueMicrotask(() => {
      try {
        const reason = this.sendBlockedReason();
        if (reason) throw new Error(reason);
        const file = this.transcriptPath(conversationId), before = this.row(conversationId);
        // A conversation without a transcript file (an older one) is followed on the language server.
        const live = fs.existsSync(file);
        this.watchTurn(conversationId, emitter, { file: live ? file : '', offset: live ? fs.statSync(file).size : 0, next: Number(before?.['step_count']) || 0, baseline: before ? Number(before['last_user_input_step_index']) : -1 });
        this.sendUserMessage(conversationId, this.buildAgyPrompt(prompt, attachments), { model })
          .catch(err => { emitter.emit('interrupt'); emitter.emit('error', errorOf(err)); });
      } catch (err) { emitter.emit('error', errorOf(err)); }
    });
    return emitter;
  }

  // A message sent while the agent works joins the running turn, as the person's message.
  async steer(conversationId: string, { prompt, attachments }: Partial<SendInput> = {}): Promise<Record<string, never>> {
    const reason = this.sendBlockedReason();
    if (reason) throw Object.assign(new Error(reason), { status: 503 });
    await this.sendUserMessage(conversationId, this.buildAgyPrompt(prompt, attachments), { steer: true });
    return {};
  }

  // Stop: the call behind the desktop's own stop button. How the turn ended is then read from
  // the conversation's record by the watcher, not assumed.
  // A file from the chat, opened in the desktop. Antigravity is an editor and opens a file it is
  // handed in the window whose workspace holds it, which is what its own file links do; there is
  // no accessibility flow for its chat, so the chat itself is not brought up.
  fileRoots(conversationId: string): string[] { return /^[\w-]{1,80}$/.test(String(conversationId)) ? [path.join(this.brainDir, conversationId)] : []; }
  openFile(_conversationId: string, { absolute }: Pick<FileTarget, 'absolute'>, run: OpenRunner = execFile): Promise<{ ok: true; pressed: true }> {
    if (process.platform === 'win32' && run === execFile) {
      const bin = path.join(this.env['LOCALAPPDATA'] || path.join(this.home, 'AppData', 'Local'), 'Programs', 'antigravity', 'Antigravity.exe');
      return new Promise((resolve, reject) => run(bin, [absolute], { timeout: 15000 }, err =>
        err ? reject(Object.assign(new Error('没能在 Antigravity 里打开这个文件'), { status: 409, cause: err })) : resolve({ ok: true, pressed: true })));
    }
    return new Promise((resolve, reject) => run('/usr/bin/open', ['-b', 'com.google.antigravity', absolute], { timeout: 15000 }, err =>
      err ? reject(Object.assign(new Error('没能在 Antigravity 里打开这个文件'), { status: 409, cause: err })) : resolve({ ok: true, pressed: true })));
  }
  async interrupt(conversationId: string): Promise<{ pending: boolean }> {
    try { await this.ls('CancelCascadeInvocation', { cascadeId: conversationId }); }
    catch (err) { throw Object.assign(new Error(`Antigravity 没有停下这一轮（${lsDetail(err)}）`), { status: lsStatus(err) }); }
    this.stopping.add(conversationId);
    return { pending: true };
  }

  // What a step waits on the person for, as a card in the chat: a permission to allow or refuse,
  // or the agent's own question with its options. The desktop shows the same step the same way.
  askOf(conversationId: string, index: number, step: unknown): Approval | null {
    const spec = bag(get(step, 'requestedInteraction')) || {}, kind = Object.keys(spec)[0];
    if (!kind) return null;
    const body = spec[kind] || {}, id = `${conversationId}_${index}`;
    const command = asText(get(step, 'runCommand', 'proposedCommandLine') || get(step, 'runCommand', 'commandLine') || '');
    let card: Omit<Approval, 'id'> & { id?: string };
    if (kind === 'askQuestion') {
      card = questionCard(id, list(get(body, 'questions')).map(item => ({ question: asText(get(item, 'question')), multi: !!get(item, 'isMultiSelect'), options: list(get(item, 'options')).map(option => ({ id: String(get(option, 'id')), label: asText(get(option, 'text')) })) })), 'Antigravity');
    } else {
      card = { title: kind === 'runCommand' ? '允许 Antigravity 运行这条命令？' : asText(get(body, 'actionDescription') || '允许 Antigravity 执行这个操作？'),
        detail: command || [get(body, 'resource', 'action'), get(body, 'resource', 'target'), get(body, 'absolutePathUri'), get(body, 'url'), get(body, 'reason')].filter(Boolean).join(' · ') || asText(get(step, 'metadata', 'toolCall', 'name') || ''), decisions: ['accept', 'decline'] };
    }
    this.asks.set(id, { conversationId, index, kind, body, command, trajectoryId: asText(get(step, 'metadata', 'sourceTrajectoryStepInfo', 'trajectoryId') || '') });
    return { id, ...card };
  }

  // The person's answer goes back the way the desktop's own buttons send it.
  async decide(id: string, decision: string): Promise<void> {
    const ask = this.asks.get(id);
    if (!ask) throw Object.assign(new Error('这个确认已经处理过了'), { status: 409 });
    const yes = decision === 'accept', once = 'PERMISSION_SCOPE_ONCE';
    const answers: Readonly<Record<string, unknown>> = {
      permission: { allow: yes, scope: once },
      filePermission: { allow: yes, scope: once, absolutePathUri: get(ask.body, 'absolutePathUri') },
      runCommand: { confirm: yes, proposedCommandLine: ask.command, submittedCommandLine: ask.command },
      askQuestion: decision === 'decline' ? { cancelled: true } : { responses: [{ ...bag(get(ask.body, 'questions', 0)), selectedOptionIds: [String(decision).replace(/^option:/, '')] }] },
    };
    const answer = (Object.hasOwn(answers, ask.kind) ? answers[ask.kind] : undefined) || { confirm: yes };
    try {
      const trajectoryId = ask.trajectoryId || get(await this.ls('GetConversationMetadata', { conversationId: ask.conversationId }), 'trajectoryId');
      await this.ls('HandleCascadeUserInteraction', { cascadeId: ask.conversationId, interaction: { trajectoryId, stepIndex: ask.index, [ask.kind]: answer } });
    } catch (err) { throw Object.assign(new Error(`Antigravity 没有收到这个回答（${lsDetail(err)}）`), { status: lsStatus(err) }); }
    this.asks.delete(id);
  }

  observe(conversationId: string): EngineEvents {
    const emitter = new EngineEvents();
    queueMicrotask(() => this.watchTurn(conversationId, emitter, { file: this.transcriptPath(conversationId) }));
    return emitter;
  }

  // A new chat. In a folder: the language server starts the conversation with that workspace, as
  // the desktop's own new chat does (same source and type as a desktop-made one), and the first
  // message goes in like any other; agentapi cannot name a folder. Without one: agentapi.
  async newConversation({ prompt, title, model, attachments, cwd }: CreateInput): Promise<CreateResult> {
    const reason = this.sendBlockedReason();
    if (reason) throw Object.assign(new Error(reason), { status: 503 });
    if (cwd) {
      if (!path.isAbsolute(cwd) || !fs.existsSync(cwd)) throw Object.assign(new Error('这个文件夹不存在，聊天没有新建'), { status: 400 });
      // The executor refuses to start without a model ("plan model not specified"), so a
      // cascade the console starts carries one explicitly: the pick the person made, else the
      // first model the desktop offers (verified against the live language server, 2.32.1).
      const wanted = model || (await this.getModels())[0]?.id;
      const config = wanted ? { plannerConfig: { requestedModel: { model: wanted } } } : undefined;
      let started: unknown;
      try { started = await this.ls('StartCascade', { source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE', workspaceUris: [pathToFileURL(cwd).href], ...(config ? { config } : {}) }); }
      catch (err) { throw Object.assign(new Error(`Antigravity 没有在这个文件夹里新建聊天（${lsDetail(err)}）`), { status: lsStatus(err) }); }
      const cascadeId = get(started, 'cascadeId');
      if (!cascadeId) throw new Error('Antigravity 未返回会话 ID');
      const id = String(cascadeId);
      await this.sendUserMessage(id, this.buildAgyPrompt(prompt, attachments), { model: wanted });
      return { id, engine: 'antigravity', started: true, cwd };
    }
    const args = ['new-conversation'];
    if (title) args.push(`--title=${title}`);
    // agentapi names a model by its alias or model id, not by the picker's id.
    if (model) args.push(`--model=${(await this.getModels()).find(item => item.id === model)?.['agentId'] || model}`);
    args.push(String(this.buildAgyPrompt(prompt, attachments)));
    const { data, stdout } = await this.agentapi(args);
    const id = asText(get(data, 'response', 'conversationId') || get(data, 'conversationId') || stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || '');
    if (!id) throw new Error('Antigravity 未返回会话 ID');
    return { id, engine: 'antigravity', started: true };
  }

  // How the turn after the person's last message ended, from the language server's record:
  // an error the desktop shows, a stop, or done. null: nothing has followed the message yet.
  async turnOutcome(conversationId: string, row: Bag, { failure = '', received = false }: { failure?: string; received?: boolean } = {}): Promise<Outcome | null> {
    try {
      const steps = list(get(await this.ls('GetCascadeTrajectorySteps', { cascadeId: conversationId, stepOffset: Math.max(0, Number(row['last_user_input_step_index']) || 0) }), 'steps'));
      // System notices (an MCP's context injections among them) are not how a turn ends, and a
      // cascade the desktop already calls idle may not have written its ending yet: completed is
      // said only when the desktop answered (its reply, or the notification it shows), failed on
      // its error, interrupted on its stop. Anything else is still waiting for its ending.
      const last = steps.slice(1).filter(step => stepKind(step) !== 'EPHEMERAL_MESSAGE').at(-1);
      if (!last) return null;
      const error = shownError(last);
      if (error) return { status: 'failed', error: { message: errorText(error) } };
      if (['CANCELED', 'INTERRUPTED'].includes(stepStatus(last))) return { status: 'interrupted' };
      return ['PLANNER_RESPONSE', 'NOTIFY_USER'].includes(stepKind(last)) ? { status: 'completed' } : null;
    } catch {
      return failure ? { status: 'failed', error: { message: failure } } : received ? { status: 'completed' } : null;
    }
  }

  // Follows one turn: what the agent says and does (from the transcript file, or from the
  // language server when the conversation has no file), and its end. The end needs evidence
  // from Antigravity's own records, and must not depend on the agent having said anything:
  // a turn can end at once with an error (a model the conversation used is gone) and no reply.
  watchTurn(conversationId: string, emitter: EngineEmitter & { once(event: 'interrupt', listener: () => void): unknown }, { file = '', offset = 0, next = 0, baseline = -1 }: { file?: string; offset?: number; next?: number; baseline?: number } = {}): void {
    let stopped = false, received = false, checking = false, polling = false, idleChecks = 0, missing = 0, failure = '';
    const pending: string[] = [], started = Date.now();
    const cleanup = () => { stopped = true; tailer?.close(); clearInterval(checker); clearInterval(poller); this.stopping.delete(conversationId); for (const id of waiting.values()) this.asks.delete(id); if (this.activeWatchers.get(conversationId)?.emitter === emitter) this.activeWatchers.delete(conversationId); };
    const onRecord = (record: unknown) => {
      idleChecks = 0;
      const type = get(record, 'type'), stepIndex = get(record, 'step_index');
      if (type === 'PLANNER_RESPONSE') {
        received = true; failure = '';
        if (get(record, 'thinking')) emitter.emit('delta', { type: 'reasoning', itemId: 'thinking' });
        const reply = str(get(record, 'content'));
        if (reply?.trim()) emitter.emit('item_completed', { item: { type: 'agentMessage', id: `message-${stepIndex}`, text: reply, phase: 'commentary' } });
        for (const [index, tool] of list(get(record, 'tool_calls')).entries()) {
          const id = asText(get(tool, 'id')) || `tool-${stepIndex}-${index}`;
          pending.push(id);
          emitter.emit('delta', { type: 'tool_call', id, name: asText(get(tool, 'name')), input: decodeArgs(get(tool, 'args')) });
          const edited = editedFile(stepOf(tool, id));
          if (edited) emitter.emit('artifact', { path: edited });
        }
      } else if (type === 'GENERIC' && get(record, 'status') !== 'RUNNING' && pending.length) {
        const callId = get(record, 'tool_call_id');
        const at = callId ? pending.findIndex(id => id === callId) : 0;
        if (at >= 0) emitter.emit('delta', { type: 'tool_result', id: pending.splice(at, 1)[0], output: toolOutput(get(record, 'content')), isError: get(record, 'status') === 'ERROR' });
      } else if (type === 'ERROR_MESSAGE') {
        failure = String(get(record, 'content') || get(record, 'error') || '').replace(/^Error:\s*/, '');
      }
    };
    const tailer = file ? tailJsonl(file, offset, onRecord, { onError: err => { cleanup(); emitter.emit('error', errorOf(err)); } }) : null;
    // The language server's steps since the message: the ones that settled (they are the
    // records when there is no file), and the ones waiting on the person, which become cards.
    const waiting = new Map<number, string>();
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const steps = list(get(await this.ls('GetCascadeTrajectorySteps', { cascadeId: conversationId, stepOffset: next }), 'steps'));
        if (stopped) return;
        const open = new Set<number>(); let index = next, settled = true;
        for (const step of steps) {
          const status = stepStatus(step);
          if (settled && SETTLED.has(status)) { if (!file) for (const record of recordsOfStep(step, index)) onRecord(record); next = index + 1; }
          else settled = false;
          if (status === 'WAITING' && get(step, 'requestedInteraction')) {
            open.add(index);
            if (!waiting.has(index)) { const ask = this.askOf(conversationId, index, step); if (ask) { waiting.set(index, ask.id); emitter.emit('approval', ask); } }
          }
          index++;
        }
        for (const [at, id] of waiting) if (!open.has(at)) { waiting.delete(at); this.asks.delete(id); emitter.emit('approval_resolved', { id }); }
      } catch {} finally { polling = false; }
    };
    const poller = setInterval(poll, this.watchMs);
    poller.unref?.();
    const checker = setInterval(async () => {
      if (stopped || checking || Date.now() - started < this.settleMs) return;
      checking = true;
      try {
        const row = this.row(conversationId);
        const idle = !!row && Number(row['not_fully_idle']) === 0;
        if (TRACE) console.error(`[agy watch] ${conversationId.slice(0, 8)} check: row=${!!row} idle=${idle} received=${received} elapsed=${Date.now() - started}ms`);
        if (!row) {
          // Antigravity has no record of this conversation (never created, or deleted there):
          // nothing can follow the message, so the turn is not left running forever.
          idleChecks = 0;
          if (!received && ++missing >= 3 && Date.now() - started > this.giveUpMs) { cleanup(); emitter.emit('error', new Error('Antigravity 的记录里没有这个聊天，这一轮没有开始')); }
          return;
        }
        missing = 0;
        if (!idle) { idleChecks = 0; return; }
        if (++idleChecks < 2) return;
        const accepted = received || Number(row['last_user_input_step_index']) > baseline;
        const outcome = accepted ? await this.turnOutcome(conversationId, row, { failure, received }) : null;
        if (stopped) return;
        if (TRACE) console.error(`[agy watch] ${conversationId.slice(0, 8)} outcome: accepted=${accepted} outcome=${JSON.stringify(outcome)} failure=${JSON.stringify(failure)}`);
        if (!outcome) {
          // Idle with nothing recorded after the message: give Antigravity time, then say so.
          if (Date.now() - started > this.giveUpMs) { cleanup(); emitter.emit('error', new Error('Antigravity 没有开始这一轮：它的记录里没有这条消息的回应')); }
          return;
        }
        tailer?.read(); await poll();
        const asked = this.stopping.has(conversationId);
        cleanup();
        emitter.emit('completed', { turn: asked && outcome.status === 'completed' ? { status: 'interrupted' } : outcome });
      } catch (err) { cleanup(); emitter.emit('error', errorOf(err)); }
      finally { checking = false; }
    }, this.watchMs);
    checker.unref?.();
    emitter.once('interrupt', cleanup);
    this.activeWatchers.set(conversationId, { cleanup, emitter });
    tailer?.read(); void poll();
  }
  dispose(): void { for (const watcher of this.activeWatchers.values()) watcher.cleanup(); this.activeWatchers.clear(); }
}
export { AntigravityBridge, quotaOf, mergeTranscript, recordsOfStep };
