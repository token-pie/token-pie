/**
 * Every threshold in one place, with its provenance.
 *
 * The gates were spread across five modules as private `const MIN_*`, each with
 * a comment explaining what it gated and, for about half of them, nothing
 * explaining why that value. From outside the source there was no way to see
 * them at all -- so "why is the panel not telling me anything?" had no answer
 * short of reading the code.
 *
 * Two things follow from collecting them here. Every one becomes a setting
 * without hand-writing a `package.json` entry per knob, and Token Specs
 * can show the whole ladder with the current reading beside each rung, which is
 * what turns a silent panel into a legible one.
 *
 * Deliberately free of `vscode`, like `entitlement.ts`: it takes a getter and
 * returns plain values, so the whole ladder is testable without an editor.
 */

/** What kind of question a knob answers. Groups the console, not the logic. */
export type KnobKind =
	/** Is there enough data to say anything at all? */
	| 'evidence'
	/** The claim is true -- is it big enough to be worth the reader's time? */
	| 'materiality'
	/** Are these two figures the same figure? */
	| 'tolerance'
	/** Which of several true descriptions to use. */
	| 'wording'
	/** How much history to hold and how far back to look. */
	| 'window';

export interface Knob {
	/** Path into `Tuning`, and the legacy setting name. */
	id: string;
	/**
	 * The name this is offered under, when it is offered at all.
	 *
	 * Seventeen thresholds in the settings UI was seventeen invitations to
	 * change something whose consequences only the source explains. A knob is
	 * only a setting when a developer could reasonably want it different *and*
	 * the tool stays honest either way. The rest are rules: still shown in the
	 * console with their reasoning, no longer dressed up as choices.
	 */
	setting?: string;
	kind: KnobKind;
	default: number;
	min?: number;
	max?: number;
	/** Rendered after the value in the console. */
	unit: 'credits' | 'requests' | 'days' | 'share' | 'ratio' | 'r2';
	/** What is withheld, or what changes, when this is not met. */
	gates: string;
	/**
	 * Why this number and not another.
	 *
	 * `derived` means it follows from something -- a count of coefficients, the
	 * precision of a field. `judged` means it was chosen, and could reasonably
	 * be chosen differently. The distinction is the honest part: a reader
	 * deciding whether to override wants to know which they are arguing with.
	 */
	basis: 'derived' | 'judged';
	why: string;
}

