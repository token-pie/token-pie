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
	creditsPerDollar: number;
	models: PublishedPrice[];
}

/** Where the card in use came from, so the console never shows a bare table. */
export type CardOrigin = 'bundled' | 'fetched' | 'user';

export interface LoadedCard {
	card: RateCard;
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
	return {
		source: o.source,
		retrieved: o.retrieved,
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

export function compare(
	card: RateCard,
	model: string,
	solved: { fresh: number; cached: number; output: number }
): RateComparison {
	const published = lookup(card, model);
	const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * PRICE_TOLERANCE;

	/**
	 * Fresh input is checked against every published class, not only against
	 * `input`. It is the one whose meaning is not fixed: on a model that writes
	 * to cache it carries the cache-write price, and reporting "expected 0.20,
	 * measured 0.25" as a discrepancy would be reporting a correct measurement
	 * as an error.
	 */
	const options: [string, number | undefined][] = published
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
	card: RateCard;
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
			return { card, origin: 'user' };
		}
	}

	const bundled = readCard(options.bundledPath);

	if (options.cachePath) {
		try {
			const raw = JSON.parse(fs.readFileSync(options.cachePath, 'utf8')) as CacheFile;
			const card = parse(raw?.card);
			if (card && typeof raw.fetchedAt === 'number') {
				// A fetched copy older than the bundled one is a downgrade: it
				// means the extension was updated more recently than the fetch.
				const newer = Date.parse(card.retrieved) >= Date.parse(bundled?.retrieved ?? '1970-01-01');
				if (newer) {
					return {
						card, origin: 'fetched', fetchedAt: raw.fetchedAt,
						...(now - raw.fetchedAt > REFRESH_INTERVAL_MS
							? { note: 'due for refresh' } : {})
					};
				}
			}
		} catch {
			// A corrupt cache is not worth reporting; the bundled copy is correct.
		}
	}

	if (!bundled) {
		throw new Error(`rate card missing or malformed: ${options.bundledPath}`);
	}
	return { card: bundled, origin: 'bundled' };
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
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, url, card }), 'utf8');
		return { ok: true, note: `${card.models.length} models, published ${card.retrieved}` };
	} catch (err) {
		return { ok: false, note: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
	}
}
