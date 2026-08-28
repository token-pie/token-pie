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
import crypto from 'crypto';
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
  ['no test scripts', /\.test\.mjs$/]
]) check(label, !files.some(f => re.test(f)), files.find(f => re.test(f)));

// This was `/Screen-\d\.png$/`, which only ever caught two files by name. Two
// debug screenshots written into the repo root by a headless-Chrome run
// packaged cleanly and passed. The rule is now the reverse: the icon named in
// the manifest is the only image allowed to ship, whatever it is called.
const icon = (JSON.parse(read('package.json')).icon ?? '').replace(/^\.\//, '');
const strayImages = files
  .map(f => path.relative(ext, f))
  .filter(f => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f) && f !== icon);
check('no images beyond the manifest icon', strayImages.length === 0, strayImages.join(', '));

// A block-list keeps losing this race: it was two filenames, then any image,
// and a stray probe .html still walked through. `.vscodeignore` excludes known
// directories, so anything new dropped in the repo root ships by default.
// Inverted for good: these are the only things allowed out.
const allowed = [
  /^package\.json$/, /^readme\.md$/i, /^changelog\.md$/i, /^license[^/]*$/i,
  /^out\/[a-z]+\.js$/, new RegExp(`^${icon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  // The published price table. Shipped so the comparison against measured
  // rates works offline and on first run, before any weekly fetch.
  /^rate-card\.json$/
];
const unexpected = files
  .map(f => path.relative(ext, f))
  // `[Content_Types].xml` and `extension.vsixmanifest` sit outside extension/
  // and belong to the container, not to us.
  .filter(f => !f.startsWith('..'))
  .filter(f => !allowed.some(re => re.test(f)));
check('nothing ships that is not on the allow-list', unexpected.length === 0, unexpected.join(', '));

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

  // 200 only proves the URL exists. The listing renders whatever `main` serves,
  // so a screenshot regenerated locally but not pushed shows the previous
  // release's UI to everyone reading the Marketplace page.
  const localFile = path.join(root, 'images', path.basename(url));
  if (code === '200' && fs.existsSync(localFile)) {
    const served = execFileSync('curl', ['-s', '--max-time', '20', url],
      { maxBuffer: 64 * 1024 * 1024 });
    const digest = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
    const mine = digest(fs.readFileSync(localFile));
    const theirs = digest(served);
    check(`${path.basename(url)} matches the local copy`, mine === theirs,
      `local ${mine}, served ${theirs} — push images/ before publishing`);
  }
}

console.log('\nmetadata agrees with itself');
const packed = JSON.parse(read('package.json'));
check('manifest version matches the filename', vsix.includes(packed.version));
// A heading alone used to pass, so `npm run bump` could leave an empty stub and
// a version would ship with nothing said about it. The entry has to have prose
// under it, up to the next heading.
// Split on top-level headings rather than matching to a lookahead: with the `m`
// flag `$` ends a LINE, so `(?=^## |$)` terminates immediately and captures
// nothing — the check passed for the wrong reason on a perfectly good entry.
const changelog = read('changelog.md');
const section = changelog
  .split(/^## /m)
  .find(part => part.startsWith(`${packed.version} `) || part.startsWith(`${packed.version}\n`));
check('changelog documents this version', section !== undefined, 'no heading for it');
check('and the entry is not an empty stub',
  // Subheadings are structure, not content; the prose has to survive removing them.
  (section ?? '').split('\n').slice(1).filter(l => !/^#+\s/.test(l)).join('').trim().length > 0,
  'heading with nothing under it');
check('icon is present', fs.existsSync(path.join(ext, packed.icon ?? '')));
check('publisher is set', Boolean(packed.publisher));
check('repository is set', Boolean(packed.repository));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed.\n` : '\nReady to publish.\n');
process.exit(failures ? 1 : 0);
