/**
 * What you can pick, and what each one costs.
 *
 * Every other surface here is built from rollups, so a model you have not used
 * yet appears nowhere. That is the wrong shape for the decision this answers,
 * which is made *before* spending: an enterprise account ran dry fifteen days
 * before its reset, and when it came back the frontier models were gone. "Where
 * did my credits go" was no longer the question.
 *
 * A join across four sources, each of which knows something the others cannot:
 *
 *   - the LM API knows which models this account may actually pick, and is the
 *     only thing that does. A model vanishing from that list is news.
 *   - the rate card knows the published price, per variant, with a date.
 *   - the rollups know what you spent, per model, which the card cannot say.
 *   - the price gate knows when a measurement is too thin to report.
 *
 * Where they disagree the row says which source it came from. Nothing here
 * blends input against output into one number: the ratio that would need is a
 * property of your prompts, not of the models, and inventing one would put a
 * made-up figure in the column a decision is read from.
 *
 * See docs/models-view.spec.md for the invariants this is written to.
 */

import { RateCard, lookup } from './ratecard';
import { isAutoModelId } from './selection';
import { Rollup, groupBy, sum } from './store';
import { PriceStats } from './pricing';
import { escapeHtml, fmtCreditsWith, fmtInt, creditsOf } from './report';

/** A model the editor says this account can pick. */
export interface AvailableModel {
	id: string;
	name: string;
	family?: string;
	maxInputTokens?: number;
}

/** Credits per 1M tokens, the unit the whole view is stated in. */
export interface Rates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite?: number;
}

export interface ModelRow {
	name: string;
	id?: string;
	variant: 'default' | 'long';
	rates?: Rates;
	/** Your own credits per message, once enough messages have been billed. */
	measured?: number;
	/** Why `measured` is absent, stated rather than left blank. */
	shortfall?: string;
	context?: number;
	/**
	 * What the vendor says the model is for, one line, from the card.
	 *
	 * Default rows only: a long context variant is the same model at a different
	 * rate, and repeating its description under a second heading says there are
	 * two models.
	 */
	note?: string;
	/**
	 * `offered` is pickable now. `gone` is in your history and no longer on
	 * offer, which is the state that cost someone a fortnight. `unpriced` is
	 * offered but absent from the card, usually a release the card has not
	 * caught up with. `published` is the card's own list, shown when the editor
	 * never told us what this account can pick -- it claims nothing about
	 * availability, which is the point. `routed` is Auto, which the editor
	 * offers alongside the models but which is a picker, not one of them.
	 */
	state: 'offered' | 'gone' | 'unpriced' | 'published' | 'routed';
	cheapestInput?: boolean;
	cheapestOutput?: boolean;
}

export interface ModelsView {
	rows: ModelRow[];
	/** Set when the list is the card's rather than the account's. */
	banner?: string;
	/** Priced models this account is not offered, counted rather than listed. */
	notOffered: number;
	/** Set when the card predates the period it is advising on. */
	stale?: string;
}

export interface ModelsInput {
	/**
	 * What the editor offers. `undefined` means it was never asked or refused
	 * to say, which is a different state from "offers nothing" and reads
	 * differently: the card's list, under a banner disclaiming it.
	 */
	available?: AvailableModel[];
	card: RateCard;
	rollups: Rollup[];
	prices: Record<string, PriceStats>;
	creditsPerNanoAiu: number;
	minObservations: number;
	/** Start of the current billing period, to date the card against. */
	periodStart?: number;
	/** Injected so the staleness rule is testable without waiting a month. */
	now?: number;
}

/**
 * When an unrefreshed card is worth mentioning.
 *
 * Four times the weekly refresh: one missed fetch is a network blip, a month
 * of them is a setting that is off or a host that cannot be reached.
 */
const STALE_AFTER_MS = 28 * 24 * 60 * 60 * 1000;

/** How many rows stand before the rest fold away. */
const VISIBLE_ROWS = 10;

/** Card figures are credits per 1k; the page states everything per 1M. */
function ratesFor(card: RateCard, id: string, variant: 'default' | 'long'): Rates | undefined {
	const p = lookup(card, id, variant);
	if (!p) {
		return undefined;
	}
	// A model with no long variant falls back to its default row, which would
	// print the same numbers twice under two headings. Only a genuinely
	// different price is a second row.
	return {
		input: p.input * 1000,
		output: p.output * 1000,
		cacheRead: p.cached * 1000,
		...(p.cacheWrite !== undefined ? { cacheWrite: p.cacheWrite * 1000 } : {})
	};
}

