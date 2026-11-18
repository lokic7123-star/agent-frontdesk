import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentEntry, AssetFile, BridgeConfig, CapabilityFlags, Character, Dispose, Engine, EngineManifest, PermissionMode, PluginAbout, PluginSetup, Space } from '../../shared/contract.js';
import { bag, get, list, messageOf, str } from '../../shared/guards.js';
import { readAppIcon } from '../services/app-assets.js';

// The desktop's own modes (Claude: "Claude" / "Code"; Codex: "ChatGPT" / "Codex"), in its own
// order and words. One space at most is the default (where sessions without `space` live); a
// space the console cannot read yet carries the reason (`unavailable`), one it lists but cannot
// start a chat in, that reason (`noNew`). One space or none: [].
// What a mode narrows of the engine's capabilities (flags only: { models: false, … }).
const capabilitiesOf = (value: unknown): { capabilities?: CapabilityFlags } => { const flags = Object.entries(bag(value) || {}).filter((entry): entry is [string, boolean] => /^[a-zA-Z]{1,32}$/.test(entry[0]) && typeof entry[1] === 'boolean'); return flags.length ? { capabilities: Object.fromEntries(flags) } : {}; };
function spacesOf(input: unknown): Space[] {
  const seen = new Set<string>();
  const spaces = list(input).filter(item => /^[a-z][a-z0-9-]{0,31}$/.test(str(get(item, 'id')) || '') && get(item, 'label') && !seen.has(String(get(item, 'id'))) && seen.add(String(get(item, 'id'))))
    .map((item): Space => ({ id: String(get(item, 'id')), label: String(get(item, 'label')), default: !!get(item, 'default'), ...(get(item, 'unavailable') ? { unavailable: String(get(item, 'unavailable')) } : {}), ...(get(item, 'noNew') ? { noNew: String(get(item, 'noNew')) } : {}), ...capabilitiesOf(get(item, 'capabilities')) }));
  if (spaces.length < 2) return [];
  const home = spaces.findIndex(item => item.default);
  return spaces.map((item, index) => ({ ...item, default: index === (home < 0 ? 0 : home) }));
}
const isSetup = (value: unknown): value is PluginSetup => typeof value === 'function';
// A drawn stand-in yields to the installed app's real icon: while the app is on this machine the
// avatar is that app's own icon (iconUrl below), and the drawing returns once the app is gone.
const withAppIcon = (character: Character | null | undefined, iconUrl?: string): Character | null =>
  character?.kind === 'image' && character.standIn && iconUrl ? { ...character, url: iconUrl, standIn: false } : character || null;
const REQUIRED = ['status', 'models', 'list', 'read', 'create', 'send'] as const;
const ID = /^[a-z][a-z0-9-]*$/;
const accentOf = (accent: unknown): string | null => (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : null);
// What a plugin module says about itself (`export const about`). One written before `about`
// existed, or as plain JavaScript without it, is known by its file's name and counts as found.
function aboutOf(value: unknown, file: string): PluginAbout {
  const id = str(get(value, 'id')) || file.replace(/\.plugin\.[jt]s$/, ''), detect = get(value, 'detect');
  if (!ID.test(id)) throw new Error(`${file}: invalid plugin id`);
  const about: PluginAbout = { id, label: str(get(value, 'label')) || id };
  const description = str(get(value, 'description')), iconUrl = str(get(value, 'iconUrl')), accent = accentOf(get(value, 'accent')), priority = get(value, 'priority'), character = get(value, 'character');
  if (description) about.description = description;
  if (iconUrl) about.iconUrl = iconUrl;
  if (accent) about.accent = accent;
  if (typeof priority === 'number') about.priority = priority;
  if (isCharacter(character)) about.character = character;
  if (typeof detect === 'function') about.detect = config => detect.call(value, config);
  const appIcon = get(value, 'appIcon');
  if (typeof appIcon === 'string' && appIcon) about.appIcon = appIcon;
  else if (typeof appIcon === 'function') about.appIcon = config => str(appIcon.call(value, config)) || '';
  return about;
}
const isCharacter = (value: unknown): value is Character => (get(value, 'kind') === 'image' || get(value, 'kind') === 'sprite') && typeof get(value, 'url') === 'string';

export interface HostContext { config?: Partial<BridgeConfig> }
/** A plugin the host knows: off until it is set up, and what its setup registered while it is on. */
interface Slot { about: PluginAbout; setup: PluginSetup; enabled: boolean; engines: string[]; assets: string[]; dispose: Dispose | null; error: string; turn: Promise<unknown> }

