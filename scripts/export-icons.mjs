// Export the whole icon set from the SVG master (logo.svg): the page's logo-*.png, the browser
// favicon.svg (rounded), the multi-size logo.ico, and the copy the desktop shortcut points to.
// Run: npm run export:icons  — replaces the browser-based pipeline (faster, no network hops).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const messageOf = err => (err instanceof Error ? err.message : String(err));

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

// The shortcut's icon copy, beside the other local caches, at a stable path this script owns.
// Windows does not refresh an icon when a file changes under the same path, so after writing
// the copy every desktop shortcut that points at it is re-saved and the shell is told to
// rebuild its icon cache — every run, not only when the pointer moved.
const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'agent-frontdesk');
fs.mkdirSync(cacheDir, { recursive: true });
const shortcutIcon = path.join(cacheDir, 'frontdesk.ico');
fs.writeFileSync(shortcutIcon, ico);

const ps = `
$ErrorActionPreference = 'Stop'
$ico = Join-Path $env:LOCALAPPDATA 'agent-frontdesk\\frontdesk.ico'
$fixed = @()
foreach ($base in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
  if (-not $base -or -not (Test-Path $base)) { continue }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($lnk in Get-ChildItem $base -Filter '*.lnk') {
    $s = $shell.CreateShortcut($lnk.FullName)
    if ($s.IconLocation -and $s.IconLocation -match 'agent-frontdesk') {
      $index = if ($s.IconLocation -match ',(\\d+)\\s*$') { $Matches[1] } else { '0' }
      $s.IconLocation = "$ico,$index"
      $s.Save()
      $fixed += $lnk.Name
    }
  }
}
Add-Type -TypeDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);' -Name Sh -Namespace Win
[Win.Sh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output ("lnk re-saved: " + ($fixed -join ', '))
`.trim();
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
  console.log(out.trim());
  // Old stamped copies from earlier runs are only removed once the pointers moved safely.
  for (const file of fs.readdirSync(cacheDir)) {
    if (/^frontdesk-.*\.ico$/.test(file)) {
      fs.rmSync(path.join(cacheDir, file));
      console.log('removed stale shortcut icon:', file);
    }
  }
} catch (err) {
  console.log('shortcut refresh failed (the old icon file is kept):', messageOf(err));
}
console.log('icons exported; shortcut icon:', shortcutIcon);

