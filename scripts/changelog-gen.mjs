#!/usr/bin/env node
/**
 * Writes the changelog entry for the version `npm version` has just written.
 *
 * This is a hook, not a version tool. `npm version` already does the bump
 * properly — `package.json`, both `package-lock.json` fields, the git tag — and
 * a bespoke reimplementation of it was worse in the one way that matters: it
 * was the thing you had to remember to use instead of the standard command.
 *
 * It used to open the section empty and leave the prose to whoever remembered.
 * That is the step that got skipped: 0.3.0 was tagged with a heading and
 * nothing under it. The commits already say what landed, in a format a hook
 * enforces, so the section is generated from them and editing it afterwards is
 * an improvement rather than the only thing standing between a tag and notes.
 *
 * Runs after the bump and before the commit, so `lastTag..HEAD` is exactly the
 * work being released.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { commits, render, userFacing } from './conventional.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const logPath = path.join(root, 'CHANGELOG.md');
const log = fs.readFileSync(logPath, 'utf8');

const heading = new RegExp(`^##\\s*${pkg.version.replace(/\./g, '\\.')}\\b`, 'm');
if (heading.test(log)) {
	console.log(`changelog already has an entry for ${pkg.version}`);
	process.exit(0);
}

const marker = '# Changelog\n';
if (!log.startsWith(marker)) {
	console.error('CHANGELOG.md does not start with "# Changelog"');
	process.exit(1);
}

// stderr piped: `git describe` with no tags is an expected state here.
const git = cmd =>
	execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let since;
try { since = git('git describe --tags --abbrev=0'); } catch { since = undefined; }

const parsed = userFacing(commits(since ? `${since}..HEAD` : 'HEAD', git));
const date = new Date().toISOString().slice(0, 10);
// A release with nothing user-facing in it is a real thing — a dependency bump,
// a rebuilt package. Preflight still refuses an empty heading, so say that
// plainly rather than leaving a hole for someone to fill with nothing.
const section = parsed.length
	? render(parsed, pkg.version, date)
	: `## ${pkg.version} - ${date}\n\n- maintenance only; nothing user-facing changed.\n`;

fs.writeFileSync(logPath, log.replace(marker, `${marker}\n${section}\n`));
console.log(`wrote ${parsed.length} entr${parsed.length === 1 ? 'y' : 'ies'} for ${pkg.version}` +
	` from ${since ?? 'the first commit'}..HEAD`);

// Advisory only: the Marketplace rejects a version that is already live, and
// finding that out at publish time is late. Never blocks — being offline is not
// a reason to fail a version bump.
try {
	const body = JSON.stringify({
		filters: [{ criteria: [{ filterType: 7, value: `${pkg.publisher}.${pkg.name}` }] }],
		flags: 0x1
	});
	const out = execFileSync('curl', [
		'-s', '--max-time', '6', '-H', 'Content-Type: application/json',
		'-H', 'Accept: application/json;api-version=3.0-preview.1',
		'-d', body, 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'
	], { encoding: 'utf8' });
	const live = JSON.parse(out)?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
	if (live) {
		const rank = v => v.split('.').map(Number).reduce((n, p) => n * 100000 + p, 0);
		console.log(`marketplace is on ${live}`);
		if (rank(pkg.version) <= rank(live)) {
			console.log(`WARNING: ${pkg.version} is not ahead of what is published`);
		}
	}
} catch { /* offline, or not listed yet */ }

console.log(`next: read ${pkg.version} in CHANGELOG.md, then npm run build`);
