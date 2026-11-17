// The plugin contract: one set of types that the server, every engine plugin and the page share.
// skills/add-desktop-engine/references/plugin-contract.md explains each shape in words; this file
// is the authority. An engine that writes a field wrongly fails `npm run build`.
//
// Nothing here imports Node or the DOM: the page and the server both compile this file.

// ---------------------------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------------------------

/** Lower-case letters, digits and hyphens, starting with a letter (checked by PluginHost). */
export type EngineId = string;
/** Times as engines record them: ISO text, epoch seconds or epoch milliseconds. */
export type TimeValue = string | number;
/** A function that releases what a plugin set up. */
export type Dispose = () => void | Promise<void>;
/** An image served by the engine's media(): `/api/sessions/<engine>/<sessionId>/media/<key>`. */
export interface MediaImage { url: string; alt?: string }
/** What media(sessionId, key) answers: an image read from the native record. */
export interface MediaFile { type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | string; data: Uint8Array }
/** A runtime asset registered with registerAsset (character art, fonts read from an installed app). */
export interface AssetFile { type: string; data: Uint8Array }
/** An error an engine throws on purpose: `status` is the HTTP status, `fallback: 'queue'` sends a steer to the queue. */
export interface EngineError extends Error { status?: number; fallback?: 'queue'; transport?: boolean; terminal?: boolean; controls?: NewControl[]; picked?: string[] }

// ---------------------------------------------------------------------------------------------
// What a plugin declares (plugin-contract.md §1, §6, §7)
// ---------------------------------------------------------------------------------------------

/** The folder menu a new chat started from a project's "+" picks on the desktop's New page. */
export interface NewFolder { control: string; via?: { control: string; option: string } }

/** What an engine can do. The page reads only these flags, never which engine it is. */
export interface Capabilities {
  attachments?: boolean;
  cwd?: boolean;
  models?: boolean;
  reasoning?: boolean;
  interrupt?: boolean;
  steer?: boolean;
  approvals?: boolean;
  dictation?: boolean;
  send?: boolean;
  openFile?: boolean;
  /** The engine can take the person to a chat in its desktop app (`show`): the header's button. */
  showInDesktop?: boolean;
  /** The desktop's own buttons on a wrap-up card (commit, open a PR…) are read from the desktop (readCard) and pressed there (pressAction). */
  cardActions?: boolean;
  createRequiresPrompt?: boolean;
  newOptions?: boolean;
  newSettings?: boolean;
  newFolder?: NewFolder;
  /** false: no permission menu (a desktop mode with its own settings). */
  permissions?: boolean;
  /** A reason that blocks every send for this engine (shown to the person). */
  sendBlocked?: string;
  /** true: interrupt can stop a desktop turn without a Frontdesk run record. */
  desktopInterrupt?: boolean;
}
/** The flags of Capabilities only: what a desktop mode (space) or a session may narrow. */
export type CapabilityFlags = { [K in keyof Capabilities as NonNullable<Capabilities[K]> extends boolean ? K : never]?: boolean };

/** One of the desktop's own modes (its sidebar switch), in its order and words. */
export interface Space {
  id: string;
  label: string;
  default?: boolean;
  capabilities?: CapabilityFlags;
  /** The console cannot start a chat in this mode yet: the reason. */
  noNew?: string;
  /** The console cannot read this mode at all: the reason. */
  unavailable?: string;
}

/** A permission mode the engine's channel accepts; `id` is letters only. */
export interface PermissionMode { id: string; label: string; description?: string }

/** How the desktop writes a conversation (plugin-contract.md §7, "对话的样子"). Unset fields draw Claude's way. */
export interface Look {
  worked?: 'fold';
  workingLive?: boolean;
  toolCaption?: 'kinds';
  diffCard?: boolean;
  ago?: 'short';
  userTime?: boolean;
  replyTime?: 'before' | 'after' | 'none';
}

/** The engine's character (plugin-contract.md §4). */
export type Character =
  | { kind: 'image'; url: string; standIn?: boolean; pixelated?: boolean; fill?: boolean; workingUrl?: string }
  | { kind: 'sprite'; url: string; columns: number; rows: number; cell: [number, number]; idle: [number, number]; working: { row: number; frames: number }; workingUrl?: string };
