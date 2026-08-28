#!/usr/bin/env node
/**
 * Prints one version's changelog entry, for the GitHub Release body.
 *
 * The workflow needs the notes as text and the notes already exist, written
 * into CHANGELOG.md by the version hook. Extracting them here rather than with
 * `sed` inside the YAML keeps the parse in one place and under test with
 * everything else — a release body that came out empty because a heading moved
 * would otherwise be discovered by reading the published Release.
 *
 *   node scripts/release-notes.mjs            this version, from package.json
 *   node scripts/release-notes.mjs v0.2.1     a tag, or a bare version
 */
import fs from 'node:fs';
import path from 'node:path';
import { section, hasProse } from './changelog.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const arg = process.argv[2];
const version = arg
	? arg.replace(/^v/, '')
	: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const entry = section(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
if (!hasProse(entry)) {
	// Fail rather than publish a Release with an empty body: a Release is the
	// artefact people subscribe to, and a blank one cannot be un-sent.
	console.error(`\n  CHANGELOG.md has no entry with prose for ${version}\n`);
	process.exit(1);
}
process.stdout.write(entry.body.replace(/^\n+/, '') + '\n');
