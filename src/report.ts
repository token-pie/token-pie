import { Rollup, Totals, DepthStats, DEPTH_BUCKETS, groupBy, sum } from './store';
import { Projection } from './projection';
import { Advice, advise, selectionMix } from './advice';
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

function fmtInt(n: number): string {
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

function fmtCredits(credits: number): string {
	return credits >= 100 ? fmtInt(credits) : credits.toFixed(2);
}

function fmtDays(days: number | undefined): string {
	if (days === undefined) {
		return '?';
	}
	if (days < 1) {
		return `${Math.max(1, Math.round(days * 24))}h`;
	}
	return days < 10 ? days.toFixed(1) : String(Math.round(days));
}

export function creditsOf(nanoAiu: number, creditsPerNanoAiu: number): number {
	return nanoAiu * creditsPerNanoAiu;
}

function escapeHtml(value: string): string {
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

function verdictSentence(p: Projection, lastDay: string | undefined): string {
	switch (p.verdict) {
		case 'exhausted': {
			const when = p.daysToReset !== undefined
				? `It comes back in <strong>${fmtDays(p.daysToReset)} days</strong>.`
				: '';
			const over = p.creditsUsed !== undefined && p.entitlement
				&& p.creditsUsed > p.entitlement
				? ` You are <strong>${fmtCredits(p.creditsUsed - p.entitlement)} credits</strong>
				   past the ${fmtCredits(p.entitlement)} you were allowed.`
				: '';
			return `<strong>Your ${escapeHtml(p.quotaId ?? 'allowance')} is used up</strong>
				&mdash; Copilot will refuse premium requests until it resets.${over} ${when}`;
		}
		case 'will-exhaust': {
			const when = p.exhaustDate
				? p.exhaustDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
				: 'soon';
			const short = p.daysToReset !== undefined && p.daysToExhaust !== undefined
				? ` &mdash; ${fmtDays(p.daysToReset - p.daysToExhaust)} days before it resets`
				: '';
			return `At your current rate the allowance runs out on <strong>${escapeHtml(when)}</strong>${short}.`;
		}
		case 'tight':
			return `Your allowance lasts to the reset, but with under ${fmtDays(2)} days of slack. ` +
				'One heavy day changes the answer.';
		case 'ok':
			return 'Your current rate finishes the period with room to spare.';
		case 'no-rate':
			return lastDay
				? 'Not enough history to project a burn rate yet &mdash; a rate needs more than ' +
				  'one day, or a single busy afternoon reads as a crisis. The allowance below is live.'
				: 'No usage recorded yet. Use Copilot Chat, then refresh.';
		default:
			return 'No quota information. Run <strong>Token Pie: Check Quota</strong> to sign in ' +
				'and read your entitlement from GitHub.';
	}
}

/**
 * A meter: one ratio against a limit.
 *
 * The solid fill is what you have spent. The ghosted extension is where the
 * observed burn rate lands you by the reset date -- if it runs off the end of
 * the track, that is the throttle, drawn.
 */
function allowanceMeter(p: Projection): string {
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
			<span><strong>${fmtCredits(used)}</strong> of ${fmtCredits(p.entitlement)} credits used</span>
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
				: `${fmtCredits(p.remaining)} cr left`}</span>
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
	if (p.burnPerDay !== undefined) {
		const overPace =
			p.sustainableDailyBurn !== undefined && p.burnPerDay > p.sustainableDailyBurn;
		tiles.push(tile(
			fmtCredits(p.burnPerDay),
			'cr/day',
			'your pace',
			`Credits per day, measured over ${fmtDays(p.daysObserved)} days of elapsed ` +
			'time with idle days included.',
			overPace ? 'hot' : undefined
		));
	}
	if (p.sustainableDailyBurn !== undefined) {
		tiles.push(tile(
			fmtCredits(p.sustainableDailyBurn),
			'cr/day',
			'sustainable pace',
			'Credits per day the remaining allowance can absorb until it resets.'
		));
	}
	if (p.daysToReset !== undefined) {
		tiles.push(tile(fmtDays(p.daysToReset), 'days', 'until reset'));
	}
	return tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : '';
}

/* --------------------------------------------------------------- advice --- */

/** Whether the habits block already said something, so silence here is fine. */
export function habitsFound(depth: Record<string, DepthStats> | undefined): boolean {
	return Object.values(depth ?? {}).filter(d => d.warmRequests > 0).length >= 2;
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
			(a, i) => `<details class="card"${i === 0 ? ' open' : ''}>
			<summary>
				<span class="card-title">${a.headline}</span>
				<span class="stake${a.bounded ? ' bounded' : ''}">${a.bounded ? '&le; ' : ''}${fmtCredits(a.creditsAtStake)} cr</span>
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
function compositionBar(
	rollups: Rollup[],
	prices: Record<string, PriceStats>,
	creditsPerNanoAiu: number
): string {
	let fresh = 0, cached = 0, output = 0;
	let costFresh = 0, costCached = 0, costOutput = 0;
	let pricedFresh = 0, pricedCached = 0, pricedOutput = 0;
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
		cached += t.cacheReadTokens;
		output += t.outputTokens;

		const credits = creditsOf(t.nanoAiu, creditsPerNanoAiu);
		totalCredits += credits;

		const stats = prices?.[model];
		const price = stats ? solve(stats, creditsPerNanoAiu) : undefined;
		if (!price || credits <= 0) {
			continue;
		}
		priced.push({ model, price });
		pricedCredits += credits;
		pricedFresh += f;
		pricedCached += t.cacheReadTokens;
		pricedOutput += t.outputTokens;
		costFresh += (f * price.fresh) / 1000;
		costCached += (t.cacheReadTokens * price.cached) / 1000;
		costOutput += (t.outputTokens * price.output) / 1000;
	}

	const tokenTotal = fresh + cached + output;
	if (tokenTotal <= 0) {
		return '';
	}

	// Below this share of spend, a cost split would describe a minority of the
	// bill while looking like the whole of it.
	const MIN_PRICED_SHARE = 0.5;
	const coverage = totalCredits > 0 ? pricedCredits / totalCredits : 0;
	const byCost = priced.length > 0 && coverage >= MIN_PRICED_SHARE
		&& costFresh + costCached + costOutput > 0;

	if (!byCost) {
		const rows: CompRow[] = [
			{ label: 'what you send', tokens: fresh + cached },
			{ label: 'new, charged in full', cls: 'c-fresh', tokens: fresh, child: true },
			{ label: 'repeated, from cache', cls: 'c-cached', tokens: cached, child: true },
			{ label: "Copilot's replies", cls: 'c-output', tokens: output }
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

	const rows: CompRow[] = [
		{ label: 'what you send', credits: costInput, tokens: tokensInput },
		{ label: 'new, charged in full', cls: 'c-fresh', credits: costFresh, tokens: pricedFresh, child: true },
		{ label: 'repeated, from cache', cls: 'c-cached', credits: costCached, tokens: pricedCached, child: true },
		{ label: "Copilot's replies", cls: 'c-output', credits: costOutput, tokens: pricedOutput },
		{ label: 'not measured yet', cls: 'c-open', credits: unpricedCost, tokens: unpricedTokens }
	];

	const models = priced.slice().sort((a, b) => b.price.n - a.price.n);
	const lead = models[0];
	const observations = models.reduce((n, m) => n + m.price.n, 0);
	const worstFit = Math.min(...models.map(m => m.price.r2));

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
function compositionTable(rows: CompRow[], withCost: boolean, caption: string): string {
	// Children are already counted inside their parent, so shares are taken
	// over the top-level rows alone and still sum to 100%.
	const tops = rows.filter(r => !r.child);
	const totalCredits = tops.reduce((n, r) => n + (r.credits ?? 0), 0);
	const totalTokens = tops.reduce((n, r) => n + r.tokens, 0);

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
			${withCost ? `<td class="num">${fmtCredits(r.credits ?? 0)}</td>
			${share(creditShare)}` : ''}
			<td class="num">${fmtTokens(r.tokens)}</td>
			${share(tokenShare)}
		</tr>`;
		})
		.join('');

	return `<table class="comp">
		<tr><th>${escapeHtml(caption)}</th>${
			withCost ? '<th class="num">Credits</th><th class="num">Share</th>' : ''}
		    <th class="num">Tokens</th><th class="num">Share</th></tr>
		${body}
	</table>`;
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
function habits(
	depth: Record<string, DepthStats>,
	rollups: Rollup[],
	creditsPerNanoAiu: number,
	p: Projection
): string {
	// Cold starts are excluded: a first request to a model pays for the whole
	// context at full price, which would swamp the trend being shown.
	const bars = DEPTH_BUCKETS
		.map(b => ({ label: b.label, stats: depth?.[b.label] }))
		.filter((b): b is { label: string; stats: DepthStats } =>
			b.stats !== undefined && b.stats.warmRequests > 0)
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
			lines.push(`<strong>Start a new chat when you change subject.</strong>
				Copilot re-sends the whole conversation every time you hit enter, so your
				${escapeHtml(last.label)} message costs
				<strong>${(last.cost / first.cost).toFixed(1)}&times;</strong> what your
				${escapeHtml(first.label)} did &mdash; ${fmtCredits(last.cost)} against
				${fmtCredits(first.cost)} credits, for the same kind of question.`);
		}
	}

	if (bars.length === 0 && lines.length === 0) {
		return '';
	}

	const peak = Math.max(...bars.map(b => b.cost), 0);
	const chart = bars.length >= 2
		? `<table class="depth">
			<tr><th>Position in the chat</th><th class="depth-bar"></th>
			    <th class="num">Credits each</th><th class="num">Messages</th></tr>
			${bars.map(b => `<tr>
			<td class="depth-label">${escapeHtml(b.label)} message</td>
			<td class="depth-bar">${hueBar(peak > 0 ? b.cost / peak : 0, 'c-fresh')}</td>
			<td class="num">${fmtCredits(b.cost)}</td>
			<td class="num dim">${fmtInt(b.requests)}</td>
		</tr>`).join('')}</table>`
		: '';

	return `
	${chart}
	${lines.map(l => `<p class="note">${l}</p>`).join('')}`;
}

