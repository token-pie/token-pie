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
	/** What GitHub says was spent this period, when the endpoint reports it. */
	creditsUsed?: number;
	/**
	 * When the allowance refills.
	 *
	 * Recorded because it dates the *start* of the billing period, and that is
	 * the only window over which GitHub's consumption and ours are comparable.
	 * Without it the panel can print both figures but not reconcile them.
	 */
	resetDate?: string;
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
		remaining: snapshot.remainingExact,
		creditsUsed: snapshot.creditsUsed,
		resetDate: e.resetDate
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

/* ------------------------------------------------- period coverage --- */

/**
 * Reconciles the two credit figures the panel shows at once.
 *
 * The meter reads GitHub's own consumption for the billing period; the
 * breakdown below it reads what this machine measured. They are never quite
 * equal, and until now the panel simply printed both and left the reader to
 * notice. The difference is not noise -- it is spend this install cannot see:
 * another editor, another machine, the CLI, github.com. That is worth naming,
 * because it bounds how much of the advice below can possibly apply.
 *
 * The comparison is only honest over the same days. Our retention window is
 * shorter than a billing period, so when history begins after the period did,
 * a shortfall proves nothing and the verdict says so rather than inventing
 * unseen spend.
 */
export interface PeriodCoverage {
	/** Start of the current billing period, inferred from the reset date. */
	periodStart: number;
	/** Earliest day we hold data for. */
	historyStart?: number;
	/** What GitHub reports spent this period. */
	githubCredits: number;
	/** What this machine measured over the days it covers. */
	localCredits: number;
	localRequests: number;
	/** githubCredits - localCredits. Positive is spend we cannot account for. */
	unaccounted: number;
	/** Fraction of GitHub's figure this machine explains. */
	share?: number;
	verdict: 'complete' | 'partial' | 'over' | 'inconclusive';
	note: string;
}

/** A day string (YYYY-MM-DD) as a UTC epoch. */
function dayMs(day: string): number {
	return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * One month back from the reset date.
 *
 * Copilot allowances renew monthly, and the endpoint gives only the *next*
 * reset. Calendar arithmetic rather than 30 days so a period that begins on
 * the 31st does not drift.
 */
export function periodStartFrom(resetDate: string): number | undefined {
	const iso = resetDate.includes('T') ? resetDate : `${resetDate}T00:00:00.000Z`;
	const reset = new Date(iso);
	if (Number.isNaN(reset.getTime())) {
		return undefined;
	}
	const start = new Date(reset.getTime());
	start.setUTCMonth(start.getUTCMonth() - 1);
	return start.getTime();
}

export function periodCoverage(input: {
	resetDate?: string;
	/** GitHub's consumption: `credits_used`, else entitlement - remaining. */
	githubCredits?: number;
	/** Our per-day credit figures, keyed by YYYY-MM-DD. */
	creditsByDay: Map<string, { credits: number; requests: number }>;
	now?: number;
}): PeriodCoverage | undefined {
	const { resetDate, githubCredits, creditsByDay } = input;
	const now = input.now ?? Date.now();
	if (resetDate === undefined || githubCredits === undefined) {
		return undefined;
	}
	const periodStart = periodStartFrom(resetDate);
	if (periodStart === undefined || periodStart > now) {
		return undefined;
	}

	const days = [...creditsByDay.entries()]
		.map(([day, v]) => ({ at: dayMs(day), ...v }))
		.filter(d => Number.isFinite(d.at))
		.sort((a, b) => a.at - b.at);
	const historyStart = days.length > 0 ? days[0].at : undefined;

	const inPeriod = days.filter(d => d.at >= periodStart);
	const localCredits = inPeriod.reduce((n, d) => n + d.credits, 0);
	const localRequests = inPeriod.reduce((n, d) => n + d.requests, 0);
	const unaccounted = githubCredits - localCredits;

	const result: PeriodCoverage = {
		periodStart,
		historyStart,
		githubCredits,
		localCredits,
		localRequests,
		unaccounted,
		share: githubCredits > 0 ? localCredits / githubCredits : undefined,
		verdict: 'inconclusive',
		note: ''
	};

	if (githubCredits <= 0) {
		result.note = 'GitHub reports nothing spent this period yet.';
		return result;
	}

	// A day of slack: history that starts within the first day of the period
	// is close enough that the reader is not being misled.
	const DAY = 86_400_000;
	if (historyStart === undefined) {
		result.note = 'No local history to compare against.';
		return result;
	}
	if (historyStart > periodStart + DAY) {
		const missed = Math.round((historyStart - periodStart) / DAY);
		result.note =
			`Local history begins ${missed} day${missed === 1 ? '' : 's'} into the ` +
			'billing period, so the shortfall below is partly days we never saw.';
		return result;
	}

	const tolerance = ROUNDING_SLACK + githubCredits * RELATIVE_TOLERANCE;
	if (Math.abs(unaccounted) <= tolerance) {
		result.verdict = 'complete';
		result.note = 'This machine accounts for essentially all of it.';
	} else if (unaccounted > 0) {
		result.verdict = 'partial';
		result.note =
			'Spent outside this install -- another machine, another editor, the ' +
			'CLI, or github.com. The breakdown below covers only what happened here.';
	} else {
		result.verdict = 'over';
		result.note =
			'We measured more than GitHub billed. The credit conversion is likely ' +
			'miscalibrated; check tokenPie.creditsPerNanoAiu.';
	}
	return result;
}
