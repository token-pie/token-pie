import * as fs from 'fs';
import * as path from 'path';
import { Entitlement, QuotaSnapshot, governingSnapshot } from './entitlement';
import { Turn } from './sessions';

/**
 * Checks that the two halves of the projection speak the same units.
 *
 * Remaining allowance comes from Copilot's entitlement endpoint; burn rate
 * comes from `copilotCredits` in VS Code's chat session files. If those are
 * denominated differently, "days until throttled" is a confident lie. Rather
 * than assume, record a quota reading each time we take one and compare the
 * consumption it implies against the credits observed over the same window.
 */

export interface QuotaReading {
	at: number;
	quotaId: string;
	entitlement: number;
	/** Fractional remainder, the precise figure to difference against. */
	remaining: number;
}

export interface Reconciliation {
	quotaId: string;
	windowStart: number;
	windowEnd: number;
	/** Consumption the endpoint reports over the window. */
	quotaDelta: number;
	/** Credits observed in chat sessions over the same window. */
	sessionCredits: number;
	turnCount: number;
	/** sessionCredits / quotaDelta. 1.0 means the units agree. */
	ratio?: number;
	verdict: 'agree' | 'disagree' | 'inconclusive';
	note: string;
}

/**
 * `quota_remaining` arrives rounded to one decimal, so a delta can be off by
 * up to 0.1 through rounding alone. Anything within that plus 5% is agreement.
 */
const ROUNDING_SLACK = 0.1;
const RELATIVE_TOLERANCE = 0.05;

export class ReadingStore {
	private readings: QuotaReading[] = [];

	constructor(private readonly file: string) {
		try {
			this.readings = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		} catch {
			this.readings = [];
		}
	}

	add(reading: QuotaReading): void {
		this.readings.push(reading);
		// A few dozen readings is ample; this is a validation aid, not history.
		this.readings = this.readings.slice(-50);
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(this.readings), 'utf8');
	}

	all(): QuotaReading[] {
		return this.readings;
	}

	/** Most recent reading for a quota, excluding the one just taken. */
	previous(quotaId: string, before: number): QuotaReading | undefined {
		return this.readings
			.filter(r => r.quotaId === quotaId && r.at < before)
			.sort((a, b) => b.at - a.at)[0];
	}
}

export function toReading(e: Entitlement, at = Date.now()): QuotaReading | undefined {
	const snapshot: QuotaSnapshot | undefined = governingSnapshot(e);
	if (!snapshot || snapshot.remainingExact === undefined || snapshot.entitlement === undefined) {
		return undefined;
	}
	return {
		at,
		quotaId: snapshot.name,
		entitlement: snapshot.entitlement,
		remaining: snapshot.remainingExact
	};
}

export function reconcile(
	previous: QuotaReading,
	current: QuotaReading,
	turns: Turn[]
): Reconciliation {
	const quotaDelta = previous.remaining - current.remaining;

	// Turns are timestamped when the request was made; include the full window.
	const inWindow = turns.filter(t => t.timestamp > previous.at && t.timestamp <= current.at);
	const sessionCredits = inWindow.reduce((n, t) => n + (t.credits ?? 0), 0);

	const result: Reconciliation = {
		quotaId: current.quotaId,
		windowStart: previous.at,
		windowEnd: current.at,
		quotaDelta,
		sessionCredits,
		turnCount: inWindow.length,
		verdict: 'inconclusive',
		note: ''
	};

	if (quotaDelta <= 0 && sessionCredits === 0) {
		result.note = 'No consumption on either side; run some chat turns between readings.';
		return result;
	}
	if (quotaDelta <= 0 && sessionCredits > 0) {
		result.verdict = 'disagree';
		result.note =
			'Chat sessions recorded credits but the quota did not move. Either the ' +
			'endpoint lags, or this quota does not govern these requests.';
		return result;
	}
	if (quotaDelta > 0 && sessionCredits === 0) {
		result.verdict = 'disagree';
		result.note =
			'The quota moved but no chat turns were recorded. Something outside ' +
			'VS Code chat is consuming it -- CLI, completions, or another editor.';
		return result;
	}

	result.ratio = sessionCredits / quotaDelta;
	const tolerance = ROUNDING_SLACK + quotaDelta * RELATIVE_TOLERANCE;
	if (Math.abs(sessionCredits - quotaDelta) <= tolerance) {
		result.verdict = 'agree';
		result.note = 'Same units. Burn rate from chat sessions can be projected against remaining quota.';
	} else {
		result.verdict = 'disagree';
		result.note =
			`Off by ${(sessionCredits - quotaDelta).toFixed(4)} (tolerance ` +
			`${tolerance.toFixed(4)}). Do not project until this is understood.`;
	}
	return result;
}