export const KNOBS: Knob[] = [
	{
		id: 'pricing.minObservations',
		kind: 'evidence', default: 6, min: 4, unit: 'requests',
		gates: 'A model shows no solved rate card, so no per-token prices and no cost split.',
		basis: 'derived',
		why: 'Three coefficients need more than three observations. Six leaves three ' +
			'degrees of freedom, which is the fewest that lets the R\u00b2 check below fail.'
	},
	{
		id: 'pricing.minR2',
		kind: 'evidence', default: 0.999, min: 0, max: 1, unit: 'r2',
		gates: 'A rate card that fits worse than this is discarded rather than shown.',
		basis: 'judged',
		why: 'Cost is an exact rate card, not a trend, so a correct fit lands on ' +
			'1.000000. Anything materially below means the model is wrong \u2014 a tier ' +
			'change mid-window, or a token class we do not know about. Note this ' +
			'guard has never been near-missed, so it is unfalsified rather than ' +
			'proven: it admits fits a thousand times worse than any observed.'
	},
	{
		id: 'advice.minHistoryRequests',
		kind: 'evidence', default: 10, min: 1, unit: 'requests',
		gates: 'All recommendations are withheld below this much total history.',
		basis: 'judged',
		why: 'Five requests can be one session that went badly. Ten is where the depth ' +
			'buckets start to fill, so "how you work" is visible rather than inferred ' +
			'from a single conversation.'
	},
	{
		id: 'advice.minBaselineRequests',
		kind: 'evidence', default: 2, min: 2, unit: 'requests',
		gates: 'A model with fewer cache-hit requests gets no cache-miss finding.',
		basis: 'derived',
		why: 'A rate needs more than one observation to be a rate.'
	},
	{
		id: 'report.minBucketRequests',
		kind: 'evidence', default: 3, min: 2, unit: 'requests',
		gates: 'A depth bucket below this is left out of the thread-depth ratio.',
		basis: 'judged',
		why: 'A "3.6x" headline was once stated from two observations against two. ' +
			'This asks whether there is enough to compute a rate, not whether it matters.'
	},
	{
		id: 'report.minPricedShare',
		kind: 'evidence', default: 0.5, min: 0, max: 1, unit: 'share',
		gates: 'Below this share of spend priced, the composition falls back to token counts.',
		basis: 'judged',
		why: 'A cost split covering a minority of the bill would look like the whole of it.'
	},
	{
		id: 'projection.minDaysForRate',
		kind: 'evidence', default: 1, min: 0.5, unit: 'days',
		gates: 'No burn rate, so no throttle projection \u2014 the verdict reads "no-rate".',
		basis: 'judged',
		why: 'This was 0.5, which is exactly the one-heavy-afternoon case it exists to ' +
			'exclude; a test projecting a throttle from a single burst caught it.'
	},
	{
		id: 'advice.minCreditsAtStake',
		setting: 'minCreditsWorthMentioning',
		kind: 'materiality', default: 0.5, min: 0, unit: 'credits',
		gates: 'Nothing worth less than this many credits is reported, however it scores '
			+ 'on the rules below.',
		basis: 'judged',
		why: 'The one materiality question only you can answer: what is too small to be '
			+ 'worth your attention. Raise it to be told less, lower it to be told more.'
	},
	{
		id: 'advice.minShareAtStake',
		kind: 'materiality', default: 0.05, min: 0, max: 1, unit: 'share',
		gates: 'A finding below this share of observed spend is not shown as a pattern.',
		basis: 'judged',
		why: 'Asks whether this is a real slice of how the person works, independently ' +
			'of whether it threatens the allowance.'
	},
	{
		id: 'advice.minShareOfAllowance',
		kind: 'materiality', default: 0.01, min: 0, max: 1, unit: 'share',
		gates: 'A finding this large against the remaining allowance is shown as urgent, ' +
			'whatever its share of spend.',
		basis: 'judged',
		why: 'The urgent path exists because a finding can be small against history and ' +
			'still decide whether the allowance survives the period.'
	},
	{
		id: 'advice.minCacheFactor',
		kind: 'materiality', default: 1.5, min: 1, unit: 'ratio',
		gates: 'A cache-miss finding is withheld unless misses cost this multiple of hits.',
		basis: 'judged',
		why: 'Below this the multiple is ordinary variance rather than a finding.'
	},
	{
		id: 'advice.autoDominantShare',
		kind: 'wording', default: 0.5, min: 0, max: 1, unit: 'share',
		gates: 'Above this share, advice says Auto chose the model rather than you.',
		basis: 'judged',
		why: 'Telling someone to route away from a model Auto picked is advice about a ' +
			'decision they never made, so the wording has to follow who chose.'
	},
	{
		id: 'report.cacheWriteDominant',
		kind: 'wording', default: 0.9, min: 0.5, max: 1, unit: 'share',
		gates: 'Above this, fresh input is labelled "and cached for next time" and the ' +
			'surcharge is explained; below 1 minus this, "charged in full".',
		basis: 'judged',
		why: 'Between the two the population is genuinely mixed and neither wording is ' +
			'true, so the label says neither.'
	},
	{
		id: 'projection.tightDaysMargin',
		setting: 'warnAtDaysLeft',
		kind: 'wording', default: 2, min: 0, unit: 'days',
		gates: 'Warn when the allowance has fewer than this many days of slack left.',
		basis: 'judged',
		why: 'How much warning you want is a decision about your own week, not something '
			+ 'the data can settle. One heavy day changes the answer at two.'
	},
	{
		id: 'reconcile.roundingSlack',
		kind: 'tolerance', default: 0.1, min: 0, unit: 'credits',
		gates: 'Absolute slack before two credit figures are called different.',
		basis: 'derived',
		why: 'quota_remaining arrives rounded to one decimal, so a delta of two ' +
			'readings can be off by 0.1 through rounding alone.'
	},
	{
		id: 'reconcile.relativeTolerance',
		kind: 'tolerance', default: 0.05, min: 0, max: 1, unit: 'share',
		gates: 'Proportional slack added to the absolute one above.',
		basis: 'judged',
		why: 'Rounding alone does not scale with the window; this absorbs the drift that does.'
	},
	{
		id: 'history.days',
		setting: 'historyDays',
		kind: 'window', default: 30, min: 1, max: 365, unit: 'days',
		gates: 'How far back transcripts are read, and how long rollups are kept.',
		basis: 'judged',
		why: 'One monthly billing period plus slack. Longer costs a slower first scan.'
	}
];

