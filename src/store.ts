import * as fs from 'fs';
import * as path from 'path';
import { Selection } from './selection';

export type Source = 'measured' | 'reported';
import { PriceStats, emptyStats, accumulate } from './pricing';

/**
 * Our own rollup, deliberately separate from `agent-traces.db`.
 *
 * Two reasons this layer exists rather than querying the trace database
 * directly on every render: the upstream database is owned by another
 * extension and has no observable retention policy, and rolling up to
 * (day, model, workspace, operation) bounds our storage and query cost no
 * matter how large it grows.
 */

export interface Rollup {
	day: string;
	model: string;
	workspace: string;
	operation: string;
	/**
	 * Whether the model was picked by you or by Auto.
	 *
	 * A dimension rather than a derived figure because it changes what the
	 * advice should say, not merely how it reads: telling someone to route
	 * away from a model Auto chose is advice about a decision they never made.
	 */
	selection: Selection;
	/**
	 * Where the figures came from.
	 *
	 * `measured` is `agent-traces.db`: the cost Copilot reported per request.
	 * `reported` is VS Code's own chat transcript, which is the only record of
	 * anything that happened before trace collection was switched on -- and
	 * which omits retried and cancelled messages, so it is a floor rather than
	 * a total. The two must never be added into one burn rate.
	 */
	source: Source;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	nanoAiu: number;
	/**
	 * The subset of the above attributable to requests that read nothing from
	 * the prompt cache.
	 *
	 * Kept as a subset rather than a key dimension so the rollup does not
	 * fragment: hit figures are the total minus these. Uncached input is the
	 * single largest controllable cost -- an identical prompt billed 5.9
	 * credits cold against 1.06 warm -- and it is visible per-span in
	 * `agent-traces.db` and in no other source.
	 */
	missRequests: number;
	missInputTokens: number;
	missNanoAiu: number;
}

interface Cursor {
	/** Highest span timestamp ingested, epoch ms. */
	watermark: number;
	/**
	 * Span ids seen inside the trailing overlap window, mapped to their
	 * timestamps so the set can be pruned by age.
	 *
	 * Storing timestamps rather than a bare list matters: a run that counts
	 * nothing must still carry forward the ids of the previous run, or the
	 * next run re-reads the overlap window with no memory and double-counts it.
	 */
	seen: Record<string, number>;
}

interface Persisted {
	version: number;
	rollups: Record<string, Rollup>;
	cursors: Record<string, Cursor>;
	/**
	 * Per-model sufficient statistics for the rate-card fit.
	 *
	 * Kept outside the rollup because the regression needs per-request
	 * variation, which aggregation destroys -- but only the statistics are
	 * kept, never the requests.
	 */
	prices: Record<string, PriceStats>;
	/**
	 * Cost by how deep into a thread a request was.
	 *
	 * The single most actionable thing the telemetry knows: the whole
	 * conversation is re-sent every turn, so the same question costs more the
	 * longer the thread. Bucketing bounds this to five rows no matter how much
	 * history accumulates.
	 */
	depth: Record<string, DepthStats>;
	/** Turns counted per chat session so far, so ordinals survive restarts. */
	turns: Record<string, { count: number; seen: number }>;
	/**
	 * Request ids already recovered, mapped to their day so the set can be
	 * pruned to the window. A flat list grew without bound.
	 */
	backfilled: Record<string, string>;
	/**
	 * Per-transcript digest: size and mtime as last processed.
	 *
	 * History does not change once written, so a transcript whose size and
	 * mtime match what was already read cannot hold anything new and is never
	 * opened again. Without this every launch re-parsed every transcript
	 * touched in the window, only to find each turn already counted.
	 */
	backfilledFiles: Record<string, { mtimeMs: number; size: number }>;
}

export interface DepthStats {
	requests: number;
	nanoAiu: number;
	/** Requests that read from the cache -- a cold start is a different story. */
	warmRequests: number;
	warmNanoAiu: number;
}

/** Ordinal ranges, chosen so each holds a recognisable kind of thread. */
export const DEPTH_BUCKETS: { label: string; min: number; max: number }[] = [
	{ label: '1st message', min: 1, max: 1 },
	{ label: '2nd-3rd', min: 2, max: 3 },
	{ label: '4th-7th', min: 4, max: 7 },
	{ label: '8th-15th', min: 8, max: 15 },
	{ label: '16th on', min: 16, max: Infinity }
];

