/**
 * GitHub's published prices, as data rather than as a claim in a comment.
 *
 * The solver recovers what each token class actually cost on this account, and
 * that is the figure the panel reports -- it is measured. But a measurement
 * with nothing to check it against is how "fresh input costs 0.25" went a
 * release and a half labelled as the input price when it is the cache-write
 * price. The published card is the second opinion.
 *
 * Prices are stored in USD per million tokens, verbatim from the source, so
 * every number here can be diffed against the docs page without arithmetic in
 * between. Conversion to credits happens on read.
 */

/** One published row. `cacheWrite` absent means the model does not bill for it. */
export interface PublishedPrice {
	name: string;
	vendor: string;
	/** GitHub lists a second, dearer row for long-context requests. */
	variant: 'default' | 'long';
	input: number;
	cachedInput: number;
	cacheWrite?: number;
	output: number;
}

export interface RateCard {
	source: string;
	/** ISO date the figures were read from the source. */
	retrieved: string;
	/**
	 * ISO date these prices took effect.
	 *
	 * Distinct from `retrieved`, and the distinction is the whole point: we
	 * usually learn about a price on some later Tuesday than the one it started
	 * applying on. Spend before this date was billed at whatever preceded it, so
	 * a newly fetched card must never be used to judge it. Absent in a source
	 * file, it falls back to `retrieved` -- the most conservative reading, since
	 * it claims the prices are no older than our knowledge of them.
	 */
	effective: string;
	creditsPerDollar: number;
	models: PublishedPrice[];
}

/** Where the card in use came from, so the console never shows a bare table. */
export type CardOrigin = 'bundled' | 'fetched' | 'user';

export interface LoadedCard {
	/** The card in force now. */
	card: RateCard;
	/** Every card known, oldest first, for dating a comparison. */
	cards: RateCard[];
	origin: CardOrigin;
	/** When the fetched copy was retrieved, for the staleness note. */
	fetchedAt?: number;
	/** Why a newer copy is not in use, when one was attempted. */
	note?: string;
}

/** Credits per 1,000 tokens, the unit the solver and the panel both speak. */
export interface PublishedRate {
	name: string;
	vendor: string;
	variant: 'default' | 'long';
	input: number;
	cached: number;
	/** Undefined when the model bills nothing for writing to cache. */
	cacheWrite?: number;
	output: number;
}

/**
 * Telemetry reports `gpt-5.6-luna`; the docs say "GPT-5.6 Luna (Default)".
 * Folding both to the same slug is the only join available -- there is no id
 * in the published table.
 */
export function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/\(.*?\)/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * Response models carry a training date the price table does not, so
 * `gpt-4o-mini-2024-07-18` has to fall back to `gpt-4o-mini` before giving up.
 */
function candidates(modelId: string): string[] {
	const base = slug(modelId);
	const out = [base];
	const undated = base.replace(/-\d{4}-\d{2}-\d{2}$/, '');
	if (undated !== base) {
		out.push(undated);
	}
	return out;
}

export function lookup(
	card: RateCard,
	modelId: string,
	variant: 'default' | 'long' = 'default'
): PublishedRate | undefined {
	const wanted = candidates(modelId);
	const row =
		card.models.find(m => m.variant === variant && wanted.includes(slug(m.name))) ??
		card.models.find(m => wanted.includes(slug(m.name)));
	if (!row) {
		return undefined;
	}
	// $/1M tokens -> credits/1k tokens: divide by 1000 for the unit, multiply by
	// credits per dollar. At 100 credits to the dollar that is x0.1.
	//
	// Rounded because the published figures are exact decimals and the product
	// is not: $0.20 per million lands on 0.020000000000000004, which would be
	// shown in the console beside a solved 0.0200 and read as a mismatch. Six
	// places is far below the finest published granularity ($0.025 per million).
	const f = card.creditsPerDollar / 1000;
	const per1k = (usdPerMillion: number) => Math.round(usdPerMillion * f * 1e6) / 1e6;
	return {
		name: row.name,
		vendor: row.vendor,
		variant: row.variant,
		input: per1k(row.input),
		cached: per1k(row.cachedInput),
		...(row.cacheWrite !== undefined ? { cacheWrite: per1k(row.cacheWrite) } : {}),
		output: per1k(row.output)
	};
}

/**
 * Strict, because the alternative is worse.
 *
 * This parses whatever a URL returned. A card that half-parses would price some
 * models and silently skip others, and the panel would show a comparison that
 * looks complete. A card that fails to parse falls back to the bundled copy,
 * which is a state the console can name.
 */
