#!/usr/bin/env node
/**
 * Standalone schema probe. Deliberately duplicates a little of src/locate.ts so
 * it runs with plain `node scripts/probe.mjs` before anything is compiled.
 *
 * Run this against a populated agent-traces.db before trusting the extension's
 * numbers. It prints the real table shape and attribute keys, which is what you
 * use to confirm (or correct) the candidate lists in src/schema.ts and
 * src/ingest.ts.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const NANO_AIU = 'copilot_chat.copilot_usage_nano_aiu';

function userRoots() {
	const home = os.homedir();
	const base =
		process.platform === 'darwin'
			? path.join(home, 'Library', 'Application Support')
			: process.platform === 'win32'
				? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
				: process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');

	let entries = [];
	try {
		entries = fs.readdirSync(base, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(e => e.isDirectory())
		.map(e => ({ root: path.join(base, e.name, 'User'), channel: e.name }))
		.filter(r => fs.existsSync(path.join(r.root, 'globalStorage')));
}

function findDbs() {
	const out = [];
	for (const { root, channel } of userRoots()) {
		const storageDirs = [{ dir: path.join(root, 'globalStorage'), profile: 'default' }];
		try {
			for (const entry of fs.readdirSync(path.join(root, 'profiles'), { withFileTypes: true })) {
				if (entry.isDirectory()) {
					storageDirs.push({
						dir: path.join(root, 'profiles', entry.name, 'globalStorage'),
						profile: entry.name
					});
				}
			}
		} catch { /* no extra profiles */ }

		for (const { dir, profile } of storageDirs) {
			const dbPath = path.join(dir, 'github.copilot-chat', 'agent-traces.db');
			if (fs.existsSync(dbPath)) {
				out.push({ path: dbPath, channel, profile, size: fs.statSync(dbPath).size });
			}
		}
	}
	const fallback = path.join(os.tmpdir(), 'copilot-agent-traces.db');
	if (fs.existsSync(fallback)) {
		out.push({ path: fallback, channel: 'tmpdir-fallback', profile: '-', size: fs.statSync(fallback).size });
	}
	return out;
}