/**
 * What the person changed about an agent in the console's settings (GET /api/engines): its name
 * and its two faces, idle and working, as pictures they uploaded. Only what they changed is
 * there; the rest is the plugin's own. `fill` (a picture of theirs fills the round face) and
 * `workingUrl` (a picture of theirs shown while it works) on a Character come from here too.
 */
export interface AgentCustom { label?: string; idle?: string; working?: string }
export type AvatarSlot = 'idle' | 'working';

/** An engine skin: a stylesheet scoped to html[data-engine="<id>"], and an optional module of renderers. */
export interface Skin { stylesheet?: string; module?: string }

// ---------------------------------------------------------------------------------------------
// Data shapes (plugin-contract.md §3)
// ---------------------------------------------------------------------------------------------

/** 'unknown': the engine has no record yet of how the session's last turn went (Codex before its log is read). */
export type SessionStatus = 'idle' | 'busy' | 'unknown';
export type MessagePhase = 'commentary' | 'final_answer';
export type TurnStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type StepStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'pending';
export type StepType =
  | 'reasoning' | 'tool_call' | 'command' | 'file_change' | 'web_search' | 'info' | 'summary'
  | 'image_view' | 'notice' | 'background_task' | 'stop_task' | 'user_message';

/** The project a session belongs to in the desktop's sidebar; `null` means "a chat, in no project". */
export interface SessionGroup { id: string; name: string; cwd?: string }
/** Something the AI said recently (only its own words): what the dock's speech bubble shows. */
export interface RecentMessage { id: string; preview: string; phase?: MessagePhase | string; at: TimeValue }
/** The session's own settings in the desktop app; the composer's menus start on them. */
/** inherited: taken from the most recent desktop session, as this one records none (Claude). */
export interface DesktopSettings { model?: string; effort?: string; permissionMode?: string; inherited?: boolean }
/** A message the desktop holds for the running turn (its own queue). */
export interface DesktopQueueItem { prompt: string; at?: TimeValue }
/** The newest turn's state, with the native evidence for it. */
export interface LatestTurn { id: string; status: TurnStatus | string; completedAt: TimeValue | null; statusEvidence: string | null }
/** Where a session sits in one mode: its project there (null: none) and its rank. */
export interface SpacePlacement { group?: SessionGroup | null; rank?: number }

export interface SessionMetadata {
  group?: SessionGroup | null;
  parentId?: string;
  attention?: string;
  desktop?: DesktopSettings;
  desktopQueue?: DesktopQueueItem[];
  recentMessages?: RecentMessage[];
  turnStartedAt?: TimeValue;
  latestTurn?: LatestTurn | null;
  model?: string | null;
  /** The desktop mode(s) the session shows in; unset is the default mode. */
  space?: string | string[];
  bySpace?: Record<string, SpacePlacement>;
  /** The session's text is not on this machine: the reason. */
  contentUnavailable?: string;
  /** A chat read from the desktop window that was not read whole. */
  readFromDesktop?: { read: number; total: number } | true;
  /** Engine-specific extras the page does not read. Values stay unknown on purpose. */
  [extra: string]: unknown;
}

export interface UnifiedSession {
  id: string;
  engine: EngineId;
  title: string;
  updatedAt: TimeValue;
  cwd: string;
  status: SessionStatus;
  isDesktopActive: boolean;
  /** Non-empty: the console must not write to this session, and this is why. */
  sendBlocked: string;
  metadata: SessionMetadata;
  /** Narrowed capabilities for this one session (set by the server). */
  capabilities?: CapabilityFlags;
}

export interface UnifiedMessage { id: string; text: string; phase?: MessagePhase | string; status?: 'streaming' | 'completed'; /** When it was said, when the record says. */ at?: TimeValue }
export interface TimelineEntry { kind: 'message' | 'activity' | 'artifact'; id: string }
/** A step-list item; status is the agent's own word, usually one of the three. */
export interface PlanItem { content: string; status: 'pending' | 'in_progress' | 'completed' | string }
export interface FileChange { path: string; kind: 'add' | 'delete' | 'update' | string; added?: number; removed?: number; diff?: string }

