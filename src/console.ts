/**
 * Everything the panel decided, and why.
 *
 * The report answers "where did the credits go". This answers the question a
 * developer asks when the report will not tell them something: which gate is
 * withholding it, what value is that gate set to, and where did that value come
 * from. Before this the answer required reading the source.
 *
 * Three sections, in the order the doubt runs:
 *
 *   1. the conversion, which every credit figure on the panel rests on
 *   2. the rate card, measured against GitHub's published one
 *   3. the gate ladder, with the current reading beside each rung
 *
 * A gate is marked `binding` when the data is currently on the wrong side of
 * it. That is the section's whole purpose: "advice needs 10 messages, you have
 * 7" is an answer, and "no recommendations" is not.
 */

import { Rollup, Totals, sum, groupBy } from './store';
import { PriceStats, solve, Price } from './pricing';
import { KnobReading } from './tuning';
import { LoadedCard, compare, lookup, RateComparison } from './ratecard';
import { PeriodCoverage } from './reconcile';
import { escapeHtml, fmtInt, creditsOf } from './report';

export interface ConsoleInput {
	rollups: Rollup[];
	creditsPerNanoAiu: number;
	creditsPerNanoAiuIsDefault: boolean;
	prices: Record<string, PriceStats>;
	readings: KnobReading[];
	card: LoadedCard;
	coverage?: PeriodCoverage;
	/** Raw ingest counters, so the pipeline can be followed end to end. */
	pipeline: {
		databases: number;
		spansScanned: number;
		spansCounted: number;
		costSpans: number;
		recoveredMessages: number;
		errors: string[];
	};
	lastRefresh?: Date;
}

function num(n: number, places = 4): string {
	return Number.isFinite(n) ? n.toFixed(places) : '--';
}

/* --------------------------------------------------------- conversion --- */

/**
 * The one assumed constant, stated as one.
 *
 * Every credit figure on the panel is a token count -- exact -- multiplied by
 * this. It has a default that is almost certainly right, and nothing in the
 * product proves it. Saying so here is cheaper than implying certainty
 * everywhere else.
 */
function conversionSection(input: ConsoleInput): string {
	const c = input.coverage;
	const verdict = !c
		? { cls: 'unknown', text: 'Not checked yet. Run <strong>Token Pie: Check Quota</strong> ' +
			'to compare this against what GitHub billed over the same days.' }
		: c.verdict === 'complete'
		? { cls: 'ok', text: `Checked: GitHub billed ${num(c.githubCredits, 2)} credits this ` +
			`period and this machine measured ${num(c.localCredits, 2)} of them. The conversion holds.` }
		: c.verdict === 'over'
		? { cls: 'bad', text: `We measured ${num(c.localCredits, 2)} credits against GitHub's ` +
			`${num(c.githubCredits, 2)}. Measuring more than you were billed points here, not at ` +
			'other machines -- this conversion is likely wrong.' }
		: c.verdict === 'partial'
		? { cls: 'warn', text: `GitHub billed ${num(c.githubCredits, 2)} credits and this machine ` +
			`accounts for ${num(c.localCredits, 2)}. The gap is spend this install cannot see, so ` +
			'it does not by itself impugn the conversion.' }
		: { cls: 'unknown', text: escapeHtml(c.note) };

	return `
	<section>
		<h2>The conversion</h2>
		<p class="lede">Every credit figure in this extension is an exact token count multiplied
			by one number. The token counts are measured. This is not.</p>
		<table>
			<tr><th>Setting</th><th class="num">Value</th><th>Source</th></tr>
			<tr><td><code>tokenPie.creditsPerNanoAiu</code></td>
				<td class="num mono">${input.creditsPerNanoAiu.toExponential()}</td>
				<td>${input.creditsPerNanoAiuIsDefault
					? 'shipped default &mdash; assumed, never measured'
					: '<strong>set by you</strong>'}</td></tr>
		</table>
		<p class="verdict-line ${verdict.cls}">${verdict.text}</p>
	</section>`;
}

/* ---------------------------------------------------------- rate card --- */