/** The card's one-line description, when it carries one for this model. */
function noteFor(card: RateCard, id: string): string | undefined {
	return lookup(card, id, 'default')?.note;
}

function same(a: Rates | undefined, b: Rates | undefined): boolean {
	return a !== undefined && b !== undefined
		&& a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead;
}

export function modelsView(input: ModelsInput): ModelsView {
	const { card, rollups, prices, creditsPerNanoAiu, minObservations } = input;
	const byModel = groupBy(rollups, 'model');
	const rows: ModelRow[] = [];

	const listed = input.available ?? [];
	const offeredKeys = new Set(listed.map(m => m.id.toLowerCase()));

	const measureOf = (id: string): { measured?: number; shortfall?: string } => {
		const stats = prices[id];
		const n = stats?.n ?? 0;
		const totals = byModel.get(id);
		if (n < minObservations || !totals) {
			// Still the count rather than a blank, but said the way a reader
			// would say it. "needs 6, has 0" was the gate talking about itself
			// in a column headed by what it was withholding.
			return {
				shortfall: n === 0
					? 'not yet billed'
					: `${fmtInt(n)} of ${minObservations} billed`
			};
		}
		const t = sum([totals].flat() as Rollup[]);
		return t.requests > 0
			? { measured: creditsOf(t.nanoAiu, creditsPerNanoAiu) / t.requests }
			: { shortfall: 'not yet billed' };
	};

	// The editor said nothing, so the card's own list stands in. Every row is
	// marked `published` rather than `offered`: this says what GitHub charges,
	// not what you may pick, and the two are exactly what came apart when the
	// frontier models went.
	if (input.available === undefined) {
		for (const name of new Set(card.models.map(m => m.name))) {
			const def = ratesFor(card, name, 'default');
			const long = ratesFor(card, name, 'long');
			rows.push({
				name, variant: 'default', rates: def,
				note: noteFor(card, name), state: 'published'
			});
			if (long && !same(long, def)) {
				rows.push({ name, variant: 'long', rates: long, state: 'published' });
			}
		}
	}

	for (const m of listed) {
		// Auto is on the list of things you can pick, so it belongs here, but it
		// is not a model and has no price of its own: it chooses one per message
		// and you are billed at that model's rate. It used to be tagged "not
		// published", which says the card is behind and will never come true.
		if (isAutoModelId(m.id)) {
			rows.push({
				name: m.name, id: m.id, variant: 'default', state: 'routed',
				note: 'Picks a model for each message. You are billed at the rate of '
					+ 'whichever one it picks, so its cost is that model\'s cost.'
			});
			continue;
		}
		const def = ratesFor(card, m.id, 'default');
		const long = ratesFor(card, m.id, 'long');
		const { measured, shortfall } = measureOf(m.id);
		rows.push({
			name: m.name, id: m.id, variant: 'default', rates: def,
			measured, shortfall, context: m.maxInputTokens,
			note: noteFor(card, m.id),
			state: def ? 'offered' : 'unpriced'
		});
		if (long && !same(long, def)) {
			rows.push({
				name: m.name, id: m.id, variant: 'long', rates: long,
				context: m.maxInputTokens, state: 'offered'
			});
		}
	}

	// Used, and no longer on offer. Listed rather than dropped: a model
	// disappearing from an account is the single most expensive thing that can
	// happen to a plan, and silence about it is how it goes unnoticed.
	if (input.available !== undefined) {
		for (const id of byModel.keys()) {
			if (offeredKeys.has(id.toLowerCase())) {
				continue;
			}
			const { measured, shortfall } = measureOf(id);
			rows.push({
				name: id, id, variant: 'default', rates: ratesFor(card, id, 'default'),
				measured, shortfall, note: noteFor(card, id), state: 'gone'
			});
		}
	}

	// Cheapest is marked per column, because input and output are read
	// separately and a model can be cheapest on one and dearest on the other.
	const live = rows.filter(r =>
		(r.state === 'offered' || r.state === 'published') && r.variant === 'default' && r.rates);
	for (const key of ['input', 'output'] as const) {
		const best = Math.min(...live.map(r => r.rates![key]));
		for (const r of live) {
			if (r.rates![key] === best) {
				if (key === 'input') { r.cheapestInput = true; } else { r.cheapestOutput = true; }
			}
		}
	}

	// Priced but not on offer. Counted, not listed: the card carries every
	// model GitHub publishes and most of them are irrelevant to this account.
	const offeredNames = new Set(rows.map(r => r.name.toLowerCase()));
	const notOffered = input.available === undefined ? 0
		: new Set(card.models
			.filter(m => !offeredNames.has(m.name.toLowerCase()))
			.map(m => m.name)).size;

	// Prices almost always predate the period they apply to, so flagging that
	// put a warning on every render. What is worth saying is that the card
	// itself has not been read in a long time, which is a fetch that is not
	// happening rather than a price that is old.
	const read = Date.parse(card.retrieved ?? '');
	const age = Number.isFinite(read) ? (input.now ?? Date.now()) - read : 0;
	const stale = age > STALE_AFTER_MS
		? `These prices were last read ${Math.round(age / 86_400_000)} days ago. `
		  + 'Run Token Pie: Refresh Published Prices if they look wrong.'
		: undefined;

	return {
		rows: sortRows(rows),
		banner: input.available === undefined
			? 'This is the published price list, not your account\'s. '
			  + 'Open the report with Copilot signed in to see which of these you can pick.'
			: undefined,
		notOffered,
		stale
	};
}

