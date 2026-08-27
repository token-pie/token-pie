/**
 * How far a number on the panel can be trusted, and how that travels.
 *
 * Token Pie reports three different kinds of number and they must not look
 * alike. A credit total read straight out of telemetry is a fact. An upper
 * bound on a saving is a fact about a limit, not about what would happen. A
 * figure that depends on an inferred conversion or an inferred ordering is
 * neither -- it can be wrong in a direction nobody knows.
 *
 * Presenting all three in the same typeface is how a tool loses the reader's
 * trust the first time one of them turns out to be wrong: having never
 * distinguished them, it cannot say which one.
 *
 * The order is a ranking of doubt, which is what makes `weakest` well defined
 * and lets sorting put solid findings first. See `DECISIONS.md#confidence`.
 */

export const CONFIDENCE_ORDER = ['measured', 'bounded', 'estimated'] as const;

export type Confidence = (typeof CONFIDENCE_ORDER)[number];

/**
 * A value carrying its own provenance.
 *
 * The alternative -- deciding at render time which sections deserve a caveat --
 * was rejected because it is wrong the moment a section moves or gains a new
 * input. Provenance is a property of how a number was computed, so it is
 * attached where it is computed.
 */
export interface Measured<T> {
	value: T;
	confidence: Confidence;
	/**
	 * Why this is not a measurement, in the reader's terms.
	 *
	 * Required for anything weaker than `measured`, and deliberately specific:
	 * "22% of spend has no conversation id" tells the reader what to discount.
	 * A generic disclaimer teaches them to stop reading badges at all, which
	 * disarms the ones that matter.
	 */
	why?: string;
}

/** Position in the ranking of doubt. Lower is more trustworthy. */
export function rank(c: Confidence): number {
	return CONFIDENCE_ORDER.indexOf(c);
}

/**
 * The confidence of something derived from several inputs.
 *
 * Doubt only accumulates: a total built from an estimated conversion is
 * estimated even if every token count feeding it was measured exactly. This is
 * the rule that keeps a badge from being forgotten downstream -- callers
 * combine rather than choose.
 */
export function weakest(...inputs: Confidence[]): Confidence {
	let worst: Confidence = 'measured';
	for (const c of inputs) {
		if (rank(c) > rank(worst)) {
			worst = c;
		}
	}
	return worst;
}

export function measured<T>(value: T): Measured<T> {
	return { value, confidence: 'measured' };
}

export function bounded<T>(value: T, why: string): Measured<T> {
	return { value, confidence: 'bounded', why };
}

export function estimated<T>(value: T, why: string): Measured<T> {
	return { value, confidence: 'estimated', why };
}

/**
 * The mark that precedes a figure.
 *
 * A glyph rather than a word: these sit inside a chip beside a number, and
 * repeating "estimated" in every chip on the page is noise that stops being
 * read. Section-level labelling uses the word; the `why` text rides along as a
 * tooltip so the glyph is never the whole explanation.
 */
export function prefix(c: Confidence): string {
	switch (c) {
		case 'bounded':
			return '≤ ';
		case 'estimated':
			return '~ ';
		default:
			return '';
	}
}