export function depthBucket(turn: number): string {
	return (DEPTH_BUCKETS.find(b => turn >= b.min && turn <= b.max) ?? DEPTH_BUCKETS[0]).label;
}

const VERSION = 8;

/** Distinguishes concurrent writes to the same store. */
let writeCounter = 0;

function keyOf(
	r: Pick<Rollup, 'day' | 'model' | 'workspace' | 'operation' | 'selection' | 'source'>
): string {
	return `${r.day} ${r.model} ${r.workspace} ${r.operation} ${r.selection} ${r.source}`;
}

export class RollupStore {
	private data: Persisted =
		{ version: VERSION, rollups: {}, cursors: {}, prices: {}, depth: {}, turns: {},
		  backfilled: {}, backfilledFiles: {} };
	private dirty = false;

	constructor(private readonly file: string) {
		this.load();
	}

	private load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Persisted;
			if (parsed.version === VERSION) {
				this.data = parsed;
			}
			// A version mismatch discards the rollup rather than migrating it.
			// Acceptable while the upstream schema is still unstable: the trace
			// database is the source of truth and a full re-ingest rebuilds us.
		} catch {
			// No store yet, or it is unreadable. Start clean.
		}
	}

	/**
	 * Write atomically, without a shared scratch file.
	 *
	 * The temporary name carries a counter because two saves can be in flight
	 * at once: the pipeline yields to the event loop, so a second refresh can
	 * interleave with the first. Both used to write `rollup.json.tmp`, the
	 * first renamed it away, and the second failed with ENOENT on a file that
	 * had just been moved out from under it.
	 */
	save(): void {
		if (!this.dirty) {
			return;
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.${++writeCounter}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
			fs.renameSync(tmp, this.file);
		} catch (err) {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// Nothing more to do; the next save will write a fresh file.
			}
			throw err;
		}
		this.dirty = false;
	}

	add(entry: Rollup): void {
		const key = keyOf(entry);
		const existing = this.data.rollups[key];
		if (existing) {
			existing.requests += entry.requests;
			existing.inputTokens += entry.inputTokens;
			existing.outputTokens += entry.outputTokens;
			existing.reasoningTokens += entry.reasoningTokens;
			existing.cacheReadTokens += entry.cacheReadTokens;
			existing.cacheWriteTokens += entry.cacheWriteTokens;
			existing.nanoAiu += entry.nanoAiu;
			existing.missRequests += entry.missRequests;
			existing.missInputTokens += entry.missInputTokens;
			existing.missNanoAiu += entry.missNanoAiu;
		} else {
			this.data.rollups[key] = { ...entry };
		}
		this.dirty = true;
	}

	getCursor(dbPath: string): number {
		return this.data.cursors[dbPath]?.watermark ?? 0;
	}

	getSeen(dbPath: string): Map<string, number> {
		return new Map(Object.entries(this.data.cursors[dbPath]?.seen ?? {}));
	}

	/** `retainMs` must match the ingest overlap window. */
	setCursor(
		dbPath: string,
		watermark: number,
		seen: Map<string, number>,
		retainMs: number
	): void {
		const cutoff = watermark - retainMs;
		const kept: Record<string, number> = {};
		for (const [id, when] of seen) {
			if (when >= cutoff) {
				kept[id] = when;
			}
		}
		this.data.cursors[dbPath] = { watermark, seen: kept };
		this.dirty = true;
	}

	/** One request's contribution to its model's rate-card fit. */
	observePrice(
		model: string,
		freshTokens: number,
		cachedTokens: number,
		outputTokens: number,
		nanoAiu: number
	): void {
		const stats = (this.data.prices[model] ??= emptyStats());
		accumulate(stats, freshTokens, cachedTokens, outputTokens, nanoAiu);
		this.dirty = true;
	}

	/** The next turn ordinal for a session, and remember it. */
	nextTurn(sessionId: string, when: number): number {
		const entry = (this.data.turns[sessionId] ??= { count: 0, seen: 0 });
		entry.count += 1;
		entry.seen = Math.max(entry.seen, when);
		this.dirty = true;
		return entry.count;
	}

	observeDepth(turn: number, nanoAiu: number, warm: boolean): void {
		const key = depthBucket(turn);
		const d = (this.data.depth[key] ??=
			{ requests: 0, nanoAiu: 0, warmRequests: 0, warmNanoAiu: 0 });
		d.requests += 1;
		d.nanoAiu += nanoAiu;
		if (warm) {
			d.warmRequests += 1;
			d.warmNanoAiu += nanoAiu;
		}
		this.dirty = true;
	}

	depthStats(): Record<string, DepthStats> {
		return this.data.depth ?? {};
	}

	/** Session turn counters are unbounded otherwise; old threads cannot grow. */
	pruneTurns(olderThanMs: number): void {
		const cutoff = Date.now() - olderThanMs;
		for (const [id, entry] of Object.entries(this.data.turns ?? {})) {
			if (entry.seen < cutoff) {
				delete this.data.turns[id];
				this.dirty = true;
			}
		}
	}

	backfilledTurns(): Map<string, string> {
		return new Map(Object.entries(this.data.backfilled ?? {}));
	}

	setBackfilledTurns(ids: Map<string, string>): void {
		this.data.backfilled = Object.fromEntries(ids);
		this.dirty = true;
	}

	/** What this transcript looked like when it was last read, if ever. */
	backfilledFile(file: string): { mtimeMs: number; size: number } | undefined {
		return this.data.backfilledFiles?.[file];
	}

	markBackfilledFile(file: string, mtimeMs: number, size: number): void {
		(this.data.backfilledFiles ??= {})[file] = { mtimeMs, size };
		this.dirty = true;
	}

	/**
	 * Forget turns that fell out of the window and transcripts that are gone.
	 *
	 * Both records would otherwise grow for as long as the extension is
	 * installed, and neither is useful once the day it covers is off the end.
	 */
	pruneBackfill(horizonDay: string, livePaths: Set<string>): void {
		for (const [id, day] of Object.entries(this.data.backfilled ?? {})) {
			if (day < horizonDay) {
				delete this.data.backfilled[id];
				this.dirty = true;
			}
		}
		for (const file of Object.keys(this.data.backfilledFiles ?? {})) {
			if (!livePaths.has(file)) {
				delete this.data.backfilledFiles[file];
				this.dirty = true;
			}
		}
	}

	priceStats(): Record<string, PriceStats> {
		return this.data.prices ?? {};
	}

	all(): Rollup[] {
		return Object.values(this.data.rollups);
	}

	since(days: number): Rollup[] {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - days);
		const key = cutoff.toISOString().slice(0, 10);
		return this.all().filter(r => r.day >= key);
	}

	reset(): void {
		this.data =
			{ version: VERSION, rollups: {}, cursors: {}, prices: {}, depth: {}, turns: {},
		  backfilled: {}, backfilledFiles: {} };
		this.dirty = true;
		this.save();
	}
}

