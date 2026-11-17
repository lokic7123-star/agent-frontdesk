import { previewFile } from '../src/server/services/file-preview.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { must, withStatus } from './support.js';
import * as __services_file_preview from '../src/server/services/file-preview.js';
import * as __services_reveal from '../src/server/services/reveal.js';

test('file previews stay inside the session folder and never show secrets or binaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-'));
  const cwd = path.join(root, 'project'), outside = path.join(root, 'outside.txt');
  fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true }); fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), 'one\ntwo\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=secret');
  fs.writeFileSync(path.join(cwd, '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(cwd, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(outside, 'not yours');
  // Creating a symlink needs Developer Mode or admin on Windows; the escape-by-symlink check
  // only runs where the link can be made (the realpath refusal itself is platform-neutral).
  let linked = true;
  try { fs.symlinkSync(outside, path.join(cwd, 'escape.txt')); } catch (err) {
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') linked = false; else throw err;
  }

  assert.deepEqual(previewFile(cwd, 'lib/a.js:2'), { path: 'lib/a.js', size: 8, text: 'one\ntwo\n', truncated: false });
  assert.equal(previewFile(cwd, path.join(cwd, 'lib', 'a.js')).path, 'lib/a.js');
  assert.match(must(previewFile(cwd, 'shot.png').image), /^data:image\/png;base64,/);
  const refused = (target: string, status: number) => assert.throws(() => previewFile(cwd, target), withStatus(status));
  refused(outside, 403);
  refused('../outside.txt', 403);
  if (linked) refused('escape.txt', 403);
  refused('.env', 403);
  refused('.git/config', 403);
  refused('blob.bin', 415);
  refused('missing.js', 404);
  assert.throws(() => previewFile('', 'lib/a.js'), withStatus(404));
});

test('"show in Finder" uses the same folder check as the preview, and the system file manager', async () => {
  const { resolveFile } = __services_file_preview;
  const { revealFile, fileManager, command } = __services_reveal;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-')));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true }); fs.writeFileSync(path.join(cwd, 'lib', 'a.js'), '');
  fs.writeFileSync(path.join(root, 'outside.txt'), '');
  assert.deepEqual(resolveFile(cwd, 'lib/a.js:3'), { file: path.join(cwd, 'lib', 'a.js'), relative: 'lib/a.js' });
  assert.throws(() => resolveFile(cwd, '../outside.txt'), withStatus(403));
  // `~/…` is the home folder: outside the session's folders it is refused like any other path.
  assert.throws(() => resolveFile(cwd, '~/'), withStatus(403));
  const realHome = process.env['HOME'];
  process.env['HOME'] = root;
  try { assert.deepEqual(resolveFile(cwd, '~/outside.txt', [root]), { file: path.join(root, 'outside.txt'), relative: 'outside.txt' }); }
  finally { process.env['HOME'] = realHome; }
  assert.deepEqual(command('/w/a.js', 'darwin'), ['/usr/bin/open', ['-R', '/w/a.js']]);
  assert.deepEqual(command('C:\\w\\a.js', 'win32'), ['explorer.exe', ['/select,C:\\w\\a.js']]);
  assert.deepEqual(command('/w/lib/a.js', 'linux'), ['xdg-open', ['/w/lib']]);
  assert.deepEqual([fileManager('darwin'), fileManager('win32'), fileManager('linux')], ['finder', 'explorer', 'files']);
  const ran: string[][] = [];
  await revealFile('/w/a.js', { platform: 'darwin', runner: (bin, args, options, done) => { ran.push([bin, ...args]); done(null); } });
  assert.deepEqual(ran, [['/usr/bin/open', '-R', '/w/a.js']]);
  await assert.rejects(revealFile('/w/a.js', { platform: 'darwin', runner: (bin, args, options, done) => done(new Error('no')) }), /没能在文件管理器里显示这个文件/);
  // explorer.exe exits with 1 after opening the folder.
  await revealFile('C:\\a.js', { platform: 'win32', runner: (bin, args, options, done) => done(Object.assign(new Error('1'), { code: 1 })) });
});

test('a folder the reply links to previews as its listing, and stays inside the session folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-dir-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, 'docs', 'old'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'docs', 'guide.md'), '# hi');
  fs.writeFileSync(path.join(cwd, 'docs', '.DS_Store'), '');
  assert.deepEqual(previewFile(cwd, 'docs/'), { path: 'docs/', size: 2, entries: [{ name: 'old', dir: true }, { name: 'guide.md', dir: false }], truncated: false });
  assert.equal(previewFile(cwd, path.join(cwd, 'docs')).path, 'docs/');
  assert.throws(() => previewFile(cwd, root), withStatus(403));
});

test('an engine may name folders it keeps for a chat; files there can be read, nothing else outside', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-roots-')));
  const brain = path.join(root, 'brain', 'c1');
  fs.mkdirSync(brain, { recursive: true }); fs.writeFileSync(path.join(brain, 'guide.md'), '# guide');
  fs.writeFileSync(path.join(root, 'other.md'), 'no');
  // No working directory (an Antigravity chat outside any workspace): the chat's own folder still reads.
  assert.equal(previewFile('', `file://${path.join(brain, 'guide.md')}`, [brain]).text, '# guide');
  assert.equal(previewFile('', 'guide.md', [brain]).path, 'guide.md');
  assert.throws(() => previewFile('', path.join(root, 'other.md'), [brain]), withStatus(403));
  assert.throws(() => previewFile('', 'guide.md'), withStatus(404));
});

test("an app's icon is read from its .icns as the PNG nearest the asked size, and a missing or foreign file gives none", async () => {
  const { readAppIcon } = await import('../src/server/services/app-assets.js');
  const png = (width: number) => { const out = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out); out.writeUInt32BE(width, 16); return out; };
  const entry = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.write(type, 'latin1'); head.writeUInt32BE(body.length + 8, 4); return Buffer.concat([head, body]); };
  const entries = Buffer.concat([entry('TOC ', Buffer.alloc(16)), entry('ic07', png(128)), entry('ic08', png(256)), entry('ic10', png(1024))]);
  const head = Buffer.alloc(8); head.write('icns', 'latin1'); head.writeUInt32BE(entries.length + 8, 4);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-icon-')), file = path.join(dir, 'app.icns');
  try {
    fs.writeFileSync(file, Buffer.concat([head, entries]));
    const icon = readAppIcon(file);
    assert.equal(icon?.type, 'image/png');
    assert.equal(Buffer.from(icon?.data || []).readUInt32BE(16), 256);
    assert.equal(Buffer.from(readAppIcon(file, 100)?.data || []).readUInt32BE(16), 128);
    assert.equal(readAppIcon(path.join(dir, 'missing.icns')), null);
    fs.writeFileSync(file, 'not an icon');
    assert.equal(readAppIcon(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
