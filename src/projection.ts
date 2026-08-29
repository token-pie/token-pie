import { Entitlement, governingSnapshot, daysUntilReset } from './entitlement';
import { Rollup, dayStartMs } from './store';
import { Tuning, defaults } from './tuning';

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
	/** Measured spend on today's local calendar day. */
	todayCredits?: number;
	/**
	 * What today was allowed to cost.
	 *
	 * `projection.dailyBudgetPercent` of the allowance when it is set, and
	 * `sustainableDailyBurn` otherwise -- a budget exists without anyone
	 * configuring one, because what remains divided by the days left is
	 * already the pace that lasts to the reset.
	 */
	todayBudget?: number;
	/**
	 * Today's spend as a share of today's budget. Above 1 is over.
	 *
	 * Deliberately not clamped: "118% of today" is the reading, and a figure
	 * that stopped at 100 would hide how far over the day went.
	 */
	todayShare?: number;
	/**
	 * When the allowance refills, verbatim from the endpoint.
	 *
	 * `daysToReset` is the derived form the projection needs; the raw date is
	 * what dates the *start* of the billing period, which is the only window
	 * over which our measured total and GitHub's are comparable.
	 */
	resetDate?: string;
}

/** Today's local day key, built the way `dayKey()` builds them. */
function dayKeyOf(now: number): string {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` +
		`-${String(d.getDate()).padStart(2, '0')}`;
}

export function project(
	entitlement: Entitlement | undefined,
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	now = Date.now(),
	tuning: Tuning = defaults()
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
			resetDate: entitlement.resetDate,
			daysToReset
		};
	}
	const base: Projection = {
		verdict: 'no-rate',
		quotaId: snapshot.name,
		entitlement: snapshot.entitlement,
		remaining,
		percentRemaining: snapshot.percentRemaining,
		creditsUsed: snapshot.creditsUsed,
		resetDate: entitlement.resetDate,
		daysToReset,
		sustainableDailyBurn:
			daysToReset && daysToReset > 0 ? remaining / daysToReset : undefined
	};

	// Today's spend, measured only. Backfilled transcript days are a floor, and
	// a budget checked against a floor says you have room you may not have.
	const todayKey = dayKeyOf(now);
	const todayCredits = rollups
		.filter(r => r.source !== 'reported' && r.day === todayKey)
		.reduce((n, r) => n + r.nanoAiu, 0) * creditsPerNanoAiu;
	const pct = tuning.projection.dailyBudgetPercent;
	const budget = pct > 0 && entitlement !== undefined && base.entitlement !== undefined
		? base.entitlement * (pct / 100)
		: base.sustainableDailyBurn;
	base.todayCredits = todayCredits;
	base.todayBudget = budget !== undefined && budget > 0 ? budget : undefined;
	base.todayShare = base.todayBudget !== undefined
		? todayCredits / base.todayBudget
		: undefined;

	const rate = burnPerDay(rollups, creditsPerNanoAiu, now, tuning.projection.minDaysForRate);
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
		base.verdict = daysToExhaust < tuning.projection.tightDaysMargin ? 'will-exhaust' : 'ok';
		return base;
	}
	if (daysToExhaust < daysToReset) {
		base.verdict = 'will-exhaust';
	} else if (daysToExhaust < daysToReset + tuning.projection.tightDaysMargin) {
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
	now: number,
	minDays: number
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
	const first = dayStartMs(days[0]);
	if (Number.isNaN(first)) {
		return undefined;
	}

	const elapsedDays = (now - first) / 86_400_000;
	if (elapsedDays < minDays) {
		return undefined;
	}

	const credits = rollups.reduce((n, r) => n + r.nanoAiu, 0) * creditsPerNanoAiu;
	return { perDay: credits / elapsedDays, days: elapsedDays };
}

/**
 * How hard today is pressing against its budget.
 *
 * `undefined` when there is no budget to press against -- an unlimited plan,
 * or no reset date to pace towards.
 */
export function dayPressure(
	p: Projection,
	tuning: Tuning = defaults()
): 'under' | 'near' | 'over' | undefined {
	if (p.todayShare === undefined) {
		return undefined;
	}
	if (p.todayShare >= 1) { return 'over'; }
	return p.todayShare >= tuning.projection.dailyWarnShare ? 'near' : 'under';
}

/**
 * Today's figure, for the status bar.
 *
 * "used" for the same reason the month figure says "left": on a spend tracker
 * a lone percentage reads as easily as the share used as the share remaining,
 * and beside a figure that means remaining, the day would be read as remaining
 * too. The two are opposite readings and only one of them is a reason to stop.
 *
 * "of today" was tried and dropped -- today is not a quantity, so the phrase
 * elides the noun it is a share of and leaves the reader to supply it. The
 * hover names the denominator in credits; this only has room for the direction.
 */
export function dayLabel(p: Projection): string | undefined {
	return p.todayShare === undefined
		? undefined
		: `${Math.round(p.todayShare * 100)}% used today`;
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
		// "97%" alone is ambiguous in the one direction that matters: on a spend
		// tracker it reads as easily as 97% *used*, which is a crisis, as 97%
		// left, which is fine. The day counts already end in "left"; this now
		// matches them.
		case 'ok':
			return p.percentRemaining !== undefined
				? `${Math.round(p.percentRemaining)}% left`
				: `${fmtDays(p.daysToExhaust)} left`;
		case 'no-rate':
			return p.percentRemaining !== undefined
				? `${Math.round(p.percentRemaining)}% left`
				: '--';
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
