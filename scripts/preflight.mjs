#!/usr/bin/env node
/**
 * Checks the packaged artefact, not the source.
 *
 * Everything here failed at least once after passing an isolated check: an
 * image link that resolved only through a redirect the Marketplace will not
 * follow, source maps and account fixtures shipping to users, a version that
 * disagreed with the changelog. The source being right does not mean the
 * package is.
 *
 * Usage: npm run preflight
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
};

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);

console.log(`\npackage: ${path.basename(vsix)}`);
if (!fs.existsSync(vsix)) {
  console.log('  FAIL  the packaged artefact for this version does not exist');
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-preflight-'));
execFileSync('unzip', ['-qo', vsix, '-d', dir]);
const ext = path.join(dir, 'extension');
const read = f => fs.readFileSync(path.join(ext, f), 'utf8');
const files = execFileSync('find', [dir, '-type', 'f']).toString().trim().split('\n');

console.log('\nnothing private ships');
const text = files.filter(f => /\.(js|json|md|txt|xml)$/.test(f))
  .map(f => fs.readFileSync(f, 'utf8')).join('\n');
for (const [label, re] of [
  ['no home directory paths', /\/Users\/[a-z]|\/home\/[a-z]|C:\\Users/i],
  ['no credential patterns', /ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|github_pat_|-----BEGIN|xox[baprs]-/],
  ['no email addresses', /[a-z0-9._%+-]+@(?!users\.noreply\.github\.com)[a-z0-9.-]+\.[a-z]{2,}/i]
]) check(label, !re.test(text), 'matched');

console.log('\nnothing needless ships');
for (const [label, re] of [
  ['no source maps', /\.map$/],
  ['no test fixtures', /fixtures?\//],
  ['no test scripts', /\.test\.mjs$/],
  ['no screenshots', /Screen-\d\.png$/]
]) check(label, !files.some(f => re.test(f)), files.find(f => re.test(f)));

console.log('\nthe listing will render');
const readme = read('readme.md');
const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
check('every image is an absolute URL', images.every(u => u.startsWith('https://')),
  images.find(u => !u.startsWith('https://')));
for (const url of images) {
  const code = execFileSync('curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', url]).toString();
  // A redirect is the failure that shipped: the Marketplace does not follow
  // them, so the image silently never appears.
  check(`${path.basename(url)} is served directly`, code === '200', `HTTP ${code}`);
}

console.log('\nmetadata agrees with itself');
const packed = JSON.parse(read('package.json'));
check('manifest version matches the filename', vsix.includes(packed.version));
check('changelog documents this version',
  new RegExp(`^##\\s*${packed.version.replace(/\./g, '\\.')}\\b`, 'm').test(read('changelog.md')),
  'no heading for it');
check('icon is present', fs.existsSync(path.join(ext, packed.icon ?? '')));
check('publisher is set', Boolean(packed.publisher));
check('repository is set', Boolean(packed.repository));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed.\n` : '\nReady to publish.\n');
process.exit(failures ? 1 : 0);