/**
 * Cheapest first, which is the order the decision is made in.
 *
 * Unpriced rows sink rather than sorting as zero -- a model with no published
 * price is not free, and putting it at the top would say so.
 */
function sortRows(rows: ModelRow[]): ModelRow[] {
	const rank = (r: ModelRow) => r.state === 'gone' ? 2 : r.rates ? 0 : 1;
	// Ties on price fall back to name, so the order is stable between renders
	// rather than depending on the order the editor happened to list them in.
	return [...rows].sort((a, b) =>
		rank(a) - rank(b)
		|| (a.rates?.input ?? Infinity) - (b.rates?.input ?? Infinity)
		|| (a.rates?.output ?? Infinity) - (b.rates?.output ?? Infinity)
		|| a.name.localeCompare(b.name)
		|| a.variant.localeCompare(b.variant));
}

/* ------------------------------------------------------------- rendering --- */

const num = (n: number) => n >= 100 ? fmtInt(n) : String(Math.round(n * 10) / 10);

function cell(r: ModelRow, key: keyof Rates, cheapest?: boolean): string {
	const v = r.rates?.[key];
	if (v === undefined) {
		return '<td class="num dim">&mdash;</td>';
	}
	return `<td class="num${cheapest ? ' best' : ''}">${num(v)}</td>`;
}

export function renderModels(view: ModelsView): string {
	if (view.rows.length === 0) {
		return '';
	}
	const row = (r: ModelRow) => {
		// The state belongs beside the name, where a reader looks to identify
		// the row. It used to take the four money columns as one colspan
		// sentence, which broke the column geometry for that row and left the
		// figures nowhere: a row missing prices still has four price columns,
		// and what belongs in them is a dash.
		const tag = r.state === 'gone' ? '<span class="tag gone">not offered</span>'
			: r.state === 'routed' ? '<span class="tag routed">picks for you</span>'
			: r.state === 'unpriced' ? '<span class="tag unpriced">not published</span>'
			: r.variant === 'long' ? '<span class="tag">long context</span>'
			: '';
		// The unit travels with the figure: a bare 2.37 in a column headed
		// "your cost/message" could be credits, dollars or messages. A long
		// context variant is the same model billed at a different rate, so
		// there is no separate measurement for it -- a dash, like any other
		// column with nothing to say.
		const yours = r.measured !== undefined
			? `<td class="num">${fmtCreditsWith(r.measured)}</td>`
			: r.shortfall
				? `<td class="num dim gate">${escapeHtml(r.shortfall)}</td>`
				: '<td class="num dim">&mdash;</td>';
		const money = cell(r, 'input', r.cheapestInput) + cell(r, 'output', r.cheapestOutput)
			+ cell(r, 'cacheRead') + cell(r, 'cacheWrite');
		// A question mark opens it, and only the question mark: the name beside
		// it stays ordinary selectable text, because a Foundry-prefixed id is
		// fifty characters and copying it is the other thing anyone does here.
		//
		// The body opens in the row rather than over it. Every other explanation
		// on this page floats, but this table sits in a div that scrolls
		// sideways, and overflow-x on a box makes overflow-y a scroll container
		// too -- an absolutely positioned panel inside one is cut off at the
		// cell's edge. The marker is a real details; the body is a block child of
		// an inline box, so it breaks out to the full width of the cell.
		const name = `${escapeHtml(r.name)}${tag}`;
		const model = r.note
			? `<td class="model">${name}<details class="about">` +
				`<summary title="What this model is for">?</summary>` +
				`<p class="about-body">${escapeHtml(r.note)}</p></details></td>`
			: `<td class="model">${name}</td>`;
		return `<tr class="${r.state}">${model}${money}${yours}</tr>`;
	};

	const cols = `<colgroup>
			<col class="c-model"><col class="c-num"><col class="c-num">
			<col class="c-num"><col class="c-num"><col class="c-gate">
		</colgroup>`;
	const head = `<thead><tr>
			<th>MODEL</th><th class="num">INPUT</th><th class="num">OUTPUT</th>
			<th class="num">CACHE READ</th><th class="num">CACHE WRITE</th>
			<th class="num">YOUR COST/MESSAGE</th>
		</tr></thead>`;
	// The folded table repeats the geometry but not the header: a second row of
	// column names inside the fold read as a second table, which is what it was.
	const table = (rows: ModelRow[], withHead: boolean) =>
		`<div class="tw"><table class="${withHead ? '' : 'fold'}">${cols}${withHead ? head : ''}` +
		`<tbody>${rows.map(row).join('')}</tbody></table></div>`;

	// Cheapest first, so the rows that fold away are the ones a decision
	// rarely reaches for. The same `details` the findings use, rather than a
	// second collapsing mechanism with its own arrow and its own bugs.
	const shown = view.rows.slice(0, VISIBLE_ROWS);
	const rest = view.rows.slice(VISIBLE_ROWS);

	return `<section class="models">
		<h2>What you can pick</h2>
		<p class="unit">Prices are <strong>credits per 1M tokens</strong>, from the
			published card. Your own figure is credits per message, measured from
			what you were billed.</p>
		${view.banner ? `<p class="note">${escapeHtml(view.banner)}</p>` : ''}
		${view.stale ? `<p class="note">${escapeHtml(view.stale)}</p>` : ''}
		${table(shown, true)}
		${rest.length > 0 ? `<details class="detail models-rest">
			<summary>${fmtInt(rest.length)} more</summary>
			<div class="detail-body">${table(rest, false)}</div>
		</details>` : ''}
		<p class="foot">${view.notOffered > 0
				? `${fmtInt(view.notOffered)} further model${view.notOffered === 1 ? '' : 's'}
				   are published but not offered to this account. `
				: ''}${view.rows.some(r => r.note)
				? `The question mark beside a model says what its vendor says it is
				   for. Those lines come from the price card and refresh with it.`
				: ''}</p>
	</section>`;
}