export interface UnifiedStep {
  id: string;
  type: StepType | string;
  title?: string;
  /** Native tool name and arguments: the shared tool catalog summarizes them. */
  name: string;
  input: unknown;
  paths?: string[];
  plan?: PlanItem[];
  images?: MediaImage[];
  changes?: FileChange[];
  detail: string;
  output: string;
  patch: string;
  status: StepStatus | string;
  durationMs: number;
  /** Engine-side: a command still running in the background after its tool call returned (Claude). */
  background?: boolean;
}

export interface Artifact { id?: string; path?: string; url?: string; title?: string; kind?: string; summary?: string }

export interface UnifiedTurn {
  id: string;
  userPrompt: string;
  userImages: MediaImage[];
  timestamp: TimeValue;
  status: TurnStatus | string;
  statusEvidence: string | null;
  completedAt: TimeValue | null;
  messages: UnifiedMessage[];
  timeline: TimelineEntry[];
  steps: UnifiedStep[];
  artifacts: Artifact[];
  /** What the running turn waits on the person for, as the desktop's record shows it. */
  approvals?: Approval[];
  assistantReply: string;
  durationMs: number;
  workedMs: number;
}

export interface History { session: UnifiedSession | null; turns: UnifiedTurn[] }

export interface Model {
  id: string;
  name: string;
  description?: string;
  hint?: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  [extra: string]: unknown;
}
/** `stale`: the controls of the desktop app that its accessibility profile no longer finds by their marks (DesktopAutomation#staleControls): sending still works where their names do. */
export interface EngineStatus { connected: boolean; error?: string; stale?: string[]; [extra: string]: unknown }
export interface Project { id: string; name: string; cwd: string; space?: string }

export interface UsageWindow { id: string; label?: string; windowMinutes?: number | null; remainingPercent?: number | null; usedPercent?: number | null; resetsAt?: number | null }
export interface Usage { available: boolean; windows?: UsageWindow[]; short?: string; reason?: string; plan?: string | null; [extra: string]: unknown }

// ---------------------------------------------------------------------------------------------
// What the console hands an engine
// ---------------------------------------------------------------------------------------------

export interface Attachment { filename?: string; path: string; originalname: string; mimetype: string; url?: string }
export interface SendInput {
  prompt: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  title?: string;
  space?: string;
  projectId?: string;
  attachments: Attachment[];
}
export interface CreateInput extends Partial<SendInput> {
  /**
   * What the console showed as chosen on the desktop's new-chat page when the first message was
   * written (capabilities.newOptions). The engine checks the page still shows it, and picks it
   * there if not, before the message goes out; when it cannot, nothing is created.
   */
  expect?: NewPick[];
}
export interface CreateResult { id: string; cwd?: string; started?: boolean; [extra: string]: unknown }
export interface FileTarget { path: string; absolute: string; relative: string; label: string }

/** A control on the desktop's New page (a menu or a toggle), read live. */
/** A wrap-up card as the record has it: its own words to find it by on the desktop, and its reply buttons (which are not the desktop's). */
export interface WrapUpCard { ask: string; recap: string; replies: string[] }
/** What the desktop drew on that card for its own actions, in order: their names as the desktop shows them. */
export interface CardRead { actions: string[] }
/** One of those buttons: by its place among them (index), with the name it was read under. */
export interface CardAction extends WrapUpCard { index: number; label: string }
export interface NewOption { label: string; section?: string; selected?: boolean }
export interface NewControl { kind: 'menu' | 'toggle'; label: string; value: string; options?: NewOption[] }
export interface NewPick { control: string; option: string }
export interface NewOptionsResult { controls: NewControl[]; settings?: DesktopSettings; picked?: string[] }

