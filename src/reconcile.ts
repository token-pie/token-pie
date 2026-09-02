import * as fs from 'fs';
import * as path from 'path';
import { Entitlement, QuotaSnapshot, governingSnapshot } from './entitlement';
import { Turn } from './sessions';
import { Tuning, defaults } from './tuning';
import { dayStartMs } from './store';
import { Confidence } from './confidence';

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
	turns: Turn[],
	tuning: Tuning = defaults()
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
	const tolerance = tuning.reconcile.roundingSlack +
		quotaDelta * tuning.reconcile.relativeTolerance;
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
	/** Earliest day we hold data for, from either source. */
	historyStart?: number;
	/**
	 * When this machine actually began recording, if it ever did.
	 *
	 * Distinct from `historyStart`, and the distinction is the whole point:
	 * backfilled chat transcripts push history back before the period began
	 * while proving nothing was measured. Only the trace database bounds what
	 * could have been seen.
	 */
	traceStart?: number;
	/** Fraction of the elapsed period the trace database was recording for. */
	recordedShare?: number;
	/** What GitHub reports spent this period. */
	githubCredits: number;
	/** What this machine measured over the days it covers. */
	localCredits: number;
	localRequests: number;
	/** githubCredits - localCredits. Positive is spend we cannot account for. */
	unaccounted: number;
	/** Fraction of GitHub's figure this machine explains. */
	share?: number;
	/**
	 * GitHub's own billing, per day, for the days of this period it holds.
	 *
	 * Different evidence from `localCredits`: those are credits attributed to
	 * particular messages, this is the quota total moving. When it accounts for
	 * the period, every credit was spent on a day this machine was watching --
	 * whatever the message-level attribution managed to explain.
	 */
	billedInPeriod?: number;
	verdict: 'complete' | 'partial' | 'unattributed' | 'over' | 'inconclusive';
	note: string;
}

/** A day string (YYYY-MM-DD) as an epoch. Local, because dayKey() is. */
const dayMs = dayStartMs;

/**
 * One month back from the reset date.
 *
 * Copilot allowances renew monthly, and the endpoint gives only the *next*
 * reset. Calendar arithmetic rather than 30 days so a period that begins on
 * the 31st does not drift.
 */
/**
 * The reset instant itself, parsed by the same rule as the period start.
 *
 * Split out so the two ends of a period cannot disagree about what a bare
 * `YYYY-MM-DD` from GitHub means.
 */