/* ---------------------------------------------------------------- table --- */

/** How a model's spend was reached, in the width of a table cell. */
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
function breakdownRows(
	groups: Map<string, Totals>,
	creditsPerNanoAiu: number,
	totalCredits: number,
	rollups?: Rollup[]
): string {
	const entries = [...groups.entries()]
		.map(([label, t]) => ({ label, t, credits: creditsOf(t.nanoAiu, creditsPerNanoAiu) }))
		.sort((a, b) => b.credits - a.credits);

	const span = rollups ? 5 : 4;
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
	warnings: string[];
	projection: Projection | undefined;
	prices: Record<string, PriceStats>;
	depth: Record<string, DepthStats>;
	history?: HistoryFacts;
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
export function renderReport(input: ReportInput): string {
	const { rollups, creditsPerNanoAiu } = input;
	const totals = sum(rollups);
	const totalCredits = creditsOf(totals.nanoAiu, creditsPerNanoAiu);
	const p: Projection = input.projection ?? { verdict: 'unknown' };

	const byModel = groupBy(rollups, 'model');
	const byWorkspace = groupBy(rollups, 'workspace');
	const byDay = groupBy(rollups, 'day');
	const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-14);

	// One day is not a trend. A single-column bar chart is always 100% full and
	// says nothing; below two days the number itself is the honest form.
	const trend = days.length >= 2
		? `<h2>Daily spend</h2><div class="chart">${sparkColumns(days, creditsPerNanoAiu)}</div>`
		: '';

	const recommendations = advise(rollups, creditsPerNanoAiu, input.prices, p.remaining);

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
		<h1>Token Pie</h1>
		<span class="sub">${coverage(days)} &middot;
			refreshed ${input.lastRefresh ? escapeHtml(input.lastRefresh.toLocaleTimeString()) : 'never'}
		</span>
	</header>
	${historyNote(input.history, days)}

	<section class="verdict" style="--hue:${severityVar(p)}">
		<div class="verdict-top">
			${heroFigure(p, totalCredits)}
			<p class="sentence">${verdictSentence(p, days.at(-1)?.[0])}</p>
		</div>
		${allowanceMeter(p)}
		${paceTiles(p)}
	</section>

	${warnings}

	<!-- One section for everything actionable. Two ("what to change" and
	     "what your habits cost") meant one of them was routinely empty while
	     the other had the finding, which read as a broken panel. -->
	<h2>What to change</h2>
	${habits(input.depth, rollups, creditsPerNanoAiu, p)}
	${adviceCards(recommendations, habitsFound(input.depth))}

	<!-- Reference, not headline. Breakdowns answer "where did it go", which a
	     developer asks occasionally; leaving three tables open made a wall. -->
	<details class="detail" open>
		<summary>Where the credits went &mdash;
			<strong>${fmtCredits(totalCredits)} credits</strong> over
			${fmtInt(totals.requests)} message${totals.requests === 1 ? '' : 's'}</summary>

		${compositionBar(rollups, input.prices, creditsPerNanoAiu) || '<p class="dim">no data</p>'}

		<table>
			<tr><th>By model</th><th>Chosen by</th><th class="num">Messages</th>
			    <th class="num">Credits</th><th>Share</th></tr>
			${breakdownRows(byModel, creditsPerNanoAiu, totalCredits, rollups)}
		</table>

		<table class="spaced">
			<tr><th>By project</th><th class="num">Messages</th>
			    <th class="num">Credits</th><th>Share</th></tr>
			${breakdownRows(byWorkspace, creditsPerNanoAiu, totalCredits)}
		</table>

		${trend}
		${coverageNote(input.costCoverage, byModel, totals)}
	</details>

	<footer>
		Credits derive from <code>copilot_chat.copilot_usage_nano_aiu</code>, the cost Copilot
		itself reports &mdash; not an estimate from list pricing, and not the chat transcript's
		own <code>copilotCredits</code>, which leaves out the messages you retried or
		cancelled and were still charged for. Calibrate <code>tokenPie.creditsPerNanoAiu</code> against your GitHub
		billing dashboard before treating absolute figures as authoritative.
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
	return (Date.now() - Date.parse(`${day}T00:00:00`)) / 86_400_000;
}

