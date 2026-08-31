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
import { section, hasProse } from './changelog.mjs';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
};

/**
 * A publish gate, not a package gate.
 *
 * Some of what is checked here cannot be wrong until the extension is
 * published -- the listing images are served from `main`, so an unpushed
 * screenshot harms nobody until someone reads the Marketplace page. Failing
 * the build on those made a circle: taking a new screenshot needs a .vsix to
 * install, and building the .vsix refused until the screenshot was pushed,
 * which cannot happen before it is taken.
 *
 * So they warn by default and fail where a publish is actually in prospect --
 * `--publish`, or CI, where the tag being built is already pushed and a green
 * run is what a Release is created from.
 */
const strict = process.argv.includes('--publish') || process.env.CI === 'true';
let warnings = 0;
const gate = (label, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${label}`); return; }
  if (strict) { failures++; } else { warnings++; }
  console.log(`  ${strict ? 'FAIL' : 'WARN'}  ${label}${detail ? `  — ${detail}` : ''}`);
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
// packaged cleanly and passed. The rule is now the reverse: an image may ship
// only if the manifest names it, whatever it is called -- the marketplace icon
// or a view-container icon, and nothing else.
// The packed manifest, read as `packed`, is not bound until later; the source
// one is already here and vsce does not rewrite `contributes`.
const icon = (manifest.icon ?? '').replace(/^\.\//, '');
const declaredImages = new Set([icon,
  ...(manifest.contributes?.viewsContainers?.activitybar ?? [])
    .map(c => (c.icon ?? '').replace(/^\.\//, ''))
].filter(Boolean));
const strayImages = files
  .map(f => path.relative(ext, f))
  .filter(f => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f) && !declaredImages.has(f));
check('no images the manifest does not name', strayImages.length === 0, strayImages.join(', '));

/**
 * Well-formed enough for the renderer to draw it.
 *
 * A double hyphen inside an XML comment is illegal, and an editing note in the
 * activity glyph's own header carried one. The file stopped parsing, VS Code
 * drew nothing where the icon goes, and every check here passed: the icon was
 * named by the manifest, was the right size, and shipped where it should. An
 * unparseable file is a well-formed package containing a blank icon.
 *
 * Deliberately not a general XML parser -- these are hand-written glyphs, and
 * what needs catching is a file a browser will refuse outright.
 */
function xmlFault(src) {
  const stack = [];
  let i = 0;
  for (;;) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { break; }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) { return 'a comment that never closes'; }
      if (src.slice(lt + 4, end).includes('--')) {
        return 'a double hyphen inside a comment';
      }
      i = end + 3;
      continue;
    }
    const end = src.indexOf('>', lt);
    if (end < 0) { return 'a tag that never closes'; }
    if (!src.startsWith('<?', lt) && !src.startsWith('<!', lt)) {
      const body = src.slice(lt + 1, end).trim();
      if (body.startsWith('/')) {
        const name = body.slice(1).trim();
        if (stack.pop() !== name) { return `</${name}> closes nothing`; }
      } else if (!body.endsWith('/')) {
        stack.push(body.split(/[\s/]/)[0]);
      }
    }
    i = end + 1;
  }
  return stack.length > 0 ? `<${stack[stack.length - 1]}> is never closed` : '';
}

for (const f of files.filter(f => f.endsWith('.svg'))) {
  const fault = xmlFault(fs.readFileSync(f, 'utf8'));
  check(`${path.basename(f)} parses, so something is drawn`, fault === '', fault);
}

// A block-list keeps losing this race: it was two filenames, then any image,
// and a stray probe .html still walked through. `.vscodeignore` excludes known
// directories, so anything new dropped in the repo root ships by default.
// Inverted for good: these are the only things allowed out.
const allowed = [
  /^package\.json$/, /^readme\.md$/i, /^changelog\.md$/i, /^license[^/]*$/i,
  /^out\/[a-z]+\.js$/,
  // Every image the manifest names, not just the marketplace icon: the
  // activity-bar container names its own, and allowing only the first meant
  // adding a view failed here rather than in the check above that already
  // knew about both.
  ...[...declaredImages].map(f => new RegExp(`^${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
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
// One request per image, not two. `-o /dev/null` still transfers the whole
// body, so asking for the status and then asking for the bytes downloaded every
// screenshot twice -- and this loop is the only part of the build that waits on
// a network.
//
// --connect-timeout because raw.githubusercontent.com resolves to four
// addresses and one of them can be a black hole on a given network. curl waits
// ten seconds on a silent SYN before trying the next, which turned this stage
// into a minute of no output and looked like the build had stopped. Three
// seconds is far above a real handshake and far below that wait.
const served = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-served-'));
for (const url of images) {
  const body = path.join(served, path.basename(url));
  const code = execFileSync('curl',
    ['-s', '-o', body, '-w', '%{http_code}',
     '--connect-timeout', '3', '--max-time', '30', url]).toString();
  // A redirect is the failure that shipped: the Marketplace does not follow
  // them, so the image silently never appears.
  //
  // A 404 splits in two, and only one of them is a fault. If the file is here
  // and not there, it has not been pushed yet -- which is every new screenshot,
  // and failing on it means a new image cannot be added without already having
  // added it. If it is not here either, the URL is wrong and nothing will ever
  // serve it.
  const localFile = path.join(root, 'images', path.basename(url));
  const unpushed = code === '404' && fs.existsSync(localFile);
  (unpushed ? gate : check)(
    `${path.basename(url)} is served directly`, code === '200',
    unpushed ? `HTTP 404 — new image, push images/ before publishing` : `HTTP ${code}`);

  // 200 only proves the URL exists. The listing renders whatever `main` serves,
  // so a screenshot regenerated locally but not pushed shows the previous
  // release's UI to everyone reading the Marketplace page.
  if (code === '200' && fs.existsSync(localFile)) {
    const digest = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
    const mine = digest(fs.readFileSync(localFile));
    const theirs = digest(fs.readFileSync(body));
    gate(`${path.basename(url)} matches the local copy`, mine === theirs,
      `local ${mine}, served ${theirs} — push images/ before publishing`);
  }
}

console.log('\nmetadata agrees with itself');
const packed = JSON.parse(read('package.json'));
check('manifest version matches the filename', vsix.includes(packed.version));
// A heading alone used to pass, so a version could ship with nothing said about
// it. The entry has to have prose under it, up to the next heading — and the
// same entry becomes the GitHub Release body, so this is the check standing
// between a bad parse and a published Release nobody can un-send.
const entry = section(read('changelog.md'), packed.version);
check('changelog documents this version', entry !== undefined, 'no heading for it');
check('and the entry is not an empty stub', hasProse(entry), 'heading with nothing under it');
check('icon is present', fs.existsSync(path.join(ext, packed.icon ?? '')));

// The allow-list only proves nothing unexpected shipped. Anything the manifest
// points at has to be proved present separately: `images/*.svg` was excluded,
// so the activity-bar icon was left out and the container would have rendered
// with no icon at all, which the package check could not see.
for (const c of packed.contributes?.viewsContainers?.activitybar ?? []) {
  check(`view container icon ships: ${c.icon}`,
    Boolean(c.icon) && fs.existsSync(path.join(ext, c.icon)));
}
check('publisher is set', Boolean(packed.publisher));
check('repository is set', Boolean(packed.repository));

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(served, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} check(s) failed.\n`);
} else if (warnings) {
  // Named as what it is: the package is sound, the listing would not be.
  console.log(`\n${warnings} warning(s). Fine to install; run with --publish before publishing.\n`);
} else {
  console.log('\nReady to publish.\n');
}
process.exit(failures ? 1 : 0);
