import { DatabaseSync } from 'node:sqlite';
import { findTraceDbs } from './locate';
import { ATTR_TABLE, num } from './schema';

/**
 * Deletes retained prompt/response/tool-schema payloads from the trace database.
 *
 * This is the one place Token Pie writes to a database it does not own, and
 * the exception is deliberate. Three call sites in copilot-chat 0.62.0 call the
 * attribute truncator without passing a limit:
 *
 *   span.setAttribute(OUTPUT_MESSAGES,  truncate(JSON.stringify([...])))   // no max
 *   span.setAttribute(TOOL_DEFINITIONS, truncate(toolJson))                // no max
 *   span.addEvent("tools_available",  { toolDefinitions: truncate(json) }) // no max
 *
 * `truncate(s, max = 0)` returns `s` untouched when max <= 0, so
 * `maxAttributeSizeChars` cannot reach them. There is no setting that suppresses
 * these; the only remedy short of an upstream fix is to remove the rows after
 * the fact.
 *
 * Safe to run alongside Copilot: SQLite serialises writers, the statements are
 * bounded, and none of these rows are read by Token Pie. A locked database
 * is reported rather than retried into contention.
 */

/** Attribute keys that survive truncation and hold model output or tool schemas. */
const PURGE_KEYS = [
	'gen_ai.output.messages',
	'gen_ai.tool.definitions',
	'gen_ai.tool.description'
];

const PURGE_EVENTS = ['tools_available'];

export interface PurgeResult {
	db: string;
	attributeRows: number;
	eventRows: number;
	bytesFreed: number;
	vacuumed: boolean;
	/** Another writer held the lock; nothing was changed. Safe to ignore. */
	skippedBusy?: boolean;
	error?: string;
}

export interface PurgeOptions {
	/**
	 * How long to wait for a lock. Deliberately short when running automatically:
	 * blocking Copilot's own writes to reclaim disk is a bad trade, and the purge
	 * is idempotent, so skipping this cycle costs nothing.
	 */
	busyTimeoutMs?: number;
	/**
	 * Reclaim free pages. VACUUM takes an exclusive lock and rewrites the file,
	 * so on the automatic path we only do it once enough has accumulated.
	 */
	vacuum?: boolean | 'auto';
}

/**
 * Reclaim once ~256 KB of free pages have built up (4 KB pages).
 *
 * Measured on a 59.6 MB backlog: DELETE 19 ms, checkpoint 4 ms, VACUUM 2 ms.
 * In steady state the whole cycle is under 3 ms, because purging keeps the
 * database near 0.5 MB and VACUUM never has much to rewrite.
 */
const VACUUM_FREELIST_PAGES = 64;

function countEvents(db: DatabaseSync): number {
	try {
		const placeholders = PURGE_EVENTS.map(() => '?').join(', ');
		const row = db
			.prepare(`SELECT COUNT(*) AS n FROM span_events WHERE name IN (${placeholders})`)
			.get(...PURGE_EVENTS) as { n: unknown };
		return num(row?.n);
	} catch {
		return 0;
	}
}

function shouldVacuum(db: DatabaseSync, mode: boolean | 'auto'): boolean {
	if (mode !== 'auto') {
		return mode;
	}
	try {
		const row = db.prepare('PRAGMA freelist_count').get() as { freelist_count: unknown };
		return num(row?.freelist_count) >= VACUUM_FREELIST_PAGES;
	} catch {
		return false;
	}
}

/** Fold the WAL into the database and truncate it. Best effort. */
function checkpoint(db: DatabaseSync): void {
	try {
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	} catch {
		try {
			// A concurrent reader can block TRUNCATE; PASSIVE still folds what it can.
			db.exec('PRAGMA wal_checkpoint(PASSIVE)');
		} catch {
			// Next run, or when Copilot closes the database.
		}
	}
}

export function purgeAll(options: PurgeOptions = {}): PurgeResult[] {
	return findTraceDbs().map(entry => purgeOne(entry.path, options));
}

export function purgeOne(dbPath: string, options: PurgeOptions = {}): PurgeResult {
	const result: PurgeResult = {
		db: dbPath, attributeRows: 0, eventRows: 0, bytesFreed: 0, vacuumed: false
	};
	let db: DatabaseSync | undefined;

	try {
		db = new DatabaseSync(dbPath);
		// Fail fast instead of blocking a developer's editor behind our lock.
		db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 2000}`);

		const attrPlaceholders = PURGE_KEYS.map(() => '?').join(', ');

		// Probe before writing. A no-op costs 0.4 ms and takes no write lock at
		// all, which is what most automatic runs will do.
		const pending = num(
			(db
				.prepare(
					`SELECT COUNT(*) AS n FROM ${ATTR_TABLE} ` +
					`WHERE key IN (${attrPlaceholders}) AND LENGTH(value) > 1`
				)
				.get(...PURGE_KEYS) as { n: unknown })?.n
		);
		const pendingEvents = countEvents(db);
		if (pending === 0 && pendingEvents === 0 && options.vacuum !== true) {
			return result;
		}
		const measured = db
			.prepare(
				`SELECT COUNT(*) AS n, SUM(LENGTH(value)) AS b FROM ${ATTR_TABLE} ` +
				`WHERE key IN (${attrPlaceholders}) AND LENGTH(value) > 1`
			)
			.get(...PURGE_KEYS) as { n: unknown; b: unknown };
		result.attributeRows = num(measured?.n);
		result.bytesFreed += num(measured?.b);

		db.prepare(
			`DELETE FROM ${ATTR_TABLE} WHERE key IN (${attrPlaceholders}) AND LENGTH(value) > 1`
		).run(...PURGE_KEYS);

		// span_events is optional in the schema; ignore it if absent.
		try {
			const eventPlaceholders = PURGE_EVENTS.map(() => '?').join(', ');
			const events = db
				.prepare(
					`SELECT COUNT(*) AS n, SUM(LENGTH(attributes)) AS b FROM span_events ` +
					`WHERE name IN (${eventPlaceholders})`
				)
				.get(...PURGE_EVENTS) as { n: unknown; b: unknown };
			result.eventRows = num(events?.n);
			result.bytesFreed += num(events?.b);

			db.prepare(
				`DELETE FROM span_events WHERE name IN (${eventPlaceholders})`
			).run(...PURGE_EVENTS);
		} catch {
			// No span_events table on this schema version.
		}

		// Order matters. In WAL mode the superseded pages -- including the content
		// just deleted -- live in the -wal file until a checkpoint folds them into
		// the database. Checkpoint first so VACUUM rewrites a database that
		// already reflects the deletes; VACUUM first would fold 800 KB of stale
		// WAL back into a freshly compacted file and grow it instead.
		checkpoint(db);

		if (shouldVacuum(db, options.vacuum ?? 'auto')) {
			try {
				db.exec('VACUUM');
				result.vacuumed = true;
				// VACUUM itself writes through the WAL, so fold that in too.
				checkpoint(db);
			} catch {
				// A reader in another window holds a lock; left for the next run.
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Losing a race with Copilot's own writer is expected and harmless.
		if (/busy|locked/i.test(message)) {
			result.skippedBusy = true;
		} else {
			result.error = message;
		}
	} finally {
		db?.close();
	}

	return result;
}