export interface DictationHandlers { language: string; onText(text: string): void; onError(message: string): void; onEnd(): void }
export interface DictationStream { send(pcm: Uint8Array): void; finish(): void; cancel(): void }
/** Whether an engine's speech-to-text can start now (a cheap check, no audio); `reason` is shown to the person when not. */
export interface DictationReady { ready: boolean; reason?: string }
/** One speech-to-text the microphone can use: an agent's own service. */
export interface DictationSource { engine: EngineId; label: string; ready: boolean; reason?: string }
/** The speech services the console has now, and its default (BRIDGE_DICTATION_ENGINE). */
export interface DictationInfo { preferred: EngineId; sources: DictationSource[] }
/** A service that could not start, and why: the one after it was tried. */
export interface DictationSkip { engine: EngineId; label: string; reason: string }
/** POST /api/dictation/:engine: the session, the service that took it, and the ones passed over. */
export interface DictationStart { id: string; engine: EngineId; label: string; skipped: DictationSkip[] }

// ---------------------------------------------------------------------------------------------
// Engine events (plugin-contract.md §5): what send() / observe() emit
// ---------------------------------------------------------------------------------------------

/** An item the engine reports whole (Codex app-server items, a finished assistant message). */
export interface EngineItem {
  type: string;
  id: string;
  text?: unknown;
  content?: unknown;
  phase?: string;
  status?: string;
  [field: string]: unknown;
}
export type EngineDelta =
  | { type: 'agent_message'; id?: string; itemId?: string; text?: string; phase?: string }
  | { type: 'tool_call'; id?: string; itemId?: string; name: string; input?: unknown; plan?: unknown }
  | { type: 'tool_result'; id?: string; itemId?: string; output?: unknown; isError?: boolean; images?: unknown }
  | { type: 'command_output'; id?: string; itemId?: string; output?: string }
  | { type: 'reasoning'; id?: string; itemId?: string }
  | { type: 'file_patch'; id?: string; itemId?: string };
export interface ApprovalRequest { id: string; title?: string; detail?: string; decisions?: Array<string | { id: string; label: string }> }
export interface EngineWarning { message?: string; retrying?: boolean; awaitingEnd?: boolean }
export interface EngineCompleted { reply?: string; code?: number; turn?: { status?: string; error?: { message?: string } } }

/** Event name → listener arguments, for every event an engine emitter carries. */
export interface EngineEventMap {
  item_started: [{ item: EngineItem }];
  item_completed: [{ item: EngineItem }];
  delta: [EngineDelta];
  artifact: [Artifact];
  approval: [ApprovalRequest];
  approval_resolved: [{ id: string }];
  warning: [EngineWarning];
  completed: [EngineCompleted];
  error: [EngineError];
  /** Asked of the emitter by the console (stop, or a failed run): the engine stops what it does. */
  interrupt: [];
}
export type EngineEventName = keyof EngineEventMap;

/** The emitter send() returns synchronously (it emits only after a microtask). */
export interface EngineEmitter {
  on<K extends EngineEventName>(event: K, listener: (...args: EngineEventMap[K]) => void): unknown;
  off<K extends EngineEventName>(event: K, listener: (...args: EngineEventMap[K]) => void): unknown;
  emit<K extends EngineEventName>(event: K, ...args: EngineEventMap[K]): boolean;
  listenerCount(event: EngineEventName): number;
  /** The native turn id, when known: lets the console match the turn after a reconnect. */
  turnId?: string | null;
}

// ---------------------------------------------------------------------------------------------
// The engine (plugin-contract.md §1, §2, §6)
// ---------------------------------------------------------------------------------------------

type Awaitable<T> = T | Promise<T>;

export interface EngineMethods {
  status(): Awaitable<EngineStatus>;
  models(): Awaitable<Model[]>;
  list(): Awaitable<UnifiedSession[]>;
  read(id: string): Awaitable<History>;
  create(input: CreateInput): Awaitable<CreateResult>;
  send(id: string, input: SendInput): EngineEmitter;

