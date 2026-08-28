import { DatabaseSync } from 'node:sqlite';

/**
 * Schema for `agent-traces.db` as written by github.copilot-chat 0.62.0
 * (`schema_version` = 1).
 *
 * The database turned out to be far friendlier than a generic OTel span dump:
 * `spans` carries first-class typed columns for everything that matters
 * (models, token counts, operation, session), and only the long tail lives in
 * the `span_attributes` key/value table. We read the columns directly and dip
 * into `span_attributes` for exactly one thing -- the billed cost.
 *
 * Columns are still verified at runtime rather than assumed, so a schema change
 * surfaces as a clear error instead of silently wrong numbers.
 */

export const SPAN_TABLE = 'spans';
export const ATTR_TABLE = 'span_attributes';
export const NANO_AIU_KEY = 'copilot_chat.copilot_usage_nano_aiu';
/**
 * Tokens written into the prompt cache, which bill at a premium over plain
 * input -- $2.50 per million against $2.00 for claude-sonnet-5.
 *
 * Unlike the token counts, this has no column on `spans`; it exists only as an
 * attribute, and only for providers that charge for cache writes. Its absence
 * on a model is a fact about that model's billing, not a gap in the data.
 */
export const CACHE_WRITE_KEY = 'gen_ai.usage.cache_creation.input_tokens';

/** Verified against schema_version 1. Higher versions are read optimistically. */
export const KNOWN_SCHEMA_VERSION = 1;

/** Without these we cannot produce a usage report at all. */
const REQUIRED = ['span_id', 'start_time_ms', 'operation_name'] as const;

/** Read when present; absent ones degrade to zero or "unknown". */
const OPTIONAL = [
	'request_model', 'response_model', 'agent_name',
	'input_tokens', 'output_tokens', 'cached_tokens', 'reasoning_tokens',
	'chat_session_id', 'conversation_id'
] as const;

export interface SpanSchema {
	version: number | undefined;
	columns: Set<string>;
	hasAttributes: boolean;
	missingOptional: string[];
}

export class SchemaError extends Error {}

export function openReadOnly(dbPath: string): DatabaseSync {
	// Read-only is not optional. Every open VS Code window runs its own
	// extension host writing to this file; adding another writer would risk
	// corrupting data we don't own.
	return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Prepare a statement that can read 64-bit integers.
 *
 * `start_time_ms` is milliseconds and fits comfortably in a double, but token
 * counts and nano-AIU values are stored as INTEGER and node:sqlite throws
 * outright on anything past Number.MAX_SAFE_INTEGER rather than truncating.
 * Opting into BigInt everywhere costs nothing -- num() and toEpochMs() both
 * accept bigint -- and removes a whole class of runtime failure.
 */
export function prepare(db: DatabaseSync, sql: string) {
	const statement = db.prepare(sql);
	statement.setReadBigInts(true);
	return statement;
}

function tableNames(db: DatabaseSync): Set<string> {
	const rows = prepare(db, "SELECT name FROM sqlite_master WHERE type='table'")
		.all() as unknown as { name: string }[];
	return new Set(rows.map(r => r.name));
}

export function detectSchema(db: DatabaseSync): SpanSchema {
	const tables = tableNames(db);
	if (!tables.has(SPAN_TABLE)) {
		throw new SchemaError(
			`No "${SPAN_TABLE}" table. Found: ${[...tables].join(', ') || '(none)'}`
		);
	}

	let version: number | undefined;
	if (tables.has('schema_version')) {
		const row = prepare(db, 'SELECT version FROM schema_version LIMIT 1')
			.get() as unknown as { version: unknown } | undefined;
		version = row ? num(row.version) : undefined;
	}

	const info = prepare(db, `PRAGMA table_info(${SPAN_TABLE})`)
		.all() as unknown as { name: string }[];
	const columns = new Set(info.map(c => c.name));

	const missingRequired = REQUIRED.filter(c => !columns.has(c));
	if (missingRequired.length > 0) {
		throw new SchemaError(
			`"${SPAN_TABLE}" is missing required column(s): ${missingRequired.join(', ')}. ` +
			`Present: ${[...columns].join(', ')}`
		);
	}

	return {
		version,
		columns,
		hasAttributes: tables.has(ATTR_TABLE),
		missingOptional: OPTIONAL.filter(c => !columns.has(c))
	};
}

/** `start_time_ms` is already epoch milliseconds; normalise defensively anyway. */
export function toEpochMs(value: unknown): number | undefined {
	if (typeof value === 'bigint') {
		return toEpochMs(Number(value));
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) {
			return undefined;
		}
		if (value > 1e17) { return value / 1e6; }   // nanoseconds
		if (value > 1e14) { return value / 1e3; }   // microseconds
		if (value > 1e11) { return value; }         // milliseconds
		return value * 1000;                        // seconds
	}
	if (typeof value === 'string') {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && value.trim() !== '') {
			return toEpochMs(numeric);
		}
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

export function num(value: unknown): number {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : 0;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

export function str(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	return undefined;
}

/**
 * Attribute keys that hold prompt, response, or tool-result text.
 *
 * These are written to the local database even with
 * `github.copilot.chat.otel.captureContent` left at its default of `false` --
 * confirmed empirically against schema_version 1, where the startup log
 * reported `captureContent=false` and `gen_ai.input.messages` still contained
 * verbatim prompt text. Treat the database as containing source-derived
 * content: it is local-only, but it is unencrypted on disk.
 */
export const CONTENT_KEYS = [
	'gen_ai.input.messages',
	'gen_ai.output.messages',
	'gen_ai.system_instructions',
	'gen_ai.tool.call.arguments',
	'gen_ai.tool.call.result',
	'copilot_chat.user_request'
];

/** How many spans carry content-bearing attributes, and how many bytes they hold. */
export function measureStoredContent(
	db: DatabaseSync
): { spans: number; bytes: number } {
	const placeholders = CONTENT_KEYS.map(() => '?').join(', ');
	try {
		const row = prepare(
			db,
			`SELECT COUNT(DISTINCT span_id) AS spans, SUM(LENGTH(value)) AS bytes ` +
			`FROM ${ATTR_TABLE} WHERE key IN (${placeholders})`
		).get(...CONTENT_KEYS) as unknown as { spans: unknown; bytes: unknown };
		return { spans: num(row?.spans), bytes: num(row?.bytes) };
	} catch {
		return { spans: 0, bytes: 0 };
	}
}
