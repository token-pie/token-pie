#!/usr/bin/env node
/**
 * The release build, start to finish, in one command.
 *
 * Every stage here was a manual step at some point, and each one was skipped or
 * half-done at least once: a package built from a stale `out/`, screenshots
 * regenerated locally but never pushed, debug files dropped in the repo root
 * that shipped inside the .vsix. A build is only trustworthy if it starts from
 * nothing and refuses to continue when a stage fails.
 *
 *   npm run build          clean, compile, test, package, preflight
 *   npm run build -- --fast  skip the clean, for iterating
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = `${manifest.name}-${manifest.version}.vsix`;
const fast = process.argv.includes('--fast');

let stage = 0;
const started = Date.now();
const LABEL_WIDTH = 34;
const announce = label => process.stdout.write(`  ${++stage}. ${label.padEnd(LABEL_WIDTH)}`);

/** Runs a stage, showing its output only when it fails. */
function run(label, cmd, args) {
  announce(label);
  const began = Date.now();
  try {
    const out = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    console.log(`ok   ${((Date.now() - began) / 1000).toFixed(1)}s`);
    return out;
  } catch (err) {
    console.log('FAILED');
    console.log('\n' + ((err.stdout ?? '') + (err.stderr ?? '')).trimEnd() + '\n');
    console.log(`build stopped at stage ${stage}: ${label}`);
    process.exit(1);
  }
}

console.log(`\nbuilding ${manifest.name} ${manifest.version}\n`);

/* -------------------------------------------------------------- clean --- */
// A package built over a stale `out/` ships whatever was left there, including
// modules deleted from source.
if (!fast) {
  announce('clean');
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
  for (const f of fs.readdirSync(root).filter(f => f.endsWith('.vsix'))) {
    fs.rmSync(path.join(root, f), { force: true });
  }
  console.log('ok');
}

/* ------------------------------------------------------------ compile --- */
run('compile', 'npx', ['tsc', '-p', '.']);

/* --------------------------------------------------------------- test --- */
const testOut = run('test', 'npm', ['test']);
const passes = (testOut.match(/PASS/g) || []).length;
console.log(`     ${passes} checks passed`);

/* ------------------------------------------------------------ package --- */
// `--no-install` alone falls back to whatever npx has cached globally, which
// is not the pinned version a fresh checkout gets from `npm install`.
run('package', path.join(root, 'node_modules', '.bin', 'vsce'), ['package']);
if (!fs.existsSync(path.join(root, vsix))) {
  console.log(`\n  the package was not written: ${vsix}`);
  process.exit(1);
}

/* ---------------------------------------------------------- preflight --- */
// Inspects the packaged artefact rather than the source: what shipped, whether
// the listing's images resolve, whether the metadata agrees with itself.
announce('preflight');
try {
  const out = execFileSync('node', ['scripts/preflight.mjs'],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const failed = (out.match(/^\s+FAIL/gm) || []).length;
  if (failed) {
    throw Object.assign(new Error('preflight'), { stdout: out });
  }
  console.log(`ok   ${(out.match(/PASS/g) || []).length} checks passed`);
} catch (err) {
  console.log('FAILED');
  console.log('\n' + ((err.stdout ?? '') + (err.stderr ?? '')).trimEnd() + '\n');
  process.exit(1);
}

/* -------------------------------------------------------------- audit --- */
// What landed against what was written about it. Preflight proves the changelog
// section is not empty; this asks whether it is complete.
stage += 1;
process.stdout.write(`  ${stage}. release audit${' '.repeat(LABEL_WIDTH - 13)}`);
try {
	const out = execFileSync('node', ['scripts/release-audit.mjs'],
		{ cwd: root, encoding: 'utf8', stdio: 'pipe' });
	const note = /note:/.test(out);
	console.log(note ? 'check' : 'ok');
	if (note) {
		console.log(out.trimEnd().split('\n').map(l => `     ${l.trim()}`).join('\n'));
	}
} catch (err) {
	console.log('FAILED');
	console.log('\n' + ((err.stdout ?? '') + (err.stderr ?? '')).trimEnd() + '\n');
	process.exit(1);
}

/* ------------------------------------------------------------ hygiene --- */
// Advisory, not fatal: the allow-list already stops a stray file shipping, but
// an untracked file in the repo is how it got into the package three times.
let notes = [];
try {
  const lines = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(l => l.length > 3)
    // XY then a space then the path; the status field is fixed-width and its
    // first column is a space for unstaged changes, so it must not be trimmed.
    .map(l => ({ status: l.slice(0, 2), file: l.slice(3) }));
  const untracked = lines.filter(l => l.status === '??').map(l => l.file);
  const modified = lines.filter(l => l.status !== '??').map(l => l.file);
  if (untracked.length) notes.push(`untracked: ${untracked.join(', ')}`);
  if (modified.length) notes.push(`uncommitted: ${modified.join(', ')}`);
} catch { /* not a git checkout; nothing to say */ }

const size = (fs.statSync(path.join(root, vsix)).size / 1024).toFixed(1);
console.log(`\n${vsix}  ${size} KB  in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const n of notes) {
  console.log(`  note: ${n}`);
}
console.log(notes.length ? '\nReady to publish, but the repo has changes not committed.\n'
                         : '\nReady to publish.\n');