  interrupt?(id: string, emitter?: EngineEmitter | null): Awaitable<{ pending?: boolean } | void | unknown>;
  steer?(id: string, input: SendInput, emitter?: EngineEmitter | null): Awaitable<{ shown?: boolean } | void | unknown>;
  sendNow?(id: string): Awaitable<{ status: string }>;
  decide?(approvalId: string, decision: string): Awaitable<unknown>;
  observe?(id: string, input?: CreateInput | SendInput): EngineEmitter;
  usage?(): Awaitable<Usage>;
  dictate?(options: DictationHandlers): Awaitable<DictationStream>;
  /** Whether dictate() can start now (signed in, the app running…); without it, dictate() is simply tried. */
  dictationReady?(): Awaitable<DictationReady>;
  media?(sessionId: string, key: string): Awaitable<MediaFile | null | undefined>;
  blocked?(id: string | null): Awaitable<string | undefined>;
  projects?(): Awaitable<Project[]>;
  openFile?(id: string, file: FileTarget): Awaitable<{ pressed?: boolean } | void | unknown>;
  /** Shows this chat in the desktop app and brings the app to the front (capabilities.showInDesktop). */
  show?(id: string): Awaitable<unknown>;
  fileRoots?(id: string): Awaitable<string[]>;
  /** Read the desktop's own buttons on this session's wrap-up card (capabilities.cardActions). */
  readCard?(id: string, card: WrapUpCard): Awaitable<CardRead>;
  /** Press one of them, by its place among them (capabilities.cardActions). */
  pressAction?(id: string, action: CardAction): Awaitable<{ pressed?: boolean } | void>;
  /** `read`: the menus whose options are wanted; `fresh`: read the desktop again instead of answering from what was read before. */
  newOptions?(options: { read: string[]; fresh?: boolean }): Awaitable<NewOptionsResult>;
  /** The console is in use: keep the desktop ready for what it may ask next (optional; must return at once). */
  keepWarm?(): void;
  pickNewOption?(control: string, option: string): Awaitable<NewOptionsResult>;
  pickNewOptions?(picks: NewPick[]): Awaitable<NewOptionsResult>;
  newSettings?(): Awaitable<{ settings?: DesktopSettings }>;
}

export interface EngineDeclaration {
  id: EngineId;
  label: string;
  description?: string;
  /** The dock's order (Codex 10, Claude 20, Antigravity 30). */
  priority?: number;
  /** The dock's two-letter prefix; defaults to the label's first two letters. */
  prefix?: string;
  iconUrl?: string;
  /** Brand colour, #rrggbb. */
  accent?: string;
  /** A character, or a function that reads it when the manifest is asked for. */
  character?: Character | null | (() => Character | null);
  permissionModes?: PermissionMode[];
  skin?: Skin;
  look?: Look;
  spaces?: Space[];
  capabilities: Capabilities;
  /** Page modules the page imports, each exporting setup({ registerRenderer, engine, helpers }). */
  uiModules?: string[];
}

/** What registerEngine takes: the declaration and the methods. */
export interface Engine extends EngineDeclaration, EngineMethods {}

/** The server's configuration (lib config): what a plugin's setup receives as `config`. */
export interface BridgeConfig {
  host: string;
  port: number;
  httpsPort: number;
  certDir: string;
  uploadsDir: string;
  pluginDir: string;
  defaultCwd: string;
  codexBin: string | null;
  claudeBin: string | null;
  codexHome: string;
  claudeHome: string;
  chatgptAppAsar: string;
  claudeDesktopHome: string;
  claudeAppAsar: string;
  dictationEngine: string;
  /** Where the console keeps what the person chose for it (which agents are switched on). */
  settingsFile: string;
  agyHome: string;
  agentapiBin: string | null;
  /** The ZCode template (plugins/zcode.plugin.ts) reads these; the phase-2 bridge will too. */
  zcodeAppAsar?: string;
  zcodeHome?: string;
  catalogs: Record<string, Model[]>;
}

export interface PluginContext {
  config: Partial<BridgeConfig>;
  registerEngine(engine: Engine): () => void;
  registerAsset(name: string, read: () => AssetFile | null | undefined | false): void;
}
/** A plugin module (`<id>.plugin.ts`) exports `setup`, and `about` beside it. */
export type PluginSetup = (context: PluginContext) => Awaitable<Dispose | void>;