/** Resolved values, addressed the way the code reads them. */
export interface Tuning {
	pricing: { minObservations: number; minR2: number };
	advice: {
		minHistoryRequests: number; minBaselineRequests: number;
		minCreditsAtStake: number; minShareAtStake: number;
		minShareOfAllowance: number; minCacheFactor: number; autoDominantShare: number;
	};
	report: { minBucketRequests: number; minPricedShare: number; cacheWriteDominant: number };
	projection: { minDaysForRate: number; tightDaysMargin: number };
	reconcile: { roundingSlack: number; relativeTolerance: number };
	history: { days: number };
}

/**
 * Where a value came from, so the console can say so rather than showing a
 * number with no story. A knob nobody has touched should look untouched.
 */
export interface KnobReading {
	knob: Knob;
	/** What is actually in effect. */
	value: number;
	/** Whether the value in effect differs from the shipped default. */
	overridden: boolean;
	/**
	 * What settings.json held, when that is not what is in effect.
	 *
	 * A knob silently clamped is worse than one that refuses: the developer
	 * reads their own setting back from the file and believes it. The console
	 * shows both figures so "I set 0.99 and nothing changed" has an answer.
	 */
	requested?: number;
}

function put(target: Record<string, Record<string, number>>, id: string, value: number): void {
	const [group, name] = id.split('.');
	target[group] = target[group] ?? {};
	target[group][name] = value;
}

export function defaults(): Tuning {
	const out: Record<string, Record<string, number>> = {};
	for (const k of KNOBS) {
		put(out, k.id, k.default);
	}
	return out as unknown as Tuning;
}

/**
 * Reads the ladder through a getter, clamping to each knob's declared range.
 *
 * Clamped rather than rejected: a setting typed by hand into settings.json is
 * not validated by anything before it reaches here, and a negative minimum
 * request count would silently disable a gate rather than loosen it.
 */
export function read(get: (id: string) => unknown): { tuning: Tuning; readings: KnobReading[] } {
	const out: Record<string, Record<string, number>> = {};
	const readings: KnobReading[] = [];
	for (const knob of KNOBS) {
		// The plain name first, then the dotted one. A rule that is no longer a
		// setting still answers to its old id, so a developer who tuned one
		// before is not silently reset -- it just stops being advertised.
		const named = knob.setting !== undefined ? get(knob.setting) : undefined;
		const raw = named !== undefined ? named : get(knob.id);
		const supplied = typeof raw === 'number' && Number.isFinite(raw);
		let value = supplied ? raw : knob.default;
		if (knob.min !== undefined) {
			value = Math.max(knob.min, value);
		}
		if (knob.max !== undefined) {
			value = Math.min(knob.max, value);
		}
		put(out, knob.id, value);
		readings.push({
			knob,
			value,
			overridden: value !== knob.default,
			...(supplied && raw !== value ? { requested: raw } : {})
		});
	}
	return { tuning: out as unknown as Tuning, readings };
}

/** Knobs offered as settings. The rest are rules the console explains. */
export function settings(): Knob[] {
	return KNOBS.filter(k => k.setting !== undefined);
}

/** Knobs that are fixed: shown, reasoned about, not offered. */
export function rules(): Knob[] {
	return KNOBS.filter(k => k.setting === undefined);
}

/**
 * Every setting name this module has ever owned, offered or not.
 *
 * The sync script needs it to *remove* entries, not only add them: a knob
 * demoted to a rule leaves its old setting behind in package.json otherwise,
 * still listed in the settings UI and no longer connected to anything.
 */
export function ownedSettingNames(): string[] {
	return KNOBS.flatMap(k => [`tokenPie.${k.id}`,
		...(k.setting ? [`tokenPie.${k.setting}`] : [])]);
}

/** The `contributes.configuration` block, so the two cannot drift. */
export function contributions(): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	for (const k of settings()) {
		props[`tokenPie.${k.setting}`] = {
			type: 'number',
			default: k.default,
			...(k.min !== undefined ? { minimum: k.min } : {}),
			...(k.max !== undefined ? { maximum: k.max } : {}),
			markdownDescription: `${k.gates} _${k.why}_`
		};
	}
	return props;
}
