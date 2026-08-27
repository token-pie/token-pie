import { Rollup, Totals, groupBy, sum } from './store';
import { Selection } from './selection';
import { PriceStats, Price, solve, costOf } from './pricing';

/**
 * Turns the rollup into things a developer can do differently.
 *
 * The bar for shipping a recommendation here: it must be derived from this
 * machine's own measured spend, carry the numbers that justify it, and clear a
 * materiality floor. Three hardcoded heuristics dressed up as "insights" is
 * a claim the reader cannot verify is of little use, so every card states the
 * evidence it rests on.
 */

export interface Advice {
	id: 'cache-miss' | 'model-mix' | 'auxiliary';
	/** The finding, numbers included. */
	headline: string;
	/** What to do about it. */
	detail: string;
	/** Credits this is worth, used for ranking. */
	creditsAtStake: number;
	/**
	 * True when `creditsAtStake` is an upper bound rather than a measurement.
	 *
	 * A bound must never outrank a measured number just because it is larger --
	 * that is how a speculative saving ends up above money demonstrably already
	 * wasted. Sorting keeps measured findings first regardless of magnitude.
	 */
	bounded: boolean;
	/** The measurement behind the headline, so it can be checked. */
	evidence: string;
}

/**
 * Materiality is measured against the allowance, not in absolute credits.
 *
 * An absolute floor cannot work across a fleet: 0.5 credits is noise to
 * someone spending 500 a day and half the history of someone who has made five
 * requests. What does generalise is "would fixing this move my throttle date"
 * -- one percent of what is left is the same weight of advice for everyone.
 */
const MIN_SHARE_OF_ALLOWANCE = 0.01;

/** Only when no allowance is known: fall back to share of observed spend. */
const MIN_CREDITS_AT_STAKE = 0.5;
const MIN_SHARE_AT_STAKE = 0.05;

/** A rate needs more than one observation to be a rate. */
const MIN_BASELINE_REQUESTS = 2;

/** A cost multiple below this is ordinary variance, not a finding. */
const MIN_CACHE_FACTOR = 1.5;

/**
 * How a model's spend was reached, by credits.
 *
 * A model can be both auto-selected and hand-picked across different threads,
 * so this reports the split rather than a single verdict.
 */
export function selectionMix(
	rollups: Rollup[],
	model: string,
	creditsPerNanoAiu: number
): { dominant: Selection; autoShare: number; credits: number } {
	const byMode = new Map<Selection, number>();
	let credits = 0;
	for (const r of rollups) {
		if (r.model !== model) {
			continue;
		}
		const c = r.nanoAiu * creditsPerNanoAiu;
		credits += c;
		byMode.set(r.selection, (byMode.get(r.selection) ?? 0) + c);
	}
	const ranked = [...byMode.entries()].sort((a, b) => b[1] - a[1]);
	return {
		dominant: ranked[0]?.[0] ?? 'unknown',
		autoShare: credits > 0 ? (byMode.get('auto') ?? 0) / credits : 0,
		credits
	};
}

/** Above this share of a model's spend, Auto is meaningfully the one choosing. */
const AUTO_DOMINANT_SHARE = 0.5;

export function advise(
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	priceStats: Record<string, PriceStats> = {},
	remainingAllowance?: number
): Advice[] {
	const totals = sum(rollups);
	const totalCredits = totals.nanoAiu * creditsPerNanoAiu;
	if (totalCredits <= 0) {
		return [];
	}

	const byModel = groupBy(rollups, 'model');
	const prices = new Map<string, Price>();
	for (const model of byModel.keys()) {
		const solved = priceStats[model] ? solve(priceStats[model], creditsPerNanoAiu) : undefined;
		if (solved) {
			prices.set(model, solved);
		}
	}

	const found = [
		cacheMissAdvice(rollups, byModel, creditsPerNanoAiu, prices),
		modelMixAdvice(rollups, byModel, creditsPerNanoAiu, totalCredits, prices),
		auxiliaryAdvice(rollups, creditsPerNanoAiu, totalCredits)
	].filter((a): a is Advice => a !== undefined);

	const material = (a: Advice) =>
		remainingAllowance !== undefined && remainingAllowance > 0
			? a.creditsAtStake / remainingAllowance >= MIN_SHARE_OF_ALLOWANCE
			: a.creditsAtStake >= MIN_CREDITS_AT_STAKE &&
			  a.creditsAtStake / totalCredits >= MIN_SHARE_AT_STAKE;

	return found
		.filter(material)
		.sort((a, b) =>
			a.bounded === b.bounded
				? b.creditsAtStake - a.creditsAtStake
				: Number(a.bounded) - Number(b.bounded)
		);
}

