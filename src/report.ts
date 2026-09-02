import { Rollup, Totals, DepthStats, ConversationStats, DEPTH_BUCKETS, groupBy, sum, dayStartMs } from './store';
import { Projection } from './projection';
import { PeriodCoverage, periodCoverage, conversionConfidence, resetInstantFrom } from './reconcile';
import { dayPressure, pctText } from './projection';
import { bareModel, modelKey } from './ratecard';
import { Tuning, defaults } from './tuning';
import { Advice, advise, selectionMix } from './advice';
import { prefix, Confidence } from './confidence';
import { PriceStats, Price, solve } from './pricing';

/**
 * The panel.
 *
 * It answers three questions in order, and nothing else: will I be throttled,
 * what should I change, and where did it go. An earlier version led with five
 * stat tiles and a daily-spend chart; with one day of history that chart is a
 * full-width rectangle, and "23.04 credits" with no denominator is not a fact
 * anyone can act on. Both are gone.
 */

export function fmtInt(n: number): string {
	return Math.round(n).toLocaleString('en-US');
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(1)}k`;
	}
	return fmtInt(n);
}

export function fmtCredits(credits: number): string {
	return credits >= 100 ? fmtInt(credits) : credits.toFixed(2);
}

/**
 * The figure with its unit spelled out.
 *
 * "cr" and "credits" were both in use -- "1,477 cr left" beside "23.04 credits"
 * -- which reads as two different units to anyone who has not just read the
 * source. One word, everywhere.
 */
export function fmtCreditsWith(credits: number): string {
	const n = fmtCredits(credits);
	return `${n} ${n === '1.00' ? 'credit' : 'credits'}`;
}

/** Hours, never zero: a period with "0h" left is one that already ended. */
function hoursLeft(days: number): number {
	return Math.max(1, Math.round(days * 24));
}

/**
 * The figure alone, in whatever unit is legible at this size.
 *
 * Under a day it counts hours, so "days" is not a unit the caller may assume.
 * The tile read "13h days" on the last day of a period: the figure carried a
 * unit of its own and the label under it carried a different one. Pair it with
 * dayUnit() wherever the unit is drawn separately, or use fmtDaysWith().
 */
export function fmtDays(days: number | undefined): string {
	if (days === undefined) {
		return '?';
	}
	if (days < 1) {
		return String(hoursLeft(days));
	}
	return days < 10 ? days.toFixed(1) : String(Math.round(days));
}

/** The unit fmtDays() just used, singular when the figure is exactly one. */
export function dayUnit(days: number | undefined): string {
	if (days === undefined || days >= 1) {
		return 'days';
	}
	return hoursLeft(days) === 1 ? 'hour' : 'hours';
}

/** The figure with its unit spelled out, for prose rather than a tile. */
export function fmtDaysWith(days: number | undefined): string {
	return `${fmtDays(days)} ${dayUnit(days)}`;
}

export function creditsOf(nanoAiu: number, creditsPerNanoAiu: number): number {
	return nanoAiu * creditsPerNanoAiu;
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
	);
}

function bar(fraction: number): string {
	const pct = Math.max(0, Math.min(1, fraction)) * 100;
	return `<div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>`;
}

/* -------------------------------------------------------------- verdict --- */

/** Status hue by severity. Reserved for state; never reused as a series colour. */
function severityVar(p: Projection): string {
	switch (p.verdict) {
		case 'exhausted':
		case 'will-exhaust': return 'var(--vscode-charts-red, #f14c4c)';
		case 'tight': return 'var(--vscode-charts-yellow, #cca700)';
		default: return 'var(--vscode-charts-blue, #4a9eff)';
	}
}

/**
 * The same severity, for text rather than fill.
 *
 * charts-yellow is a fill: as a 40px hero it measured 2.17:1 on light, under
 * the 3:1 that large text needs, and the theme's own warning foreground is
 * only 2.93:1 there. No single yellow clears the bar in both themes, because
 * the one that reads on white is invisible on near-black. Orange does: 4.0:1
 * on both, in each theme's own value for it. Red comes from errorForeground,
 * the colour a theme contrast-checks against its editor background.
 */
function severityTextVar(p: Projection): string {
	switch (p.verdict) {
		case 'exhausted':
		case 'will-exhaust': return 'var(--vscode-errorForeground, #f14c4c)';
		case 'tight': return 'var(--vscode-charts-orange, #bf6a02)';
		default: return 'var(--vscode-charts-blue, #4a9eff)';
	}
}

/**
 * A meter: one ratio against a limit.
 *
 * The solid fill is what you have spent. The ghosted extension is where the
 * observed burn rate lands you by the reset date -- if it runs off the end of
 * the track, that is the throttle, drawn.
 */
function allowanceMeter(p: Projection, historyDays: number): string {
	if (p.entitlement === undefined || p.remaining === undefined || p.entitlement <= 0) {
		return '';
	}
	const used = Math.max(0, p.entitlement - p.remaining);
	const projected = p.burnPerDay !== undefined && p.daysToReset !== undefined
		? used + p.burnPerDay * p.daysToReset
		: undefined;
	const overshoots = projected !== undefined && projected > p.entitlement;

	// When the projection runs past the allowance, the track is scaled to the
	// projection and the allowance is marked on it. Clipping the forecast at
	// 100% instead would draw an overshoot as a bar that merely fills up --
	// the one reading the number underneath flatly contradicts.
	const scaleMax = overshoots ? projected! : p.entitlement;
	const usedFrac = Math.min(1, used / scaleMax);
	const projectedFrac = projected !== undefined ? Math.min(1, projected / scaleMax) : undefined;
	const ghostWidth = projectedFrac !== undefined ? Math.max(0, projectedFrac - usedFrac) : 0;

	const hue = severityVar(p);
	const ghost = ghostWidth > 0
		? `<div class="meter-ghost" style="left:${(usedFrac * 100).toFixed(2)}%;` +
		  `width:${(ghostWidth * 100).toFixed(2)}%"></div>`
		: '';
	const limit = overshoots
		? `<div class="meter-limit" style="left:${((p.entitlement / scaleMax) * 100).toFixed(2)}%"
			title="allowance: ${fmtCredits(p.entitlement)} credits"></div>`
		: '';

	const projectionNote = p.verdict === 'exhausted'
		? `<span class="over">${p.creditsUsed !== undefined && p.entitlement
			&& p.creditsUsed > p.entitlement
				? `${fmtCredits(p.creditsUsed - p.entitlement)} credits over`
				: 'nothing left'}</span>`
		: projected === undefined
		? '<span class="dim">projection needs more than one day of history</span>'
		: overshoots
			? `<span class="over">${fmtCredits(projected - p.entitlement)} over by reset</span>`
			: `<span class="dim">projected ${fmtCredits(projected)} by reset</span>`;

	return `
	<div class="meter-wrap">
		<div class="meter-head">
			<div class="mh-label"><strong>${fmtCredits(used)}</strong> of
				${fmtCredits(p.entitlement)} credits used${creditHint(historyDays)}</div>
			${projectionNote}
		</div>
		<div class="meter" style="--hue:${hue}"
		     title="${fmtCredits(used)} used, ${fmtCredits(p.remaining)} remaining">
			<div class="meter-fill" style="width:${(usedFrac * 100).toFixed(2)}%"></div>
			${ghost}
			${limit}
		</div>
		<div class="meter-foot">
			<span class="dim">${p.quotaId ? escapeHtml(p.quotaId) : 'allowance'}</span>
			<span class="dim">${overshoots
				? `allowance ends here &middot; ${fmtCredits(p.remaining)} left today`
				: `${fmtCreditsWith(p.remaining)} left`}</span>
		</div>
	</div>`;
}

/* ---------------------------------------------------------------- tiles --- */

/**
 * A bare number on a tile is not a measurement.
 *
 * "275 / PER DAY SUSTAINABLE" left the reader to guess between credits,
 * requests and tokens. The unit now rides the value, and the label says what
 * the number means rather than restating the unit.
 */
function tile(value: string, unit: string, label: string, hint?: string, state?: 'hot'): string {
	const title = hint ? ` title="${escapeHtml(hint)}"` : '';
	return `<div class="tile${state ? ` ${state}` : ''}"${title}>` +
		`<div class="v">${value}<span class="unit">${unit}</span></div>` +
		`<div class="k">${label}</div></div>`;
}

function paceTiles(p: Projection): string {
	const tiles: string[] = [];
	// A tile that cannot be computed still stands in the row. Omitting it left
	// the row short and the card looking like it had failed to render, when the
	// truth is narrower: this one figure is not knowable yet.
	if (p.burnPerDay === undefined) {
		tiles.push(tile('&mdash;', '', 'your pace',
			'A rate needs a day of measured history. Backfilled days are a floor ' +
			'and are never averaged into it.'));
	}
	if (p.burnPerDay !== undefined) {
		const overPace =
			p.sustainableDailyBurn !== undefined && p.burnPerDay > p.sustainableDailyBurn;
		tiles.push(tile(
			fmtCredits(p.burnPerDay),
			'credits/day',
			'your pace',
			`Credits per day, measured over ${fmtDaysWith(p.daysObserved)} of elapsed ` +
			'time with idle days included.',
			overPace ? 'hot' : undefined
		));
	}
	if (p.sustainableDailyBurn !== undefined) {
		tiles.push(tile(
			fmtCredits(p.sustainableDailyBurn),
			'credits/day',
			'sustainable pace',
			'Credits per day the remaining allowance can absorb until it resets.'
		));
	}
	if (p.daysToReset !== undefined) {
		tiles.push(tile(fmtDays(p.daysToReset), dayUnit(p.daysToReset), 'until reset'));
	}
	return tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : '';
}

/* --------------------------------------------------------------- advice --- */

/** Whether the habits block already said something, so silence here is fine. */
export function habitsFound(depth: Record<string, DepthStats> | undefined): boolean {
	return Object.values(depth ?? {}).filter(d => d.warmRequests > 0).length >= 2;
}

/**
 * What the mark on every chip means, said once.
 *
 * The chips carry `~` and a dashed border when a finding inherits doubt from
 * the credit conversion, and a mark nobody can decode is worse than no mark:
 * it reads as a rendering fault. One sentence, and only when something is
 * actually marked -- a permanent disclaimer would train the reader to stop
 * looking at the badges that matter.
 */
function conversionNote(
	conversion: { confidence: Confidence; why?: string },
	shown: Advice[]
): string {
	if (conversion.confidence === 'measured' || shown.length === 0) {
		return '';
	}
	if (!shown.some(a => a.confidence === 'estimated')) {
		return '';
	}
	return `<p class="note dim">The <strong>~</strong> on each figure is the credit
		conversion, not the count behind it: token counts are exact, but turning them into
		credits uses a multiplier nothing has checked yet. Run
		<strong>Token Pie: Check Quota</strong> twice, a few messages apart, and these become
		measurements.</p>`;
}

function adviceCards(items: Advice[], somethingElseSaid: boolean): string {
	if (items.length === 0) {
		return somethingElseSaid
			? ''
			: '<p class="dim">Nothing worth changing shows up in your usage yet.</p>';
	}
	// Only the top-ranked finding is expanded. The rest keep their headline --
	// which is the finding, numbers and all -- visible in the summary, so
	// collapsing costs the reader nothing but the remedy text.
	return items
		.map(
			(a) => `<details class="card">
			<summary>
				<span class="card-title">${a.headline}</span>
				<span class="stake ${a.confidence}"${a.why ? ` title="${escapeHtml(a.why)}"` : ''}>${escapeHtml(prefix(a.confidence))}${fmtCreditsWith(a.creditsAtStake)}</span>
			</summary>
			<div class="card-body">${a.detail}</div>
			<div class="card-evidence">${escapeHtml(a.evidence)}</div>
		</details>`
		)
		.join('');
}

/* ---------------------------------------------------------- composition --- */

/**
 * Part-to-whole, direct-labelled, and weighted by **cost** wherever the rate
 * card is known.
 *
 * This bar previously showed token counts under the heading "what you are
 * paying for", which is a cost claim. Output tokens bill at 4x fresh input and
 * 12.5x cached input, so the two readings diverge substantially: model
 * output was 2% of tokens and 16% of spend, while cached context was 66% of
 * tokens and 12% of spend. Showing tokens there understated output eightfold.
 */
/**
 * What the non-cached half of your input actually is.
 *
 * "New, charged in full" was wrong in a way that mattered. Tokens that miss the
 * cache are usually also *written* to it, and a cache write bills above plain
 * input -- $2.50 per million against $2.00 on claude-sonnet-5. The solver
 * recovered 0.25 credits per 1k for this class and that figure is the published
 * cache-write price, not the published input price, so the row was carrying a
 * premium the label denied.
 *
 * Providers that do not charge for cache writes report none, and on those the
 * old wording was right, so the label follows the data rather than picking one.
 */