/** Exactly one per view. The number the panel exists to deliver. */
function heroFigure(p: Projection, totalCredits: number): string {
	switch (p.verdict) {
		case 'exhausted':
			return `<div class="hero">0<span class="unit">credits left</span></div>`;
		case 'will-exhaust':
		case 'tight':
			return `<div class="hero">${fmtDays(p.daysToExhaust)}<span class="unit">days left</span></div>`;
		case 'ok':
		case 'no-rate':
			return p.percentRemaining !== undefined
				? `<div class="hero">${Math.round(p.percentRemaining)}<span class="unit">% left</span></div>`
				: `<div class="hero">${fmtCredits(totalCredits)}<span class="unit">credits</span></div>`;
		default:
			return `<div class="hero">${fmtCredits(totalCredits)}<span class="unit">credits spent</span></div>`;
	}
}

function sparkColumns(days: [string, Totals][], creditsPerNanoAiu: number): string {
	const peak = Math.max(1, ...days.map(([, t]) => t.nanoAiu));
	return days
		.map(([day, t]) => {
			const height = Math.max(2, (t.nanoAiu / peak) * 100);
			const credits = fmtCredits(creditsOf(t.nanoAiu, creditsPerNanoAiu));
			return `<div class="col" title="${day}: ${credits} credits">
				<div class="stem" style="height:${height.toFixed(0)}%"></div>
				<div class="tick">${day.slice(5)}</div>
			</div>`;
		})
		.join('');
}