/** Cost per input token, split by whether the request read from the cache. */
export interface CacheSplit {
	model: string;
	missRequests: number;
	hitRequests: number;
	/** Credits per input token, uncached. */
	missRate: number;
	/** Credits per input token, cached. */
	hitRate: number;
	factor: number;
	/** Credits the uncached requests would not have cost at cached rates. */
	excessCredits: number;
	/** True when the figures come from a solved rate card rather than an average. */
	exact: boolean;
}

/**
 * Two ways to price a cache miss, in order of preference.
 *
 * **With a rate card** the answer is exact: fresh input bills at `A` and cached
 * input at `B`, both solved from this model's own requests, so a miss costs
 * `(A - B)` per token and the multiple is simply `A / B`. Nothing is inferred.
 *
 * **Without one** it falls back to comparing average credits-per-input-token
 * across cached and uncached requests. That average is confounded: the
 * numerator includes output cost, which bills at several times input, so a
 * miss that happened to produce a long answer looks like a worse cache miss
 * than it was. The fallback is normalised per input token rather than per
 * request so at least prompt length cannot masquerade as a cache problem.
 */
export function cacheSplit(
	model: string,
	t: Totals,
	creditsPerNanoAiu: number,
	price?: Price
): CacheSplit | undefined {
	const hitInput = t.inputTokens - t.missInputTokens;
	const hitRequests = t.requests - t.missRequests;

	if (t.missInputTokens <= 0 || hitInput <= 0 || hitRequests < MIN_BASELINE_REQUESTS) {
		return undefined;
	}

	if (price && price.fresh > 0 && price.cached > 0) {
		return {
			model,
			missRequests: t.missRequests,
			hitRequests,
			missRate: price.fresh / 1000,
			hitRate: price.cached / 1000,
			factor: price.fresh / price.cached,
			// Exactly what those tokens cost fresh, less what they would have
			// cost warm. No output cost enters either side.
			excessCredits: (t.missInputTokens * (price.fresh - price.cached)) / 1000,
			exact: true
		};
	}

	const hitNano = t.nanoAiu - t.missNanoAiu;
	if (t.missNanoAiu <= 0 || hitNano <= 0) {
		return undefined;
	}
	const missRate = (t.missNanoAiu / t.missInputTokens) * creditsPerNanoAiu;
	const hitRate = (hitNano / hitInput) * creditsPerNanoAiu;
	if (!Number.isFinite(missRate) || !Number.isFinite(hitRate) || hitRate <= 0) {
		return undefined;
	}

	return {
		model,
		missRequests: t.missRequests,
		hitRequests,
		missRate,
		hitRate,
		factor: missRate / hitRate,
		excessCredits: (t.missNanoAiu * creditsPerNanoAiu) - (t.missInputTokens * hitRate),
		exact: false
	};
}

