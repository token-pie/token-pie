#!/usr/bin/env node
/**
 * Compares what landed against what was written about it.
 *
 * Preflight can tell that a changelog section exists and has prose in it. It
 * cannot tell that the prose is *complete*, and that is the failure that
 * actually happened: entries kept being appended to a version already published,
 * because nothing said that section was closed. The version and the changelog
 * drifted in content before they drifted in number.
 *
 * Conventional commit types make the check possible. `feat`, `fix`, `perf` and
 * anything marked breaking are user-facing and belong in release notes;
 * `chore`, `docs`, `test`, `refactor`, `ci`, `build`, `style` do not. So the
 * question has a mechanical form: how many user-facing commits since the last
 * tag, and how many bullets under the current heading?
 *
 * It cannot verify a word of the prose. It can stop a release where four
 * features landed and one line was written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { commits, userFacing } from './conventional.mjs';
import { section, bullets as countBullets } from './changelog.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// stderr piped: `git describe` with no tags writes "fatal: No names found" and
// that is an expected state here, not an error worth showing.
const git = cmd =>
	execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let since;
try {
	since = git('git describe --tags --abbrev=0');
} catch {
	since = undefined; // no tags yet: the whole history is unreleased
}

const range = since ? `${since}..HEAD` : 'HEAD';
let total = 0;
let parsed = [];
try {
	const out = git(`git log ${range} --format=%s`);
	total = out ? out.split('\n').length : 0;
	// The same parse the bump uses, so the audit cannot disagree with the
	// version about which commits were user-facing.
	parsed = commits(range, git);
} catch {
	console.log('  not a git checkout; nothing to audit');
	process.exit(0);
}

const unconventional = total - parsed.length;
const facing = userFacing(parsed);

// The current version's section, up to the next top-level heading.
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const bullets = countBullets(section(changelog, pkg.version));

if (!since) {
	// Every release before tagging began is in this range, so the count is not
	// meaningful yet. Say so rather than reporting a number that looks wrong.
	console.log('\n  no version tags yet, so this spans already-released work.');
	console.log('  `npm version` tags from here on and the range becomes exact.');
}
console.log(`\n  since ${since ?? 'the first commit'}: ${total} commit(s)` +
	`, ${facing.length} user-facing`);
if (unconventional > 0) {
	console.log(`  ${unconventional} not conventional (older history; the hook covers new ones)`);
}
for (const c of facing) {
	console.log(`    ${c.breaking ? 'BREAKING ' : ''}${c.type.padEnd(5)} ${c.subject}`);
}
console.log(`  changelog ${pkg.version}: ${bullets} bullet(s)`);

if (since && facing.length > 0 && bullets === 0) {
	console.log(`\n  ${facing.length} user-facing commit(s) and nothing written about them.\n`);
	process.exit(1);
}
if (since && bullets < facing.length) {
	console.log(`\n  note: fewer bullets than user-facing commits — check nothing is missing\n`);
} else {
	console.log('');
}