function freshLabel(fresh: number, cacheWrite: number, dominant: number): string {
	if (fresh <= 0) {
		return 'new to this request';
	}
	const written = cacheWrite / fresh;
	if (written >= dominant) {
		return 'new, and cached for next time';
	}
	if (written <= 1 - dominant) {
		return 'new, charged in full';
	}
	return 'new to this request';
}

/**
 * The premium, named -- because it is the thing that makes the cache pay.
 *
 * A cache write costs more than plain input, and a reader who sees only the
 * higher number reasonably concludes caching is a bad deal. It is the opposite:
 * the 25% surcharge once is what buys the 90% discount on every repeat.
 */
function cacheWriteNote(fresh: number, cacheWrite: number, dominant: number): string {
	if (fresh <= 0 || cacheWrite / fresh < dominant) {
		return '';
	}
	return `Anything you send new is also written into the cache: a surcharge
		paid once that buys the cheaper rate on every message that reuses it.`;
}

/**
 * Why the two share columns disagree.
 *
 * The Per token column already prints 4x and 0.08x, so this does not exist to
 * report the rates. It exists to say what they cause: 1% of the text being 21%
 * of the bill is the whole reason the two shares are side by side, and a reader
 * who has not done the division does not see it.
 *
 * It used to open "That is the gap between the two share columns:", whose
 * "That" pointed at whichever sentence happened to precede it -- the unpriced
 * backlog when there was one, the goodness of fit when there was not. Neither
 * is the gap. The cause comes first now and the consequence after it, so there
 * is nothing for the pronoun to pick up wrongly.
 */
function rateContrast(lead: { model: string; price: Price } | undefined): string {
	if (!lead || lead.price.fresh <= 0) {
		return '';
	}
	const vsFresh = lead.price.output / lead.price.fresh;
	if (!Number.isFinite(vsFresh) || vsFresh < 1.5) {
		return '';
	}
	const vsCached = lead.price.cached > 0 ? lead.price.output / lead.price.cached : undefined;
	// &times; rather than "x", so the figure reads as the same quantity the Per
	// token column above it prints.
	return `On ${escapeHtml(lead.model)}, Copilot's replies cost ` +
		`${vsFresh.toFixed(0)}&times; what you send` +
		(vsCached && Number.isFinite(vsCached)
			? ` and ${vsCached.toFixed(0)}&times; what it reads back from cache`
			: '') +
		` &mdash; which is why the two share columns disagree.`;
}

function compositionBar(
	rollups: Rollup[],
	prices: Record<string, PriceStats>,
	creditsPerNanoAiu: number,
	tuning: Tuning
): string {
	let fresh = 0, cached = 0, output = 0, reasoning = 0, cacheWrite = 0;
	let costFresh = 0, costCached = 0, costOutput = 0, costReasoning = 0;
	let pricedFresh = 0, pricedCached = 0, pricedOutput = 0, pricedReasoning = 0;
	let pricedCacheWrite = 0;
	let pricedCredits = 0, totalCredits = 0;
	const priced: { model: string; price: Price }[] = [];

	const byModel = new Map<string, Rollup[]>();
	for (const r of rollups) {
		byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
	}

	for (const [model, rows] of byModel) {
		const t = sum(rows);
		const f = Math.max(0, t.inputTokens - t.cacheReadTokens);
		fresh += f;
		cacheWrite += t.cacheWriteTokens;
		cached += t.cacheReadTokens;
		output += t.outputTokens;
		reasoning += t.reasoningTokens;

		const credits = creditsOf(t.nanoAiu, creditsPerNanoAiu);
		totalCredits += credits;

		const stats = prices?.[model];
		const price = stats ? solve(stats, creditsPerNanoAiu, tuning) : undefined;
		if (!price || credits <= 0) {
			continue;
		}
		priced.push({ model, price });
		pricedCredits += credits;
		pricedFresh += f;
		pricedCacheWrite += t.cacheWriteTokens;
		pricedCached += t.cacheReadTokens;
		pricedOutput += t.outputTokens;
		pricedReasoning += t.reasoningTokens;
		costFresh += (f * price.fresh) / 1000;
		costCached += (t.cacheReadTokens * price.cached) / 1000;
		costOutput += (t.outputTokens * price.output) / 1000;
		// Thinking is billed at the output rate, not a rate of its own. Fitting
		// a fourth coefficient against 13 reasoning-bearing requests returned
		// -0.00008 credits per 1k with R2 unchanged at 1.000000 -- zero to
		// within solver noise. See DECISIONS.md#reasoning.
		costReasoning += (t.reasoningTokens * price.output) / 1000;
	}

	const tokenTotal = fresh + cached + output;
	if (tokenTotal <= 0) {
		return '';
	}

	const coverage = totalCredits > 0 ? pricedCredits / totalCredits : 0;
	const byCost = priced.length > 0 && coverage >= tuning.report.minPricedShare
		&& costFresh + costCached + costOutput > 0;

	if (!byCost) {
		const rows: CompRow[] = [
			{ label: 'what you send', tokens: fresh + cached },
			{ label: freshLabel(fresh, cacheWrite, tuning.report.cacheWriteDominant), cls: 'c-fresh', tokens: fresh, child: true },
			{ label: 'repeated, from cache', cls: 'c-cached', tokens: cached, child: true },
			{ label: "Copilot's replies", cls: 'c-output', tokens: output },
			{ label: 'thinking, never shown', tokens: reasoning, child: true }
		];
		return `
	<div class="composition">
		${compositionTable(rows, false, 'By kind of text')}
		<p class="note">By token count &mdash; not by cost. Output bills at a multiple of
		   input; measuring the rate needs six billed messages on one model.</p>
	</div>`;
	}

	// Spend on models without a solved rate card cannot be split across the
	// three classes -- but it was still spent. Carrying it as a fourth row
	// keeps the table summing to the same total as the by-model table;
	// dropping it silently lost a third of the bill on real data.
	const unpricedCost = Math.max(0, totalCredits - pricedCredits);
	const unpricedTokens = Math.max(0, tokenTotal - (pricedFresh + pricedCached + pricedOutput));

	// Credits and tokens as adjacent columns over the same population, row for
	// row. Their divergence is the finding -- output is a sliver of the tokens
	// and a slab of the bill -- so it is shown, not asserted in a sentence.

	// Input is the sum of its two halves and belongs on the page as such: it is
	// the word everyone uses, and without a subtotal the reader cannot see the
	// input-versus-output split at all -- only fresh, cached and output
	// separately, with the first two never added up.
	const costInput = costFresh + costCached;
	const tokensInput = pricedFresh + pricedCached;

	// Taken from the figures in the table rather than from a rate card, so the
	// reader can check any of them by dividing the two columns either side.
	// Fresh input is the baseline: it is the price everything else is a discount
	// or a premium on, and showing it as 1x makes the baseline visible instead
	// of implied.
	const perToken = (credits: number, tokens: number) =>
		tokens > 0 ? credits / tokens : undefined;
	const base = perToken(costFresh, pricedFresh);
	const relative = (credits: number, tokens: number) => {
		const rate = perToken(credits, tokens);
		return base && base > 0 && rate !== undefined ? rate / base : undefined;
	};

	const rows: CompRow[] = [
		{ label: 'what you send', credits: costInput, tokens: tokensInput },
		{ label: freshLabel(pricedFresh, pricedCacheWrite, tuning.report.cacheWriteDominant), cls: 'c-fresh',
		  credits: costFresh, tokens: pricedFresh,
		  child: true, multiple: relative(costFresh, pricedFresh) },
		{ label: 'repeated, from cache', cls: 'c-cached', credits: costCached, tokens: pricedCached,
		  child: true, multiple: relative(costCached, pricedCached) },
		{ label: "Copilot's replies", cls: 'c-output', credits: costOutput, tokens: pricedOutput,
		  multiple: relative(costOutput, pricedOutput) },
		// Thinking is output, so it carries output's price -- which is the point:
		// the text you never see costs the same as the answer.
		{ label: 'thinking, never shown', credits: costReasoning, tokens: pricedReasoning,
		  child: true, multiple: relative(costReasoning, pricedReasoning) },
		{ label: 'not measured yet', cls: 'c-open', credits: unpricedCost, tokens: unpricedTokens }
	];

	const models = priced.slice().sort((a, b) => b.price.n - a.price.n);
	const lead = models[0];
	const observations = models.reduce((n, m) => n + m.price.n, 0);
	const worstFit = Math.min(...models.map(m => m.price.r2));

	// Two paragraphs, because they answer different questions -- where these
	// prices came from, and why 1% of the text is 21% of the bill -- and they
	// are not read the same way. Provenance keeps `.card-evidence`, whose
	// monospace is the house signal for a measurement rather than an argument;
	// the same styling on four sentences of explanation made the explanation
	// look like debug output and the eye skipped it.
	const why = [
		rateContrast(lead),
		cacheWriteNote(pricedFresh, pricedCacheWrite, tuning.report.cacheWriteDominant)
	].filter(Boolean).join(' ');

	return `
	<div class="composition">
		${compositionTable(rows, true, 'By kind of text')}
		<p class="card-evidence rate-card">Prices measured from your own
			${observations} billed message${observations === 1 ? '' : 's'} on
			${escapeHtml(lead.model)}${
				models.length > 1 ? ` and ${models.length - 1} other model${models.length > 2 ? 's' : ''}` : ''
			}, ${worstFit >= 0.9999
				? 'matching every one of them to the credit'
				: `accounting for ${(worstFit * 100).toFixed(1)}% of what you were charged`}${
				unpricedCost > 0
					? `. The ${fmtCredits(unpricedCost)} credits not measured yet need six billed
					   messages on one model before they can be split`
					: ''}.</p>
		${why ? `<p class="note comp-why">${why}</p>` : ''}
	</div>`;
}

interface CompRow {
	label: string;
	/**
	 * Palette class. Identity is also the row label, never colour alone.
	 * Absent on subtotal rows, which take a neutral.
	 */
	cls?: string;
	credits?: number;
	tokens: number;
	/** A breakdown of the total above it: indented, and outside the shares. */
	child?: boolean;
	/**
	 * Cost per token, as a multiple of fresh input.
	 *
	 * The table showed volume and cost but never the price, so the reader had to
	 * divide one column by the other to discover why 1% of the tokens is 21% of
	 * the bill. A per-1k *rate* column was tried and removed -- 0.25 credits per
	 * 1k is the unit a billing system thinks in. A multiple is not: "four times
	 * what you send" is a sentence a person can hold.
	 *
	 * Only on rows that are a single price class. A parent blends two rates, and
	 * a weighted average of prices is not a price.
	 */
	multiple?: number;
}

/**
 * A table, with the share columns drawn as bars.
 *
 * Four classes across two measures is more numbers than a stacked bar can
 * label, and the point is a comparison between two columns rather than a
 * part-to-whole shape. Putting the two shares side by side makes the
 * divergence both visible and exact -- and every row carries its own name, so
 * colour never has to carry identity.
 */
/** 1x, 0.08x, 4x -- readable at both ends of a fifty-fold range. */
function fmtMultiple(m: number): string {
	if (!Number.isFinite(m) || m <= 0) {
		return '';
	}
	if (m < 1) {
		return `${m.toFixed(2)}&times;`;
	}
	return `${Math.abs(m - Math.round(m)) < 0.05 ? m.toFixed(0) : m.toFixed(1)}&times;`;
}

function compositionTable(rows: CompRow[], withCost: boolean, caption: string): string {
	// Children are already counted inside their parent, so shares are taken
	// over the top-level rows alone and still sum to 100%.
	const tops = rows.filter(r => !r.child);
	const totalCredits = tops.reduce((n, r) => n + (r.credits ?? 0), 0);
	const totalTokens = tops.reduce((n, r) => n + r.tokens, 0);

	// Absent entirely when no row can carry one, rather than a column of blanks.
	const withRate = withCost && rows.some(r => r.multiple !== undefined);

	const body = rows
		.filter(r => r.tokens > 0 || (r.credits ?? 0) > 0)
		.map(r => {

			// A child shows its own figures but no share bar: the share belongs
			// to the total above it, and drawing one invites reading a part as
			// though it were a whole.
			const share = (fraction: number) =>
				`<td class="pct-only">${(fraction * 100).toFixed(0)}%</td>`;

			const creditShare = totalCredits > 0 ? (r.credits ?? 0) / totalCredits : 0;
			const tokenShare = totalTokens > 0 ? r.tokens / totalTokens : 0;

			return `<tr class="${r.child ? 'comp-child' : 'comp-top'}">
			<td class="comp-name">${r.label}</td>
			${withRate ? `<td class="num rate">${fmtMultiple(r.multiple ?? 0)}</td>` : ''}
			${withCost ? `<td class="num">${fmtCredits(r.credits ?? 0)}</td>
			${share(creditShare)}` : ''}
			<td class="num">${fmtTokens(r.tokens)}</td>
			${share(tokenShare)}
		</tr>`;
		})
		.join('');

	return `<div class="tw"><table class="comp">
		<!-- Two columns both called "Share" left position as the only clue to
		     which measure each belonged to. Each now names its own denominator,
		     and the token one borrows the caption's word so the pair reads as
		     "62% of spend, 82% of text". -->
		<tr><th>${escapeHtml(caption)}</th>${
			withRate ? '<th class="num">Per token</th>' : ''}${
			withCost ? '<th class="num">Credits</th><th class="num">% of spend</th>' : ''}
		    <th class="num">Tokens</th><th class="num">% of text</th></tr>
		${body}
	</table></div>`;
}