function cacheMissAdvice(
	rollups: Rollup[],
	byModel: Map<string, Totals>,
	creditsPerNanoAiu: number,
	prices: Map<string, Price>
): Advice | undefined {
	const splits = [...byModel.entries()]
		.map(([model, t]) => cacheSplit(model, t, creditsPerNanoAiu, prices.get(model)))
		.filter((s): s is CacheSplit => s !== undefined && s.factor >= MIN_CACHE_FACTOR && s.excessCredits > 0)
		.sort((a, b) => b.excessCredits - a.excessCredits);

	const worst = splits[0];
	if (!worst) {
		return undefined;
	}

	const excess = splits.reduce((n, s) => n + s.excessCredits, 0);
	const misses = splits.reduce((n, s) => n + s.missRequests, 0);
	const mix = selectionMix(rollups, worst.model, creditsPerNanoAiu);
	const byAuto = mix.dominant === 'auto' && mix.autoShare >= AUTO_DOMINANT_SHARE;

	return {
		id: 'cache-miss',
		headline:
			`${misses} request${misses === 1 ? '' : 's'} re-read ` +
			`${misses === 1 ? 'its' : 'their'} whole context uncached, costing ` +
			`${fmt(excess)} credits more than the same tokens cost warm.`,
		detail:
			'A cold cache bills every token of the conversation at full price. Each model ' +
			'keeps its own cache, so the first request to a model inside a thread pays ' +
			'in full and every later one is warm -- including when you come back to a ' +
			'model you used earlier. Editing an earlier message or leaving a thread idle ' +
			'long enough to expire has the same effect.' +
			(byAuto
				? ' Auto is doing the switching here, not you: it can change model between ' +
				  'turns of one thread, and each change starts a fresh cache. Pinning a ' +
				  'model for the length of a long thread is what avoids this.'
				: ' Finishing a thread on the model you started it on is the single ' +
				  'cheapest habit change available.'),
		creditsAtStake: excess,
		bounded: false,
		evidence:
			`${worst.model}: ${fmtRate(worst.missRate)} per 1k input tokens uncached vs ` +
			`${fmtRate(worst.hitRate)} cached, over ${worst.missRequests} uncached and ` +
			`${worst.hitRequests} cached requests -- ${worst.factor.toFixed(1)}x. ` +
			(worst.exact
				? 'Both rates are from this model\'s solved rate card, so no output cost ' +
				  'is mixed into either side.'
				: 'Rates are averages over whole requests, so output cost is mixed in; ' +
				  'six billed requests on one model would let this be solved exactly.')
	};
}

/**
 * Credits per token of total traffic. The fallback comparator only.
 *
 * Pooling input and output into one denominator is confounded: output bills at
 * several times input, so a model that writes long answers looks costlier per
 * token than one that writes short ones at identical prices. Used only when a
 * rate card is unavailable for both models being compared.
 */
function modelRate(t: Totals, creditsPerNanoAiu: number): number | undefined {
	const tokens = t.inputTokens + t.outputTokens;
	if (tokens <= 0) {
		return undefined;
	}
	return (t.nanoAiu * creditsPerNanoAiu) / tokens;
}

/**
 * What the dearest model's *actual workload* would have cost elsewhere.
 *
 * This is the like-for-like comparison. Rather than comparing two pooled
 * per-token averages -- which conflates price with how much each model chose
 * to write -- it takes the exact fresh, cached and output tokens already spent
 * on the dearest model and re-prices that same basket with the other model's
 * solved rate card. Identical work, different rates.
 */
function counterfactual(
	rollups: Rollup[],
	dearest: string,
	alternative: Price
): { tokens: { fresh: number; cached: number; output: number }; cost: number } | undefined {
	const rows = rollups.filter(r => r.model === dearest);
	if (rows.length === 0) {
		return undefined;
	}
	const t = sum(rows);
	const tokens = {
		fresh: Math.max(0, t.inputTokens - t.cacheReadTokens),
		cached: t.cacheReadTokens,
		output: t.outputTokens
	};
	const cost = costOf(alternative, tokens.fresh, tokens.cached, tokens.output);
	return cost > 0 ? { tokens, cost } : undefined;
}