export function parse(raw: unknown): RateCard | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const o = raw as Record<string, unknown>;
	const models = o.models;
	if (
		typeof o.source !== 'string' ||
		typeof o.retrieved !== 'string' ||
		typeof o.creditsPerDollar !== 'number' ||
		!(o.creditsPerDollar > 0) ||
		!Array.isArray(models) ||
		models.length === 0
	) {
		return undefined;
	}

	const out: PublishedPrice[] = [];
	for (const m of models) {
		if (typeof m !== 'object' || m === null) {
			return undefined;
		}
		const r = m as Record<string, unknown>;
		const nums = ['input', 'cachedInput', 'output'] as const;
		if (
			typeof r.name !== 'string' || r.name.length === 0 ||
			typeof r.vendor !== 'string' ||
			(r.variant !== 'default' && r.variant !== 'long') ||
			nums.some(k => typeof r[k] !== 'number' || !Number.isFinite(r[k] as number) || (r[k] as number) < 0)
		) {
			return undefined;
		}
		if (r.cacheWrite !== undefined &&
			(typeof r.cacheWrite !== 'number' || !Number.isFinite(r.cacheWrite) || r.cacheWrite < 0)) {
			return undefined;
		}
		out.push({
			name: r.name,
			vendor: r.vendor,
			variant: r.variant,
			input: r.input as number,
			cachedInput: r.cachedInput as number,
			...(r.cacheWrite !== undefined ? { cacheWrite: r.cacheWrite as number } : {}),
			output: r.output as number
		});
	}
	const effective = typeof o.effective === 'string' && !Number.isNaN(Date.parse(o.effective))
		? o.effective
		: o.retrieved;
	if (Number.isNaN(Date.parse(effective))) {
		return undefined;
	}
	return {
		source: o.source,
		retrieved: o.retrieved,
		effective,
		creditsPerDollar: o.creditsPerDollar,
		models: out
	};
}

/**
 * How a solved rate compares to the published one, per class.
 *
 * The interesting column is `matches`, and the interesting *row* is the one
 * where it is false: that is either a miscalibrated conversion, a model priced
 * differently than the table says, or -- as with fresh input -- a class we are
 * measuring correctly and naming wrongly.
 */
export interface RateComparison {
	model: string;
	published?: PublishedRate;
	/** Which card the comparison used, and when it took effect. */
	appliedFrom?: string;
	/**
	 * Prices changed inside the window these rates were fitted over.
	 *
	 * Set means the comparison was withheld rather than made: the measurement
	 * spans two price regimes and matches neither by construction.
	 */
	spansPriceChange?: string[];
	/**
	 * The window opens before any card we hold.
	 *
	 * The comparison is still made -- the oldest card is the best statement
	 * available about those days, and withholding would leave the panel silent
	 * about most of its own history. But it is an assumption, not a record, and
	 * the page says so rather than presenting it as dated fact.
	 */
	predatesKnownPrices?: boolean;
	classes: {
		label: string;
		solved: number;
		published?: number;
		/** Which published class the solved figure actually matches, if any. */
		matchedAs?: string;
		ratio?: number;
	}[];
}

/** Within a tenth of a percent is the same price stated two ways. */
const PRICE_TOLERANCE = 0.001;

/* --------------------------------------------------------- history --- */

/**
 * Which card was in force at a moment.
 *
 * A fetched card replaces nothing: it is appended, and the older ones stay
 * because they are still the correct prices for the days they covered. Spend
 * from three weeks ago is judged against the card that was effective three
 * weeks ago, not against the one that arrived on Tuesday.
 */
export function effectiveAt(cards: RateCard[], at: number): RateCard | undefined {
	return cards
		.filter(c => Date.parse(c.effective) <= at)
		.sort((a, b) => Date.parse(b.effective) - Date.parse(a.effective))[0];
}

/**
 * Cards that took effect strictly inside a window.
 *
 * A non-empty answer means the solved rates are a blend of two price regimes
 * and no single published card is the right thing to compare them against.
 * Reporting a mismatch there would be blaming the measurement for a price
 * change, which is exactly the retrospective judgement to avoid.
 */
export function changedDuring(cards: RateCard[], from: number, to: number): RateCard[] {
	const sorted = [...cards].sort((a, b) => Date.parse(a.effective) - Date.parse(b.effective));
	// The earliest card is never a change. Nothing preceded it -- it is where the
	// record starts. Counting it withheld every comparison on a fresh install,
	// because the bundled card is dated later than the history it is being asked
	// about, which is the ordinary case rather than an exceptional one.
	return sorted.slice(1).filter(c => {
		const at = Date.parse(c.effective);
		return at > from && at <= to;
	});
}