/** Whether a plugin's desktop app is on this machine, as far as it can tell without starting anything. */
export interface PluginPresence { installed: boolean; /** Where it was found (a path), for the person to read. */ where?: string }
/**
 * What a plugin says about itself before it is set up (`export const about`): the agent as the
 * console lists it while it is switched off. Switching it on runs `setup`; switching it off
 * removes what `setup` registered and calls the function it returned.
 */
export interface PluginAbout {
  /** The plugin's id: the id of the engine it registers. */
  id: EngineId;
  label: string;
  description?: string;
  /** Its place in the list, as the engine's (Codex 10, Claude 20, Antigravity 30). */
  priority?: number;
  iconUrl?: string;
  /**
   * The installed app's own icon file (.icns), or a function that finds it. The host serves it at
   * /api/characters/<id>-icon, on or off, and it is the agent's and its engine's `iconUrl` while
   * the file is there. Read from the person's copy of the app; never copied into the project.
   */
  appIcon?: string | ((config: Partial<BridgeConfig>) => string);
  /** Brand colour, #rrggbb. */
  accent?: string;
  /** A face that needs nothing from `setup` (a file the page already serves). */
  character?: Character;
  /**
   * Looks for the desktop app on this machine. Until the person chooses, an agent is on when its
   * app is found and off when it is not. Reads no private data and starts nothing; a plugin
   * without it counts as found.
   */
  detect?(config: Partial<BridgeConfig>): Awaitable<PluginPresence>;
}

// ---------------------------------------------------------------------------------------------
// What the page receives (REST and SSE)
// ---------------------------------------------------------------------------------------------

/** One engine as the page sees it (GET /api/engines). */
export interface EngineManifest {
  id: EngineId;
  label: string;
  description?: string;
  prefix: string;
  iconUrl?: string;
  spaces: Space[];
  permissionModes: PermissionMode[];
  accent: string | null;
  character: Character | null;
  /** The plugin's own name, when the person gave the agent another one. */
  defaultLabel?: string;
  custom?: AgentCustom;
  skin: Skin | null;
  look: Look;
  capabilities: Capabilities;
  uiModules: string[];
}
/** An agent the console can connect (a plugin), switched on or off (GET /api/engines `agents`). */
export interface AgentEntry {
  id: EngineId;
  label: string;
  description?: string;
  iconUrl?: string;
  accent: string | null;
  character: Character | null;
  /** The plugin's own name, when the person gave the agent another one. */
  defaultLabel?: string;
  custom?: AgentCustom;
  enabled: boolean;
  /** Whether its desktop app was found on this machine; null when the plugin cannot tell. */
  installed: boolean | null;
  where?: string;
  /** Why it could not be switched on, when that failed. */
  error?: string;
}
/** What switching an agent off would drop: turns the console follows, and messages waiting to go out. */
export interface AgentBusy { running: number; queued: number }
export interface EnginesResponse {
  /** The agents switched on, in the rail's order. */
  engines: EngineManifest[];
  /** Every agent the console knows, on or off. */
  agents: AgentEntry[];
  defaultCwd: string;
  projectDir: string;
  httpsPort: number | null;
  fileManager: string;
  dictation: DictationInfo;
}

/** A tool step as the page draws it. */
export interface Activity {
  id: string;
  kind: string;
  title: string;
  status: StepStatus | string;
  detail: string;
  output: string;
  durationMs: number;
  paths: string[];
  plan?: PlanItem[];
  images?: MediaImage[];
  changes?: FileChange[];
  /** The address a 'preview' activity opened, as its result names it: drawn as a card the person can open. */
  url?: string;
}
export interface PresentedArtifact { id: string; kind: string; title: string; path: string; url: string; summary: string }
// A card asking the person for something. The decision 'desktop' is no answer: its button takes
// the person to the chat in the desktop app (capabilities.showInDesktop), for what can only be
// done there (a dialog the desktop shows, a form of questions).
export interface Approval { id: string; title: string; detail: string; decisions: Array<string | { id: string; label: string }> }
export interface PresentedMessage { id: string; text: string; phase?: string; status?: 'streaming' | 'completed'; at?: TimeValue }