// The composition root discovers extensions. The application never imports a provider.
// A plugin is known first (discover / add) and set up only when it is switched on (enable), so one
// whose desktop app is not on this machine costs nothing and reports nothing. Switching it off
// (disable) takes back everything its setup registered.
class PluginHost {
  context: HostContext;
  engines: Map<string, Engine>;
  plugins: Map<string, Slot>;
  assets: Map<string, () => AssetFile | null | undefined | false>;
  constructor(context: HostContext = {}) { this.context = context; this.engines = new Map(); this.plugins = new Map(); this.assets = new Map(); }
  register(engine: Engine): () => void {
    if (!ID.test(engine.id || '')) throw new Error('Invalid engine id');
    if (this.engines.has(engine.id)) throw new Error(`Duplicate engine: ${engine.id}`);
    // A plugin compiled from TypeScript cannot leave these out; one loaded as plain JavaScript can.
    for (const method of REQUIRED) {
      if (typeof engine[method] !== 'function') throw new Error(`${engine.id} is missing ${method}()`);
    }
    this.engines.set(engine.id, engine);
    return () => this.engines.delete(engine.id);
  }
  /** Makes a plugin known. It stays off until enable(). */
  add(about: PluginAbout, setup: PluginSetup): void {
    if (!ID.test(about.id || '')) throw new Error('Invalid plugin id');
    if (this.plugins.has(about.id)) throw new Error(`Duplicate plugin: ${about.id}`);
    this.plugins.set(about.id, { about, setup, enabled: false, engines: [], assets: [], dispose: null, error: '', turn: Promise.resolve() });
  }
  /** Reads the plugin files of a directory without setting any of them up. */
  async discover(directory: string): Promise<void> {
    // Compiled plugins end in .plugin.js; under tsx (npm run dev, tests) the sources end in .plugin.ts.
    for (const file of fs.readdirSync(directory).filter(file => /\.plugin\.[jt]s$/.test(file) && !file.endsWith('.d.ts')).sort()) {
      const plugin: unknown = await import(pathToFileURL(path.resolve(directory, file)).href);
      const setup = get(plugin, 'setup');
      if (!isSetup(setup)) throw new Error(`${file} does not export setup()`);
      this.add(aboutOf(get(plugin, 'about'), file), setup);
    }
  }
  /** Every plugin of a directory, set up (what the host did before plugins could be switched off). */
  async load(directory: string): Promise<void> {
    await this.discover(directory);
    for (const id of this.plugins.keys()) await this.enable(id);
  }
  /**
   * Switches on the plugins that should be on: the person's choice where they made one
   * (`chosen(id)`), otherwise whether the plugin finds its desktop app on this machine. One that
   * fails to set up stays off with its reason (catalog), and the others still start.
   */
  async start(chosen: (id: string) => boolean | undefined = () => undefined): Promise<void> {
    for (const [id, slot] of this.plugins) {
      if (slot.enabled) continue;
      const wanted = chosen(id) ?? (await this.presence(slot)).installed !== false;
      if (wanted) await this.enable(id).catch((err: unknown) => console.error(`Plugin ${id} could not be set up: ${messageOf(err)}`));
    }
  }
  private slot(id: string): Slot {
    const slot = this.plugins.get(id);
    if (!slot) throw Object.assign(new Error(`Unknown plugin: ${id}`), { status: 404 });
    return slot;
  }
  // One change at a time per plugin: a second click waits for the first to finish.
  private inTurn<T>(slot: Slot, work: () => Promise<T>): Promise<T> {
    const next = slot.turn.then(work, work);
    slot.turn = next.catch(() => {});
    return next;
  }
  /** Sets the plugin up. What it registered before failing is taken back, and the reason kept. */
  async enable(id: string): Promise<void> {
    const slot = this.slot(id);
    return this.inTurn(slot, async () => {
      if (slot.enabled) return;
      const engines: string[] = [], assets: string[] = [];
      try {
        const dispose = await slot.setup({ config: this.context.config || {},
          registerEngine: engine => { const remove = this.register(engine); engines.push(engine.id); return remove; },
          registerAsset: (name, read) => { this.assets.set(name, read); assets.push(name); } });
        Object.assign(slot, { enabled: true, engines, assets, dispose: typeof dispose === 'function' ? dispose : null, error: '' });
      } catch (err) {
        for (const engine of engines) this.engines.delete(engine);
        for (const name of assets) this.assets.delete(name);
        slot.error = messageOf(err) || 'setup failed';
        throw err;
      }
    });
  }
  /**
   * Takes the plugin's engines and assets away, then lets it release what it holds. `removed` is
   * called with the engine ids as soon as they are gone and before the plugin is disposed, for
   * whoever keeps something per engine (runs, observers, caches) to let go of it.
   */
  async disable(id: string, removed: (engines: string[]) => void = () => {}): Promise<void> {
    const slot = this.slot(id);
    return this.inTurn(slot, async () => {
      slot.error = '';
      if (!slot.enabled) return;
      const { engines, assets, dispose } = slot;
      for (const engine of engines) this.engines.delete(engine);
      for (const name of assets) this.assets.delete(name);
      Object.assign(slot, { enabled: false, engines: [], assets: [], dispose: null });
      try { removed(engines); } finally { try { await dispose?.(); } catch (err) { console.error(`Plugin ${id} did not release cleanly: ${messageOf(err)}`); } }
    });
  }
  /** The engines a plugin registered (none while it is off). */
  enginesOf(id: string): string[] { return [...this.slot(id).engines]; }
  private async presence(slot: Slot): Promise<{ installed: boolean | null; where?: string }> {
    if (!slot.about.detect) return { installed: null };
    try { const found = await slot.about.detect(this.context.config || {}), where = str(get(found, 'where')); return { installed: !!get(found, 'installed'), ...(where ? { where } : {}) }; }
    catch { return { installed: null }; }
  }
  // The installed app's own icon (`about.appIcon`), served at /api/characters/<id>-icon whether the
  // agent is on or off. It is the agent's and its engine's `iconUrl` while the file is there and
  // neither names another; without the app the page draws the two-letter prefix.
  private appIcon(id: string): string {
    const from = this.plugins.get(id)?.about.appIcon;
    try { return (typeof from === 'function' ? from(this.context.config || {}) : from) || ''; } catch { return ''; }
  }
  private iconUrl(id: string): string | undefined {
    const file = this.appIcon(id);
    return file && fs.existsSync(file) ? `/api/characters/${id}-icon` : undefined;
  }
  /** GET /api/characters/<name>: what a plugin registered under that name, or an agent's app icon. */
  asset(name: string): AssetFile | null {
    const icon = /^(.+)-icon$/.exec(name)?.[1];
    return this.assets.get(name)?.() || (icon && this.appIcon(icon) ? readAppIcon(this.appIcon(icon)) : null);
  }
  /** Every plugin as the page lists it, on or off, in the rail's order. */
  async catalog(): Promise<AgentEntry[]> {
    const slots = [...this.plugins.values()].sort((a, b) => (a.about.priority || 100) - (b.about.priority || 100));
    return Promise.all(slots.map(async (slot): Promise<AgentEntry> => {
      const { id, label, description, accent, character } = slot.about, iconUrl = slot.about.iconUrl || this.iconUrl(id);
      return { id, label, ...(description ? { description } : {}), ...(iconUrl ? { iconUrl } : {}), accent: accentOf(accent), character: withAppIcon(character, iconUrl), enabled: slot.enabled, ...await this.presence(slot), ...(slot.error ? { error: slot.error } : {}) };
    }));
  }
  get(id: string): Engine {
    const engine = this.engines.get(id);
    if (!engine) throw Object.assign(new Error(`Unknown engine: ${id}`), { status: 404 });
    return engine;
  }
  manifests(): EngineManifest[] {
    return [...this.engines.values()].sort((a, b) => (a.priority || 100) - (b.priority || 100)).map(({ id, label, description, prefix, iconUrl, accent, character, skin, look, permissionModes, spaces, capabilities, uiModules = [] }) => { const icon = iconUrl || this.iconUrl(id);
      return { id, label, description, prefix: prefix || label.slice(0, 2), iconUrl: icon, spaces: spacesOf(spaces),
      permissionModes: list(permissionModes).filter(mode => /^[A-Za-z]{1,32}$/.test(str(get(mode, 'id')) || '') && get(mode, 'label')).map((mode): PermissionMode => ({ id: String(get(mode, 'id')), label: String(get(mode, 'label')), description: String(get(mode, 'description') || '') })), accent: accentOf(accent), character: withAppIcon(typeof character === 'function' ? character() : character, icon), skin: skin || null, look: look && typeof look === 'object' ? look : {}, capabilities, uiModules }; });
  }
  async dispose(): Promise<void> { for (const id of [...this.plugins.keys()].reverse()) await this.disable(id); }
}
export { PluginHost };