/** The window a set of solved rates was fitted over. */
export interface Window {
	from: number;
	to: number;
}

export function compare(
	card: RateCard,
	model: string,
	solved: { fresh: number; cached: number; output: number },
	/**
	 * The days the solved rates were fitted over, and every card known.
	 *
	 * Omitted, the comparison is made against `card` as given -- which is right
	 * for a caller that has already chosen the card. Supplied, the card is
	 * chosen by date and a mid-window price change withholds the comparison
	 * instead of reporting the change as a measurement error.
	 */
	history?: { cards: RateCard[]; window: Window }
): RateComparison {
	let applied = card;
	let spans: string[] | undefined;
	let predates = false;
	if (history) {
		const changes = changedDuring(history.cards, history.window.from, history.window.to);
		if (changes.length > 0) {
			spans = changes.map(c => c.effective);
		}
		// The card in force when the window opened. Rates fitted over those days
		// were paid at those prices, whatever has been published since -- a newer
		// card never reaches backwards.
		const governing = effectiveAt(history.cards, history.window.from);
		if (governing) {
			applied = governing;
		} else {
			// Nothing we hold covers days that early. The oldest card is the best
			// statement available about them; using the newest instead would be
			// exactly the retrospective judgement this dating exists to prevent.
			const oldest = [...history.cards]
				.sort((a, b) => Date.parse(a.effective) - Date.parse(b.effective))[0];
			if (oldest) {
				applied = oldest;
				predates = true;
			}
		}
	}
	const published = lookup(applied, model);
	const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * PRICE_TOLERANCE;

	/**
	 * Fresh input is checked against every published class, not only against
	 * `input`. It is the one whose meaning is not fixed: on a model that writes
	 * to cache it carries the cache-write price, and reporting "expected 0.20,
	 * measured 0.25" as a discrepancy would be reporting a correct measurement
	 * as an error.
	 */
	const options: [string, number | undefined][] = published && !spans
		? [['input', published.input], ['cache write', published.cacheWrite],
		   ['cached input', published.cached], ['output', published.output]]
		: [];

	const row = (label: string, solvedValue: number, expected: number | undefined) => {
		const matched = options.find(([, v]) => v !== undefined && near(solvedValue, v));
		return {
			label,
			solved: solvedValue,
			published: expected,
			...(matched ? { matchedAs: matched[0] } : {}),
			...(expected !== undefined && expected > 0 ? { ratio: solvedValue / expected } : {})
		};
	};

	return {
		model,
		published,
		appliedFrom: applied.effective,
		...(spans ? { spansPriceChange: spans } : {}),
		...(predates ? { predatesKnownPrices: true } : {}),
		classes: [
			row('fresh input', solved.fresh, published?.input),
			row('cached input', solved.cached, published?.cached),
			row('output', solved.output, published?.output)
		]
	};
}

/* ---------------------------------------------------------- loading --- */

import * as fs from 'fs';
import * as path from 'path';

/** A week. The published table changes when models are added, not hourly. */
export const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on a fetched card, so a wrong URL cannot pull down something large. */
const MAX_CARD_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface CacheFile {
	fetchedAt: number;
	url: string;
	/**
	 * Every card we have seen, oldest first.
	 *
	 * A fetch appends rather than replaces. The card from six weeks ago is not
	 * stale data -- it is the correct price list for the days it covered, and
	 * discarding it would leave old spend to be judged against prices that did
	 * not exist yet.
	 */
	cards: RateCard[];
	/** Superseded single-card shape, still read so an existing cache survives. */
	card?: RateCard;
}

/**
 * The card in use, and why it is the one in use.
 *
 * Order is user override, then a cached fetch, then the bundled copy. The
 * bundled copy is never a failure state -- it is a dated snapshot of the
 * source, and shipping it means the comparison works offline and on first run.
 */