/**
 * Models are only comparable if they do the same kind of work.
 *
 * Without this, the dearest agent model gets compared against whatever mini
 * model Copilot uses for thread titles and completions, and the card claims a
 * developer could save most of their bill by "switching" to something that
 * cannot do the job. On one simulated profile it advised saving 2,130 of 2,412
 * credits that way: arithmetically correct, but not something a user could act on.
 */
function substitutes(rollups: Rollup[], model: string): Set<string> {
	const contexts = new Set(
		rollups.filter(r => r.model === model && USER_FACING.test(r.operation))
			.map(r => r.operation)
	);
	const out = new Set<string>();
	if (contexts.size === 0) {
		return out;
	}
	for (const r of rollups) {
		if (r.model !== model && contexts.has(r.operation)) {
			out.add(r.model);
		}
	}
	return out;
}

function modelMixAdvice(
	rollups: Rollup[],
	byModel: Map<string, Totals>,
	creditsPerNanoAiu: number,
	totalCredits: number,
	prices: Map<string, Price>
): Advice | undefined {
	const rated = [...byModel.entries()]
		.map(([model, t]) => ({
			model,
			credits: t.nanoAiu * creditsPerNanoAiu,
			requests: t.requests,
			rate: modelRate(t, creditsPerNanoAiu),
			price: prices.get(model)
		}))
		.filter(m => m.rate !== undefined && m.rate > 0) as
		{ model: string; credits: number; requests: number; rate: number; price?: Price }[];

	if (rated.length < 2) {
		return undefined;
	}

	const dearest = [...rated].sort((a, b) => b.credits - a.credits)[0];
	const usable = substitutes(rollups, dearest.model);
	const others = rated.filter(m => m.model !== dearest.model && usable.has(m.model));
	if (others.length === 0) {
		return undefined;
	}

	// Prefer an alternative we can price exactly. Ranking candidates by their
	// fresh-input rate rather than a pooled average keeps the choice of
	// comparator from being confounded by output mix too.
	const priced = others
		.filter(m => m.price && dearest.price)
		.sort((a, b) => a.price!.fresh - b.price!.fresh)[0];
	const cheapest = priced ?? [...others].sort((a, b) => a.rate - b.rate)[0];
	if (!cheapest) {
		return undefined;
	}

	const exact = priced !== undefined
		? counterfactual(rollups, dearest.model, priced.price!)
		: undefined;

	// With both rate cards the saving is a re-priced basket of the very tokens
	// already spent, not a guess. It stays `bounded` because the cheaper model
	// might need more turns to finish the same work -- that part is unknowable
	// from telemetry -- but the price side is now measured.
	const saving = exact ? dearest.credits - exact.cost : undefined;
	if (exact && (saving === undefined || saving <= 0)) {
		return undefined;
	}
	if (!exact && cheapest.rate >= dearest.rate) {
		return undefined;
	}

	const multiple = exact
		? dearest.credits / exact.cost
		: dearest.rate / cheapest.rate;
	const ceiling = saving ?? dearest.credits * (1 - cheapest.rate / dearest.rate);

	const share = dearest.credits / totalCredits;
	const mix = selectionMix(rollups, dearest.model, creditsPerNanoAiu);
	// Advising someone to route away from a model is advice about a choice.
	// When Auto made that choice, the actionable lever is Auto itself.
	const byAuto = mix.dominant === 'auto' && mix.autoShare >= AUTO_DOMINANT_SHARE;

	const costPhrase = exact
		? `the same tokens would have cost ${fmt(exact.cost)} on ${cheapest.model}`
		: `at ${multiple.toFixed(1)}x the token rate of ${cheapest.model}`;

	return {
		id: 'model-mix',
		headline: byAuto
			? `Auto picked ${dearest.model} for ${(mix.autoShare * 100).toFixed(0)}% of its ` +
			  `spend &mdash; ${costPhrase}.`
			: `${dearest.model} took ${(share * 100).toFixed(0)}% of your spend &mdash; ` +
			  `${costPhrase}.`,
		detail:
			(byAuto
				? `Auto optimises for getting the answer right, not for what it costs, and ` +
				  `you did not choose this model -- so "switch models" is not the lever. ` +
				  `The lever is scope: pin a cheaper model yourself on threads you already ` +
				  `know are routine, and leave Auto to the work where being wrong is ` +
				  `expensive. `
				: `Worth keeping for multi-file agent work, where the stronger model finishes ` +
				  `in fewer turns and costs less overall. Worth switching away from for the ` +
				  `turns that are not that: naming things, explaining a function, writing a ` +
				  `commit message, a single-line fix. `) +
			(exact
				? `The ${fmt(ceiling)} credit difference prices the exact tokens you already ` +
				  `spent at the other model's measured rates. It still assumes the cheaper ` +
				  `model would finish in the same number of turns, which telemetry cannot ` +
				  `tell us.`
				: `At most ${fmt(ceiling)} credits sit in that difference.`),
		creditsAtStake: ceiling,
		bounded: true,
		evidence: exact
			? `${escapeBasket(exact.tokens)} on ${dearest.model} cost ${fmt(dearest.credits)}; ` +
			  `the same basket at ${cheapest.model} rates ` +
			  `(fresh ${cheapest.price!.fresh.toFixed(3)}, cached ${cheapest.price!.cached.toFixed(3)}, ` +
			  `output ${cheapest.price!.output.toFixed(3)} cr/1k, from ${cheapest.price!.n} requests) ` +
			  `costs ${fmt(exact.cost)}. ${(mix.autoShare * 100).toFixed(0)}% auto-selected.`
			: `${dearest.model}: ${fmtRate(dearest.rate)} per 1k tokens over ` +
			  `${dearest.requests} requests, ${(mix.autoShare * 100).toFixed(0)}% of that ` +
			  `spend auto-selected. ${cheapest.model}: ${fmtRate(cheapest.rate)} over ` +
			  `${cheapest.requests}. Neither model has a solved rate card yet, so this ` +
			  `compares pooled per-token averages and is confounded by output mix.`
	};
}