export function resetInstantFrom(resetDate: string): number | undefined {
	const iso = resetDate.includes('T') ? resetDate : `${resetDate}T00:00:00.000Z`;
	const reset = new Date(iso);
	return Number.isNaN(reset.getTime()) ? undefined : reset.getTime();
}

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
	/** When the trace database starts, epoch ms. Absent means nothing measured. */
	traceStartMs?: number;
	/**
	 * GitHub's running total differenced per day, from the store.
	 *
	 * Deliberately not folded into `creditsByDay`: comparing GitHub's figure
	 * against a copy of itself would agree by construction and prove nothing.
	 * It is used only to answer a different question -- was this machine here
	 * while the quota moved -- which decides whether a shortfall is spend
	 * elsewhere or cost this machine failed to attribute.
	 */
	billedByDay?: Map<string, number>;
	now?: number;
	tuning?: Tuning;
}): PeriodCoverage | undefined {
	const { resetDate, githubCredits, creditsByDay, traceStartMs } = input;
	const tuning = input.tuning ?? defaults();
	const now = input.now ?? Date.now();
	if (resetDate === undefined || githubCredits === undefined) {
		return undefined;
	}
	const periodStart = periodStartFrom(resetDate);
	if (periodStart === undefined || periodStart > now) {
		return undefined;
	}

	const days = [...creditsByDay.entries()]
		.map(([day, v]) => ({ day, at: dayMs(day), ...v }))
		.filter(d => Number.isFinite(d.at))
		.sort((a, b) => a.at - b.at);
	const historyStart = days.length > 0 ? days[0].at : undefined;

	// Calendar dates compared as calendar dates.
	//
	// A day key is local midnight; a period start is UTC midnight, built from a
	// bare YYYY-MM-DD reset date that carries no zone at all. Comparing them as
	// instants meant that east of UTC the period's own first day landed before
	// its start and was dropped -- in IST, 05-30 short of it -- so the busiest
	// day of a fresh period was excluded from what this machine could account
	// for, and the shortfall was reported as spend on another machine.
	const periodStartDay = new Date(periodStart).toISOString().slice(0, 10);

	const inPeriod = days.filter(d => d.day >= periodStartDay);
	const localCredits = inPeriod.reduce((n, d) => n + d.credits, 0);
	const localRequests = inPeriod.reduce((n, d) => n + d.requests, 0);
	const unaccounted = githubCredits - localCredits;

	// Only the days the trace database was running could ever have been seen.
	// Judging coverage by the earliest day we hold data for was the defect: a
	// machine with two days of measurement and a month of backfilled
	// transcripts reported history beginning before the period did, passed the
	// check meant to catch exactly that, and blamed 19,094 unread credits on
	// other machines.
	const DAY_MS = 86_400_000;
	// Both spans measured from the same instant, and the ratio taken before any
	// rounding. Flooring `elapsed` at a day instead made a period a few hours
	// old look barely covered when it was covered entirely.
	const elapsed = now - periodStart;
	const recordedFrom = traceStartMs !== undefined
		? Math.max(periodStart, traceStartMs)
		: undefined;
	const recordedShare = recordedFrom !== undefined && elapsed > 0
		? Math.min(1, Math.max(0, now - recordedFrom) / elapsed)
		: recordedFrom !== undefined ? 1 : undefined;

	const result: PeriodCoverage = {
		periodStart,
		historyStart,
		traceStart: traceStartMs,
		recordedShare,
		githubCredits,
		localCredits,
		localRequests,
		unaccounted,
		share: githubCredits > 0 ? localCredits / githubCredits : undefined,
		billedInPeriod: input.billedByDay !== undefined
			? [...input.billedByDay.entries()]
				.filter(([day]) => day >= periodStartDay)
				.reduce((n, [, credits]) => n + credits, 0)
			: undefined,
		verdict: 'inconclusive',
		note: ''
	};

	if (githubCredits <= 0) {
		result.note = 'GitHub reports nothing spent this period yet.';
		return result;
	}

	if (historyStart === undefined) {
		result.note = 'No local history to compare against.';
		return result;
	}

	// Nothing was measured at all, so every figure below came from chat
	// transcripts -- a floor, and no basis for saying where the rest went.
	if (traceStartMs === undefined) {
		result.note =
			'Nothing was measured on this machine this period. The figures below ' +
			'come from chat transcripts, which record less than was billed.';
		return result;
	}

	if (recordedShare !== undefined && recordedShare < tuning.reconcile.minRecordedShare) {
		const recorded = Math.max(1, Math.round((now - (recordedFrom ?? now)) / DAY_MS));
		const total = Math.max(recorded + 1, Math.round(elapsed / DAY_MS));
		result.note =
			`This machine was only recording for ${recorded} of the ${total} days ` +
			'in this billing period, so the shortfall below is mostly days it was ' +
			'never watching rather than spend somewhere else.';
		return result;
	}

	const tolerance = tuning.reconcile.roundingSlack +
		githubCredits * tuning.reconcile.relativeTolerance;
	if (Math.abs(unaccounted) <= tolerance) {
		result.verdict = 'complete';
		result.note = 'This machine accounts for essentially all of it.';
	} else if (unaccounted > 0) {
		// Before blaming another machine, check whether this one was watching.
		//
		// `billedDays` is GitHub's own total differenced day over day, so when
		// it accounts for the period every credit was spent on a day this
		// install was running. The shortfall is then cost Copilot never wrote
		// onto a span -- it stops recording cost for whole models, and the
		// conversion multiplier is a default until something checks it -- not
		// spend somewhere else. Reporting that as "another machine" sent
		// someone looking for a second install that did not exist.
		const seen = result.billedInPeriod;
		if (seen !== undefined && seen >= githubCredits - tolerance) {
			result.verdict = 'unattributed';
			result.note =
				'All of it was spent on days this machine was watching. It could not ' +
				'attribute every credit to a message: Copilot records no cost for ' +
				'some of them, and the credit conversion is a default until it is ' +
				'checked.';
			return result;
		}
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

/* ------------------------------------------- conversion confidence --- */

/**
 * How far the credit conversion can be trusted, from whether it has been checked.
 *
 * Every credit figure in the panel is an exact token count multiplied by
 * `creditsPerNanoAiu`. The token counts are measured; the multiplier is a
 * default that nothing proves. `confidence.ts` was built to carry exactly this
 * doubt downstream, and until now nothing emitted `estimated`, so the rule had
 * no way to fire and every derived figure claimed to be a measurement.
 *
 * `periodCoverage` is the only evidence available: when what this machine
 * measured matches what GitHub billed over the same days, the conversion is
 * confirmed against a real quota delta, and the figures built on it are
 * measurements. Short of that they are estimates, whatever the token counts.
 */
export function conversionConfidence(
	coverage: PeriodCoverage | undefined,
	/** True when the developer has set the conversion themselves. */
	overridden = false
): { confidence: Confidence; why?: string } {
	if (coverage?.verdict === 'complete') {
		return { confidence: 'measured' };
	}
	if (coverage?.verdict === 'over') {
		return {
			confidence: 'estimated',
			why: 'We measured more credits than GitHub billed over the same days, so the ' +
				'conversion from nano-AIU to credits is probably wrong. Check ' +
				'tokenPie.creditsPerNanoAiu against your billing dashboard.'
		};
	}

	// A partial match is not a failed check. The shortfall is spend this install
	// cannot see, which says nothing about the multiplier either way -- so it
	// leaves the conversion unconfirmed rather than impugned.
	const because = coverage?.verdict === 'partial'
		? 'Some of your spend happened outside this install, so the check could not ' +
			'confirm the conversion.'
		: coverage === undefined
		? 'Run Token Pie: Check Quota to compare it against what GitHub billed.'
		: 'There is not yet enough overlapping history to check it.';

	return {
		confidence: 'estimated',
		why: overridden
			? `Token counts are exact, but the credits they are converted into rest on the ` +
				`value you set for tokenPie.creditsPerNanoAiu, which has not been verified ` +
				`against GitHub's own figure. ${because}`
			: `Token counts are exact, but the credits they are converted into rest on a ` +
				`default conversion nothing has verified. ${because}`
	};
}