const STYLES = `
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
	h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
	h2 { font-size: 0.72rem; margin: 20px 0 8px; text-transform: uppercase;
	     letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); font-weight: 600; }
	h2.first { margin-top: 0; }
	.sub { color: var(--vscode-descriptionForeground); font-size: 0.82rem; }
	.dim { color: var(--vscode-descriptionForeground); }


	.verdict { padding: 14px 16px; border-radius: 8px;
	           background: var(--vscode-editorWidget-background);
	           border: 1px solid var(--vscode-widget-border, transparent);
	           border-left: 3px solid var(--hue); }
	.verdict-top { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
	.hero { font-size: 2.5rem; font-weight: 600; line-height: 1; color: var(--hue); flex: none; }
	.hero .unit { font-size: 0.85rem; font-weight: 500; margin-left: 6px;
	              color: var(--vscode-descriptionForeground); }
	.sentence { margin: 0; font-size: 0.9rem; flex: 1 1 260px; min-width: 240px; }

	.meter-wrap { margin-top: 14px; }
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
	.over { color: var(--vscode-charts-red, #f14c4c); font-weight: 600; }

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
	.tile.hot .v { color: var(--vscode-charts-red, #f14c4c); }

	/* <details> keeps the lower-ranked findings one click away without script. */
	.card { border-radius: 7px; margin-bottom: 8px;
	        background: var(--vscode-editorWidget-background);
	        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
	.card > summary { list-style: none; cursor: pointer; padding: 10px 13px;
	        display: flex; gap: 12px; align-items: baseline; justify-content: space-between; }
	.card > summary::-webkit-details-marker { display: none; }
	.card > summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
	.card-title { font-weight: 600; font-size: 0.89rem; }
	.card-title::before { content: '\\25B8'; margin-right: 7px; font-size: 0.75em;
	        color: var(--vscode-descriptionForeground); }
	.card[open] .card-title::before { content: '\\25BE'; }
	.stake { flex: none; font-size: 0.76rem; font-variant-numeric: tabular-nums;
	         padding: 1px 7px; border-radius: 10px; white-space: nowrap;
	         color: var(--vscode-charts-blue, #4a9eff);
	         border: 1px solid var(--vscode-charts-blue, #4a9eff); }
	.stake.bounded { color: var(--vscode-descriptionForeground);
	                 border-color: var(--vscode-widget-border, rgba(128,128,128,0.4)); }
	.card-body { padding: 0 13px 4px 13px; font-size: 0.85rem; }
	.card-evidence { padding: 6px 13px 11px; font-size: 0.74rem;
	                 font-family: var(--vscode-editor-font-family);
	                 color: var(--vscode-descriptionForeground); }

	.comp td, .comp th { padding: 4px 12px 4px 0; }
	table.spaced { margin-top: 26px; }
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
	.pct-only { text-align: right; font-size: 0.78rem; width: 46px;
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
	.note { font-size: 0.83rem; margin: 10px 0 0; }
	.rate-card { padding: 0; margin-top: 6px; }

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

	.chart { display: flex; align-items: flex-end; gap: 6px; height: 74px; margin-top: 6px; }
	.col { flex: 1 1 0; max-width: 42px; display: flex; flex-direction: column;
	       justify-content: flex-end; align-items: center; height: 100%; }
	.stem { width: 100%; background: var(--vscode-charts-blue, #4a9eff);
	        border-radius: 4px 4px 0 0; opacity: 0.8; }
	.tick { font-size: 0.62rem; color: var(--vscode-descriptionForeground);
	        margin-top: 4px; white-space: nowrap; }

	details.detail { margin-top: 22px; }
	details.detail > summary { cursor: pointer; list-style: none; font-size: 0.82rem;
	    padding: 8px 12px; border-radius: 6px;
	    color: var(--vscode-descriptionForeground);
	    background: var(--vscode-editorWidget-background);
	    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
	details.detail > summary::-webkit-details-marker { display: none; }
	details.detail > summary::before { content: '\\25B8'; margin-right: 8px; font-size: 0.8em; }
	details.detail[open] > summary::before { content: '\\25BE'; }
	details.detail > summary:hover { color: var(--vscode-foreground); }
	details.detail[open] > summary { margin-bottom: 4px; }

	.warn { margin: 12px 0; padding: 8px 11px; border-radius: 5px; font-size: 0.8rem;
	        background: var(--vscode-inputValidation-warningBackground, rgba(255,190,0,0.1));
	        border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,190,0,0.4)); }
	.history { margin: 0 0 14px; }
	footer { margin-top: 22px; padding-top: 12px; font-size: 0.73rem;
	         border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
	         color: var(--vscode-descriptionForeground); max-width: 88ch; }
`;