/**
 * Solved beside published, per class.
 *
 * The row that matters is one where a solved figure matches a *different*
 * published class than its own name -- a correct measurement under a wrong
 * label, which is exactly what "fresh input" turned out to be.
 */
function rateCardSection(input: ConsoleInput): string {
	const { card, origin, fetchedAt, note } = input.card;
	const byModel = groupBy(input.rollups, 'model');

	const rows: string[] = [];
	for (const model of byModel.keys()) {
		const stats = input.prices[model];
		const price: Price | undefined = stats ? solve(stats, input.creditsPerNanoAiu) : undefined;
		const published = lookup(card, model);

		if (!price) {
			rows.push(`<tr class="dim"><td>${escapeHtml(model)}</td>
				<td colspan="4">no solved rate card${stats ? ` (${stats.n} billed messages)` : ''}
					&mdash; ${published ? `published as <em>${escapeHtml(published.name)}</em>`
						: 'and not in the published table'}</td></tr>`);
			continue;
		}
		const cmp: RateComparison = compare(card, model, price);
		rows.push(`<tr><td rowspan="${cmp.classes.length}">${escapeHtml(model)}
			<span class="dim">n=${price.n}, R&sup2;=${price.r2.toFixed(6)}</span></td>
			${classCells(cmp.classes[0])}</tr>` +
			cmp.classes.slice(1).map(c => `<tr>${classCells(c)}</tr>`).join(''));
	}

	const age = fetchedAt !== undefined
		? `fetched ${new Date(fetchedAt).toLocaleDateString()}`
		: `bundled with the extension`;

	return `
	<section>
		<h2>The rate card</h2>
		<p class="lede">What the solver recovered from your own spend, beside what GitHub
			publishes. A figure that matches a <em>different</em> class than its own name is a
			correct measurement under a wrong label &mdash; not an error in the fit.</p>
		<table>
			<tr><th>Model</th><th>Class</th><th class="num">Measured</th>
			    <th class="num">Published</th><th>Agreement</th></tr>
			${rows.join('') || '<tr><td colspan="5" class="dim">no models yet</td></tr>'}
		</table>
		<p class="note dim">Card in use: <strong>${origin}</strong>, ${age}, published
			${escapeHtml(card.retrieved)}, ${card.models.length} models${note ? ` &mdash; ${escapeHtml(note)}` : ''}.
			Source: <code>${escapeHtml(card.source)}</code></p>
	</section>`;
}

function classCells(c: RateComparison['classes'][number]): string {
	const agreement = c.published === undefined
		? '<span class="dim">nothing published</span>'
		: c.matchedAs === c.label
		? '<span class="ok">matches</span>'
		: c.matchedAs
		? `<span class="warn">matches <strong>${escapeHtml(c.matchedAs)}</strong> instead</span>`
		: `<span class="bad">matches no published class${
			c.ratio ? ` (${c.ratio.toFixed(2)}x expected)` : ''}</span>`;
	return `<td>${escapeHtml(c.label)}</td>
		<td class="num mono">${num(c.solved)}</td>
		<td class="num mono">${c.published !== undefined ? num(c.published) : '&mdash;'}</td>
		<td>${agreement}</td>`;
}

/* --------------------------------------------------------- the gates --- */

/**
 * Which rung the data is currently standing below.
 *
 * Computed from the same rollups the panel drew, so this cannot claim a gate
 * passed that the panel found failing.
 */