/**
 * The sidebar's reduction: the cheapest, and the one you actually spend on.
 *
 * No bar. Every other bar in this column means spend against a quota -- the
 * meter, the day, the week -- so drawing a price ratio in the same vocabulary
 * says a model is consuming something, which it is not until you send it
 * anything. A ratio between two published prices is a fact about a price
 * list, and the two figures state it without a graphic pretending to measure.
 *
 * One line per model: the name, its role, and the two rates set right so the
 * digits line up under each other and the comparison is a glance down a
 * column rather than an arithmetic exercise.
 */
export function compactModels(view: ModelsView, rollups: Rollup[],
	creditsPerNanoAiu: number): string {
	const priced = view.rows.filter(r =>
		(r.state === 'offered' || r.state === 'published')
		&& r.variant === 'default' && r.rates);
	if (priced.length === 0) {
		return '';
	}
	const cheapest = priced.find(r => r.cheapestInput) ?? priced[0];

	const byModel = groupBy(rollups, 'model');
	let heaviest: { name: string; credits: number } | undefined;
	for (const [id, rs] of byModel) {
		const credits = creditsOf(sum([rs].flat() as Rollup[]).nanoAiu, creditsPerNanoAiu);
		if (!heaviest || credits > heaviest.credits) {
			heaviest = { name: id, credits };
		}
	}
	const mine = heaviest && priced.find(r =>
		(r.id ?? r.name).toLowerCase() === heaviest!.name.toLowerCase());

	const rows: [ModelRow, string][] = [[cheapest, 'cheapest']];
	if (mine && mine !== cheapest) {
		rows.push([mine, 'you use most']);
	}

	// The role goes under the name rather than beside it: at 300px it competed
	// with the name for the same line and both had to be truncated. The rates
	// are centred against the two-line block, not baselined to its first line,
	// which would sit them high and read as belonging to the name alone.
	const line = ([r, role]: [ModelRow, string]) => `<div class="mrow">
		<div class="mid">
			<div class="mname">${escapeHtml(r.name)}</div>
			<div class="mrole ${role === 'cheapest' ? 'best' : 'yours'}">${
				escapeHtml(role)}</div>
		</div>
		<div class="mrate">${num(r.rates!.input)}<span class="msep">/</span>${
			num(r.rates!.output)}</div>
	</div>`;

	return `<div class="sec models">
		<div class="wk-head">Models</div>
		<div class="munit">in / out, credits per 1M tokens</div>
		${rows.map(line).join('')}
	</div>`;
}
