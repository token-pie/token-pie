#!/usr/bin/env node
/**
 * Proves two things at once, which is exactly what a security review asks for:
 *
 *   1. Prompt / response / system-prompt text is NOT being retained.
 *   2. The token and cost data Token Pie depends on IS still intact.
 *
 * Run after setting `github.copilot.chat.otel.maxAttributeSizeChars` to 1,
 * restarting VS Code, and sending a Copilot Chat request.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CONTENT_KEYS = [
	'gen_ai.input.messages',
	'gen_ai.output.messages',
	'gen_ai.system_instructions',
	'gen_ai.tool.call.arguments',
	'gen_ai.tool.call.result',
	'gen_ai.tool.definitions',
	'copilot_chat.user_request'
];
const NANO_AIU = 'copilot_chat.copilot_usage_nano_aiu';

/** A single character plus JSON quoting slack. Anything longer is real content. */
const SUPPRESSED_MAX_BYTES = 8;

function findDb() {
	const base =
		process.platform === 'darwin'
			? path.join(os.homedir(), 'Library', 'Application Support')
			: process.platform === 'win32'
				? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
				: process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');

	for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
		if (!dir.isDirectory()) {
			continue;
		}
		const p = path.join(base, dir.name, 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db');
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return undefined;
}

/**
 * A missing database after a settings change almost always means one thing:
 * VS Code has not been restarted, so the running extension host is still on the
 * old config -- and if the database was deleted while that host held it open,
 * it keeps writing to the unlinked inode. Spans land nowhere visible and are
 * discarded on quit. Detect it by comparing settings.json against the newest
 * log-session directory, whose name is the process start timestamp.
 */
function diagnoseStaleHost() {
	const base =
		process.platform === 'darwin'
			? path.join(os.homedir(), 'Library', 'Application Support')
			: process.platform === 'win32'
				? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
				: process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');

	for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
		if (!dir.isDirectory()) {
			continue;
		}
		const userDir = path.join(base, dir.name, 'User');
		const settings = path.join(userDir, 'settings.json');
		const logs = path.join(base, dir.name, 'logs');
		if (!fs.existsSync(settings) || !fs.existsSync(logs)) {
			continue;
		}

		// Log session directories are named YYYYMMDDTHHMMSS.
		const sessions = fs.readdirSync(logs).filter(n => /^\d{8}T\d{6}$/.test(n)).sort();
		const newest = sessions[sessions.length - 1];
		if (!newest) {
			continue;
		}
		const started = new Date(
			`${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6, 8)}T` +
			`${newest.slice(9, 11)}:${newest.slice(11, 13)}:${newest.slice(13, 15)}`
		);
		const changed = fs.statSync(settings).mtime;

		if (changed > started) {
			console.log(`  ${dir.name}: settings.json changed at ${changed.toLocaleTimeString()},`);
			console.log(`  but VS Code has been running since ${started.toLocaleTimeString()}.`);
			console.log('  The running extension host is still on the OLD config.');
			console.log('');
			console.log('  Quit VS Code completely (not just Reload Window) and reopen it.');
			console.log('  If the database was deleted while it was running, that host still');
			console.log('  holds the unlinked file and spans are going nowhere visible;');
			console.log('  quitting discards them. Then send a Copilot Chat request.');
			return true;
		}
	}
	return false;
}

const dbPath = findDb();
if (!dbPath) {
	console.log('No agent-traces.db found.\n');
	if (!diagnoseStaleHost()) {
		console.log('  Restart VS Code and send a Copilot Chat request first.');
	}
	process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (sql, ...args) => {
	const st = db.prepare(sql);
	st.setReadBigInts(true);
	return st.all(...args).map(row => {
		const out = {};
		for (const [k, v] of Object.entries(row)) {
			out[k] = typeof v === 'bigint' ? Number(v) : v;
		}
		return out;
	});
};

console.log(`${dbPath}`);
const wal = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
console.log(`db ${(fs.statSync(dbPath).size / 1024).toFixed(0)} KB + wal ${(wal / 1024).toFixed(0)} KB`);
console.log(`spans: ${q('SELECT COUNT(*) AS n FROM spans')[0].n}, attributes: ${q('SELECT COUNT(*) AS n FROM span_attributes')[0].n}\n`);

let failures = 0;

console.log('content suppression');
for (const key of CONTENT_KEYS) {
	const rows = q(
		'SELECT value, LENGTH(value) AS len FROM span_attributes WHERE key = ? ORDER BY len DESC',
		key
	);
	if (rows.length === 0) {
		console.log(`  n/a   ${key.padEnd(32)} not present`);
		continue;
	}
	const worst = rows[0];
	const ok = worst.len <= SUPPRESSED_MAX_BYTES;
	if (!ok) {
		failures++;
	}
	const sample = JSON.stringify(String(worst.value)).slice(0, 46);
	console.log(
		`  ${ok ? 'PASS' : 'FAIL'}  ${key.padEnd(32)} ${rows.length} span(s), max ${worst.len}B  ${sample}`
	);
}

// Events carry a copy of the user message, and are truncated by the same
// setting -- but they live in a different table, so check them separately.
const events = q("SELECT name, MAX(LENGTH(attributes)) AS len FROM span_events GROUP BY name");
console.log('\nspan_events');
for (const e of events) {
	const ok = e.len <= 120;
	if (!ok) {
		failures++;
	}
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${String(e.name).padEnd(32)} max ${e.len}B`);
}
if (events.length === 0) {
	console.log('  n/a   (no events recorded)');
}

console.log('\nusage data still intact');
const usage = q(
	`SELECT COUNT(*) AS chats, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
	        COUNT(DISTINCT response_model) AS models, COUNT(DISTINCT chat_session_id) AS sessions
	 FROM spans WHERE operation_name = 'chat'`
)[0];
const cost = q('SELECT COUNT(*) AS n, SUM(CAST(value AS REAL)) AS total FROM span_attributes WHERE key = ?', NANO_AIU)[0];

const checks = [
	['chat spans recorded', usage.chats > 0, `${usage.chats}`],
	['token counts present', Number(usage.input) > 0, `${usage.input} in / ${usage.output} out`],
	['models identified', usage.models > 0, `${usage.models} distinct`],
	['session ids present', usage.sessions > 0, `${usage.sessions} distinct`],
	['cost attribute present', cost.n > 0, `${cost.n} span(s), ${((Number(cost.total) || 0) * 1e-9).toFixed(4)} credits`]
];
for (const [label, ok, detail] of checks) {
	if (!ok) {
		failures++;
	}
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(32)} ${detail}`);
}

db.close();
console.log(
	failures === 0
		? '\nContent suppressed, usage data intact.\n'
		: `\n${failures} check(s) failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