function hueBar(fraction: number, cls: string): string {
	const pct = Math.max(0, Math.min(1, fraction)) * 100;
	return `<div class="bar"><div class="fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>`;
}

/**
 * What the way you work costs, rather than where the money went.
 *
 * Breakdowns by model and workspace answer "where", which is reference
 * material. This answers "what did I do that cost this" -- the whole
 * conversation is re-sent on every turn, so the same question gets steadily
 * more expensive the deeper into a thread it is asked. That is a habit a
 * developer can change this afternoon, and no other view shows it.
 */
/**
 * A per-bucket mean needs more than one or two messages behind it.
 *
 * The only guard here used to be `warmRequests > 0`, which let a single message
 * anchor either end of the ratio: a "3.6x" headline was being stated from two
 * observations against two. Same distinction as the advice floors -- this asks
 * whether there is enough to compute a rate, not whether the rate matters.
 */
function habits(
	depth: Record<string, DepthStats>,
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	p: Projection,
	minBucketRequests: number
): string {
	// Cold starts are excluded: a first request to a model pays for the whole
	// context at full price, which would swamp the trend being compared.
	const bars = DEPTH_BUCKETS
		.map(b => ({ label: b.label, stats: depth?.[b.label] }))
		.filter((b): b is { label: string; stats: DepthStats } =>
			b.stats !== undefined && b.stats.warmRequests >= minBucketRequests)
		.map(b => ({
			label: b.label,
			requests: b.stats.warmRequests,
			cost: (b.stats.warmNanoAiu * creditsPerNanoAiu) / b.stats.warmRequests
		}));

	const lines: string[] = [];

	const totals = sum(rollups);
	const perRequest = totals.requests > 0
		? (totals.nanoAiu * creditsPerNanoAiu) / totals.requests
		: undefined;
	if (perRequest !== undefined && perRequest > 0) {
		const left = p.remaining !== undefined
			? `. At that rate you have about
			   <strong>${fmtInt(p.remaining / perRequest)} messages</strong> left
			   before you run out`
			: '';
		lines.push(`Each message you send costs
			<strong>${fmtCredits(perRequest)} credits</strong> on average${left}.`);
	}

	if (bars.length >= 2) {
		const first = bars[0];
		const last = bars[bars.length - 1];
		if (first.cost > 0 && last.cost > first.cost) {
			// The multiple is a rate; on its own it cannot say whether the habit
			// is worth changing. A 3.6x multiple on messages you rarely send is
			// worth ignoring, so the share of spend sitting in the deep bucket --
			// the size of the lever -- goes in the same sentence.
			const deep = depth?.[last.label];
			const spent = deep ? deep.nanoAiu * creditsPerNanoAiu : 0;
			const share = totals.nanoAiu > 0
				? spent / (totals.nanoAiu * creditsPerNanoAiu)
				: 0;
			const lever = deep && share > 0
				? ` &mdash; and took <strong>${(share * 100).toFixed(0)}% of your credits</strong>
				   from ${fmtInt(deep.requests)} message${deep.requests === 1 ? '' : 's'}`
				: '';
			lines.push(`<strong>Start a new chat when you change subject.</strong>
				Copilot re-sends the whole conversation every time you hit enter, so your
				${escapeHtml(last.label)} message costs
				<strong>${(last.cost / first.cost).toFixed(1)}&times;</strong> what your
				${escapeHtml(first.label)} did${lever}.`);
		}
	}

	// The per-bucket table moved to "Where the credits went": it is a breakdown,
	// and it restated in four rows exactly what the sentence above says in one.
	// The top of this section carries the action; the evidence lives with the
	// other evidence.
	if (lines.length === 0) {
		return '';
	}

	return lines.map(l => `<p class="note">${l}</p>`).join('');
}

/**
 * Spend per conversation, most expensive first.
 *
 * Labelled by project and start time rather than by id: the id is a UUID and
 * identifies nothing to the person who had the conversation. Cost per message
 * is the column that earns the table -- by project and by model both report a
 * mean across sessions that differ by half again.
 */
function conversationTable(
	conversations: Record<string, ConversationStats> | undefined,
	creditsPerNanoAiu: number,
	totalCredits: number
): string {
	const rows = Object.values(conversations ?? {})
		.map(c => ({ ...c, credits: c.nanoAiu * creditsPerNanoAiu }))
		.filter(c => c.requests > 0 && c.credits > 0)
		.sort((a, b) => b.credits - a.credits);
	// One conversation is not a comparison, and the comparison is the point.
	if (rows.length < 2) {
		return '';
	}

	const when = (ms: number) => new Date(ms).toLocaleDateString(undefined,
		{ month: 'short', day: 'numeric' }) + ', ' +
		new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

	return `
	<div class="tw"><table class="spaced">
		<tr><th>By conversation</th><th class="num">Messages</th>
		    <th class="num">Each</th>
		    <th class="num">Credits</th><th>% of spend</th></tr>
		${rows.map((c, i) => `<tr${i === 0 ? ' class="lead"' : ''}>
			<td>${escapeHtml(c.workspace)} <span class="dim">&middot; ${escapeHtml(when(c.firstMs))}</span></td>
			<td class="num">${fmtInt(c.requests)}</td>
			<td class="num">${fmtCredits(c.credits / c.requests)}</td>
			<td class="num">${fmtCredits(c.credits)}</td>
			<td class="share">${bar(totalCredits > 0 ? c.credits / totalCredits : 0)}<span
				class="pct">${totalCredits > 0 ? ((c.credits / totalCredits) * 100).toFixed(0) : 0}%</span></td>
		</tr>`).join('')}
	</table></div>`;
}

/** Where the money sits by position in the chat -- a breakdown, not a claim. */
function depthTable(
	depth: Record<string, DepthStats>,
	creditsPerNanoAiu: number,
	totalCredits: number
): string {
	const rows = DEPTH_BUCKETS
		.map(b => ({ label: b.label, stats: depth?.[b.label] }))
		.filter((b): b is { label: string; stats: DepthStats } =>
			b.stats !== undefined && b.stats.requests > 0);
	if (rows.length < 2) {
		return '';
	}

	return `
	<div class="tw"><table class="spaced">
		<tr><th>By position in the chat</th><th class="num">Messages</th>
		    <th class="num">Credits</th><th>Share</th></tr>
		${rows.map(r => {
			const credits = r.stats.nanoAiu * creditsPerNanoAiu;
			const share = totalCredits > 0 ? credits / totalCredits : 0;
			return `<tr>
			<td>${escapeHtml(r.label.replace(/ message$/, ''))}</td>
			<td class="num dim">${fmtInt(r.stats.requests)}</td>
			<td class="num">${fmtCredits(credits)}</td>
			<td>${hueBar(share, 'c-fresh')} ${(share * 100).toFixed(0)}%</td>
		</tr>`;
		}).join('')}
	</table></div>`;
}

/* ---------------------------------------------------------------- table --- */

/** How a model's spend was reached, in the width of a table cell. */
/**
 * Models grouped by what they are, labelled by what they are called.
 *
 * `groupBy(rollups, 'model')` keys on the raw string, so one model reported
 * under two spellings was two rows whose shares each looked like half the
 * truth: 305 credits under `copilot/claude-sonnet-4.6` and 54 under
 * `claude-sonnet-4-6`, neither of them that model's spend.
 *
 * The label is the bare name with the most requests behind it rather than the
 * first one seen, so the table shows the spelling the account actually uses.
 */
/**
 * Which of these figures were measured, and which are floors.
 *
 * `Rollup.source` says the two must never be added into one burn rate. The
 * projection honours that -- it filters `reported` out before computing a rate
 * -- but the panel's own totals add them and said nothing, so a card reading
 * "862 credits over 31 messages" looked like a measurement when every credit
 * in it came from a transcript. Transcripts omit the messages you retried or
 * cancelled and were still charged for, which is exactly the spend someone
 * reading this page is trying to find.
 *
 * Stated rather than corrected: the recovered history is worth showing, and a
 * floor labelled as one is more use than no history at all.
 */
function sourceNote(rollups: Rollup[], creditsPerNanoAiu: number): string {
	let measured = 0, reported = 0;
	for (const r of rollups) {
		const c = creditsOf(r.nanoAiu, creditsPerNanoAiu);
		if (r.source === 'reported') { reported += c; } else { measured += c; }
	}
	if (reported <= 0) {
		return '';
	}
	const floor = 'Transcripts omit the messages you retried or cancelled and were ' +
		'still charged for, so that is a floor rather than a total.';
	if (measured <= 0) {
		return `<div class="warn"><div>Nothing on this page was measured. Every figure
			comes from VS Code's own chat transcripts, not from Copilot's cost record.
			${floor}</div></div>`;
	}
	return `<p class="note"><strong>${fmtCredits(reported)}</strong> of these
		${fmtCredits(measured + reported)} credits come from chat transcripts rather
		than Copilot's own cost record. ${floor}</p>`;
}

