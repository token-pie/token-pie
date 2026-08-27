/**
 * Parsing and interpretation of Copilot's entitlement payload.
 *
 * Deliberately free of any vscode import so the logic can be exercised against
 * a recorded real response -- which is how the has_quota bug below was caught.
 */

export interface QuotaSnapshot {
	/** e.g. "chat", "completions", "premium_interactions" */
	name: string;
	entitlement?: number;
	/** Integer floor of what is left. */
	remaining?: number;
	/** Fractional remainder -- the number to project against. */
	remainingExact?: number;
	percentRemaining?: number;
	creditsUsed?: number;
	/**
	 * Whether this quota applies to the account at all.
	 *
	 * Load-bearing: on Free, `premium_interactions` comes back with
	 * entitlement 0, remaining 0 and has_quota false. Treating it as the
	 * binding constraint reports "0% remaining" on an account that has 99% of
	 * its actual chat allowance left.
	 */
	hasQuota?: boolean;
	unlimited?: boolean;
	overagePermitted?: boolean;
	overageCount?: number;
}

export interface Entitlement {
	/** The GitHub account this answer describes. Not necessarily the one you expected. */
	login?: string;
	/** "no_access" means this account has no Copilot -- a different problem from no quota. */
	accessTypeSku?: string;
	chatEnabled?: boolean;
	plan?: string;
	resetDate?: string;
	tokenBasedBilling?: boolean;
	snapshots: QuotaSnapshot[];
	organizations: string[];
	/** Unparsed response, so diagnostics can show what actually came back. */
	raw: unknown;
}



/**
 * VS Code's GitHub session. `createIfNone: false` on the first attempt so a
 * background refresh never throws a sign-in prompt at someone mid-task; the
 * explicit command retries interactively.
 */




/**
 * `quota_snapshots` has been observed as a map of name -> snapshot. Accept an
 * array too rather than assume, since this shape is not contractual.
 */
export function parseSnapshots(value: unknown): QuotaSnapshot[] {
	if (!value || typeof value !== 'object') {
		return [];
	}
	const entries = Array.isArray(value)
		? value.map((v, i) => [String(i), v] as const)
		: Object.entries(value as Record<string, unknown>);

	const out: QuotaSnapshot[] = [];
	for (const [key, v] of entries) {
		if (!v || typeof v !== 'object') {
			continue;
		}
		const s = v as Record<string, unknown>;
		out.push({
			name: str(s['quota_id']) ?? str(s['name']) ?? key,
			entitlement: numOrUndefined(s['entitlement']),
			remaining: numOrUndefined(s['remaining']),
			remainingExact: numOrUndefined(s['quota_remaining']) ?? numOrUndefined(s['remaining']),
			percentRemaining: numOrUndefined(s['percent_remaining']),
			creditsUsed: numOrUndefined(s['credits_used']),
			hasQuota: s['has_quota'] === true,
			unlimited: s['unlimited'] === true,
			overagePermitted: s['overage_permitted'] === true,
			overageCount: numOrUndefined(s['overage_count'])
		});
	}
	return out;
}

/** True when the account simply has no Copilot -- distinct from having no quota data. */
export function hasCopilotAccess(e: Entitlement): boolean {
	if (e.accessTypeSku === 'no_access') {
		return false;
	}
	return e.chatEnabled !== false;
}

/** A quota that can actually run out and stop you working. */
/**
 * Whether this allowance is one that can actually cut you off.
 *
 * `has_quota` is deliberately not consulted. It reads like "a quota exists"
 * but means "quota remains": on an exhausted Business seat it comes back
 * `false` alongside `entitlement: 10000` and `credits_used: 19114`. Requiring
 * it to be true made Token Pie go blind at the exact moment Copilot itself
 * displays "Quota reached".
 *
 * A real allowance is one that is not unlimited and has a non-zero
 * entitlement. That still excludes the phantom `premium_interactions` on Free
 * plans, which reports `entitlement: 0` -- the case this guard was written for,
 * where both readings happened to agree.
 */
export function isBinding(s: QuotaSnapshot): boolean {
	return !s.unlimited && (s.entitlement ?? 0) > 0;
}

/**
 * The snapshot that governs whether chat gets cut off.
 *
 * Only binding quotas are considered. Among those, the one closest to
 * exhaustion wins -- being 2% into a chat allowance matters less than being
 * 90% into completions, and whichever runs out first is the one that stops
 * you. Name priority is only a tie-breaker.
 */
export function governingSnapshot(e: Entitlement): QuotaSnapshot | undefined {
	const binding = e.snapshots.filter(isBinding);
	if (binding.length === 0) {
		return undefined;
	}
	const priority = ['chat', 'premium_interactions', 'premium', 'credits'];
	return binding.sort((a, b) => {
		const byRemaining = (a.percentRemaining ?? 100) - (b.percentRemaining ?? 100);
		if (byRemaining !== 0) {
			return byRemaining;
		}
		const rank = (s: QuotaSnapshot) => {
			const i = priority.indexOf(s.name.toLowerCase());
			return i === -1 ? priority.length : i;
		};
		return rank(a) - rank(b);
	})[0];
}

/** Days until the allowance refills, from `quota_reset_date`. */
export function daysUntilReset(e: Entitlement, now = Date.now()): number | undefined {
	if (!e.resetDate) {
		return undefined;
	}
	const reset = Date.parse(
		e.resetDate.includes('T') ? e.resetDate : `${e.resetDate}T00:00:00.000Z`
	);
	if (Number.isNaN(reset)) {
		return undefined;
	}
	return Math.max(0, (reset - now) / 86_400_000);
}

export function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function numOrUndefined(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v)) {
		return v;
	}
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
		return Number(v);
	}
	return undefined;
}