function bindingState(input: ConsoleInput): Map<string, string> {
	const out = new Map<string, string>();
	const totals: Totals = sum(input.rollups);
	const requests = totals.requests;
	const days = new Set(input.rollups.map(r => r.day)).size;

	const t = (id: string, current: number, need: number, unit: string) => {
		if (current < need) {
			out.set(id, `${fmtInt(current)} ${unit}, needs ${need}`);
		}
	};

	const knob = (id: string) => input.readings.find(r => r.knob.id === id)?.value ?? 0;
	t('advice.minHistoryRequests', requests, knob('advice.minHistoryRequests'), 'messages');
	t('projection.minDaysForRate', days, knob('projection.minDaysForRate'), 'days');

	// Priced share and per-model observation counts, the two that most often
	// withhold the cost split on a real machine.
	let priced = 0;
	let best = 0;
	for (const [model, mt] of groupBy(input.rollups, 'model')) {
		const stats = input.prices[model];
		best = Math.max(best, stats?.n ?? 0);
		if (stats && solve(stats, input.creditsPerNanoAiu)) {
			priced += creditsOf(mt.nanoAiu, input.creditsPerNanoAiu);
		}
	}
	t('pricing.minObservations', best, knob('pricing.minObservations'), 'messages on one model');

	const total = creditsOf(totals.nanoAiu, input.creditsPerNanoAiu);
	const share = total > 0 ? priced / total : 0;
	if (share < knob('report.minPricedShare')) {
		out.set('report.minPricedShare',
			`${(share * 100).toFixed(0)}% of spend priced, needs ${(knob('report.minPricedShare') * 100).toFixed(0)}%`);
	}
	return out;
}

function gatesSection(input: ConsoleInput): string {
	const binding = bindingState(input);
	const kinds: [string, string][] = [
		['evidence', 'Is there enough data to say anything?'],
		['materiality', 'The claim is true &mdash; is it worth saying?'],
		['tolerance', 'Are these two figures the same figure?'],
		['wording', 'Which of several true descriptions to use'],
		['window', 'How much history to hold']
	];

	const groups = kinds.map(([kind, heading]) => {
		const rows = input.readings.filter(r => r.knob.kind === kind).map(r => {
			const b = binding.get(r.knob.id);
			return `<tr class="${b ? 'binding' : ''}">
				<td><code>tokenPie.${escapeHtml(r.knob.id)}</code>
					${b ? `<span class="chip">withholding now &mdash; ${escapeHtml(b)}</span>` : ''}
					<div class="dim">${escapeHtml(r.knob.gates)}</div></td>
				<td class="num mono">${r.value}${r.requested !== undefined
					? `<div class="bad">you set ${r.requested}</div>` : ''}</td>
				<td class="num mono dim">${r.knob.default}</td>
				<td><span class="basis ${r.knob.basis}">${r.knob.basis}</span>
					<div class="dim why">${escapeHtml(r.knob.why)}</div></td></tr>`;
		});
		return rows.length === 0 ? '' : `
			<h3>${heading}</h3>
			<table>
				<tr><th>Gate</th><th class="num">In effect</th><th class="num">Default</th>
				    <th>Why this number</th></tr>
				${rows.join('')}
			</table>`;
	});

	const count = binding.size;
	return `
	<section>
		<h2>The gates</h2>
		<p class="lede">Every threshold the panel applies, what it is set to, and whether it
			is withholding something right now. <strong>Derived</strong> means the number
			follows from something; <strong>judged</strong> means it was chosen and could
			reasonably be chosen otherwise.</p>
		${count > 0
			? `<p class="verdict-line warn">${count} gate${count === 1 ? ' is' : 's are'}
				currently withholding output. They are marked below.</p>`
			: '<p class="verdict-line ok">No gate is currently withholding anything.</p>'}
		${groups.join('')}
	</section>`;
}

/* --------------------------------------------------------- pipeline --- */

function pipelineSection(input: ConsoleInput): string {
	const p = input.pipeline;
	const totals = sum(input.rollups);
	const step = (label: string, value: string, note: string) =>
		`<tr><td>${label}</td><td class="num mono">${value}</td><td class="dim">${note}</td></tr>`;

	return `
	<section>
		<h2>The pipeline</h2>
		<p class="lede">Every stage between the trace database and the figures on the panel,
			with what each one dropped.</p>
		<table>
			<tr><th>Stage</th><th class="num">Count</th><th>What it means</th></tr>
			${step('databases read', fmtInt(p.databases), 'one per VS Code channel and profile')}
			${step('spans scanned', fmtInt(p.spansScanned), 'rows examined in this pass')}
			${step('billable messages', fmtInt(p.spansCounted),
				'operation_name = chat; invoke_agent and execute_tool repeat the same tokens and are excluded')}
			${step('with a cost attribute', fmtInt(p.costSpans),
				'the rest are free models, which report no cost')}
			${step('recovered from transcripts', fmtInt(p.recoveredMessages),
				'history predating trace collection; a floor, since transcripts omit retries')}
			${step('rollup rows', fmtInt(input.rollups.length),
				'day x model x project x operation x selection x source')}
			${step('messages in the window', fmtInt(totals.requests), 'what the panel totals')}
			${step('tokens in the window',
				fmtInt(totals.inputTokens + totals.outputTokens), 'input plus output')}
			${step('of those, written to cache', fmtInt(totals.cacheWriteTokens),
				'billed above plain input on providers that charge for it')}
		</table>
		${p.errors.length > 0
			? `<div class="warn-box">${p.errors.map(e => `<div>${escapeHtml(e)}</div>`).join('')}</div>`
			: ''}
	</section>`;
}