function escapeBasket(t: { fresh: number; cached: number; output: number }): string {
	const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
	return `${k(t.fresh)} fresh + ${k(t.cached)} cached + ${k(t.output)} output tokens`;
}

/**
 * Copilot bills work you did not ask for -- thread titles, progress messages --
 * under its own agent names. Usually trivial; occasionally not.
 */
const USER_FACING = /agent|editor|panel|inline|edits|ask|chat$/i;

function auxiliaryAdvice(
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	totalCredits: number
): Advice | undefined {
	const byOperation = groupBy(rollups, 'operation');
	const auxiliary = [...byOperation.entries()]
		.filter(([name]) => !USER_FACING.test(name))
		.map(([name, t]) => ({ name, credits: t.nanoAiu * creditsPerNanoAiu, requests: t.requests }))
		.filter(a => a.credits > 0)
		.sort((a, b) => b.credits - a.credits);

	if (auxiliary.length === 0) {
		return undefined;
	}
	const credits = auxiliary.reduce((n, a) => n + a.credits, 0);
	const share = credits / totalCredits;

	return {
		id: 'auxiliary',
		headline:
			`${(share * 100).toFixed(0)}% of your spend went to requests you did not make.`,
		detail:
			'Copilot bills background calls -- thread titles, progress summaries, ' +
			'follow-up suggestions -- against the same allowance as your own turns. ' +
			'They are individually small and collectively not.',
		creditsAtStake: credits,
		bounded: false,
		evidence: auxiliary
			.slice(0, 3)
			.map(a => `${a.name}: ${fmt(a.credits)} over ${a.requests} requests`)
			.join('; ')
	};
}

function fmt(credits: number): string {
	return credits >= 100 ? Math.round(credits).toLocaleString('en-US') : credits.toFixed(2);
}

function fmtRate(creditsPerToken: number): string {
	const per1k = creditsPerToken * 1000;
	return per1k >= 0.01 ? per1k.toFixed(2) : per1k.toFixed(4);
}
