#!/usr/bin/env node
/**
 * Finding one version's entry in CHANGELOG.md.
 *
 * Three things ask this question — preflight proves the entry is not an empty
 * stub, the audit counts its bullets, and the release workflow uses it as the
 * GitHub Release body — and each had its own copy of the split. That is one
 * copy too many for a parse that has already been wrong once: matching to a
 * lookahead, `(?=^## |$)` with the `m` flag terminates at the end of the first
 * LINE, so the capture came back empty and preflight passed a perfectly good
 * entry for the wrong reason.
 *
 * So the split lives here, done the way that works: cut on top-level headings
 * and take the part that starts with the version.
 */

/**
 * The entry for `version`, or undefined when there is none.
 * `heading` is the full heading line; `body` is everything under it.
 */
export function section(changelog, version) {
	const part = changelog
		.split(/^## /m)
		.find(p => p.startsWith(`${version} `) || p.startsWith(`${version}\n`));
	if (part === undefined) { return undefined; }
	const [first, ...rest] = part.split('\n');
	return { heading: `## ${first}`, body: rest.join('\n').replace(/\s+$/, '') };
}

/** Whether an entry says anything, ignoring subheadings, which are structure. */
export function hasProse(entry) {
	if (!entry) { return false; }
	return entry.body.split('\n').filter(l => !/^#+\s/.test(l)).join('').trim().length > 0;
}

/** How many bullets the entry lists — what the audit compares against commits. */
export function bullets(entry) {
	return entry ? (entry.body.match(/^- /gm) || []).length : 0;
}