function groupModels(rollups: Rollup[]): Map<string, Totals> {
	const buckets = new Map<string, { rollups: Rollup[]; labels: Map<string, number> }>();
	for (const r of rollups) {
		const key = modelKey(r.model);
		const bucket = buckets.get(key)
			?? { rollups: [] as Rollup[], labels: new Map<string, number>() };
		bucket.rollups.push(r);
		const label = bareModel(r.model);
		bucket.labels.set(label, (bucket.labels.get(label) ?? 0) + r.requests);
		buckets.set(key, bucket);
	}
	const out = new Map<string, Totals>();
	for (const { rollups: bucket, labels } of buckets.values()) {
		// Ties broken by name so the table does not reorder between refreshes.
		const label = [...labels.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
		out.set(label, sum(bucket));
	}
	return out;
}

function selectionCell(
	rollups: Rollup[] | undefined,
	model: string,
	creditsPerNanoAiu: number
): string {
	if (!rollups) {
		return '';
	}
	const mix = selectionMix(rollups, model, creditsPerNanoAiu);
	if (mix.dominant === 'unknown') {
		return '<td class="dim sel">&mdash;</td>';
	}
	const label =
		mix.dominant === 'auto' ? 'Auto'
		: mix.dominant === 'manual' ? 'you'
		: 'mixed';
	const detail = mix.autoShare > 0 && mix.autoShare < 1
		? ` title="${(mix.autoShare * 100).toFixed(0)}% of this model's spend was auto-selected"`
		: '';
	return `<td class="sel${mix.dominant === 'auto' ? ' auto' : ''}"${detail}>${label}</td>`;
}

/** Rows worth a reader's attention, with the free tail folded into one line. */
/**
 * A model's thinking as a percentage of its own output.
 *
 * A model that reports none shows a dash rather than 0%: "0%" asserts a
 * measurement of zero, and most models simply do not emit the attribute.
 */
function thinkingCell(t: Totals): string {
	if (t.outputTokens <= 0 || t.reasoningTokens <= 0) {
		return '<td class="num dim">&mdash;</td>';
	}
	return `<td class="num">${((t.reasoningTokens / t.outputTokens) * 100).toFixed(0)}%</td>`;
}

function breakdownRows(
	groups: Map<string, Totals>,
	creditsPerNanoAiu: number,
	totalCredits: number,
	rollups?: Rollup[],
	/**
	 * Thinking as a share of each model's own replies.
	 *
	 * A composition row can only say "thinking cost you 1.38 credits", which is
	 * a fact nobody can act on. What is actionable is that the models differ:
	 * measured here, two of four charged 15-24% of their output budget for text
	 * the developer never sees and the other two charged none. That belongs
	 * beside the model names, where the choice is actually made.
	 */
	withThinking = false
): string {
	const entries = [...groups.entries()]
		.map(([label, t]) => ({ label, t, credits: creditsOf(t.nanoAiu, creditsPerNanoAiu) }))
		.sort((a, b) => b.credits - a.credits);

	const span = (rollups ? 6 : 5) + (withThinking ? 1 : 0);
	if (entries.length === 0) {
		return `<tr><td colspan="${span}" class="dim">no data</td></tr>`;
	}

	const billed = entries.filter(e => e.credits > 0);
	const free = entries.filter(e => e.credits <= 0);

	// The top spender gets the accent; the rest recede. Emphasis, not a
	// categorical palette -- the ranking is the story, not the identities.
	const rows = billed.map((e, i) => `<tr${i === 0 ? ' class="lead"' : ''}>
			<td>${escapeHtml(e.label)}</td>
			${selectionCell(rollups, e.label, creditsPerNanoAiu)}
			<td class="num">${fmtInt(e.t.requests)}</td>
			<td class="num dim">${fmtTokens(e.t.inputTokens + e.t.outputTokens)}</td>
			${withThinking ? thinkingCell(e.t) : ''}
			<td class="num">${fmtCredits(e.credits)}</td>
			<td class="share">${bar(totalCredits > 0 ? e.credits / totalCredits : 0)}<span
				class="pct">${totalCredits > 0 ? ((e.credits / totalCredits) * 100).toFixed(0) : 0}%</span></td>
		</tr>`);

	if (free.length) {
		const requests = free.reduce((n, e) => n + e.t.requests, 0);
		rows.push(`<tr class="folded">
			<td class="dim">${escapeHtml(free.map(f => f.label).join(', '))} &mdash; unbilled</td>
			${rollups ? '<td></td>' : ''}
			<td class="num dim">${fmtInt(requests)}</td>
			<td class="num dim">${fmtTokens(free.reduce((n, e) => n + e.t.inputTokens + e.t.outputTokens, 0))}</td>
			${withThinking ? '<td></td>' : ''}
			<td class="num dim">0.00</td>
			<td></td>
		</tr>`);
	}
	return rows.join('');
}

/* --------------------------------------------------------------- render --- */
export interface ReportInput {
	rollups: Rollup[];
	creditsPerNanoAiu: number;
	dbCount: number;
	lastRefresh: Date | undefined;
	costCoverage: number;
	/**
	 * Billed credits per local day, where GitHub could answer for one.
	 *
	 * The charts fall back to measured spans for every day it has none, which
	 * is every day that ended before this record began.
	 */
	billedDays?: Map<string, number>;
	/**
	 * The models section, rendered by its own module.
	 *
	 * Passed in rather than built here: it needs the rate card and the editor's
	 * model list, and having report.ts reach for either would make the two
	 * modules import each other.
	 */
	modelsHtml?: string;
	warnings: string[];
	projection: Projection | undefined;
	prices: Record<string, PriceStats>;
	depth: Record<string, DepthStats>;
	conversations?: Record<string, ConversationStats>;
	history?: HistoryFacts;
	/** True when the developer has set `creditsPerNanoAiu` themselves. */
	conversionOverridden?: boolean;
	/**
	 * The gate ladder. Defaults when absent, so a caller that does not care --
	 * a test, a fixture -- reads the same thresholds the extension ships with.
	 */
	tuning?: Tuning;
}

export interface HistoryFacts {
	/** First day the trace database covers. */
	traceStartDay?: string;
	/** Oldest chat transcript on the machine, cost data or not. */
	oldestTranscriptDay?: string;
	/** Messages recovered from transcripts predating the trace database. */
	recoveredMessages: number;
}

/**
 * Two columns wherever the panel is wide enough.
 *
 * The panel opens in an editor group that is routinely 1400px across, and a
 * single 900px column pushed the model tables below the fold for no reason.
 * Reading order still holds when it collapses to one column on a narrow split:
 * verdict, then advice, then the breakdowns.
 */
/**
 * "Credits" is the unit every figure on this page is denominated in, and
 * nothing said what one was. The window is stated as a maximum, not as a claim
 * that 30 days of data exist -- see `historyNote`.
 */
const LOGO = `<svg class="logo" viewBox="42 42 172 172" width="21" height="21" aria-hidden="true">
	<g transform="translate(128,128)">
		<path d="M 0 0 L 0 -86 A 86 86 0 0 1 0 86 Z" fill="var(--vscode-charts-blue, #3794FF)"/>
		<path d="M 0 0 L 0 86 A 86 86 0 0 1 -81.79 -26.58 Z" fill="var(--vscode-charts-green, #89D185)"/>
		<path d="M 0 0 L -81.79 -26.58 A 86 86 0 0 1 0 -86 Z" fill="var(--vscode-charts-purple, #B180D7)"/>
		<g stroke="var(--vscode-editor-background, #1F1F1F)" stroke-width="9" stroke-linecap="round">
			<line x1="0" y1="0" x2="0" y2="-86"/>
			<line x1="0" y1="0" x2="0" y2="86"/>
			<line x1="0" y1="0" x2="-81.79" y2="-26.58"/>
		</g>
	</g>
</svg>`;

export function renderReport(input: ReportInput): string {
	const { rollups, creditsPerNanoAiu } = input;
	const tuning = input.tuning ?? defaults();
	// Most models never emit a reasoning count; a column of dashes would be
	// noise on an account that does not use one.
	const anyThinking = rollups.some(r => r.reasoningTokens > 0);
	// Same reasoning as the Thinking column beside it: a machine whose spans
	// never record who picked the model got a column of em-dashes, which reads
	// as missing data rather than as a dimension that does not apply here.
	const anySelection = rollups.some(r => r.selection !== 'unknown');
	const totals = sum(rollups);
	const totalCredits = creditsOf(totals.nanoAiu, creditsPerNanoAiu);
	const p: Projection = input.projection ?? { verdict: 'unknown' };

	// GitHub's own consumption figure, preferred over the difference we derive
	// from the meter: `credits_used` is what the account was billed, while
	// entitlement - remaining inherits the rounding on both.
	const periodFit = periodCoverage({
		resetDate: p.resetDate,
		githubCredits: p.creditsUsed ?? (p.entitlement !== undefined && p.remaining !== undefined
			? Math.max(0, p.entitlement - p.remaining)
			: undefined),
		creditsByDay: creditsByDay(rollups, creditsPerNanoAiu),
		// Day granularity is enough: what is being counted is days recorded
		// against days elapsed. Parsed as UTC to match the day keys it is
		// compared with, which are built the same way.
		traceStartMs: input.history?.traceStartDay !== undefined
			? dayStartMs(input.history.traceStartDay)
			: undefined,
		// Not merged into creditsByDay above: this is GitHub's figure, and
		// comparing it with itself would agree by construction. It answers the
		// separate question of whether this machine was here while the quota
		// moved.
		billedByDay: input.billedDays,
		tuning
	});

	// A definition has to precede the first figure that uses it, and which
	// figure that is depends on the page: the meter is absent when no allowance
	// is known, and the definition must not disappear with it.
	const hasMeter = p.entitlement !== undefined && p.remaining !== undefined && p.entitlement > 0;

	const byModel = groupModels(rollups);
	const byWorkspace = groupBy(rollups, 'workspace');
	const byDay = groupBy(rollups, 'day');
	const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-14);

	// One day is not a trend. A single-column bar chart is always 100% full and
	// says nothing; below two days the number itself is the honest form.

	// The one assumption every credit figure rests on, resolved once and passed
	// down rather than re-derived per finding.
	const conversion = conversionConfidence(periodFit, input.conversionOverridden);
	const recommendations = advise(
		rollups, creditsPerNanoAiu, input.prices, p.remaining, tuning, conversion
	);

	const warnings = input.warnings.length
		? `<div class="warn">${input.warnings.map(w => `<div>${escapeHtml(w)}</div>`).join('')}</div>`
		: '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
${STYLES}
</style>
</head>
<body>
	<header>
		<h1>${LOGO}Token Pie<a class="repo" href="https://github.com/token-pie/token-pie#readme"
		   target="_blank" rel="noopener noreferrer"
		   title="Token Pie on GitHub"><svg viewBox="0 0 16 16" width="17" height="17"
		   aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg></a></h1>
		<span class="sub">${coverage(days)} &middot;
			<i>refreshed ${input.lastRefresh ? escapeHtml(input.lastRefresh.toLocaleTimeString()) : 'never'}</i>
		</span>
	</header>
	${historyNote(input.history, days)}

	<section class="verdict" style="--hue:${severityVar(p)};--hue-text:${severityTextVar(p)}">
		<div class="verdict-cols">
		<div class="verdict-main">
		<!-- The hero sits against the bar it describes. A sentence used to
		     stand between them saying what the meter, the projection line and
		     the pace tiles all say already. -->
		<div class="verdict-top">${heroFigure(p, totalCredits)}</div>
		${allowanceMeter(p, tuning.history.days)}
		${paceTiles(p)}
		${periodBars(rollups, creditsPerNanoAiu, periodFit?.periodStart, Date.now(),
			input.billedDays,
			p.resetDate !== undefined ? resetInstantFrom(p.resetDate) : undefined)}
		</div>
		<!-- Today over the week: two horizons, both narrower than the month,
		     in the column that is already about time rather than totals. -->
		<div class="aside">
			${dayFigure(p, tuning)}
			${weekBars(rollups, creditsPerNanoAiu, new Date(), input.billedDays)}
		</div>
		</div>
	</section>

	<!-- Beside the meter, not under a table. This sentence is the only thing on
	     the page that reconciles GitHub's figure against this machine's, and it
	     used to render inside the breakdown body several screens down -- so the
	     card could show a day larger than the month containing it with the
	     explanation out of sight. Two numbers that disagree have to be argued
	     with where they are read. (No worked figures in shipped comments: they
	     land in the DOM, where a test looking for one found this instead.) -->
	${coverageLine(periodFit)}

	${input.modelsHtml ?? ''}

	${warnings}

	<!-- One section for everything actionable. Two ("what to change" and
	     "what your habits cost") meant one of them was routinely empty while
	     the other had the finding, which read as a broken panel. -->
	<!-- Reference, not headline. Breakdowns answer "where did it go", which a
	     developer asks occasionally; leaving three tables open made a wall.
	     This is its own section: an <h2> closes nothing, so while the breakdown
	     was a bare sibling of the advice cards -- sharing their chrome -- it
	     read as a third recommendation rather than a different kind of thing.
	     The heading names the section; the summary carries the total, so
	     neither repeats the other. -->
	<section>
		<h2>Where the credits went</h2>
	<details class="detail" open>
		<summary><strong>${fmtCredits(totalCredits)} credits</strong> over
			${fmtInt(totals.requests)} message${totals.requests === 1 ? '' : 's'}${
			hasMeter ? '' : creditHint(tuning.history.days)}</summary>
		<div class="detail-body">

		${sourceNote(rollups, creditsPerNanoAiu)}

		${compositionBar(rollups, input.prices, creditsPerNanoAiu, tuning) || '<p class="dim">no data</p>'}

		<div class="tw"><table>
			<tr><th>By model</th>${anySelection ? '<th>Chosen by</th>' : ''}
			    <th class="num">Messages</th>
			    <th class="num">Tokens</th>
			    ${anyThinking ? '<th class="num">Thinking</th>' : ''}
			    <th class="num">Credits</th><th>Share</th></tr>
			${breakdownRows(byModel, creditsPerNanoAiu, totalCredits,
				anySelection ? rollups : undefined, anyThinking)}
		</table></div>

		<div class="tw"><table class="spaced">
			<tr><th>By project</th><th class="num">Messages</th>
			    <th class="num">Tokens</th>
			    <th class="num">Credits</th><th>Share</th></tr>
			${breakdownRows(byWorkspace, creditsPerNanoAiu, totalCredits)}
		</table></div>

		${conversationTable(input.conversations, creditsPerNanoAiu, totalCredits)}

		${depthTable(input.depth, creditsPerNanoAiu, totalCredits)}

		${coverageNote(input.costCoverage, byModel, totals)}
		</div>
	</details>
	</section>

	<section>
		<h2>What to change</h2>
		${habits(input.depth, rollups, creditsPerNanoAiu, p, tuning.report.minBucketRequests)}
		${adviceCards(recommendations, habitsFound(input.depth))}
		${conversionNote(conversion, recommendations)}
	</section>

	<footer>
		${rollups.some(r => r.source !== 'reported')
			? `Credits come from <code>copilot_chat.copilot_usage_nano_aiu</code>, the cost
			   Copilot reports per request &mdash; not list pricing, and not the
			   transcript's own <code>copilotCredits</code>, which omits messages you
			   retried or cancelled and were still charged for.`
			// Saying it anyway on a page with no measurement behind it names a source
			// that was never read.
			: `Credits here come from the transcript's own <code>copilotCredits</code>,
			   which omits messages you retried or cancelled and were still charged for.
			   <code>copilot_chat.copilot_usage_nano_aiu</code>, the cost Copilot reports
			   per request, is what this reads once tracing is on.`} Every price, threshold and conversion behind this page &mdash; and
		which of them is currently withholding something &mdash; is in the
		<strong>Token Specs</strong>, on the gear in this editor's title bar.
	</footer>
</body>
</html>`;
}

/**
 * Missing cost attributes are only a measurement gap when they are unexplained.
 *
 * A model that reports no cost anywhere in the window is a free model, not a
 * hole in the data, and warning about it put a yellow alarm at the top of the
 * panel saying the figures undercount when they did not.
 */
function coverageNote(
	coverage: number,
	byModel: Map<string, Totals>,
	totals: Totals
): string {
	if (coverage >= 1 || totals.requests === 0) {
		return '';
	}
	const free = [...byModel.entries()].filter(([, t]) => t.nanoAiu === 0);
	const freeRequests = free.reduce((n, [, t]) => n + t.requests, 0);
	const missing = totals.requests * (1 - coverage);

	// Within a request or two of fully explained: report it, do not alarm.
	if (free.length > 0 && freeRequests >= missing - 1) {
		return `<p class="note dim">${fmtInt(freeRequests)} of ${fmtInt(totals.requests)} messages
			cost nothing, all of them on ${escapeHtml(free.map(f => f[0]).join(', '))}.
			Models that bill nothing report no cost, so nothing is missing here.</p>`;
	}
	return `<div class="warn"><div>Only ${(coverage * 100).toFixed(0)}% of your messages
		reported what they cost, and free models do not account for the rest.
		The credit figures here undercount.</div></div>`;
}

/** What period this actually covers -- not what the query asked for. */
function coverage(days: [string, Totals][]): string {
	if (days.length === 0) {
		return 'no usage recorded yet';
	}
	const first = days[0][0];
	const last = days[days.length - 1][0];
	const pretty = (d: string) =>
		new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	return first === last
		? `${escapeHtml(pretty(first))} only`
		: `${escapeHtml(pretty(first))} to ${escapeHtml(pretty(last))}`;
}

/**
 * Why there is so little history.
 *
 * `agent-traces.db` is written only from the moment the exporter is switched
 * on and holds nothing retroactively. On a machine with a year of Copilot use
 * it can hold two hours, and a panel that says "last 30 days" over one day of
 * data reads as broken rather than as honest.
 */
/**
 * The two credit figures on this page, reconciled.
 *
 * The meter above reads GitHub's consumption for the billing period; the total
 * beside this line reads ours. Printing both and saying nothing left the reader
 * to spot the difference and guess at it. Named, the difference is useful: it
 * bounds how much of the advice below can apply, because advice can only ever
 * be about spend this machine can see.
 */
function coverageLine(c: PeriodCoverage | undefined): string {
	if (!c) {
		return '';
	}
	const since = new Date(c.periodStart)
		.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	const billed = `GitHub bills <strong>${fmtCreditsWith(c.githubCredits)}</strong>
		since ${escapeHtml(since)}`;

	switch (c.verdict) {
		case 'complete':
			return `<p class="note">${billed}, and this machine accounts for
				essentially all of it.</p>`;
		case 'partial':
			return `<p class="note">${billed}. This machine accounts for
				<strong>${fmtCredits(c.localCredits)}</strong>
				(${Math.round((c.share ?? 0) * 100)}%); the other
				${fmtCreditsWith(c.unaccounted)} went somewhere it cannot see &mdash;
				another machine, another editor, the CLI, or github.com.
				Everything below covers only what happened here.</p>`;
		case 'unattributed':
			return `<p class="note">${billed}, and all of it on days this machine was
				watching. It could attribute <strong>${fmtCredits(c.localCredits)}</strong>
				of that to particular messages; Copilot recorded no cost for the rest.
				Nothing here went to another machine &mdash; the gap is cost this
				install never saw written down, so the breakdown below understates
				rather than misses.</p>`;
		case 'over':
			return `<div class="warn"><div>${billed}, but this machine measured
				${fmtCreditsWith(c.localCredits)} over the same days. The credit
				conversion is likely miscalibrated &mdash; check
				<code>tokenPie.creditsPerNanoAiu</code> against your billing dashboard.</div></div>`;
		default:
			return `<p class="note dim">${billed}. ${escapeHtml(c.note)}</p>`;
	}
}

function historyNote(h: HistoryFacts | undefined, days: [string, Totals][]): string {
	if (!h || days.length === 0) {
		return '';
	}
	const span = h.traceStartDay ? daysSince(h.traceStartDay) : undefined;
	if (span === undefined || span > 14) {
		return '';
	}
	const older = h.oldestTranscriptDay && h.oldestTranscriptDay < h.traceStartDay!;
	return `<p class="note dim history">Recording started
		<strong>${escapeHtml(prettyDay(h.traceStartDay!))}</strong>, so that is as far back as
		this goes. Copilot keeps no cost history before the day you switch tracing on.${
			older
				? ` Your chat transcripts reach back to ${escapeHtml(prettyDay(h.oldestTranscriptDay!))},
				   but ${h.recoveredMessages > 0
					? `only ${fmtInt(h.recoveredMessages)} message${h.recoveredMessages === 1 ? '' : 's'}
					   in them recorded what they cost; those are included above and marked as a floor`
					: 'none of them recorded what they cost, so nothing can be recovered from them'}.`
				: ''}</p>`;
}

function prettyDay(d: string): string {
	return new Date(`${d}T00:00:00`).toLocaleDateString(undefined,
		{ month: 'long', day: 'numeric', year: 'numeric' });
}

function daysSince(day: string): number {
	return (Date.now() - dayStartMs(day)) / 86_400_000;
}

/** Exactly one per view. The number the panel exists to deliver. */
/**
 * Today, beside the month.
 *
 * The hero is a fact you cannot change before the reset; this is the only
 * figure an afternoon can still move. Shown as a share of what the day was
 * allowed to cost, and deliberately not clamped -- 118% is the reading, and a
 * bar that stopped at full would hide how far over the day went.
 */
function dayFigure(p: Projection, tuning: Tuning): string {
	const pressure = dayPressure(p, tuning);
	// No budget to measure against -- an exhausted allowance, or a plan with no
	// limit. What today cost is still a fact, and withholding the figure left a
	// third of the card blank at the moment it was most worth looking at.
	if (pressure === undefined || p.todayShare === undefined || p.todayBudget === undefined) {
		return p.todayCredits === undefined ? '' : `<div class="day day-under">
			<div class="day-v">${fmtCredits(p.todayCredits)}<span class="unit">today</span></div>
			<div class="day-track"></div>
			<div class="day-k"><span>credits spent<br>no budget to pace against</span></div>
		</div>`;
	}
	const pct = Math.round(p.todayShare * 100);
	// Past the budget the track rescales to the spend and the budget becomes a
	// line on it -- the same move the month meter makes when the projection
	// runs off the end, so the two bars on this card speak one language.
	//
	// It used to clamp the fill at 100%, which drew 151% and 500% as the same
	// full bar: the figure above carried the whole difference and the graphic
	// carried none of it. Rescaled, the marker slides left as the overshoot
	// grows, so how far past is legible without reading the number.
	const spent = p.todayCredits ?? 0;
	const over = spent > p.todayBudget;
	const scaleMax = over ? spent : p.todayBudget;
	const fill = scaleMax > 0 ? Math.min(100, (spent / scaleMax) * 100) : 0;
	const mark = over && scaleMax > 0
		? `<span class="day-limit" style="left:${((p.todayBudget / scaleMax) * 100).toFixed(2)}%"
		     title="budget: ${escapeHtml(fmtCredits(p.todayBudget))} credits"></span>`
		: '';
	// Where the denominator came from, because it is two different numbers.
	// Unset, it is what remains over the days left -- derived, and calling that
	// "budgeted" would credit the reader with a decision the code made. Set, it
	// is a figure they chose, and saying so is what makes it theirs.
	const set = tuning.projection.dailyBudgetPercent > 0;
	const source = set ? 'your daily budget' : 'your pace to reset';
	return `<div class="day day-${pressure}">
		<div class="day-v">${pct}<span class="unit">% used today</span></div>
		<div class="day-track"><span class="day-fill"
			style="width:${fill.toFixed(2)}%"></span>${mark}</div>
		<div class="day-k"><span>${fmtCredits(p.todayCredits ?? 0)} of
			${fmtCredits(p.todayBudget)} credits<br>${source}</span>${budgetHint(p, tuning)}</div>
	</div>`;
}

/**
 * Where the number in the denominator came from, and how to choose your own.
 *
 * A figure nobody set is a figure nobody can argue with, and 539 credits a day
 * arrived with no provenance at all -- the first thing asked of it was what it
 * meant. `details` rather than a hover: the panel runs with scripts disabled
 * and a CSP of `default-src 'none'`, and a title attribute cannot be read on a
 * touch device or by a keyboard.
 */
/**
 * A marker that opens an explanation over the page rather than in it.
 *
 * Shared because the second one was about to be a copy of the first, and the
 * two differ only in prose.
 */
function hint(summary: string, body: string): string {
	return `<details class="hint">
		<summary title="${escapeHtml(summary)}">?</summary>
		<div class="hint-body">${body}</div>
	</details>`;
}

/**
 * What a credit is, at the first figure denominated in one.
 *
 * This was four lines of standing prose in the middle of the verdict card, read
 * once and then skipped past on every refresh forever. The definition still has
 * to be reachable -- nobody arrives knowing what an AI Credit is -- but it does
 * not have to be in the way to be reachable.
 */
function creditHint(days: number): string {
	return hint('What an AI Credit is', `<p>An <strong>AI Credit</strong> is
		GitHub's billing unit for Copilot. One is <strong>$0.01</strong>, charged
		on the tokens each message sends and receives.</p>
		<p>This panel keeps up to the last <strong>${fmtInt(days)} days</strong>.
		<a href="https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises"
		   target="_blank" rel="noopener noreferrer">How credits work</a></p>`);
}

function budgetHint(p: Projection, tuning: Tuning): string {
	const set = tuning.projection.dailyBudgetPercent > 0;
	const days = p.daysToCover;
	const had = (p.remaining ?? 0) + (p.todayCredits ?? 0);
	const derivation = set
		? `<p><strong>${tuning.projection.dailyBudgetPercent}%</strong> of your
		   ${fmtCredits(p.entitlement ?? 0)}-credit allowance, which you set, is
		   <strong>${fmtCredits(p.todayBudget ?? 0)} credits</strong> a day.</p>`
		: `<p>You have not set one, so this is your own pace:
		   <strong>${fmtCredits(had)} credits</strong> at the start of today over
		   the <strong>${days ?? 1} day${days === 1 ? '' : 's'}</strong> left
		   before the allowance resets, which is
		   <strong>${fmtCredits(p.todayBudget ?? 0)} a day</strong>.</p>`;
	return hint('How this figure is worked out', `
			${derivation}
			<p>${set
				? `Change <code>tokenPie.dailyBudget</code> to move the line, or
				   set it to <strong>0</strong> to go back to your own pace.`
				: `Set <code>tokenPie.dailyBudget</code> to a percent of your whole
				   allowance to measure against a figure of your own instead
				   &mdash; <strong>1</strong> would be
				   ${fmtCredits((p.entitlement ?? 0) / 100)} credits a day.`}</p>`);
}

function heroFigure(p: Projection, totalCredits: number): string {
	switch (p.verdict) {
		case 'exhausted':
			return `<div class="hero">0<span class="unit">credits left</span></div>`;
		case 'will-exhaust':
		case 'tight':
			return `<div class="hero">${fmtDays(p.daysToExhaust)}` +
				`<span class="unit">${dayUnit(p.daysToExhaust)} left</span></div>`;
		case 'ok':
		case 'no-rate':
			return p.percentRemaining !== undefined
				? `<div class="hero">${pctText(p.percentRemaining)}<span class="unit">% left this month</span></div>`
				: `<div class="hero">${fmtCredits(totalCredits)}<span class="unit">credits</span></div>`;
		default:
			return `<div class="hero">${fmtCredits(totalCredits)}<span class="unit">credits spent</span></div>`;
	}
}

/**
 * This week, Monday to Sunday, as horizontal bars.
 *
 * It replaces a column chart of the last fourteen days, which was a shape
 * without a question: nobody asks "what did the 14th cost" and the labels were
 * unreadable at that width anyway. A calendar week answers something the rest
 * of the card is already about -- am I on pace -- because the week is the unit
 * people actually plan work in.
 *
 * Days that have not happened yet are drawn, empty. Dropping them would make a
 * Monday look like a finished week with one busy day, and the point of showing
 * seven rows is that you can see how much of the week is still to come.
 */
/**
 * Every day of the billing period, as a column.
 *
 * The meter says how much of the allowance has gone; it cannot say whether it
 * went steadily or in one afternoon, and those call for opposite responses.
 * The week chart answers the same question over seven days, which is too short
 * to see a period in.
 *
 * Columns rather than the week's rows: thirty rows is a page, thirty columns is
 * a strip. The two charts read differently on purpose -- one is a list of days
 * you can name, the other a shape.
 */
/**
 * Spend per day, billed where GitHub could answer and measured where not.
 *
 * The charts read spans, so they emptied the day Copilot stopped writing cost
 * onto them: a week of real work drawn as seven zero bars under the heading
 * "nothing yet". A billed figure exists only for days watched whole since that
 * record began, so the measured sum still answers for every day before it.
 */
export function spendByDay(
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	billed?: Map<string, number>
): Map<string, number> {
	const spend = new Map<string, number>();
	for (const r of rollups) {
		spend.set(r.day, (spend.get(r.day) ?? 0) + creditsOf(r.nanoAiu, creditsPerNanoAiu));
	}
	for (const [day, credits] of billed ?? []) {
		spend.set(day, credits);
	}
	return spend;
}

export function periodBars(
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	periodStart: number | undefined,
	now = Date.now(),
	billed?: Map<string, number>,
	resetAt?: number
): string {
	if (periodStart === undefined) {
		return '';
	}
	const spend = spendByDay(rollups, creditsPerNanoAiu, billed);

	const start = new Date(periodStart);
	start.setHours(0, 0, 0, 0);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);

	// The whole period, not the part of it that has happened.
	//
	// Drawing only the elapsed days made this chart vanish on the first day of
	// a period -- one column is not a shape, so it was suppressed, and the
	// verdict card was left with a hole where a chart had been the day before.
	// It also grew a column a day, so the same spend moved every morning.
	// The month is a fixed frame that fills up, which is what a reader already
	// thinks they are looking at.
	const last = resetAt !== undefined ? new Date(resetAt) : today;
	last.setHours(0, 0, 0, 0);
	if (resetAt !== undefined) {
		// The reset instant belongs to the next period; the last day of this
		// one is the day before it.
		last.setDate(last.getDate() - 1);
	}
	const span = Math.round((last.getTime() - start.getTime()) / 86_400_000) + 1;
	// A guard against a nonsense reset date, not a judgement about how much
	// there is to show: a quiet period still has its days, exactly as a quiet
	// week still has seven. Withholding the chart is what made the card look
	// broken rather than empty.
	if (!Number.isFinite(span) || span < 2 || span > 62) {
		return '';
	}

	const todayKey = dayKeyLocal(today);
	const days = Array.from({ length: span }, (_, i) => {
		const d = new Date(start);
		d.setDate(start.getDate() + i);
		const key = dayKeyLocal(d);
		return {
			key, day: d.getDate(), credits: spend.get(key) ?? 0,
			today: key === todayKey, future: key > todayKey
		};
	});
	const peak = Math.max(...days.map(d => d.credits));

	const label = (d: Date) =>
		d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	// A floor of 2%, so a day that cost something is never drawn as a day that
	// cost nothing -- the difference between "quiet" and "absent" is the whole
	// point of the chart.
	const cols = days.map(d => `
		<span class="pd-col${d.today ? ' pd-today' : ''}${d.future ? ' pd-future' : ''}"
		      title="${escapeHtml(d.key)}: ${fmtCredits(d.credits)} credits">
			<span class="pd-fill" style="height:${
				peak > 0 && d.credits > 0
					? Math.max(2, (d.credits / peak) * 100).toFixed(1) : 0}%"></span>
		</span>`).join('');

	return `
	<div class="period">
		<div class="pd-head">Since ${escapeHtml(label(start))}
			<span class="pd-peak">${peak > 0
				? `busiest day ${fmtCreditsWith(peak)}` : 'nothing yet'}</span></div>
		<div class="pd-plot">${cols}</div>
		<div class="pd-axis"><span>${escapeHtml(label(start))}</span>
			<span>${escapeHtml(label(last))}</span></div>
	</div>`;
}

export function weekBars(
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	now = new Date(),
	billed?: Map<string, number>
): string {
	// Monday of the current week, in local time: the day strings are local days.
	const monday = new Date(now);
	monday.setHours(0, 0, 0, 0);
	monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));

	const spend = spendByDay(rollups, creditsPerNanoAiu, billed);

	const today = dayKeyLocal(now);
	const rows = Array.from({ length: 7 }, (_, i) => {
		const d = new Date(monday);
		d.setDate(monday.getDate() + i);
		const key = dayKeyLocal(d);
		return {
			key,
			name: d.toLocaleDateString(undefined, { weekday: 'short' }),
			credits: spend.get(key) ?? 0,
			future: key > today,
			today: key === today
		};
	});

	const peak = Math.max(...rows.map(r => r.credits));
	const total = rows.reduce((n, r) => n + r.credits, 0);
	// A quiet week still has seven days in it. Withholding the chart left a
	// third of the card blank on an account that had simply not spent anything
	// yet, which reads as broken rather than as quiet -- and the empty tracks
	// say "nothing here" perfectly well on their own.

	const bars = rows.map(r => `
		<div class="wk-row${r.today ? ' wk-today' : ''}${r.future ? ' wk-future' : ''}"
		     title="${escapeHtml(r.key)}: ${fmtCredits(r.credits)} credits">
			<span class="wk-day">${escapeHtml(r.name)}</span>
			<span class="wk-track"><span class="wk-fill"
				style="width:${peak > 0 ? ((r.credits / peak) * 100).toFixed(1) : 0}%"></span></span>
			<span class="wk-val">${r.credits > 0 ? fmtCredits(r.credits) : ''}</span>
		</div>`).join('');

	return `
	<div class="week">
		<div class="wk-head">This week
			<span class="wk-total">${total > 0 ? fmtCreditsWith(total) : 'nothing yet'}</span></div>
		${bars}
	</div>`;
}

/** Local calendar day, matching the keys the store writes. */
function dayKeyLocal(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const STYLES = `
	/* Nothing may push the page sideways. A table with six columns is wider than
	   a sidebar and always will be, so it scrolls inside its own box; the page
	   itself never does. */
	.tw { overflow-x: auto; }
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 14px 20px 24px;
		line-height: 1.45;
		max-width: 860px;
		margin: 0 auto;
	}
	header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
	/* Beside the title, not floated to the far edge -- at the edge it reads as
	   unrelated chrome rather than as part of the product's name block. */
	.repo { color: var(--vscode-descriptionForeground); margin-left: 9px; }
	.repo svg { vertical-align: -0.2em; }
	.repo:hover { color: var(--vscode-foreground); }
	/* NOT inline-flex: a flex container takes its baseline from its first item,
	   which here is the logo, so <header>'s baseline alignment pinned the date
	   to the image's bottom edge instead of to the title's baseline -- and
	   enlarging the logo pushed it further out of line. Inline content with an
	   optical vertical-align keeps the baseline on the words. */
	h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
	.logo { vertical-align: -0.28em; margin-right: 8px; }
	/* The sentence and the note share the column beside the hero figure. */

	/* The theme's link colour is contrast-checked against its background;
	   charts-blue is a fill colour for chart marks and is not. */
	.hint-body a { color: var(--vscode-textLink-foreground, #4a9eff); }
	/* Opening leftwards in the right-hand column. Anchored to the marker's left
	   edge it reached 127px past the page and took it sideways -- the same
	   overflow the narrow split caught, arrived at by moving the marker instead
	   of shrinking the window. */
	.aside .hint-body { left: auto; right: 0; }
	h2 { font-size: 0.72rem; margin: 20px 0 8px; text-transform: uppercase;
	     letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); font-weight: 600; }
	h2.first { margin-top: 0; }
	.sub { color: var(--vscode-descriptionForeground); font-size: 0.82rem; }
	.dim { color: var(--vscode-descriptionForeground); }


	/* The week sits beside the verdict, not under it: it answers the same
	   question the card is already asking -- am I on pace -- and a chart under
	   the tiles reads as a separate section nobody scrolls to. 30%, not 20:
	   a heavy week reads "1,234" where a light one reads "23.04", and the
	   value column grows to fit it out of the bar's width. */
	.verdict-cols { display: flex; gap: 26px; align-items: stretch; }
	.verdict-main { flex: 1 1 auto; min-width: 0; }
	.aside {
		flex: 0 0 30%; min-width: 0;
		border-left: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22));
		padding-left: 18px;
	}
	.week { min-width: 0; }
	/* Today above the week, separated the way the meter is from the tiles. */
	.aside .day + .week { margin-top: 16px; padding-top: 14px;
	                      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22)); }
	/* No ground of its own here: the column is the frame, and a tinted box
	   inside a bordered column reads as a box inside a box. The bar still
	   carries the state. */
	.aside .day { padding: 0; border: none; background: none; }
	/* Separated from the tiles the way the tiles are from the meter. */
	.period { margin-top: 18px; padding-top: 14px;
	          border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22)); }
	.pd-head { display: flex; justify-content: space-between; align-items: baseline;
	           gap: 8px; font-size: 0.72rem; text-transform: uppercase;
	           letter-spacing: 0.07em; color: var(--vscode-descriptionForeground);
	           margin-bottom: 9px; }
	/* Columns share the width evenly and sit on a common baseline, so the shape
	   is the reading and no single day can widen the strip. */
	.pd-plot { display: flex; align-items: flex-end; gap: 3px; height: 46px; }
	/* The empty days are context, not content. At the week chart's track weight
	   twenty-six of them were a wall of grey with the two days that cost
	   anything lost inside it. */
	.pd-col { flex: 1 1 0; min-width: 0; height: 100%;
	          display: flex; align-items: flex-end;
	          background: rgba(128, 128, 128, 0.1);
	          background: color-mix(in srgb,
	              var(--vscode-editorWidget-border, rgba(128,128,128,0.22)) 45%, transparent);
	          border-radius: 2px; }
	.pd-fill { display: block; width: 100%; border-radius: 2px; background: var(--hue); }
	/* Today is the column a reader looks for first, and on a quiet day it is
	   also the shortest. The outline finds it when the bar cannot. */
	.pd-today { outline: 1px solid var(--hue); outline-offset: 1px; }
	.pd-peak { letter-spacing: 0; text-transform: none; font-size: 0.7rem; }
	.pd-axis { display: flex; justify-content: space-between; margin-top: 6px;
	           font-size: 0.68rem; color: var(--vscode-descriptionForeground); }

	.wk-head {
		display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
		font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em;
		color: var(--vscode-descriptionForeground); margin-bottom: 9px;
	}
	.wk-total { font-variant-numeric: tabular-nums; letter-spacing: 0; text-transform: none;
	            font-size: 0.8rem; color: var(--vscode-foreground); font-weight: 600; }
	.wk-row { display: flex; align-items: center; gap: 8px; padding: 2px 0;
	          font-size: 0.76rem; }
	.wk-day { flex: 0 0 2.4em; color: var(--vscode-descriptionForeground); }
	/* The bar keeps a floor. Its neighbours size to their content, so a week
	   billed in thousands would otherwise take the track's width for digits and
	   leave a chart with no chart in it. */
	.wk-track { flex: 1 1 auto; height: 8px; border-radius: 4px; min-width: 46px;
	            background: var(--vscode-editorWidget-border, rgba(128,128,128,0.22)); }
	.wk-fill { display: block; height: 100%; border-radius: 4px; background: var(--hue); }
	.wk-val { flex: 0 0 auto; min-width: 2.6em; text-align: right;
	          font-variant-numeric: tabular-nums;
	          color: var(--vscode-descriptionForeground); }
	/* Today is the row the reader is standing on, so it is the one named. */
	.wk-today .wk-day, .wk-today .wk-val { color: var(--vscode-foreground); font-weight: 600; }
	/* Days that have not happened yet are drawn so the week keeps its shape,
	   but faintly: an empty Friday is not a quiet Friday. */
	.wk-future { opacity: 0.45; }
	/* Days the period has not reached. Drawn, because the frame is the month:
	   an empty track is the difference between "not spent" and "not shown". */
	.pd-future { opacity: 0.45; }

	.verdict { padding: 14px 16px; border-radius: 8px;
	           background: var(--vscode-editorWidget-background);
	           border: 1px solid var(--vscode-widget-border, transparent);
	           border-left: 3px solid var(--hue); }
	/* Row and column gaps differ deliberately. The hero's unit label ("% left")
	   is small text ending where the note's small text begins, so a gap sized
	   for the big numeral leaves the two reading as one run. Wrapped on a narrow
	   panel the figure sits above the note and needs far less. */
	/* Tight against the meter beneath it, the way the day figure sits against
	   its own bar. The gap was sized for a sentence that is no longer there. */
	.verdict-top { margin-bottom: 14px; }
	/* Today, beside the month.
	   The state is the bar and the ground, never the number. Colouring the
	   figure itself put amber text at 2.93:1 on a light theme -- below the 3:1
	   a 24px run needs -- which is the same mistake this file records under
	   "chart colours are fills, and I kept using them as text". A fill is
	   exactly what the bar is, so the hue goes there, and the tint follows the
	   .warn treatment, which is the one warning styling here already proven to
	   survive both themes. */
	.day { flex: none; min-width: 132px; padding: 7px 10px; border-radius: 5px;
	       border: 1px solid transparent; }
	.day-v { font-size: 1.5rem; font-weight: 600; line-height: 1;
	         color: var(--vscode-foreground); }
	.day-v .unit { font-size: 0.78rem; font-weight: 500; margin-left: 5px;
	               color: var(--vscode-descriptionForeground); }
	.day-track { position: relative; height: 4px; border-radius: 2px; margin: 8px 0;
	             background: var(--vscode-editorWidget-border, #8884); overflow: hidden; }
	/* Where the budget fell, once the track is measuring the spend instead.
	   The month meter draws its allowance line proud of the track; this one
	   cannot, because the track clips to keep the fill's rounded ends. Cut as a
	   notch in the fill instead -- the marker only ever appears on a full bar,
	   so a gap in it reads at 4px where a line on top of it did not, and it
	   says the same thing: budget to the left, overspend to the right. */
	.day-limit { position: absolute; top: -1px; bottom: -1px; width: 2px;
	             background: var(--vscode-editor-background, #1f1f1f); }
	.day-fill { display: block; height: 100%; background: var(--day-hue); }
	/* The marker sits against the caption it explains. On a line of its own it
	   read as an orphan and cost the card a row. */
	.day-k { display: flex; align-items: flex-end; gap: 7px;
	         font-size: 0.72rem; color: var(--vscode-descriptionForeground); }
	.day-k .hint { margin-top: 0; }
	/* The marker is the affordance, so it has to look like one: a bordered
	   circle rather than a bare question mark, which reads as punctuation. */
	/* An overlay, not an expansion. Inline, three paragraphs of explanation
	   pushed the hero and the meter down the card and made opening the hint a
	   worse page than not opening it. Anchored so the layout underneath never
	   moves. */
	.hint { position: relative; margin-top: 8px; }
	/* Inline beside a label rather than under a figure: no line of its own, and
	   centred on the text it hangs off. */
	.mh-label { display: flex; align-items: center; gap: 7px; }
	.mh-label .hint { margin-top: 0; }
	.hint > summary { list-style: none; cursor: pointer; width: 15px; height: 15px;
	                  border-radius: 50%; font-size: 0.66rem; line-height: 15px;
	                  text-align: center; font-weight: 700;
	                  color: var(--vscode-descriptionForeground);
	                  border: 1px solid var(--vscode-descriptionForeground); }
	.hint > summary::-webkit-details-marker { display: none; }
	.hint > summary:hover { color: var(--vscode-foreground);
	                        border-color: var(--vscode-foreground); }
	.hint[open] > summary { color: var(--vscode-foreground);
	                        border-color: var(--vscode-foreground); }
	/* Wider than the column it hangs off, because the explanation is prose and
	   a 132px measure would set it one or two words to the line. Left-anchored
	   and width-capped so it cannot reach past the page and start it scrolling
	   sideways. */
	.hint-body { position: absolute; z-index: 5; top: 21px; left: 0;
	             width: 260px; max-width: min(260px, 70vw);
	             padding: 10px 12px; border-radius: 6px;
	             background: var(--vscode-editorWidget-background, #252526);
	             border: 1px solid var(--vscode-editorWidget-border, #454545);
	             box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
	             font-size: 0.72rem; line-height: 1.6;
	             color: var(--vscode-descriptionForeground); }
	.hint-body p { margin: 0 0 9px; }
	.hint-body p:last-child { margin-bottom: 0; }
	.hint-body code { font-size: 0.95em; }
	.day-under { --day-hue: var(--vscode-charts-blue, #4a9eff); }
	.day-near  { --day-hue: var(--vscode-charts-yellow, #cca700);
	             background: var(--vscode-inputValidation-warningBackground, rgba(255,190,0,0.1));
	             border-color: var(--vscode-inputValidation-warningBorder, rgba(255,190,0,0.4)); }
	.day-over  { --day-hue: var(--vscode-charts-red, #f14c4c);
	             background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.1));
	             border-color: var(--vscode-inputValidation-errorBorder, rgba(241,76,76,0.4)); }

	/* --hue-text, not --hue: the fill colour and the text colour part company
	   at the amber end, where the fill is legible and the text is not. Even
	   the theme's own warning foreground measured 2.93:1 at this size on
	   light, so it is pulled toward the editor's foreground -- darker on a
	   light theme, lighter on a dark one, and still recognisably the status
	   colour. The plain declaration stays first as the fallback. */
	.hero { font-size: 2.5rem; font-weight: 600; line-height: 1; flex: none;
	        color: var(--hue-text, var(--hue)); }
	.hero .unit { font-size: 1.15rem; font-weight: 500; margin-left: 7px;
	              color: var(--vscode-descriptionForeground); }
	.sentence { margin: 0; font-size: 0.9rem; flex: 1 1 260px; min-width: 240px; }

	.meter-wrap { margin-top: 22px; }
	.meter-head, .meter-foot { display: flex; justify-content: space-between; gap: 12px;
	     font-size: 0.78rem; margin-bottom: 5px; font-variant-numeric: tabular-nums; }
	.meter-foot { margin: 5px 0 0; }
	.meter { position: relative; height: 10px; border-radius: 5px; overflow: hidden;
	         background: var(--vscode-editorWidget-border, rgba(128,128,128,0.22)); }
	.meter-fill { position: absolute; left: 0; top: 0; bottom: 0;
	              border-radius: 5px 0 0 5px; background: var(--hue); }
	/* A 2px surface gap keeps the forecast from fusing with the spend. */
	.meter-limit { position: absolute; top: -3px; bottom: -3px; width: 2px;
	     background: var(--vscode-foreground); opacity: 0.9; }
	.meter-ghost { position: absolute; top: 0; bottom: 0;
	     background: repeating-linear-gradient(135deg, var(--hue) 0 3px, transparent 3px 6px);
	     opacity: 0.55; box-shadow: -2px 0 0 var(--vscode-editorWidget-background); }
	/* charts-red is a fill. As body text it measured 4.29:1 on dark and 3.36:1
	   on light, against the 4.5:1 a 12.5px run needs -- the third time this file
	   has used a chart colour for text, and the first fixture with an
	   over-quota account found it immediately. errorForeground is the theme's
	   own text red and is contrast-checked against the editor background. */
	.over { color: var(--vscode-errorForeground, #f14c4c); font-weight: 600; }

	/* Inside the verdict card, not a separate band -- pace is part of the verdict. */
	.tiles { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 14px;
	         padding-top: 12px;
	         border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22)); }
	.tile { flex: 0 1 auto; }
	.tile .v { font-size: 1.25rem; font-weight: 600; }
	.tile .v .unit { font-size: 0.75rem; font-weight: 500; margin-left: 3px;
	                 color: var(--vscode-descriptionForeground); }
	.tile .k { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
	           color: var(--vscode-descriptionForeground); margin-top: 1px; }
	/* Same reason as .over above, and the fourth time: as 20px text charts-red
	   measured 4.29:1 dark and 3.36:1 light, against the 4.5:1 it needs. The
	   first fixture with a pace over budget found it. */
	.tile.hot .v { color: var(--vscode-errorForeground, #f14c4c); }

	/* <details> keeps the lower-ranked findings one click away without script. */
	/* 8px between bordered containers read as one glued block. Prose above the
	   first card needs a larger gap than the cards need from each other, or the
	   habits paragraph looks like part of the first finding. */
	.card { border-radius: 7px; margin-bottom: 12px;
	        background: var(--vscode-editorWidget-background);
	        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
	.note + .card { margin-top: 20px; }
	.card > summary { list-style: none; cursor: pointer; padding: 12px 15px;
	        display: flex; gap: 12px; align-items: baseline; justify-content: space-between; }
	.card > summary::-webkit-details-marker { display: none; }
	.card > summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
	.card-title { font-weight: 600; font-size: 0.86rem; }
	.card-title::before,
	details.detail > summary::before {
	        content: ''; display: inline-block; width: 6px; height: 6px;
	        margin: 0 10px 2px 0; vertical-align: middle;
	        border-right: 1.7px solid currentColor;
	        border-bottom: 1.7px solid currentColor;
	        transform: rotate(45deg); transform-origin: 55% 55%;
	        transition: transform 130ms ease; opacity: 0.85; }
	.card[open] .card-title::before,
	details.detail[open] > summary::before { transform: rotate(-135deg); }

	.stake { flex: none; font-size: 0.76rem; font-variant-numeric: tabular-nums;
	         padding: 1px 7px; border-radius: 10px; white-space: nowrap;
	         color: var(--vscode-charts-blue, #4a9eff);
	         border: 1px solid var(--vscode-charts-blue, #4a9eff); }
	/* Anything that is not a measurement drops out of the accent colour, so a
	   solid finding is distinguishable at a glance and not by reading the mark
	   alone. Colour is never the only carrier: the chip also gains a prefix. */
	/*
	 * The sidebar.
	 *
	 * The panel was laid out for an editor group and the sidebar is a third of
	 * that, so the flex rows that wrap on a narrow split do not wrap here --
	 * their min-widths add up to more than the column is wide, and the page
	 * overflows instead. Below the breakpoint those minimums go, the two-column
	 * rows stack, and the padding comes in.
	 */
	@media (max-width: 560px) {
		/* Back to expanding in place. An overlay is anchored to its marker, so
		   in a 320px split a 260px panel starts 146px past the edge and takes
		   the whole page sideways with it. There is no room to float something
		   over this width anyway: the thing it would cover is the thing you
		   were reading. */
		.hint-body { position: static; width: auto; max-width: none;
		             box-shadow: none; margin-top: 8px; }
		body { padding: 12px 14px 20px; }
		header { gap: 6px 10px; }
		.verdict { padding: 12px 13px; }
		/* Beside becomes below: 30% of a narrow split is not a chart. */
		.verdict-cols { flex-wrap: wrap; gap: 18px; }
		/* Thirty-one columns share about 290px here. At the wide gap they take
		   less than half of it and the chart reads as stripes rather than as a
		   shape; the columns are the data and the gaps only separate them. */
		.pd-plot { gap: 1px; height: 38px; }
		.aside { flex: 1 1 100%; border-left: none; padding-left: 0;
		         border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22));
		         padding-top: 14px; }
		/* The floor that keeps the bar visible in a 30% column is three pixels
		   more than a 320px split can spare once the day and the value have
		   taken theirs. Lower here; the bar is still a bar. */
		.wk-track { min-width: 34px; }
		.wk-val { min-width: 0; }
		.verdict-top { gap: 10px 16px; }
		.hero { font-size: 2rem; }
		.tiles { gap: 14px; }
		.tile { flex: 1 1 100%; }
		.meter-head, .meter-foot { flex-wrap: wrap; gap: 2px 10px; }
		.card > summary { padding: 11px 12px; gap: 8px; flex-wrap: wrap; }
		.card-body, .detail-body { padding-left: 12px; padding-right: 12px; }
		.card-evidence { margin-left: 12px; margin-right: 12px; }
		/* Monospace evidence at panel size is far wider than a sidebar; it wraps
		   rather than reaching for a horizontal scrollbar the page must not have. */
		.card-evidence, .rate-card { overflow-wrap: anywhere; }
	}

	.stake.bounded, .stake.estimated {
	                 color: var(--vscode-descriptionForeground);
	                 border-color: var(--vscode-widget-border, rgba(128,128,128,0.4)); }
	.stake.estimated { border-style: dashed; }
	.card-body { padding: 2px 15px 8px; font-size: 0.85rem;
	             line-height: 1.6; text-wrap: pretty; }
	.card-evidence { margin: 14px 15px 13px; font-size: 0.74rem;
	                 font-family: var(--vscode-editor-font-family);
	                 line-height: 1.55;
	                 color: var(--vscode-descriptionForeground); }

	.card-evidence.rate-card { margin: 16px 0 0; }
	/* The note is the last thing in the composition block, and the next table's
	   header row followed it immediately -- the two read as one element. */
	.composition { margin-bottom: 28px; }

	.comp td, .comp th { padding: 4px 12px 4px 0; }
	/* The gap belongs to the scroll box, not to the table inside it: a margin
	   on the table is inside the wrapper and leaves two wrappers flush. */
	.tw:has(> table.spaced) { margin-top: 26px; }
	table.spaced { margin-top: 0; }
	.depth { border-collapse: collapse; width: 100%; margin-bottom: 12px;
	         font-variant-numeric: tabular-nums; }
	.depth td { padding: 3px 10px 3px 0; border: none; font-size: 0.83rem; }
	.depth th { padding: 0 10px 5px 0; border: none; font-size: 0.7rem; font-weight: 500;
	            text-transform: uppercase; letter-spacing: 0.05em;
	            color: var(--vscode-descriptionForeground); }
	.depth th.num, .depth td.num { text-align: right; }
	.depth-label { white-space: nowrap; color: var(--vscode-descriptionForeground); }
	.depth-bar { width: 55%; }
	.depth-bar .bar { width: 100%; }

	.comp tr.comp-top td { font-weight: 600; }
	.comp tr.comp-child td { font-weight: 400; border-bottom: none;
	                         color: var(--vscode-descriptionForeground); }
	.comp tr.comp-child .comp-name { padding-left: 22px; }
	/* The price is a property of the row, not a measurement of this month, so it
	   recedes next to the figures it explains. */
	.comp .rate { color: var(--vscode-descriptionForeground); font-size: 0.8rem; }
	.comp th { white-space: nowrap; }
	.pct-only { text-align: right; font-size: 0.78rem; width: 80px;
	            color: var(--vscode-descriptionForeground); }
	.rate-num { font-size: 0.76rem; margin-left: 7px;
	            color: var(--vscode-descriptionForeground); }
	.comp-name { white-space: nowrap; }
	.seg { min-width: 2px; }
	/* Series hues in fixed order. Blue next to purple fails CVD separation
	   (dE 5.6 protan); blue -> green -> purple clears it at dE 20.9. Red and
	   yellow stay reserved for the verdict. */
	.c-fresh  { background: var(--vscode-charts-blue, #3794ff); }
	.c-cached { background: var(--vscode-charts-green, #89d185); }
	.c-output { background: var(--vscode-charts-purple, #b180d7); }
	.c-open   { background: repeating-linear-gradient(135deg,
	            var(--vscode-descriptionForeground) 0 2px, transparent 2px 5px); opacity: 0.6; }
	/* Subtotal rows carry no hue of their own; their bars borrow the neutral. */
	.c-any    { background: var(--vscode-charts-foreground, #cccccc); opacity: 0.75; }
	.swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
	/* Block margins, not just a top one. A note introduces whatever follows it
	   as often as it trails what came before, and with no bottom margin the
	   reconciliation line sat flush against the table it was introducing.
	   Adjacent margins collapse, so .note + .card still gets its 20px. */
	.note { font-size: 0.83rem; margin: 12px 0; line-height: 1.6; text-wrap: pretty; }
	.rate-card { padding: 0; margin-top: 6px; }

	/* The cheapest figure in its column, which is the only mark on the page:
	   no badge says "recommended", because cheapest is not best and this view
	   has no way to know whether the cheap one could do the work.

	   textLink, not charts-blue: as 13px text the chart colour measured
	   3.59:1 on light against the 4.5:1 body text needs. That is the fifth
	   time a fill has been used as text in this file, and the first fixture
	   that rendered this table found it immediately. */
	td.best { font-weight: 600; color: var(--vscode-textLink-foreground, #4daafc); }

	/* Six columns do not fit a split editor, so the table scrolls inside the
	   .tw wrapper like every other wide table here rather than taking the page
	   with it: at 320px it ran 54px past the viewport and the panel went
	   sideways. A backtick in this comment ends the stylesheet, which is a
	   template literal -- hence the bare class name. The width itself is set
	   with the rest of the table's rules below. */
	.tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
	       color: var(--vscode-descriptionForeground); margin-left: 6px; }
	/* errorForeground and descriptionForeground, both of which a theme contrast
	   checks against its editor background. charts-orange is a fill and at
	   9px it is the sixth thing in this file that would have been read as
	   text. The two states are told apart by their words as much as their
	   colour, since one is a fact about your account and the other about a
	   file that has not caught up. */
	.tag.gone { color: var(--vscode-errorForeground, #f85149); }
	.tag.unpriced { color: var(--vscode-descriptionForeground); }
	/* Auto is not a state of the card, so it does not borrow the card's
	   colours. Same weight as the long-context tag: a fact about the row. */
	.tag.routed { color: var(--vscode-descriptionForeground); }
	.models td.model .tag { margin-left: 8px; }
	.models .foot { font-size: 0.78rem; color: var(--vscode-descriptionForeground);
	                margin: 10px 0 0; line-height: 1.6; }
	/* The unit belongs where the figures are read, not only in a footer under
	   twenty rows: "20" and "120" are 20 and 120 of something until it is said. */
	.models .unit { font-size: 0.8rem; color: var(--vscode-descriptionForeground);
	                margin: 0 0 12px; line-height: 1.6; }
	.models .unit strong { color: var(--vscode-foreground); font-weight: 600; }
	tr.gone td.model { color: var(--vscode-descriptionForeground); }

	/* The table was a wall: twenty-odd rows of six columns, every border drawn,
	   the model name the same weight as the figures beside it. The rules
	   between rows go in favour of a banded background, the name carries the
	   weight, and the money sits in a tighter block so the eye runs down a
	   column rather than across a grid. */
	.models { margin-top: 26px; }
	.models table { min-width: 430px; }
	/* One geometry for both tables. Without fixed widths the folded rows sized
	   themselves independently and no column lined up across the fold. */
	.models table { table-layout: fixed; }
	.models .c-model { width: 29%; }
	.models .c-num { width: 12.5%; }
	.models .c-gate { width: 21%; }
	/* Header and cell share their padding, or every label sits 10px off the
	   figures beneath it -- which is what the inherited th rule did. */
	.models th, .models td { padding: 7px 2px 7px 14px; }
	.models th { padding-top: 0; padding-bottom: 9px; white-space: nowrap;
	             overflow: hidden; text-overflow: ellipsis; }
	.models th:first-child, .models td:first-child { padding-left: 10px; }
	/* The last column ran to the edge of the panel with nothing behind it. */
	.models th:last-child, .models td:last-child { padding-right: 12px; }
	.models td { border-bottom: none; }
	.models tbody tr:nth-child(odd) {
	    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.06)); }
	/* Seven rows stand, so the fold opens on an even one. Without this the
	   banding restarted and two shaded rows met across the boundary. */
	.models table.fold tbody tr:nth-child(odd) { background: none; }
	.models table.fold tbody tr:nth-child(even) {
	    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.06)); }
	/* Wraps. A Foundry-prefixed id is 50 characters and the column is 29% of
	   the panel, so nowrap sent it straight through the INPUT column and the
	   tag landed on top of a price. overflow-wrap anywhere, because an id is one
	   word to a line-breaker: there is no space in it to break at. break-word
	   rather than anywhere, so the hyphens and slashes an id already has are
	   used first: anywhere split gpt-4o-mini-2024-07-18 after the 07-.
	   (No backticks in this file's comments -- the stylesheet is a template
	   literal.) */
	.models td.model { font-weight: 500; white-space: normal;
	                   overflow-wrap: break-word; line-height: 1.45; }
	/* The tag keeps its own line rather than being torn across two. */
	.models td.model .tag { white-space: nowrap; }
	.models td.dim { font-size: 0.78rem; }
	/* The gate text is prose in a numeric column; sized down and right-set so
	   the column still scans as one edge. */
	.models td.gate { font-size: 0.75rem; white-space: nowrap; }
	/* An absent price is not zero and not a gap to skip: dimmed to the weight
	   of punctuation so the column still reads as a column. */
	.models td.dim:not([colspan]) { opacity: 0.45; }
	/* What a model is for, opened from a question mark beside its name.

	   Not the .hint bubble the rest of the page uses. That panel is absolutely
	   positioned, and this table sits inside a sideways-scrolling wrapper:
	   overflow-x on a box makes its overflow-y a scroll container too, so the
	   panel is cut off at the cell's edge and the note opens into a box it
	   cannot be read out of. Verified in a browser, not assumed.

	   So the body opens in the flow and the rows below it move down. A details
	   element set to inline puts the marker on the name's line; its block child
	   breaks
	   out of that inline box and takes the full width of the cell, which is the
	   whole reason the body is a block and not a span. */
	.models .about { display: inline; }
	.models .about > summary { display: inline-block; list-style: none;
	    cursor: pointer; margin-left: 7px; vertical-align: 1px;
	    width: 13px; height: 13px; border-radius: 50%;
	    font-size: 0.58rem; line-height: 12px; text-align: center;
	    font-weight: 700; white-space: nowrap;
	    color: var(--vscode-descriptionForeground);
	    border: 1px solid var(--vscode-descriptionForeground); }
	.models .about > summary::-webkit-details-marker { display: none; }
	.models .about > summary:hover, .models .about[open] > summary {
	    color: var(--vscode-foreground); border-color: var(--vscode-foreground); }
	.models .about > summary:focus-visible {
	    outline: 1px solid var(--vscode-focusBorder, #0078d4); outline-offset: 2px; }
	/* Lighter than the name it hangs under, so an open row still reads as one
	   row with a name at the top of it rather than as two lines of equal claim. */
	.models .about-body { display: block; margin: 5px 0 1px; font-weight: 400;
	    font-size: 0.75rem; line-height: 1.5;
	    color: var(--vscode-descriptionForeground); }
	.models-rest { margin-top: 10px; }
	.models-rest > summary { font-size: 0.8rem; font-weight: 500;
	    color: var(--vscode-descriptionForeground); padding: 9px 14px; }
	.models-rest .detail-body { padding: 0 0 6px; }

	table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
	th, td { text-align: left; padding: 5px 10px 5px 0; font-size: 0.83rem;
	         border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
	th { color: var(--vscode-descriptionForeground); font-weight: 500;
	     font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
	td.num, th.num { text-align: right; }
	td.share { width: 120px; }
	td.sel, th:nth-child(2) { font-size: 0.78rem; }
	td.sel { color: var(--vscode-descriptionForeground); }
	td.sel.auto { color: var(--vscode-foreground); }
	tr.lead td { font-weight: 600; }
	tr.lead .fill { opacity: 1; }
	.bar { display: inline-block; width: 74px; height: 6px; border-radius: 3px;
	       background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); vertical-align: middle; }
	.fill { height: 100%; border-radius: 3px; background: var(--vscode-charts-blue, #4a9eff);
	        opacity: 0.55; }
	/* .fill is declared after the hue classes, so it would otherwise win on
	   source order and paint every composition bar blue. No backticks in this
	   block -- the whole stylesheet is a template literal. */
	.fill.c-fresh  { background: var(--vscode-charts-blue, #3794ff); opacity: 1; }
	.fill.c-cached { background: var(--vscode-charts-green, #89d185); opacity: 1; }
	.fill.c-output { background: var(--vscode-charts-purple, #b180d7); opacity: 1; }
	.fill.c-any    { background: var(--vscode-charts-foreground, #cccccc); opacity: 0.75; }
	.fill.c-open   { background: repeating-linear-gradient(135deg,
	                 var(--vscode-descriptionForeground) 0 2px, transparent 2px 5px); opacity: 0.6; }
	.pct { font-size: 0.73rem; color: var(--vscode-descriptionForeground); margin-left: 7px; }


	section + section { margin-top: 38px; }
	details.detail { margin-top: 0; }
	details.detail { border-radius: 7px;
	    background: var(--vscode-editorWidget-background);
	    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
	details.detail > summary { cursor: pointer; list-style: none;
	    font-size: 0.86rem; font-weight: 600; padding: 12px 15px; border-radius: 7px;
	    color: var(--vscode-foreground); }
	details.detail > summary::-webkit-details-marker { display: none; }
	details.detail > summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
	details.detail[open] > summary { border-radius: 7px 7px 0 0; }
	.detail-body { padding: 2px 15px 14px; }

	/* Same reason as the evidence line above: a warning quotes paths, and a path
	   is a single unbreakable word to a line-breaker. */
	.warn { margin: 12px 0; padding: 8px 11px; border-radius: 5px; font-size: 0.8rem;
	        overflow-wrap: anywhere;
	        background: var(--vscode-inputValidation-warningBackground, rgba(255,190,0,0.1));
	        border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,190,0,0.4)); }
	.history { margin: 0 0 14px; }
	footer { margin: 40px 0 0; font-size: 0.73rem; font-style: italic;
	         color: var(--vscode-descriptionForeground); line-height: 1.65; }
	footer code { font-weight: 700; color: var(--vscode-foreground); }
`;

/** Per-day credits and message counts, the shape `periodCoverage` compares. */
export function creditsByDay(
	rollups: Rollup[],
	creditsPerNanoAiu: number
): Map<string, { credits: number; requests: number }> {
	const map = new Map<string, { credits: number; requests: number }>();
	for (const r of rollups) {
		const entry = map.get(r.day) ?? { credits: 0, requests: 0 };
		entry.credits += creditsOf(r.nanoAiu, creditsPerNanoAiu);
		entry.requests += r.requests;
		map.set(r.day, entry);
	}
	return map;
}
