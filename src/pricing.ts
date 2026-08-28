/**
 * Recovers what each kind of token actually costs, from your own spend.
 *
 * `copilot_chat.copilot_usage_nano_aiu` is a single total per request, so no
 * attribute says how much of it was input and how much was output. But cost is
 * linear in the three token classes, and every request is one observation of
 * that line, so the rate card can be solved for:
 *
 *   cost = fresh x A + cached x B + output x C
 *
 * In testing this recovered claude-sonnet-5 as exactly
 * 0.25 / 0.02 / 1.00 credits per 1k tokens with four degrees of freedom and a
 * max residual of 0.0000 credits -- measured rather than assumed.
 *
 * Two of those match the published card outright ($0.20 and $10.00 per million,
 * at 1 credit = $0.01). The first does not: the published *input* price is
 * $2.00 per million, or 0.20 credits per 1k. 0.25 is the published **cache
 * write** price of $2.50. That is not an error in the fit -- on this account
 * `gen_ai.usage.cache_creation.input_tokens` accounts for all but 64 of the
 * 117,066 tokens that missed the cache, so `fresh` and "written to cache" are
 * the same population and the solver prices them as one.
 *
 * The consequence is that `fresh` is the baseline every multiple on the panel
 * is quoted against, and that baseline carries a cache-write premium. Output is
 * 4x `fresh` -- but 5x plain input. Models that bill no cache write have no
 * such premium, and `report.ts` labels the row from `cacheWriteTokens` rather
 * than assuming either.
 *
 * **Output is 4x fresh input and 12.5x cached input**, which is
 * why reporting composition by token count misstates where the money went.
 *
 * Only sufficient statistics are kept, never the spans: a symmetric 3x3 X'X
 * and a 3x1 X'y are enough to solve, and they accumulate incrementally like
 * everything else in the rollup.
 */

/** Predictors are in thousands of tokens; the response is nano-AIU x 1e-9. */
export interface PriceStats {
	n: number;
	/** Upper triangle of X'X: [ff, fc, fo, cc, co, oo]. */
	xx: number[];
	/** X'y: [fy, cy, oy]. */
	xy: number[];
	sy: number;
	syy: number;
}

export interface Price {
	/** Credits per 1,000 tokens. */
	fresh: number;
	cached: number;
	output: number;
	/** Observations behind the fit. */
	n: number;
	r2: number;
}

export function emptyStats(): PriceStats {
	return { n: 0, xx: [0, 0, 0, 0, 0, 0], xy: [0, 0, 0], sy: 0, syy: 0 };
}

export function accumulate(
	s: PriceStats,
	freshTokens: number,
	cachedTokens: number,
	outputTokens: number,
	nanoAiu: number
): void {
	// A request that cost nothing carries no information about a rate and
	// would drag every coefficient toward zero.
	if (nanoAiu <= 0) {
		return;
	}
	const f = freshTokens / 1000;
	const c = cachedTokens / 1000;
	const o = outputTokens / 1000;
	const y = nanoAiu * 1e-9;

	s.n += 1;
	s.xx[0] += f * f; s.xx[1] += f * c; s.xx[2] += f * o;
	s.xx[3] += c * c; s.xx[4] += c * o;
	s.xx[5] += o * o;
	s.xy[0] += f * y; s.xy[1] += c * y; s.xy[2] += o * y;
	s.sy += y;
	s.syy += y * y;
}

export function mergeStats(a: PriceStats, b: PriceStats): PriceStats {
	const out = emptyStats();
	out.n = a.n + b.n;
	for (let i = 0; i < 6; i++) {
		out.xx[i] = a.xx[i] + b.xx[i];
	}
	for (let i = 0; i < 3; i++) {
		out.xy[i] = a.xy[i] + b.xy[i];
	}
	out.sy = a.sy + b.sy;
	out.syy = a.syy + b.syy;
	return out;
}

/**
 * Three coefficients need more than three observations to mean anything.
 *
 * Six gives three degrees of freedom, which is enough for the residual check
 * below to be able to fail.
 */
const MIN_OBSERVATIONS = 6;

/**
 * The relationship is an exact rate card, not a noisy trend.
 *
 * A real fit lands on R2 = 1.00000. Anything materially below that means the
 * model is wrong -- a tier change mid-window, a token class we do not know
 * about -- and reporting a rate card from it would be inventing numbers.
 */
const MIN_R2 = 0.999;

/** A negative price is not a price. Small negatives are solver noise. */
const NEGATIVE_TOLERANCE = -1e-6;

export function solve(s: PriceStats, creditsPerNanoAiu: number): Price | undefined {
	if (s.n < MIN_OBSERVATIONS) {
		return undefined;
	}

	const m = [
		[s.xx[0], s.xx[1], s.xx[2], s.xy[0]],
		[s.xx[1], s.xx[3], s.xx[4], s.xy[1]],
		[s.xx[2], s.xx[4], s.xx[5], s.xy[2]]
	];

	// Gauss-Jordan with partial pivoting. A singular system means the token
	// classes moved together across every request and cannot be separated --
	// which is a real state, not an error.
	const scale = Math.max(...m.flat().map(Math.abs));
	if (!(scale > 0)) {
		return undefined;
	}
	for (let i = 0; i < 3; i++) {
		let pivot = i;
		for (let r = i + 1; r < 3; r++) {
			if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) {
				pivot = r;
			}
		}
		[m[i], m[pivot]] = [m[pivot], m[i]];
		if (Math.abs(m[i][i]) < scale * 1e-12) {
			return undefined;
		}
		for (let r = 0; r < 3; r++) {
			if (r === i) {
				continue;
			}
			const factor = m[r][i] / m[i][i];
			for (let col = i; col < 4; col++) {
				m[r][col] -= factor * m[i][col];
			}
		}
	}
	const beta = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
	if (beta.some(b => !Number.isFinite(b) || b < NEGATIVE_TOLERANCE)) {
		return undefined;
	}

	// Residual sum from the sufficient statistics: y'y - 2b'X'y + b'X'Xb.
	const bXy = beta[0] * s.xy[0] + beta[1] * s.xy[1] + beta[2] * s.xy[2];
	const bXXb =
		beta[0] * beta[0] * s.xx[0] + beta[1] * beta[1] * s.xx[3] + beta[2] * beta[2] * s.xx[5] +
		2 * (beta[0] * beta[1] * s.xx[1] + beta[0] * beta[2] * s.xx[2] + beta[1] * beta[2] * s.xx[4]);
	const ssr = Math.max(0, s.syy - 2 * bXy + bXXb);
	const sst = Math.max(0, s.syy - (s.sy * s.sy) / s.n);
	const r2 = sst > 0 ? 1 - ssr / sst : 1;
	if (r2 < MIN_R2) {
		return undefined;
	}

	// Coefficients are in (nano-AIU x 1e-9) per 1k tokens; convert to credits.
	const toCredits = creditsPerNanoAiu * 1e9;
	return {
		fresh: Math.max(0, beta[0]) * toCredits,
		cached: Math.max(0, beta[1]) * toCredits,
		output: Math.max(0, beta[2]) * toCredits,
		n: s.n,
		r2
	};
}

/** What a bundle of tokens costs at a recovered rate card. */
export function costOf(
	p: Price,
	freshTokens: number,
	cachedTokens: number,
	outputTokens: number
): number {
	return (
		(freshTokens * p.fresh + cachedTokens * p.cached + outputTokens * p.output) / 1000
	);
}