export interface PresentedTurn {
  id: string;
  userPrompt: string;
  userImages: MediaImage[];
  timestamp: string | null;
  durationMs: number;
  workedMs: number;
  status: TurnStatus | string;
  statusEvidence: string | null;
  completedAt: string | null;
  timeline: TimelineEntry[];
  messages: PresentedMessage[];
  activities: Activity[];
  artifacts: PresentedArtifact[];
  approvals?: Approval[];
}

/** A turn the console runs (RunService), as the page restores it. */
export interface RunTurn {
  id: string;
  /** Absent for a turn the console only observes (started by create). */
  userPrompt?: string;
  /** The pictures the desktop recorded with the message, once its record of the turn is read. */
  userImages?: MediaImage[];
  timestamp: string;
  status: 'running' | 'reconnecting' | 'completed' | 'failed' | 'interrupted' | string;
  statusEvidence?: string;
  completedAt?: number;
  nativeTurnId?: string;
  warning?: string;
  messages: PresentedMessage[];
  activities: Activity[];
  artifacts: PresentedArtifact[];
  approvals: Approval[];
  timeline: TimelineEntry[];
}
/** A file or folder the side panel shows (POST …/file): its text, an image as a data URL, or a folder's entries. */
export interface FilePreview { path: string; size: number; text?: string; image?: string; entries?: Array<{ name: string; dir: boolean }>; truncated?: boolean }
export interface QueuedMessage { id: string; prompt: string; attachments: number; at: string }

export interface SessionHistoryResponse {
  session: UnifiedSession | null;
  turns: PresentedTurn[];
  activeTurn: RunTurn | null;
  queued: QueuedMessage[];
  cursor: string;
}

/** The public events of one conversation (SSE `bridge` events). */
export interface BridgeEventMap {
  'run.started': { turn: RunTurn };
  'message.updated': PresentedMessage;
  'activity.upsert': Activity;
  'artifact.upsert': PresentedArtifact;
  'approval.requested': Approval;
  'approval.resolved': { id: string };
  'run.warning': { message: string; retrying: boolean; awaitingEnd: boolean };
  'run.connection_lost': { message: string };
  'run.completed': Record<string, never>;
  'run.failed': { message?: string };
  'run.interrupted': Record<string, never>;
  'session.snapshot': { session?: UnifiedSession | null; turns: PresentedTurn[]; [extra: string]: unknown };
  'queue.updated': { items: QueuedMessage[] };
  'assistant.notice': { id: string; preview: string; phase?: string; at?: TimeValue };
  /** What the desktop holds for the running turn (its own queue), as read from its record. */
  'desktop.queue': { items: unknown[] };
}
export type BridgeEventType = keyof BridgeEventMap;
/** An event's type and data as a pair, one member per type: `emit(...args)` checks the data against the type. */
export type BridgeEventArgs = { [K in BridgeEventType]: [type: K, data: BridgeEventMap[K]] }[BridgeEventType];
export interface BridgeEventOf<K extends BridgeEventType> { id: string; seq: number; engine: EngineId; sessionId: string; turnId: string | null; type: K; data: BridgeEventMap[K]; timestamp: string }
/** One event, narrowed by its `type` (what the page switches on). */
export type BridgeEvent = { [K in BridgeEventType]: BridgeEventOf<K> }[BridgeEventType];
/** Any event, its data not tied to its type (what the server's journal stores). */
export type AnyBridgeEvent = BridgeEventOf<BridgeEventType>;

/** The dock's activity stream (GET /api/activity, /api/activity/events). */
export interface ActivityEntry {
  engine: EngineId;
  sessionId: string;
  turnId?: string | null;
  title?: string;
  running: boolean;
  outcome?: string | null;
  startedAt?: number;
  completedAt?: number;
  lastMessageAt?: number;
  confirmedTerminal?: boolean;
  nativeRevision?: string;
  nativeTerminalToken?: string | null;
}
export interface ActivityNotice { id: string; messageId: string; engine: EngineId; sessionId: string; preview: string; phase: string; at: number }
export interface ActivitySnapshot { sessions: ActivityEntry[]; notices: ActivityNotice[]; timestamp: number }
