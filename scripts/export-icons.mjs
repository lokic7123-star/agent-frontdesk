// Export the whole icon set from the SVG master (logo.svg): the page's logo-*.png, the browser
// favicon.svg (rounded), the multi-size logo.ico, and the copy the desktop shortcut points to.
// Run: npm run export:icons  — replaces the browser-based pipeline (faster, no network hops).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGO = path.join(ROOT, 'src/client/public/assets/logo');
const square = fs.readFileSync(path.join(LOGO, 'logo.svg'), 'utf8');
// favicon.svg: same drawing clipped to its own rounded corners.
const rounded = square
  .replace('  <rect width="512" height="512" fill="url(#bg)"/>',
    '  <clipPath id="corner"><rect width="512" height="512" rx="112"/></clipPath>\n  <g clip-path="url(#corner)">\n  <rect width="512" height="512" fill="url(#bg)"/>')
  .replace(/<\/svg>/, '  </g>\n</svg>')
  .replace(/<!-- Agent Frontdesk[\s\S]*?-->/, '<!-- Agent Frontdesk\'s mark with its own rounded corners, for the browser tab (see logo.svg). -->');
fs.writeFileSync(path.join(LOGO, 'favicon.svg'), rounded);

const render = (svg, px) => new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng();
const dist = path.join(ROOT, 'dist/public/assets/logo');
fs.mkdirSync(dist, { recursive: true });
for (const [name, px] of [['logo-512.png', 512], ['logo-180.png', 180], ['logo-128.png', 128], ['logo-64.png', 64], ['logo-32.png', 32]]) {
  const png = render(square, px);
  fs.writeFileSync(path.join(LOGO, name), png);
  fs.writeFileSync(path.join(dist, name), png);
}

// Multi-size ICO (PNG-in-ICO entries) from the rounded-corner drawing.
const entries = [[256, 0], [128, 128], [64, 64], [48, 48], [32, 32], [16, 16]];
const pngs = entries.map(([px]) => render(rounded, px));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
const offset0 = 6 + entries.length * 16;
const dirs = [], blobs = [];
entries.forEach(([, w], i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(w === 256 ? 0 : w, 0); e.writeUInt8(w === 256 ? 0 : w, 1);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset0 + blobs.reduce((a, b) => a + b.length, 0), 12);
  dirs.push(e); blobs.push(pngs[i]);
});
const ico = Buffer.concat([header, ...dirs, ...blobs]);
fs.writeFileSync(path.join(LOGO, 'logo.ico'), ico);
fs.writeFileSync(path.join(dist, 'logo.ico'), ico);

// The shortcut's icon copy, beside the other local caches. A fresh name each run defeats the
// Windows icon cache, which does not refresh on a same-path content change.
const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'agent-frontdesk');
fs.mkdirSync(cacheDir, { recursive: true });
const stamp = Date.now().toString(36);
const shortcutIcon = path.join(cacheDir, `frontdesk-${stamp}.ico`);
fs.writeFileSync(shortcutIcon, ico);
for (const file of fs.readdirSync(cacheDir)) {
  if (/^frontdesk-.*\.ico$/.test(file) && file !== path.basename(shortcutIcon)) {
    fs.rmSync(path.join(cacheDir, file));
    console.log('removed stale shortcut icon:', file);
  }
}
console.log('icons exported; shortcut icon:', shortcutIcon);
