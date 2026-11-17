import type { AssetFile } from '../../shared/contract.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginPresence } from '../../shared/contract.js';
import { bag, get, parseJson } from '../../shared/guards.js';

// Reads one file out of an installed Electron app's app.asar without extracting it,
// so a desktop app's own artwork is shown from the user's copy and never vendored here.
interface AsarEntry { path: string; size: number; offset: number }
interface AsarIndex { mtimeMs: number; base: number; files: AsarEntry[] }
const headers = new Map<string, AsarIndex>();
function asarIndex(archive: string): AsarIndex {
  const stat = fs.statSync(archive), cached = headers.get(archive);
  if (cached?.mtimeMs === stat.mtimeMs) return cached;
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const size = prefix.readUInt32LE(12), base = 8 + prefix.readUInt32LE(4);
    const header = Buffer.alloc(size); fs.readSync(fd, header, 0, size, 16);
    const files: AsarEntry[] = [];
    // The archive's header is JSON of nested { files: { <name>: entry } }; an entry with `files` is a folder.
    const walk = (node: unknown, at: string): void => { for (const [name, entry] of Object.entries(bag(get(node, 'files')) || {})) { if (get(entry, 'files')) walk(entry, `${at}/${name}`); else files.push({ path: `${at}/${name}`, size: Number(get(entry, 'size')), offset: Number(get(entry, 'offset')) }); } };
    walk(parseJson(header.toString('utf8')), '');
    const index = { mtimeMs: stat.mtimeMs, base, files };
    headers.set(archive, index);
    return index;
  } finally { fs.closeSync(fd); }
}
function readAsarFile(archive: string, pattern: RegExp): { path: string; data: Buffer } | null {
  const index = asarIndex(archive);
  const entry = index.files.find(file => pattern.test(file.path) && Number.isFinite(file.offset));
  if (!entry) return null;
  const fd = fs.openSync(archive, 'r');
  try { const data = Buffer.alloc(entry.size); fs.readSync(fd, data, 0, entry.size, index.base + entry.offset); return { path: entry.path, data }; }
  finally { fs.closeSync(fd); }
}
// For a plugin's `detect` (is its desktop app on this machine?). Nothing is opened or started.
/** Where the app an app.asar belongs to may be installed: its bundle ("/Applications/X.app"), and the same bundle in the person's own Applications folder. */
function appPlaces(asar: string): string[] {
  if (process.platform === 'win32') {
    // Windows Electron layout (<AppDir>\resources\app.asar): the app is its install folder.
    const at = asar.toLowerCase().lastIndexOf(`${path.sep}resources${path.sep}`);
    const app = at < 0 ? asar : asar.slice(0, at);
    return [app];
  }
  const at = asar.indexOf('.app/'), app = at < 0 ? asar : asar.slice(0, at + 4);
  return [app, path.join(os.homedir(), 'Applications', path.basename(app))];
}
/** The first of these paths that exists, as a plugin's `detect` answers. */
function firstExisting(paths: Array<string | undefined>): PluginPresence {
  const where = paths.find(item => !!item && fs.existsSync(item));
  return where ? { installed: true, where } : { installed: false };
}
// An installed app's own icon, from where the platform keeps it: an .icns file (macOS; a list
// of pictures, each a 4-letter type and a length, the modern ones whole PNG files — the one
// nearest `size` pixels wide is returned), a plain .png, or the /icon.png inside an Electron
// app.asar (Windows). Null when the app isn't there or the file is neither.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
function readAppIcon(file: string, size = 256): AssetFile | null {
  if (file.toLowerCase().endsWith('.asar')) {
    try { const found = readAsarFile(file, /\/icon\.png$/); return found && found.data.length >= 4 && found.data.subarray(0, 4).equals(PNG_MAGIC) ? { type: 'image/png', data: found.data } : null; } catch { return null; }
  }
  let data: Buffer;
  try { data = fs.readFileSync(file); } catch { return null; }
  if (data.length >= 8 && data.subarray(0, 4).equals(PNG_MAGIC)) return { type: 'image/png', data };
  if (data.length < 8 || data.toString('latin1', 0, 4) !== 'icns') return null;
  let best: { width: number; png: Buffer } | null = null;
  for (let at = 8; at + 8 <= data.length;) {
    const length = data.readUInt32BE(at + 4);
    if (length < 8 || at + length > data.length) break;
    const body = data.subarray(at + 8, at + length);
    // A PNG's width is the first field of its first chunk (IHDR), at byte 16.
    if (body.length > 24 && body.subarray(0, 4).equals(PNG_MAGIC)) {
      const width = body.readUInt32BE(16);
      if (!best || Math.abs(width - size) < Math.abs(best.width - size)) best = { width, png: body };
    }
    at += length;
  }
  return best ? { type: 'image/png', data: best.png } : null;
}
export { readAsarFile, readAppIcon, appPlaces, firstExisting };
