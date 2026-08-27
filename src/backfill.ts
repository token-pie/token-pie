import { Rollup, RollupStore } from './store';
import * as fs from 'fs';
import { userDirs, readSessionFileCached, findSessionFiles, Turn } from './sessions';
import { OnProgress, yieldToLoop, YIELD_EVERY } from './progress';
import { dayKey } from './ingest';

/**
 * Everything that happened before trace collection was switched on.
 *
 * `agent-traces.db` is written only once the exporter setting is enabled and
 * has no retroactive contents: on a machine with thirteen months of Copilot
 * use it held two and a half hours. VS Code's own chat transcripts go back as
 * far as the sessions do, so they are the only record of the rest.
 *
 * They are a **floor, not a total**. `copilotCredits` records completed user
 * turns and omits the retries and cancellations you were still charged for --
 * measured at roughly a 55% shortfall on agent work. Backfilled days are
 * therefore marked `reported`, kept strictly to days the trace database does
 * not cover, and excluded from the burn rate that drives the throttle
 * projection: an undercount there would say "you are fine" to someone who is
 * not.
 */

export interface BackfillResult {
	daysAdded: number;
	turnsCounted: number;
	turnsWithoutCost: number;
	/** Earliest day now represented, from either source. */
	earliestDay?: string;
	/** Chat transcripts found, and how many carried any cost figure. */
	sessionFiles: number;
	sessionFilesWithCost: number;
	/** Oldest transcript on the machine, whether or not it has cost in it. */
	oldestTranscriptDay?: string;
}

/** The panel shows a rolling 30 days; recovering more would display nowhere. */
export const BACKFILL_DAYS = 30;

export async function backfill(
	store: RollupStore,
	/** Epoch ms of the earliest span the trace database holds, if any. */
	traceStartMs: number | undefined,
	dirs: string[] = userDirs(),
	now = Date.now(),
	onProgress?: OnProgress
): Promise<BackfillResult> {
	const result: BackfillResult = {
		daysAdded: 0, turnsCounted: 0, turnsWithoutCost: 0,
		sessionFiles: 0, sessionFilesWithCost: 0
	};

	// Anything on or after the day the trace database begins is already counted
	// properly. Overlapping the two sources on one day would double it.
	const cutoff = traceStartMs !== undefined ? dayKey(traceStartMs) : undefined;
	const horizon = dayKey(now - BACKFILL_DAYS * 86_400_000);

	const seen = store.backfilledTurns();
	const days = new Set<string>();

	const notBefore = now - BACKFILL_DAYS * 86_400_000;
	const files = dirs.flatMap(dir => findSessionFiles(dir));
	result.sessionFiles = files.length;

	let processed = 0;
	for (const sf of files) {
		const stamp = fileDay(sf.file);
		if (stamp && (!result.oldestTranscriptDay || stamp < result.oldestTranscriptDay)) {
			result.oldestTranscriptDay = stamp;
		}

		// One transcript per unit of work, with the loop given a turn every few
		// of them. A single pass over every file blocked the editor outright.
		const turns = readSessionFileCached(sf, notBefore);
		if (++processed % YIELD_EVERY === 0) {
			onProgress?.({ phase: 'reading-history', done: processed, total: files.length });
			await yieldToLoop();
		}
		if (!turns) {
			continue;
		}
		if (turns.some(t => t.credits !== undefined)) {
			result.sessionFilesWithCost++;
		}

		for (const turn of turns) {
			if (!Number.isFinite(turn.timestamp) || turn.timestamp <= 0) {
				continue;
			}
			const day = dayKey(turn.timestamp);
			if (day < horizon) {
				continue;
			}
			if (cutoff !== undefined && day >= cutoff) {
				continue;
			}
			if (seen.has(turn.requestId)) {
				continue;
			}
			seen.add(turn.requestId);
			days.add(day);
			result.turnsCounted++;
			if (turn.credits === undefined) {
				result.turnsWithoutCost++;
			}
			store.add(toRollup(turn, day));
		}
	}

	store.setBackfilledTurns(seen);
	result.daysAdded = days.size;
	result.earliestDay = [...days].sort()[0];
	return result;
}

/**
 * `credits` here is VS Code's own figure, converted back into the nano-AIU the
 * rest of the pipeline speaks so that one column means one thing everywhere.
 */
function fileDay(file: string): string | undefined {
	try {
		return dayKey(fs.statSync(file).mtimeMs);
	} catch {
		return undefined;
	}
}

function toRollup(turn: Turn, day: string): Rollup {
	return {
		day,
		model: turn.model || 'unknown',
		workspace: turn.workspace || 'unknown',
		// The transcript does not record which agent made the call.
		operation: 'chat',
		selection: 'unknown',
		source: 'reported',
		requests: 1,
		inputTokens: turn.promptTokens,
		outputTokens: turn.completionTokens,
		reasoningTokens: 0,
		// The transcript reports no cache split, and guessing one would feed a
		// cache finding that has no evidence behind it.
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		nanoAiu: (turn.credits ?? 0) * 1e9,
		missRequests: 0,
		missInputTokens: 0,
		missNanoAiu: 0
	};
}
