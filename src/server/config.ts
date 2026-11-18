import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, HERE } from './paths.js';
import type { BridgeConfig, Model } from '../shared/contract.js';
import { bag, list, get, str, parseJson } from '../shared/guards.js';

function executable(env: string, candidates: string[]): string | null {
  if (process.env[env]) return process.env[env];
  const paths = candidates.flatMap(candidate => path.isAbsolute(candidate) ? [candidate] :
    (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, candidate)));
  return paths.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}
function findClaude(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 5) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file, depth + 1);
      else if (item.name === 'claude' || item.name === 'claude.exe') found.push(file);
    }
  }
  walk(root, 0);
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
// The optional model catalog file: { <engine>: [{ id, name, … }] }; entries without an id are skipped.
function catalogsOf(value: unknown): Record<string, Model[]> {
  const out: Record<string, Model[]> = {};
  for (const [engine, models] of Object.entries(bag(value) || {})) {
    out[engine] = list(models).flatMap(item => { const id = str(get(item, 'id')); return id ? [{ ...bag(item), id, name: str(get(item, 'name')) || id }] : []; });
  }
  return out;
}
function winCodexApp(localAppData: string): string {
  try {
    return path.dirname(fs.readlinkSync(path.join(localAppData, 'Microsoft', 'WindowsApps', 'chatgpt-desktop.exe')));
  } catch { return ''; }
}
const firstHere = (candidates: string[]): string => candidates.find(file => fs.existsSync(file)) || candidates[0] || '';
function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const home = os.homedir();
  const agyHome = env.ANTIGRAVITY_HOME || path.join(home, '.gemini/antigravity');
  // Where Windows keeps per-user app installs and roaming app data; nothing on macOS/Linux.
  const win = process.platform === 'win32';
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const localPrograms = path.join(localAppData, 'Programs');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const msixCodex = win ? winCodexApp(localAppData) : '';
  let catalogs: Record<string, Model[]> = {};
  if (env.BRIDGE_MODEL_CATALOG) catalogs = catalogsOf(parseJson(fs.readFileSync(env.BRIDGE_MODEL_CATALOG, 'utf8')));
  return {
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 4100),
    // HTTPS (for the microphone on other devices) is on by default when the console
    // listens beyond loopback; HTTPS_PORT=0 turns it off.
    httpsPort: env.HTTPS_PORT != null ? Number(env.HTTPS_PORT) : ['127.0.0.1', 'localhost', '::1'].includes(env.HOST || '127.0.0.1') ? 0 : Number(env.PORT || 4100) + 1,
    certDir: env.BRIDGE_CERT_DIR || path.join(ROOT, '.certs'),
    uploadsDir: env.BRIDGE_UPLOADS_DIR || path.join(ROOT, 'uploads'),
    pluginDir: env.BRIDGE_PLUGIN_DIR || path.join(HERE, 'plugins'),
    defaultCwd: env.BRIDGE_DEFAULT_CWD || home,
    codexBin: executable('CODEX_BIN', win
      ? [...(msixCodex ? [path.join(msixCodex, 'resources', 'codex.exe')] : []), 'codex.exe', 'codex.cmd', 'codex.bat', 'codex', path.join(localPrograms, 'ChatGPT', 'resources', 'codex-cli', 'bin', 'codex.exe')]
      : ['codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex']),
    claudeBin: executable('CLAUDE_BIN', win
      ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude', path.join(home, '.local', 'bin', 'claude.exe'), ...findClaude(path.join(appData, 'Claude', 'claude-code'))]
      : ['claude', ...findClaude(path.join(home, 'Library/Application Support/Claude/claude-code'))]),
    codexHome: env.CODEX_HOME || path.join(home, '.codex'),
    claudeHome: env.CLAUDE_HOME || path.join(home, '.claude'),
    chatgptAppAsar: env.CHATGPT_APP_ASAR || (win ? firstHere([path.join(localPrograms, 'ChatGPT', 'resources', 'app.asar'), ...(msixCodex ? [path.join(msixCodex, 'resources', 'app.asar')] : [])]) : '/Applications/ChatGPT.app/Contents/Resources/app.asar'),
    claudeDesktopHome: env.CLAUDE_DESKTOP_HOME || (win ? path.join(appData, 'Claude') : path.join(home, 'Library/Application Support/Claude')),
    claudeAppAsar: env.CLAUDE_APP_ASAR || (win ? path.join(localPrograms, 'Claude', 'resources', 'app.asar') : '/Applications/Claude.app/Contents/Resources/app.asar'),
    // Speech-to-text used by every engine's mic button; falls back to the engine's own.
    dictationEngine: env.BRIDGE_DICTATION_ENGINE || 'claude',
    // What the person chose in the console (which agents are on). Local to this checkout, not committed.
    settingsFile: env.BRIDGE_SETTINGS_FILE || path.join(ROOT, '.frontdesk.json'),
    agyHome, agentapiBin: executable('AGENTAPI_BIN', win
      // The Windows install ships bin/agentapi.bat (verified on this machine).
      ? [path.join(agyHome, 'bin', 'agentapi.exe'), path.join(agyHome, 'bin', 'agentapi.bat'), 'agentapi.exe', 'agentapi.cmd', 'agentapi.bat', 'agentapi']
      : [path.join(agyHome, 'bin/agentapi'), 'agentapi']),
    // The ZCode template's own places; the phase-2 bridge reads them too.
    zcodeAppAsar: env.ZCODE_APP_ASAR || (win ? firstHere([path.join(localPrograms, 'Zcode', 'resources', 'app.asar')]) : undefined),
    zcodeHome: env.ZCODE_HOME || path.join(home, '.zcode'),
    catalogs,
  };
}
/** Invokes a Windows `.cmd`/`.bat` shim through `cmd.exe /d /s /c` with explicit quoting so Node 24 never warns on `shell: true`. */
function winSpawnArgs<T extends object = Record<string, unknown>>(
  file: string,
  args: readonly string[] = [],
  options: T = {} as T,
): [string, string[], T & { windowsVerbatimArguments?: boolean; windowsHide?: boolean }] {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const q = (s: string) => `"${String(s).replace(/\r?\n/g, ' ').replace(/"/g, '""').replace(/%/g, '%%')}"`;
    const line = [q(file), ...args.map(q)].join(' ');
    return [
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `"${line}"`],
      { ...options, windowsVerbatimArguments: true, windowsHide: true },
    ];
  }
  return [file, [...args], options];
}
export { loadConfig, winSpawnArgs };
