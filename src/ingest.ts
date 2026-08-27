import { DatabaseSync } from 'node:sqlite';
import { findTraceDbs, TraceDb } from './locate';
import {
	detectSchema, openReadOnly, prepare, toEpochMs, num, str,
	measureStoredContent,
	SchemaError, SpanSchema, SPAN_TABLE, ATTR_TABLE, NANO_AIU_KEY
} from './schema';
import { sessionToWorkspace } from './workspaces';
import { SelectionIndex } from './selection';
import { Rollup, RollupStore } from './store';
import { backfill, BackfillResult } from './backfill';
import { OnProgress, yieldToLoop } from './progress';

export interface IngestResult {
	dbCount: number;
	/** Earliest span the trace database holds, epoch ms. */
	traceStartMs?: number;
	/** History recovered from VS Code's own chat transcripts. */
	backfill?: BackfillResult;
	spansScanned: number;
	spansCounted: number;
	costSpans: number;
	/** Spans whose stored attributes include prompt/response/tool-result text. */
	contentSpans: number;
	contentBytes: number;
	errors: string[];
	schemas: { db: string; schema: SpanSchema | undefined; error?: string }[];
}

/** Re-read a small overlap so spans committed out of order aren't dropped. */
const OVERLAP_MS = 5 * 60 * 1000;

/**
 * Only `chat` spans are billable LLM calls.
 *
 * This filter is load-bearing. An agent turn produces an `invoke_agent` span
 * that repeats its child `chat` span's token counts verbatim -- 18,183 input
 * tokens appearing on both -- while carrying no cost attribute of its own.
 * Counting every span with tokens on it would double every agent turn.
 * `execute_tool` spans carry no tokens at all.
 */
const BILLABLE_OPERATION = 'chat';

/** `dbs` is injectable so the pipeline can be exercised against fixtures. */
export async function ingestAll(
	store: RollupStore,
	dbs: TraceDb[] = findTraceDbs(),
	onProgress?: OnProgress,
	/**
	 * Where to look for chat transcripts. Injectable so a test can pass `[]`:
	 * the default reads the real user directories, which silently mixed live
	 * transcripts into fixture-based runs.
	 */
	sessionDirs?: string[]
): Promise<IngestResult> {
	const result: IngestResult = {
		dbCount: dbs.length,
		spansScanned: 0,
		spansCounted: 0,
		costSpans: 0,
		contentSpans: 0,
		contentBytes: 0,
		errors: [],
		schemas: []
	};

	for (const [index, db] of dbs.entries()) {
		onProgress?.({ phase: 'reading-traces', done: index, total: dbs.length });
		try {
			ingestOne(db, store, result);
			// One database per unit of work: reading spans is the other place
			// this used to hold the editor's only thread for a long time.
			await yieldToLoop();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result.errors.push(`${db.channel}/${db.profile}: ${message}`);
			result.schemas.push({ db: db.path, schema: undefined, error: message });
		}
	}

	// Everything before trace collection was switched on lives only in the chat
	// transcripts. Without this the panel shows hours of history on a machine
	// with a year of usage.
	try {
		onProgress?.({ phase: 'reading-history' });
		result.backfill = await backfill(
			store, result.traceStartMs, sessionDirs, Date.now(), onProgress
		);
	} catch (err) {
		result.errors.push(`backfill: ${err instanceof Error ? err.message : String(err)}`);
	}

	// A thread untouched for this long will not gain more turns.
	store.pruneTurns(90 * 24 * 60 * 60 * 1000);
	store.save();
	return result;
}

