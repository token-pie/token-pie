#!/usr/bin/env node
/**
 * Conventional Commits -> SemVer, and the release notes that follow from them.
 *
 * The commit hook has always enforced the format and the audit has always read
 * it, but the number in the middle was still chosen by hand: someone had to
 * look at the log, decide "that was a feature, so minor", and type it. That is
 * the one judgement the convention exists to remove. `feat` means minor. Not
 * "suggests"; means. Deciding it by eye is how a release goes out as a patch
 * with a feature in it.
 *
 * So the mapping lives here, once, and both the version and the notes are read
 * out of the same parse:
 *
 *   BREAKING CHANGE / !   major
 *   feat                  minor
 *   fix, perf, revert     patch
 *   everything else       no release
 *
 * The one deliberate departure from semantic-release: while the major version
 * is 0, a breaking change bumps the minor rather than declaring 1.0.0. SemVer
 * says anything may change at major zero, so a `feat!` there is not the
 * milestone that promoting to 1.0.0 announces. `release --major` is how you
 * announce it, when you mean to.
 */

/** The types the hook accepts, and whether each one reaches a user. */
const LEVELS = { feat: 'minor', fix: 'patch', perf: 'patch', revert: 'patch' };

/** Section headings, in the order they appear under a version. */
const SECTIONS = [
	{ key: 'breaking', heading: 'Breaking' },
	{ key: 'feat', heading: 'Added' },
	{ key: 'fix', heading: 'Fixed' },
	{ key: 'perf', heading: 'Faster' },
	{ key: 'revert', heading: 'Reverted' }
];

const RANK = { patch: 1, minor: 2, major: 3 };

/**
 * Splits one commit into its conventional parts, or returns undefined for a
 * subject that is not conventional at all — history from before the hook.
 */
export function parse(subject, body = '') {
	const m = subject.match(/^([a-z]+)(?:\(([^)]*)\))?(!)?: (.+)$/);
	if (!m) { return undefined; }
	const [, type, scope, bang, text] = m;
	// The footer form is the normative one; `!` is the shorthand for it.
	const footer = /^BREAKING[ -]CHANGE:/m.test(body);
	return { type, scope, breaking: Boolean(bang) || footer, subject: text };
}

/** Reads a git range into parsed commits, oldest first, unparseable dropped. */
export function commits(range, git) {
	// NUL between fields and RS between records: a body contains newlines and
	// splitting on them merges a commit into the one after it.
	const raw = git(`git log ${range} --format=%s%x00%b%x1e`);
	return raw
		.split('\x1e')
		.map(r => r.trim())
		.filter(Boolean)
		.map(r => { const [s, b] = r.split('\x00'); return parse(s, b ?? ''); })
		.filter(c => c !== undefined)
		.reverse();
}

/** The level these commits require, or undefined when none of them ship. */
export function level(parsed) {
	let highest;
	for (const c of parsed) {
		const l = c.breaking ? 'major' : LEVELS[c.type];
		if (l && (!highest || RANK[l] > RANK[highest])) { highest = l; }
	}
	return highest;
}

/** Applies a level to a version, honouring the major-zero rule. */
export function next(version, lvl, { promote = false } = {}) {
	const [maj, min, pat] = version.split('.').map(Number);
	// Major zero: breaking is not yet an event, so it lands as a minor. Only an
	// explicit promotion leaves 0.x.
	const effective = lvl === 'major' && maj === 0 && !promote ? 'minor' : lvl;
	if (effective === 'major') { return `${maj + 1}.0.0`; }
	if (effective === 'minor') { return `${maj}.${min + 1}.0`; }
	return `${maj}.${min}.${pat + 1}`;
}

/** The commits that belong in release notes. */
export function userFacing(parsed) {
	return parsed.filter(c => c.breaking || LEVELS[c.type]);
}

/** Renders a version's section: `## x.y.z - date`, then a group per type. */
export function render(parsed, version, date) {
	const bucket = c => (c.breaking ? 'breaking' : c.type);
	const seen = new Set();
	const lines = [`## ${version} - ${date}`];
	for (const { key, heading } of SECTIONS) {
		const group = parsed.filter(c => bucket(c) === key);
		if (!group.length) { continue; }
		lines.push('', `### ${heading}`, '');
		for (const c of group) {
			// The same subject twice is a cherry-pick or an amend that landed
			// twice; it is one line in the notes either way.
			const text = c.scope ? `**${c.scope}:** ${c.subject}` : c.subject;
			if (seen.has(text)) { continue; }
			seen.add(text);
			lines.push(`- ${text}`);
		}
	}
	return lines.join('\n') + '\n';
}
