import { Entitlement, governingSnapshot, daysUntilReset } from './entitlement';
import { Rollup } from './store';

/**
 * Joins remaining allowance to observed burn rate.
 *
 * "You have spent 23 credits" is not information -- it has no denominator and
 * no horizon. "You run out on Thursday, two days before your quota resets" is
 * a thing a developer can act on. That join is the product.
 */

export type Verdict =
	/** Already used up. Nothing to project; only the reset date matters. */
	| 'exhausted'
	/** Burn rate will exhaust the allowance before it resets. */
	| 'will-exhaust'
	/** Will survive the period, but with little headroom. */
	| 'tight'
	/** Comfortable. */
	| 'ok'
	/** Quota known, but not enough history to project a rate. */
	| 'no-rate'
	/** No binding quota, or no entitlement data. */
	| 'unknown';

export interface Projection {
	verdict: Verdict;
	/**
	 * Why the verdict is `unknown`. "No quota data, sign in" and "signed in,
	 * but this plan reports no metered quota" are different situations and only
	 * one of them is fixed by running a command.
	 */
	unknownReason?: 'not-signed-in' | 'no-binding-quota' | 'no-remaining-figure';
	quotaId?: string;
	entitlement?: number;
	remaining?: number;
	percentRemaining?: number;
	/** Credits per day, from observed history. */
	burnPerDay?: number;
	/** Days of observed history the rate is based on. */
	daysObserved?: number;
	/** Days until the allowance is exhausted at the current rate. */
	daysToExhaust?: number;
	/** Days until the allowance refills. */
	daysToReset?: number;
	/** The date you stop being able to work, when that lands before the reset. */
	exhaustDate?: Date;
	/** Headroom: how much daily spend the remaining period can absorb. */
	sustainableDailyBurn?: number;
	/** What GitHub says you have spent against this allowance. */
	creditsUsed?: number;
}

/** Below this many days of headroom, warn. */
const TIGHT_DAYS_MARGIN = 2;

/**
 * A rate needs enough history to mean anything.
 *
 * This was 0.5, which is exactly the "one heavy afternoon" case it was meant to
 * exclude -- a test projecting a throttle from a single day's burst caught it.
 * A full day minimum means new users see "no-rate" until there is something
 * real to extrapolate from, which is the honest answer.
 */
const MIN_DAYS_FOR_RATE = 1;

export function project(
	entitlement: Entitlement | undefined,
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	now = Date.now()
): Projection {
	if (!entitlement) {
		return { verdict: 'unknown', unknownReason: 'not-signed-in' };
	}
	const snapshot = governingSnapshot(entitlement);
	if (!snapshot) {
		// The account is known and may well have snapshots -- they are just all
		// unlimited, or all report no quota. Telling this user to sign in again
		// sends them round a loop that cannot terminate.
		return { verdict: 'unknown', unknownReason: 'no-binding-quota' };
	}
	if (snapshot.remainingExact === undefined) {
		return { verdict: 'unknown', unknownReason: 'no-remaining-figure' };
	}

	const remaining = snapshot.remainingExact;
	const daysToReset = daysUntilReset(entitlement, now);

	// Already out. A burn rate cannot say anything useful here and the only
	// fact that matters is when the allowance comes back.
	if (remaining <= 0) {
		return {
			verdict: 'exhausted',
			quotaId: snapshot.name,
			entitlement: snapshot.entitlement,
			remaining: 0,
			percentRemaining: 0,
			creditsUsed: snapshot.creditsUsed,
			daysToReset
		};
	}
	const base: Projection = {
		verdict: 'no-rate',
		quotaId: snapshot.name,
		entitlement: snapshot.entitlement,
		remaining,
		percentRemaining: snapshot.percentRemaining,
		daysToReset,
		sustainableDailyBurn:
			daysToReset && daysToReset > 0 ? remaining / daysToReset : undefined
	};

	const rate = burnPerDay(rollups, creditsPerNanoAiu, now);
	if (!rate) {
		return base;
	}
	base.burnPerDay = rate.perDay;
	base.daysObserved = rate.days;

	if (rate.perDay <= 0) {
		base.verdict = 'ok';
		return base;
	}

	const daysToExhaust = remaining / rate.perDay;
	base.daysToExhaust = daysToExhaust;
	base.exhaustDate = new Date(now + daysToExhaust * 86_400_000);

	if (daysToReset === undefined) {
		base.verdict = daysToExhaust < TIGHT_DAYS_MARGIN ? 'will-exhaust' : 'ok';
		return base;
	}
	if (daysToExhaust < daysToReset) {
		base.verdict = 'will-exhaust';
	} else if (daysToExhaust < daysToReset + TIGHT_DAYS_MARGIN) {
		base.verdict = 'tight';
	} else {
		base.verdict = 'ok';
	}
	return base;
}

/**
 * Credits per day from the rollup.
 *
 * Measured across the span from the first observed day to now, not across
 * "days that had activity" -- idle days are real and dividing by active days
 * only would overstate the rate for anyone who works in bursts.
 */
function burnPerDay(
	all: Rollup[],
	creditsPerNanoAiu: number,
	now: number
): { perDay: number; days: number } | undefined {
	// Backfilled history is a floor, not a total -- it omits the retries and
	// cancellations you were charged for. Averaging it into the burn rate would
	// understate it, and understating the burn rate tells someone they are safe
	// when they are about to be cut off. Only measured spend projects.
	const rollups = all.filter(r => r.source !== 'reported');
	if (rollups.length === 0) {
		return undefined;
	}
	const days = [...new Set(rollups.map(r => r.day))].sort();
	const first = Date.parse(`${days[0]}T00:00:00`);
	if (Number.isNaN(first)) {
		return undefined;
	}

	const elapsedDays = (now - first) / 86_400_000;
	if (elapsedDays < MIN_DAYS_FOR_RATE) {
		return undefined;
	}

	const credits = rollups.reduce((n, r) => n + r.nanoAiu, 0) * creditsPerNanoAiu;
	return { perDay: credits / elapsedDays, days: elapsedDays };
}

/** Short status-bar label. Every character has to earn its place. */
export function statusLabel(p: Projection): string {
	switch (p.verdict) {
		case 'exhausted':
			return p.daysToReset !== undefined
				? `${fmtDays(p.daysToReset)} to reset`
				: 'used up';
		case 'will-exhaust':
			return `${fmtDays(p.daysToExhaust)} left`;
		case 'tight':
			return `${fmtDays(p.daysToExhaust)} left`;
		case 'ok':
			return p.percentRemaining !== undefined
				? `${Math.round(p.percentRemaining)}%`
				: `${fmtDays(p.daysToExhaust)} left`;
		case 'no-rate':
			return p.percentRemaining !== undefined ? `${Math.round(p.percentRemaining)}%` : '--';
		default:
			return '--';
	}
}

function fmtDays(days: number | undefined): string {
	if (days === undefined) {
		return '?';
	}
	if (days < 1) {
		return `${Math.max(1, Math.round(days * 24))}h`;
	}
	return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}