function ingestOne(traceDb: TraceDb, store: RollupStore, result: IngestResult): void {
	let db: DatabaseSync | undefined;
	try {
		db = openReadOnly(traceDb.path);
		const schema = detectSchema(db);
		result.schemas.push({ db: traceDb.path, schema });

		const cursor = store.getCursor(traceDb.path);
		const since = cursor > 0 ? cursor - OVERLAP_MS : 0;

		const has = (column: string) => schema.columns.has(column);
		const col = (column: string, fallback = 'NULL') =>
			has(column) ? `s."${column}"` : fallback;

		// Cost lives in span_attributes rather than on the span row, so pull it
		// with a correlated subquery. It is the only attribute we need.
		const nano = schema.hasAttributes
			? `(SELECT value FROM ${ATTR_TABLE} WHERE span_id = s.span_id AND key = '${NANO_AIU_KEY}')`
			: 'NULL';

		const sql =
			`SELECT s.span_id AS span_id, s.start_time_ms AS start_ms, ` +
			`${col('response_model')} AS response_model, ` +
			`${col('request_model')} AS request_model, ` +
			`${col('agent_name')} AS agent_name, ` +
			`${col('input_tokens', '0')} AS input_tokens, ` +
			`${col('output_tokens', '0')} AS output_tokens, ` +
			`${col('cached_tokens', '0')} AS cached_tokens, ` +
			`${col('reasoning_tokens', '0')} AS reasoning_tokens, ` +
			`${col('chat_session_id')} AS chat_session_id, ` +
			`${nano} AS nano_aiu ` +
			`FROM ${SPAN_TABLE} s ` +
			`WHERE s.operation_name = ? AND s.start_time_ms >= ? ` +
			// Turn ordinals are only meaningful in time order.
			`ORDER BY s.start_time_ms ASC`;

		const rows = prepare(db, sql)
			.all(BILLABLE_OPERATION, since) as unknown as Record<string, unknown>[];

		// The earliest span overall, so the backfill knows where to stop.
		const earliest = prepare(db, `SELECT MIN(start_time_ms) AS t FROM ${SPAN_TABLE}`)
			.all()[0] as unknown as { t: unknown };
		const earliestMs = toEpochMs(earliest?.t);
		if (earliestMs !== undefined) {
			result.traceStartMs = result.traceStartMs === undefined
				? earliestMs
				: Math.min(result.traceStartMs, earliestMs);
		}

		if (schema.hasAttributes) {
			const content = measureStoredContent(db);
			result.contentSpans += content.spans;
			result.contentBytes += content.bytes;
		}

		const workspaces = sessionToWorkspace(traceDb.userDir);
		const selections = new SelectionIndex(traceDb.userDir);
		const seen = store.getSeen(traceDb.path);
		let maxSeen = cursor;

		for (const row of rows) {
			result.spansScanned++;

			const when = toEpochMs(row.start_ms);
			if (when === undefined || when < since) {
				continue;
			}

			const spanId = str(row.span_id);
			if (spanId && seen.has(spanId)) {
				continue;
			}

			const nanoAiu = num(row.nano_aiu);
			if (nanoAiu > 0) {
				result.costSpans++;
			}

			const sessionId = str(row.chat_session_id);
			const inputTokens = num(row.input_tokens);
			const cacheReadTokens = num(row.cached_tokens);
			// A request that read nothing from the cache paid full price for
			// every token of context it carried. Splitting it out here is what
			// lets the report say how much that cost, rather than reporting a
			// cache-hit percentage with no action attached to it.
			const missed = cacheReadTokens === 0;
			const model = str(row.response_model) ?? str(row.request_model) ?? 'unknown';

			store.add({
				day: dayKey(when),
				model,
				workspace: (sessionId && workspaces.get(sessionId)) || 'unknown',
				// The trace database resolves the model before recording it, so
				// whether Auto did the choosing survives only in VS Code's own
				// session files.
				selection: selections.lookup(sessionId, model),
				source: 'measured',
				// `agent_name` separates the request you made ("panel/editAgent")
				// from the auxiliary calls Copilot makes on your behalf ("title",
				// "progressMessages"), which is exactly the breakdown that explains
				// a surprising bill.
				operation: str(row.agent_name) ?? BILLABLE_OPERATION,
				requests: 1,
				inputTokens,
				outputTokens: num(row.output_tokens),
				reasoningTokens: num(row.reasoning_tokens),
				cacheReadTokens,
				cacheWriteTokens: 0,
				nanoAiu,
				missRequests: missed ? 1 : 0,
				missInputTokens: missed ? inputTokens : 0,
				missNanoAiu: missed ? nanoAiu : 0
			});

			// Per-request, before the rollup aggregates the variation away.
			store.observePrice(
				model, inputTokens - cacheReadTokens, cacheReadTokens,
				num(row.output_tokens), nanoAiu
			);

			// How deep into its thread this request was. Spans without a session
			// (background work) have no thread and are left out of the picture.
			if (sessionId) {
				const turn = store.nextTurn(sessionId, when);
				store.observeDepth(turn, nanoAiu, cacheReadTokens > 0);
			}

			result.spansCounted++;
			maxSeen = Math.max(maxSeen, when);
			if (spanId) {
				seen.set(spanId, when);
			}
		}

		store.setCursor(traceDb.path, maxSeen, seen, OVERLAP_MS);
	} finally {
		db?.close();
	}
}

export function dayKey(epochMs: number): string {
	const d = new Date(epochMs);
	const month = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${month}-${day}`;
}

export { SchemaError, Rollup };