export function load(options: {
	bundledPath: string;
	cachePath?: string;
	/** `tokenPie.rateCard.models`, parsed the same way as a fetched card. */
	override?: unknown;
	now?: number;
}): LoadedCard {
	const now = options.now ?? Date.now();

	if (options.override !== undefined && options.override !== null) {
		const card = parse(options.override);
		if (card) {
			// An override is a deliberate statement about prices, so it stands
			// alone -- but only from its own effective date. Days before it are
			// still judged by whatever the history holds.
			return { card, cards: [card], origin: 'user' };
		}
	}

	const bundled = readCard(options.bundledPath);

	if (options.cachePath) {
		try {
			const raw = JSON.parse(fs.readFileSync(options.cachePath, 'utf8')) as CacheFile;
			const stored = (Array.isArray(raw?.cards) ? raw.cards : [raw?.card])
				.map(parse)
				.filter((c): c is RateCard => c !== undefined);
			if (stored.length > 0 && typeof raw.fetchedAt === 'number') {
				const cards = merge(bundled ? [bundled, ...stored] : stored);
				const current = effectiveAt(cards, now) ?? cards[cards.length - 1];
				// Origin describes the card in force, not the set it came from.
				// With history kept, a fetch can leave the bundled snapshot still
				// governing today -- an older fetched card cannot displace it,
				// because the latest effective date wins -- and calling that
				// "fetched" would misreport where today's prices came from.
				const fromBundle = bundled !== undefined && current.effective === bundled.effective
					&& current.retrieved === bundled.retrieved;
				return {
					card: current, cards,
					origin: fromBundle ? 'bundled' : 'fetched',
					...(fromBundle ? {} : { fetchedAt: raw.fetchedAt }),
					...(!fromBundle && now - raw.fetchedAt > REFRESH_INTERVAL_MS
						? { note: 'due for refresh' } : {})
				};
			}
		} catch {
			// A corrupt cache is not worth reporting; the bundled copy is correct.
		}
	}

	if (!bundled) {
		throw new Error(`rate card missing or malformed: ${options.bundledPath}`);
	}
	return { card: bundled, cards: [bundled], origin: 'bundled' };
}

/**
 * One card per effective date, oldest first.
 *
 * Two cards claiming the same effective date is the ordinary case -- a refetch
 * of unchanged prices -- and the later-retrieved one wins, since it is the same
 * statement made more recently.
 */
function merge(cards: RateCard[]): RateCard[] {
	const byDate = new Map<string, RateCard>();
	for (const c of cards) {
		const seen = byDate.get(c.effective);
		if (!seen || c.retrieved >= seen.retrieved) {
			byDate.set(c.effective, c);
		}
	}
	return [...byDate.values()].sort((a, b) => Date.parse(a.effective) - Date.parse(b.effective));
}

function readCard(file: string): RateCard | undefined {
	try {
		return parse(JSON.parse(fs.readFileSync(file, 'utf8')));
	} catch {
		return undefined;
	}
}

export function isDue(cachePath: string, now = Date.now()): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CacheFile;
		return typeof raw.fetchedAt !== 'number' || now - raw.fetchedAt > REFRESH_INTERVAL_MS;
	} catch {
		return true;
	}
}

/**
 * Pulls a newer card and caches it. Returns what happened, never throws.
 *
 * Nothing about the panel depends on this succeeding, so a refused fetch is
 * reported and forgotten rather than retried or surfaced as a warning. The URL
 * is a setting: an enterprise on negotiated pricing points it at their own
 * file, and the same code path serves both.
 */
export async function refresh(
	url: string,
	cachePath: string,
	now = Date.now()
): Promise<{ ok: boolean; note: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { accept: 'application/json' }
		});
		if (!res.ok) {
			return { ok: false, note: `${url} returned ${res.status}` };
		}
		const text = await res.text();
		if (text.length > MAX_CARD_BYTES) {
			return { ok: false, note: `response over ${MAX_CARD_BYTES} bytes; ignored` };
		}
		const card = parse(JSON.parse(text));
		if (!card) {
			// Deliberately not partial: half a card would price some models and
			// silently skip others while looking complete.
			return { ok: false, note: 'response was not a valid rate card; kept the previous one' };
		}
		// Appended, never substituted. Prices that have been superseded are still
		// the right prices for the days they covered.
		let existing: RateCard[] = [];
		try {
			const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CacheFile;
			existing = (Array.isArray(raw?.cards) ? raw.cards : [raw?.card])
				.map(parse)
				.filter((c): c is RateCard => c !== undefined);
		} catch {
			// No usable history yet; this card starts it.
		}
		const cards = merge([...existing, card]);
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, url, cards }), 'utf8');
		const added = cards.length > existing.length;
		return {
			ok: true,
			note: `${card.models.length} models, effective ${card.effective}` +
				(added ? `; ${cards.length} card(s) on record` : '; prices unchanged')
		};
	} catch (err) {
		return { ok: false, note: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
	}
}