/* ----------------------------------------------------------- render --- */

export function renderConsole(input: ConsoleInput): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${CONSOLE_STYLES}</style>
</head>
<body>
	<header>
		<h1>Token Pie &mdash; debug console</h1>
		<span class="sub"><i>${input.lastRefresh
			? `data as of ${escapeHtml(input.lastRefresh.toLocaleString())}`
			: 'never refreshed'}</i></span>
	</header>
	<p class="lede top">Nothing here is derived for display. These are the values the
		extension is running on, in the order the doubt runs: the one constant everything
		rests on, then the prices, then the gates that decide what you are shown.</p>
	${conversionSection(input)}
	${rateCardSection(input)}
	${gatesSection(input)}
	${pipelineSection(input)}
	<footer>
		Every gate above is a setting under <code>tokenPie.</code> &mdash; open Settings and
		search for it, or edit <code>settings.json</code>. Values outside a gate's range are
		clamped rather than obeyed; when that happens this page shows both figures.
	</footer>
</body>
</html>`;
}

const CONSOLE_STYLES = `
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 14px 20px 24px;
		line-height: 1.45;
		max-width: 1000px;
		margin: 0 auto;
	}
	header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
	h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
	h2 {
		font-size: 0.95rem; margin: 0 0 4px; font-weight: 600;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
	}
	h3 { font-size: 0.82rem; margin: 18px 0 6px; font-weight: 600; color: var(--vscode-descriptionForeground); }
	section { margin-top: 26px; }
	.sub, .dim { color: var(--vscode-descriptionForeground); }
	.lede { color: var(--vscode-descriptionForeground); margin: 6px 0 14px; text-wrap: pretty; }
	.lede.top { margin-bottom: 0; }
	table { width: 100%; border-collapse: collapse; margin: 8px 0 4px; font-size: 0.86rem; }
	th, td { text-align: left; padding: 6px 10px 6px 0; vertical-align: top;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
	th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 0.78rem;
		text-transform: uppercase; letter-spacing: 0.04em; }
	.num { text-align: right; }
	.mono { font-family: var(--vscode-editor-font-family); }
	code { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
	.why { font-size: 0.92em; max-width: 46ch; margin-top: 2px; }
	.ok { color: var(--vscode-charts-green, #89D185); }
	.warn { color: var(--vscode-charts-yellow, #CCA700); }
	.bad { color: var(--vscode-charts-red, #F14C4C); }
	.unknown { color: var(--vscode-descriptionForeground); }
	.verdict-line { margin: 10px 0 0; text-wrap: pretty; }
	.warn-box {
		border-left: 3px solid var(--vscode-charts-yellow, #CCA700);
		padding: 8px 12px; margin-top: 12px;
		background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
	}
	/* A withholding gate is the reason someone opened this page. */
	tr.binding td { background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.10)); }
	.chip {
		display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 9px;
		font-size: 0.74rem; white-space: nowrap;
		color: var(--vscode-charts-yellow, #CCA700);
		border: 1px solid currentColor;
	}
	.basis {
		display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 0.72rem;
		text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid currentColor;
	}
	.basis.derived { color: var(--vscode-charts-green, #89D185); }
	.basis.judged { color: var(--vscode-charts-orange, #D18616); }
	footer {
		margin-top: 30px; padding-top: 12px; font-size: 0.85rem;
		color: var(--vscode-descriptionForeground); text-wrap: pretty;
		border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
	}
`;