export interface Totals {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	nanoAiu: number;
	missRequests: number;
	missInputTokens: number;
	missNanoAiu: number;
}

export function sum(rollups: Rollup[]): Totals {
	const totals: Totals = {
		requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
		cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 0,
		missRequests: 0, missInputTokens: 0, missNanoAiu: 0
	};
	for (const r of rollups) {
		totals.requests += r.requests;
		totals.inputTokens += r.inputTokens;
		totals.outputTokens += r.outputTokens;
		totals.reasoningTokens += r.reasoningTokens;
		totals.cacheReadTokens += r.cacheReadTokens;
		totals.cacheWriteTokens += r.cacheWriteTokens;
		totals.nanoAiu += r.nanoAiu;
		totals.missRequests += r.missRequests;
		totals.missInputTokens += r.missInputTokens;
		totals.missNanoAiu += r.missNanoAiu;
	}
	return totals;
}

export function groupBy(rollups: Rollup[], field: keyof Rollup): Map<string, Totals> {
	const groups = new Map<string, Rollup[]>();
	for (const r of rollups) {
		const key = String(r[field]);
		const bucket = groups.get(key);
		if (bucket) {
			bucket.push(r);
		} else {
			groups.set(key, [r]);
		}
	}
	const out = new Map<string, Totals>();
	for (const [key, bucket] of groups) {
		out.set(key, sum(bucket));
	}
	return out;
}
