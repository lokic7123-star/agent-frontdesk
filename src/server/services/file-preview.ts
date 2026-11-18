// Read-only preview of a file (or folder) an agent mentions in its reply. Only files inside the session's own
// working directory can be read; secrets and repository internals are refused; large and binary
// files are not sent. Nothing is ever written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FilePreview } from '../../shared/contract.js';
export type { FilePreview };

const SECRET = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/i;
const INTERNAL = /(^|\/)\.git(\/|$)/;
const IMAGES: Partial<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_LIMIT = 512 * 1024, IMAGE_LIMIT = 6 * 1024 * 1024, DIR_LIMIT = 500;
const isDir = (file: string): boolean => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };

const refuse = (status: number, message: string) => Object.assign(new Error(message), { status });

// A file a reply names, as { file (absolute, real), relative } inside the session's working
// directory, or inside a folder the engine keeps for that chat (`roots`, e.g. Antigravity's
// brain/<id>, where its documents are); anything outside them is refused. A relative path is read
// from the working directory (or the first such folder when there is none). Shared by the preview
// and by "show in Finder / in the desktop". `relative` is relative to the folder it was found in.
function resolveFile(cwd: string, requested: unknown, roots: string[] = []): { file: string; relative: string } {
  const bases = [cwd, ...roots].filter(Boolean);
  if (!bases.length) throw refuse(404, '这个会话没有记录工作目录，无法预览文件');
  const raw = String(requested || '').trim().replace(/:(\d+)(:\d+)?$/, '');
  let asked = raw;
  if (/^file:\/\//i.test(raw)) {
    try { asked = fileURLToPath(raw); }
    catch {
      const stripped = raw.replace(/^file:\/\/\/?(?=[a-zA-Z]:[\\/])|^file:\/\//i, '');
      try { asked = decodeURIComponent(stripped); } catch { asked = stripped; }
    }
  }
  // `~/…` is the home folder, as the agent's shell reads it (HOME first: Git Bash and the like
  // set it even where os.homedir() would look elsewhere, e.g. USERPROFILE on Windows).
  const named = /^~([\\/]|$)/.test(asked) ? path.join(process.env.HOME || os.homedir(), asked.slice(1)) : asked;
  if (!asked || asked.length > 1024 || asked.includes('\0')) throw refuse(400, '文件路径无效');
  const real = (base: string): string | null => { try { return fs.realpathSync(base); } catch { return null; } };
  const reals = bases.map(real).filter((base): base is string => !!base);
  if (!reals.length) throw refuse(404, '会话的工作目录已经不存在');
  let file: string;
  try { file = fs.realpathSync(path.isAbsolute(named) ? named : path.join(reals[0] ?? '', named)); } catch { throw refuse(404, '找不到这个文件'); }
  for (const root of reals) {
    const relative = path.relative(root, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return { file, relative: relative.replace(/\\/g, '/') };
  }
  throw refuse(403, '只能预览这个会话工作目录里的文件');
}

function previewFile(cwd: string, requested: unknown, roots: string[] = []): FilePreview {
  const { file, relative } = resolveFile(cwd, requested, roots);
  if (SECRET.test(relative) || INTERNAL.test(relative)) throw refuse(403, '这个文件可能包含密钥或仓库内部数据，不提供预览');
  const stat = fs.statSync(file);
  // A folder the reply links to: what is in it (names only), folders first, hidden entries left out.
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(file, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, dir: entry.isDirectory() || (entry.isSymbolicLink() && isDir(path.join(file, entry.name))) }))
      .sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
    return { path: `${relative}/`, size: entries.length, entries: entries.slice(0, DIR_LIMIT), truncated: entries.length > DIR_LIMIT };
  }
  if (!stat.isFile()) throw refuse(400, '这不是一个文件');
  const type = IMAGES[path.extname(file).toLowerCase()];
  if (type) {
    if (stat.size > IMAGE_LIMIT) throw refuse(413, '图片太大，不提供预览');
    return { path: relative, size: stat.size, image: `data:${type};base64,${fs.readFileSync(file).toString('base64')}` };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (buffer.includes(0)) throw refuse(415, '这是二进制文件，不提供预览');
    return { path: relative, size: stat.size, text: buffer.toString('utf8'), truncated: stat.size > TEXT_LIMIT };
  } finally { fs.closeSync(fd); }
}

export { previewFile, resolveFile };
