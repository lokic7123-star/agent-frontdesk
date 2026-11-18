// Build a single-file Windows executable (Node SEA): the server and its npm dependencies are
// bundled into one CJS file with esbuild, then fused into a copy of node.exe. The exe still reads
// dist/public and src/server/native from disk, so it belongs in the project root (paths.ts finds
// the project by walking up from itself to package.json). Run: npm run build:exe
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'exe');
const BUNDLE = path.join(OUT, 'server-bundle.cjs');
const CONFIG = path.join(OUT, 'sea-config.json');
const BLOB = path.join(OUT, 'sea-prep.blob');
const EXE = path.join(ROOT, 'Agent Frontdesk.exe');
const NODE = process.execPath;

fs.mkdirSync(OUT, { recursive: true });
console.log('[1/4] esbuild: bundling the server (dist/exe/server-bundle.cjs)…');
// CJS output has no import.meta; the sources use import.meta.url to find the project root
// (paths.ts) and to detect "run as main" (server.ts). Give them the real file URL of the bundle.
execFileSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.join(ROOT, 'src', 'server', 'server.ts'),
  '--bundle', '--platform=node', '--format=cjs', '--target=node24',
  '--banner:js=const __sea_file_url = require("node:url").pathToFileURL(__filename).href;',
  '--define:import.meta.url=__sea_file_url',
  '--outfile=' + BUNDLE, '--log-level=warning', '--legal-comments=none',
], { stdio: 'inherit', cwd: ROOT });

console.log('[2/4] node --experimental-sea-config: writing the SEA blob…');
fs.writeFileSync(CONFIG, JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true }));
execFileSync(NODE, ['--experimental-sea-config', CONFIG], { stdio: 'inherit', cwd: ROOT });

console.log('[3/4] copying node.exe and injecting the blob (postject)…');
fs.copyFileSync(NODE, EXE);
// (The exe's file icon stays node's own; the desktop shortcut's icon is owned by
// scripts/export-icons.mjs, which also refreshes the shell's icon cache.)
const postjectArgs = [EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
execFileSync(NODE, [path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'), ...postjectArgs], { stdio: 'inherit', cwd: ROOT });

const size = fs.statSync(EXE).size;
console.log(`[4/4] done: ${EXE} (${(size / 1048576).toFixed(1)} MB). Keep it in the project root.`);