function probe(entry) {
	console.log('='.repeat(72));
	console.log(`${entry.channel} / profile:${entry.profile}  (${(entry.size / 1024 / 1024).toFixed(2)} MB)`);
	console.log(entry.path);
	console.log('='.repeat(72));

	const db = new DatabaseSync(entry.path, { readOnly: true });
	// Token counts and nano-AIU are INTEGER; node:sqlite throws on anything past
	// Number.MAX_SAFE_INTEGER unless BigInt reads are enabled.
	const q = sql => {
		const st = db.prepare(sql);
		st.setReadBigInts(true);
		return st.all().map(row => {
			const out = {};
			for (const [k, v] of Object.entries(row)) {
				out[k] = typeof v === 'bigint' ? Number(v) : v;
			}
			return out;
		});
	};
	try {
		const tables = q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
		console.log(`\ntables: ${tables.join(', ')}`);

		for (const table of tables) {
			const info = q(`PRAGMA table_info(${table})`);
			const count = q(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;
			console.log(`\n-- ${table}  (${count} rows)`);
			for (const col of info) {
				console.log(`     ${col.name.padEnd(28)} ${col.type}`);
			}
		}

		if (!tables.includes('spans')) {
			console.log('\nNo "spans" table -- schema has changed.');
			return;
		}

		// Attributes live in their own key/value table, not in a JSON column on
		// the span row -- the first version of this probe looked in the wrong
		// place and reported zero cost coverage on a database that had it.
		if (tables.includes('span_attributes')) {
			console.log('\n-- span_attributes keys:');
			for (const r of q('SELECT key, COUNT(*) AS n FROM span_attributes GROUP BY key ORDER BY key')) {
				console.log(`     ${String(r.key).padEnd(48)} x${r.n}`);
			}

			const cost = q(
				`SELECT COUNT(*) AS n, SUM(CAST(value AS REAL)) AS total
				 FROM span_attributes WHERE key = '${NANO_AIU}'`
			)[0];
			console.log(`\n-- cost: ${cost.n} span(s) carry ${NANO_AIU}`);
			console.log(`   raw nano_aiu total: ${cost.total ?? 0}  (~${((Number(cost.total) || 0) * 1e-9).toFixed(4)} credits at the default rate)`);
		} else {
			console.log('\n-- no span_attributes table: no billed-cost data available');
		}

		// Billable calls only. invoke_agent repeats its child chat span's token
		// counts, so counting both doubles every agent turn.
		console.log('\n-- spans by operation:');
		for (const r of q('SELECT operation_name, COUNT(*) AS n FROM spans GROUP BY operation_name ORDER BY n DESC')) {
			const note = r.operation_name === 'chat' ? '  <- billable' : '';
			console.log(`     ${String(r.operation_name).padEnd(20)} ${r.n}${note}`);
		}

		console.log('\n-- chat spans by model and agent:');
		for (const r of q(
			`SELECT response_model, agent_name, COUNT(*) AS n, SUM(input_tokens) AS input
			 FROM spans WHERE operation_name = 'chat'
			 GROUP BY response_model, agent_name ORDER BY input DESC`
		)) {
			console.log(`     ${String(r.response_model).padEnd(26)} ${String(r.agent_name ?? '-').padEnd(20)} ${r.n} req  ${r.input} in`);
		}

		const sessions = q(
			"SELECT COUNT(DISTINCT chat_session_id) AS n FROM spans WHERE chat_session_id IS NOT NULL"
		)[0].n;
		console.log(`\n-- ${sessions} distinct chat_session_id value(s); workspace is resolved by`);
		console.log('   matching these against User/workspaceStorage/*/chatSessions/.');
	} finally {
		db.close();
	}
}

/**
 * "No database" has three quite different causes, and telling them apart is the
 * difference between a useful message and a wild goose chase. Check whether the
 * setting is on, and whether Copilot has logged that instrumentation came up.
 */
function diagnoseMissingDb() {
	const settingOn = userRoots().some(({ root }) => {
		try {
			const raw = fs.readFileSync(path.join(root, 'settings.json'), 'utf8');
			return /"github\.copilot\.chat\.otel\.dbSpanExporter\.enabled"\s*:\s*true/.test(raw);
		} catch {
			return false;
		}
	});

	if (!settingOn) {
		console.log('No agent-traces.db, and local trace collection is not enabled.\n');
		console.log('  1. Add to VS Code USER settings.json:');
		console.log('       "github.copilot.chat.otel.dbSpanExporter.enabled": true');
		console.log('     Do NOT also set "github.copilot.chat.otel.enabled" -- that flips');
		console.log('     Copilot to network export and no database is written.');
		console.log('  2. Restart VS Code.');
		console.log('  3. Use Copilot Chat for a few requests, then re-run this probe.');
		return;
	}

	console.log('No agent-traces.db yet, but the setting IS enabled.\n');

	const started = latestOtelStartup();
	if (started) {
		console.log(`  Copilot logged "Instrumentation enabled" at ${started}.`);
		console.log('  The exporter=otlp-http / endpoint=localhost:4318 text in that line is');
		console.log('  cosmetic -- it echoes config, not the exporter actually built. In');
		console.log('  database-only mode the span exporter is a no-op and nothing is sent.');
		console.log('');
		console.log('  The database is created lazily on the first span flush, so:');
		console.log('    -> send a Copilot Chat request, wait a few seconds, re-run this probe.');
	} else {
		console.log('  No "[OTel] Instrumentation enabled" line found in the VS Code logs.');
		console.log('  The setting requires a reload, and only windows started after the');
		console.log('  change pick it up.');
		console.log('    -> restart VS Code entirely, then send a Copilot Chat request.');
	}
}

/** Most recent OTel startup line across Copilot Chat's per-window logs. */
function latestOtelStartup() {
	let newest;
	for (const { root } of userRoots()) {
		const logsDir = path.join(path.dirname(root), 'logs');
		let sessions = [];
		try {
			sessions = fs.readdirSync(logsDir);
		} catch {
			continue;
		}
		for (const session of sessions) {
			let windows = [];
			try {
				windows = fs.readdirSync(path.join(logsDir, session));
			} catch {
				continue;
			}
			for (const win of windows) {
				const log = path.join(
					logsDir, session, win, 'exthost', 'GitHub.copilot-chat', 'GitHub Copilot Chat.log'
				);
				let text;
				try {
					text = fs.readFileSync(log, 'utf8');
				} catch {
					continue;
				}
				for (const line of text.split('\n')) {
					if (line.includes('[OTel] Instrumentation enabled')) {
						const stamp = line.slice(0, 23);
						if (!newest || stamp > newest) {
							newest = stamp;
						}
					}
				}
			}
		}
	}
	return newest;
}

const dbs = findDbs();
if (dbs.length === 0) {
	diagnoseMissingDb();
	process.exit(1);
}

for (const entry of dbs) {
	try {
		probe(entry);
	} catch (err) {
		console.error(`\nFailed to probe ${entry.path}: ${err.message}`);
	}
	console.log();
}
