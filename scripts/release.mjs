#!/usr/bin/env node
/**
 * Picks the version from the commits and hands it to `npm version`.
 *
 * The convention already decides this. Every commit since the last tag carries
 * a type the hook enforced, `feat` means minor and `fix` means patch, so the
 * number is a function of the log and not a judgement call. Making it one is
 * how 0.2.1 shipped features under a patch bump.
 *
 *   npm run release              bump by what landed
 *   npm run release -- --dry-run say what it would do, change nothing
 *   npm run release -- --major   leave 0.x behind: promote to 1.0.0
 *
 * It only chooses. `npm version` does the bump, the changelog hook writes the
 * notes from the same commits, and both stay usable on their own — an explicit
 * `npm version 1.0.0` still works and still gets its notes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { commits, level, next, userFacing } from './conventional.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dry = process.argv.includes('--dry-run');
const promote = process.argv.includes('--major');

const git = cmd =>
	execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// `npm version` refuses on a dirty tree, but it refuses after `preversion` has
// run the whole suite. Saying so first is worth the two lines.
if (git('git status --porcelain')) {
	console.error('\n  the working tree has changes; commit or stash them first\n');
	process.exit(1);
}

let since;
try { since = git('git describe --tags --abbrev=0'); } catch { since = undefined; }
const range = since ? `${since}..HEAD` : 'HEAD';

const parsed = commits(range, git);
const facing = userFacing(parsed);
const lvl = level(parsed);

console.log(`\n  ${pkg.version}, ${parsed.length} conventional commit(s) since ${since ?? 'the first commit'}\n`);
if (!lvl) {
	console.log('  nothing user-facing landed, so there is nothing to release.');
	console.log('  `npm version patch` if you need a version anyway.\n');
	process.exit(1);
}

for (const c of facing) {
	const why = c.breaking ? 'major' : c.type === 'feat' ? 'minor' : 'patch';
	console.log(`    ${why.padEnd(6)} ${c.breaking ? '! ' : '  '}${c.scope ? `${c.scope}: ` : ''}${c.subject}`);
}

const target = next(pkg.version, lvl, { promote });
const held = lvl === 'major' && target !== `${Number(pkg.version.split('.')[0]) + 1}.0.0`;
console.log(`\n  ${lvl} -> ${target}`);
if (held) {
	console.log('  (major zero: breaking lands as a minor. --major to declare 1.0.0)');
}
if (promote && lvl !== 'major') {
	console.log('  (--major given, but nothing breaking landed)');
}

if (dry) {
	console.log('\n  dry run; nothing changed.\n');
	process.exit(0);
}
console.log('');
execFileSync('npm', ['version', target], { cwd: root, stdio: 'inherit' });
