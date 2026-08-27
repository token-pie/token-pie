#!/usr/bin/env node
/**
 * Opens a changelog entry for the version `npm version` has just written.
 *
 * This is a hook, not a version tool. `npm version` already does the bump
 * properly — `package.json`, both `package-lock.json` fields, the git tag — and
 * a bespoke reimplementation of it was worse in the one way that matters: it
 * was the thing you had to remember to use instead of the standard command.
 * Reaching for `npm version` then left the changelog behind and preflight
 * refused to package.
 *
 * So the standard command stays the entry point and this fills the one gap it
 * has, from the `version` lifecycle script:
 *
 *   npm version minor     ->  bump, then this, then commit + tag
 *
 * The heading goes in empty on purpose: preflight fails on an entry with no
 * prose under it, so a forgotten changelog stops the build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
fs.writeFileSync(logPath, log.replace(marker, `${marker}\n## ${pkg.version}\n\n`));
console.log(`opened a changelog entry for ${pkg.version}`);

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

console.log(`next: describe ${pkg.version} in CHANGELOG.md, then npm run build`);
