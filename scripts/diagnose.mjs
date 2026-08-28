#!/usr/bin/env node
/**
 * What the panel is actually adding up, day by day and label by label.
 *
 * Written because a work machine showed "862 credits over 31 messages" and,
 * one line below it, "this machine accounts for 20.48". Both figures come from
 * the same rollups and the same conversion; only a date filter separates them.
 * Nothing on the page said which days fell on which side of it, so the two
 * numbers could not be reconciled by looking.
 *
 * Reads the saved rollup rather than agent-traces.db: it is exactly what the
 * panel renders from, it needs no database access, and it can be run on a
 * machine whose panel looks wrong without reproducing anything.
 *
 * Workspace names are the only field that could carry anything private, and
 * they are not printed. Model names and figures are.
 *
 *   npm run diagnose
 *   npm run diagnose -- --file <rollup.json>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slug } from '../out/ratecard.js';

const argv = process.argv.slice(2);
const value = name => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };

const EXT_ID = 'token-pie.token-pie';
function storageDir() {
	const home = os.homedir();
	const base = process.platform === 'darwin'
		? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage')
		: process.platform === 'win32'
			? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage')
			: path.join(home, '.config', 'Code', 'User', 'globalStorage');
	return path.join(base, EXT_ID);
}

const file = value('file') ?? path.join(storageDir(), 'rollup.json');
if (!fs.existsSync(file)) {
	console.error(`no rollup at ${file}`);
	process.exit(1);
}
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
// Persisted as an object keyed by the dedupe key, not an array.
const held = saved.rollups ?? saved;
const rollups = Array.isArray(held) ? held : Object.values(held);
if (!rollups.length) {
	console.error('the rollup is empty');
	process.exit(1);
}

// The shipped default; --k to match a machine that has overridden it.
const k = Number(value('k') ?? 1e-9);
const credits = r => (r.nanoAiu ?? 0) * k;
const fmt = n => n.toFixed(2).padStart(10);

/* ------------------------------------------------------------- by day --- */
// The year is printed. The panel formats these as "Jul 30" with no year, so a
// day from a previous year is indistinguishable from this one on the page --
// and it is the difference between a day inside the billing period and a day
// that can never be in it.
const byDay = new Map();
for (const r of rollups) {
	const e = byDay.get(r.day) ?? { credits: 0, requests: 0, tokens: 0, sources: new Set() };
	e.credits += credits(r);
	e.requests += r.requests ?? 0;
	e.tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
	e.sources.add(r.source ?? 'unknown');
	byDay.set(r.day, e);
}
const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

console.log(`\n  ${rollups.length} rollups, ${days.length} distinct days\n`);
console.log('  day            credits   requests     tokens  source');
let total = 0;
for (const [day, e] of days) {
	total += e.credits;
	console.log(`  ${day}  ${fmt(e.credits)} ${String(e.requests).padStart(10)} ` +
		`${String(e.tokens).padStart(10)}  ${[...e.sources].join('+')}`);
}
console.log(`  ${''.padEnd(12)} ${fmt(total)}  <- what the summary line shows`);

/* ---------------------------------------------------------- by source --- */
// measured is agent-traces.db, reported is the chat transcript, which omits
// retried and cancelled messages. Rollup.source says the two must never be
// added into one burn rate; the panel adds them.
const bySource = new Map();
for (const r of rollups) {
	const s = r.source ?? 'unknown';
	const e = bySource.get(s) ?? { credits: 0, requests: 0, days: new Set() };
	e.credits += credits(r);
	e.requests += r.requests ?? 0;
	e.days.add(r.day);
	bySource.set(s, e);
}
console.log('\n  by source');
for (const [s, e] of bySource) {
	console.log(`  ${s.padEnd(12)} ${fmt(e.credits)} over ${e.days.size} day(s), ${e.requests} request(s)`);
}

/* --------------------------------------------------------- by period --- */
// The reconciliation line sums only days on or after the period start. Which
// days those are is the whole question, so both sides are printed.
const start = value('since');
if (start) {
	const inside = days.filter(([d]) => d >= start);
	const outside = days.filter(([d]) => d < start);
	const sum = list => list.reduce((n, [, e]) => n + e.credits, 0);
	console.log(`\n  against a period starting ${start}`);
	console.log(`  on or after  ${fmt(sum(inside))} over ${inside.length} day(s)  <- "this machine accounts for"`);
	console.log(`  before       ${fmt(sum(outside))} over ${outside.length} day(s)`);
	if (outside.length) {
		console.log(`  earliest excluded day: ${outside[0][0]}`);
	}
} else {
	console.log('\n  pass --since YYYY-MM-DD to split it at the billing period start');
}

/* ---------------------------------------------------------- by model --- */
// Grouping is on the raw string, so one model reported under two spellings is
// two rows that never add up. slug() already exists for the rate-card join.
const byModel = new Map();
for (const r of rollups) {
	const e = byModel.get(r.model) ?? { credits: 0, requests: 0 };
	e.credits += credits(r);
	e.requests += r.requests ?? 0;
	byModel.set(r.model, e);
}
console.log(`\n  ${byModel.size} distinct model label(s)`);
const collisions = new Map();
for (const [label, e] of [...byModel.entries()].sort((a, b) => b[1].credits - a[1].credits)) {
	const s = slug(label);
	collisions.set(s, [...(collisions.get(s) ?? []), label]);
	console.log(`  ${fmt(e.credits)} ${String(e.requests).padStart(5)}  ${label}`);
	console.log(`  ${''.padEnd(16)}  slug: ${s}`);
}
const split = [...collisions.entries()].filter(([, l]) => l.length > 1);
if (split.length) {
	console.log('\n  labels that are the same model split across rows:');
	for (const [s, labels] of split) {
		console.log(`  ${s}: ${labels.join('  |  ')}`);
	}
}

/* ------------------------------------------------------- selection --- */
const sel = new Map();
for (const r of rollups) {
	sel.set(r.selection, (sel.get(r.selection) ?? 0) + (r.requests ?? 0));
}
console.log(`\n  chosen by: ${[...sel.entries()].map(([s, n]) => `${s}=${n}`).join(', ')}`);
console.log('');
