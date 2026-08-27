/**
 * What the extension is doing, right now.
 *
 * The pipeline reads SQLite and parses transcripts on the extension host's
 * only thread. Doing that in one synchronous pass froze VS Code for minutes on
 * a machine with a lot of history, and a frozen extension is indistinguishable
 * from a broken one -- the reported symptom was "the button vanished".
 *
 * Two things follow. Work is cut into units with a yield between them, so the
 * editor stays responsive; and each phase is announced, so a slow start looks
 * like progress rather than a hang.
 */

export type Phase =
	| 'idle'
	| 'starting'
	| 'reading-traces'
	| 'reading-history'
	| 'tidying'
	| 'checking-quota'
	| 'ready'
	| 'failed';

export interface Progress {
	phase: Phase;
	/** Units finished and expected, when the total is known up front. */
	done?: number;
	total?: number;
}

export type OnProgress = (p: Progress) => void;

/**
 * Human wording for the status bar.
 *
 * Terse on purpose: this sits after `TP |` in a bar competing with the branch
 * name, problem counts and everything else an editor puts there. The tooltip
 * carries the full sentence.
 */
export function phaseLabel(p: Progress): string | undefined {
	switch (p.phase) {
		case 'starting':
			return 'starting';
		case 'reading-traces':
			return 'usage';
		case 'reading-history':
			return p.total && p.total > 0
				? `history ${p.done ?? 0}/${p.total}`
				: 'history';
		case 'tidying':
			return 'tidying';
		case 'checking-quota':
			return 'allowance';
		default:
			return undefined;
	}
}

/**
 * Hand control back to the event loop.
 *
 * `setTimeout(0)` rather than a microtask: a resolved promise queues a
 * microtask, which runs before the loop gets a turn, so awaiting one in a tight
 * loop yields nothing at all.
 */
export function yieldToLoop(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

/** Units between yields. Small enough to stay responsive, large enough to finish. */
export const YIELD_EVERY = 8;
