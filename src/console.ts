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
import { LoadedCard, compare, lookup, RateComparison, effectiveAt } from './ratecard';
import { PeriodCoverage, conversionConfidence } from './reconcile';
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

/**
 * A link, never a bare URL.
 *
 * A pasted address is unreadable at this size and wraps mid-path; the text says
 * where it goes. Opened outside the panel, like every link the report emits:
 * a webview has no back button, so navigating inside it is a dead end.
 */
function link(href: string, text: string): string {
	if (!/^https:\/\//.test(href)) {
		return escapeHtml(text);
	}
	return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${
		escapeHtml(text)}</a>`;
}

/**
 * A section that stays shut until you want it.
 *
 * Four sections open at once is a page you scroll rather than read. The
 * summary carries the finding -- "1 disagreement", "2 withholding", "never
 * checked" -- so the closed page answers the question and opening one is for
 * the working, not for the answer.
 */
function pane(title: string, state: string, tone: Tone, body: string, open = false): string {
	return `
	<details class="pane"${open ? ' open' : ''}>
		<summary><span class="chev"></span><span class="pane-title">${title}</span>
			<span class="state ${tone}">${state}</span></summary>
		<div class="pane-body">${body}</div>
	</details>`;
}

type Tone = 'ok' | 'warn' | 'bad' | 'flat';

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

	// The same call the panel makes, so the two pages cannot disagree about
	// whether the figures on them are measurements.
	const conf = conversionConfidence(c, !input.creditsPerNanoAiuIsDefault);

	const state = conf.confidence === 'measured'
		? 'checked against GitHub'
		: c === undefined ? 'never checked' : `unconfirmed \u00b7 ${c.verdict}`;

	return pane('The conversion', state, conf.confidence === 'measured' ? 'ok' : 'warn', `
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
		<p class="note">Everything derived from it is therefore
			<strong class="${conf.confidence === 'measured' ? 'ok' : 'warn'}">${conf.confidence}</strong>.
			${conf.confidence === 'measured'
				? 'Findings on the panel carry no doubt mark from this.'
				: 'Findings on the panel are marked <strong>~</strong> and carry this reason.'}</p>`);
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
	const { card, cards, origin, fetchedAt, note } = input.card;
	const byModel = groupBy(input.rollups, 'model');

	// The days the solved rates were actually fitted over. A card published
	// after they end has no bearing on what those requests were billed.
	const days = input.rollups.map(r => Date.parse(`${r.day}T00:00:00.000Z`))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const window = days.length > 0
		? { from: days[0], to: days[days.length - 1] + 86_400_000 }
		: undefined;
	const dating = window ? { cards, window } : undefined;

	// Two tables, not one. A model with a solved card contributes five columns
	// of figures; a model without one contributes a sentence. Forced into the
	// same grid the sentence wins -- a `colspan` row is laid out across columns
	// 2 to 5, so ~700px of prose set the width of the CLASS column and left a
	// canyon between "fresh input" and the number it belongs to.
	const compared: string[] = [];
	const absent: string[] = [];
	let agreeing = 0;

	for (const model of byModel.keys()) {
		const stats = input.prices[model];
		const price: Price | undefined = stats ? solve(stats, input.creditsPerNanoAiu) : undefined;
		const published = lookup(card, model);
		const seen = stats
			? `${fmtInt(stats.n)} billed message${stats.n === 1 ? '' : 's'}`
			: 'no billed messages';

		if (!price) {
			absent.push(`<tr><td class="model">${escapeHtml(model)}</td>
				<td class="dim">${seen} &mdash; a rate card needs
					${input.readings.find(r => r.knob.id === 'pricing.minObservations')?.value ?? 6}
					on one model.
					${published
						? `Published as <em>${escapeHtml(published.name)}</em>.`
						: 'Not in the published table.'}</td></tr>`);
			continue;
		}

		const cmp: RateComparison = compare(card, model, price, dating);
		if (cmp.spansPriceChange) {
			// Comparing would report a price change as a measurement error.
			absent.push(`<tr><td class="model">${escapeHtml(model)}</td>
				<td class="dim">Published prices changed on
					${cmp.spansPriceChange.map(d => escapeHtml(d)).join(', ')}, inside the days
					these rates were measured. They blend two price regimes and match neither
					by construction, so the comparison is withheld.</td></tr>`);
			continue;
		}

		// The model names its group once. Internal rules are suppressed so three
		// classes of one model read as one block rather than as three models
		// with their names missing.
		if (cmp.classes.every(c => c.matchedAs === c.label)) {
			agreeing++;
		}
		compared.push(cmp.classes.map((c, i) => `<tr class="${i === 0 ? 'group-start' : 'group-cont'}">${
			i === 0
				? `<td class="model">${escapeHtml(model)}<span class="dim fit">${
					fmtInt(price.n)} messages &middot; R&sup2; ${price.r2.toFixed(6)}</span></td>`
				: '<td class="model"></td>'
		}${classCells(c)}</tr>`).join(''));
	}

	const comparison = compared.length === 0 ? '' : `
		<table class="rates">
			<colgroup><col class="c-model"><col class="c-class"><col class="c-num">
				<col class="c-num"><col class="c-agree"></colgroup>
			<tr><th>Model</th><th>Class</th><th class="num">Measured</th>
			    <th class="num">Published</th><th>Agreement</th></tr>
			${compared.join('')}
		</table>`;

	const notCompared = absent.length === 0 ? '' : `
		<h3>Not compared</h3>
		<table class="absent">
			<colgroup><col class="c-model"><col></colgroup>
			<tr><th>Model</th><th>Why</th></tr>
			${absent.join('')}
		</table>`;

	const nothing = compared.length === 0 && absent.length === 0
		? '<p class="dim">No models yet.</p>' : '';

	const age = fetchedAt !== undefined
		? `fetched ${new Date(fetchedAt).toLocaleDateString()}`
		: `bundled with the extension`;

	const applied = window ? effectiveAt(cards, window.from) : undefined;
	const oldest = [...cards].sort((a, b) => Date.parse(a.effective) - Date.parse(b.effective))[0];
	const windowStart = window
		? new Date(window.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
		: '';

	// Three states worth distinguishing, and the panel used to show none of
	// them: an older card governs, no card governs, or the current one does.
	const dated = !window
		? ''
		: applied && applied.effective !== card.effective
		? `<p class="note">These rates were measured over days governed by the card effective
			<strong>${escapeHtml(applied.effective)}</strong>, so that is what they are compared
			against &mdash; not the current one, effective ${escapeHtml(card.effective)}.
			A price change does not apply backwards.</p>`
		: !applied && oldest
		? `<p class="note">Your history starts ${escapeHtml(windowStart)}, before any price
			list on record &mdash; the oldest is effective
			<strong>${escapeHtml(oldest.effective)}</strong>. Those days are compared against it
			because it is the best statement available about them, but that is an assumption
			rather than a record.</p>`
		: '';

	// The finding, counted: a class matching a different published class is the
	// thing worth opening for.
	const disagreements = compared.length - agreeing;
	const state = compared.length === 0
		? `no model priced yet \u00b7 ${absent.length} waiting`
		: disagreements > 0
		? `${disagreements} disagreement${disagreements === 1 ? '' : 's'}`
		: `${compared.length} model${compared.length === 1 ? '' : 's'} agree`;

	return pane('The rate card', state,
		compared.length === 0 ? 'flat' : disagreements > 0 ? 'warn' : 'ok', `
		<p class="lede">What the solver recovered from your own spend, beside what GitHub
			publishes. A figure that matches a <em>different</em> class than its own name is a
			correct measurement under a wrong label &mdash; not an error in the fit.
			Rates are compared against the card that was in force over the days they were
			measured, never against a later one.</p>
		${comparison}
		${notCompared}
		${nothing}
		${dated}
		<p class="note dim">Card in use: <strong>${origin}</strong>, ${age}, effective
			${escapeHtml(card.effective)}, ${card.models.length} models${
				cards.length > 1 ? `, ${cards.length} on record` : ''
			}${note ? ` &mdash; ${escapeHtml(note)}` : ''}.
			Read from ${link(card.source, "GitHub's published prices")}.</p>`);
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
	return `<td class="cls">${escapeHtml(c.label)}</td>
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
		const mine = input.readings.filter(r => r.knob.kind === kind);
		const withholding = mine.filter(r => binding.has(r.knob.id)).length;
		const changed = mine.filter(r => r.overridden).length;
		const rows = mine.map(r => {
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
		// Open only when there is something to answer for. Seventeen gates
		// expanded is the wall of text this page exists to replace; a group
		// that is withholding, or that someone has changed, is the exception.
		const open = withholding > 0 || changed > 0;
		const tally = [
			withholding > 0 ? `<span class="chip">${withholding} withholding</span>` : '',
			changed > 0 ? `<span class="chip changed">${changed} changed</span>` : ''
		].join('');
		return rows.length === 0 ? '' : `
		<details class="group"${open ? ' open' : ''}>
			<summary><span class="chev"></span>${heading}
				<span class="dim count">${mine.length}</span>${tally}</summary>
			<table>
				<tr><th>Gate</th><th class="num">In effect</th><th class="num">Default</th>
				    <th>Why this number</th></tr>
				${rows.join('')}
			</table>
		</details>`;
	});

	const count = binding.size;
	const state = count > 0
		? `${count} withholding`
		: `${input.readings.length} thresholds \u00b7 none withholding`;

	return pane('The gates', state, count > 0 ? 'warn' : 'ok', `
		<p class="lede">Every threshold the panel applies, what it is set to, and whether it
			is withholding something right now. <strong>Derived</strong> means the number
			follows from something; <strong>judged</strong> means it was chosen and could
			reasonably be chosen otherwise.</p>
		${count > 0
			? `<p class="verdict-line warn">${count} gate${count === 1 ? ' is' : 's are'}
				currently withholding output. They are marked below.</p>`
			: '<p class="verdict-line ok">No gate is currently withholding anything.</p>'}
		${groups.join('')}`, count > 0);
}

/* --------------------------------------------------------- pipeline --- */

function pipelineSection(input: ConsoleInput): string {
	const p = input.pipeline;
	const totals = sum(input.rollups);
	const step = (label: string, value: string, note: string) =>
		`<tr><td>${label}</td><td class="num mono">${value}</td><td class="dim">${note}</td></tr>`;

	// Spans scanned is zero before the first ingest of a session, and "65
	// messages from 0 spans" reads as a contradiction rather than as a cursor
	// that has not moved.
	const messages = `${fmtInt(totals.requests)} message${totals.requests === 1 ? '' : 's'}`;
	const state = p.errors.length > 0
		? `${p.errors.length} error${p.errors.length === 1 ? '' : 's'}`
		: p.spansScanned > 0
		? `${messages} from ${fmtInt(p.spansScanned)} span${p.spansScanned === 1 ? '' : 's'}`
		: `${messages} on record`;

	return pane('The pipeline', state, p.errors.length > 0 ? 'bad' : 'flat', `
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
			: ''}`, p.errors.length > 0);
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
	<p class="lede top">The values the extension is actually running on, in the order the
		doubt runs. Each line below answers its own question; open one for the working.</p>
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
		font-size: 0.95rem; margin: 0 0 6px; font-weight: 600;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
	}
	/* Four sections open at once is a page you scroll rather than read, so each
	   is a pane whose summary carries its own answer. Opening one is for the
	   working, not for the finding. */
	details.pane {
		border-radius: 8px; margin-bottom: 10px;
		background: var(--vscode-editorWidget-background);
		border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22));
	}
	details.pane > summary {
		list-style: none; cursor: pointer; padding: 13px 16px;
		display: flex; gap: 10px; align-items: center;
	}
	details.pane > summary::-webkit-details-marker { display: none; }
	details.pane > summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
	details.pane[open] > summary { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.22)); }
	details.pane[open] > summary .chev { transform: rotate(-135deg); }
	.pane-title { font-size: 0.92rem; font-weight: 600; }
	.pane-body { padding: 4px 16px 18px; }
	.pane-body > .lede:first-child { margin-top: 10px; }
	/* The answer, on the closed line. */
	.state {
		margin-left: auto; font-size: 0.76rem; font-weight: 500;
		font-variant-numeric: tabular-nums; white-space: nowrap;
	}
	.state.ok { color: var(--vscode-charts-green, #89D185); }
	.state.warn { color: var(--vscode-charts-yellow, #CCA700); }
	.state.bad { color: var(--vscode-charts-red, #F14C4C); }
	.state.flat { color: var(--vscode-descriptionForeground); }

	/* Seventeen gates expanded is the wall this page exists to replace. Each
	   group collapses; the ones with something to answer for open themselves.
	   Same chevron geometry as the report, so the two pages behave alike. */
	details.group {
		border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
	}
	details.group:first-of-type { border-top: none; }
	details.group > summary {
		list-style: none; cursor: pointer; padding: 11px 2px;
		display: flex; gap: 9px; align-items: center;
		font-size: 0.86rem; font-weight: 600;
	}
	details.group > summary::-webkit-details-marker { display: none; }
	details.group > summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
	.chev {
		display: inline-block; width: 6px; height: 6px; flex: none;
		margin-right: 1px;
		border-right: 1.7px solid currentColor;
		border-bottom: 1.7px solid currentColor;
		transform: rotate(45deg); transform-origin: 55% 55%;
		transition: transform 130ms ease; opacity: 0.85;
	}
	details.group[open] > summary .chev { transform: rotate(-135deg); }
	.count { font-weight: 400; margin-left: auto; }
	details.group table { margin: 0 0 10px; }
	details.group table tr:last-child td { border-bottom: none; }
	section { margin-top: 34px; }
	h3 { margin-top: 22px; }
	.sub, .dim { color: var(--vscode-descriptionForeground); }
	.lede { color: var(--vscode-descriptionForeground); margin: 8px 0 16px; text-wrap: pretty; }
	.lede.top { margin-bottom: 0; }
	/* 10px of right padding alone ran every column into its neighbour. Padding
	   on both sides, and more of it, so the columns read as columns. */
	table { width: 100%; border-collapse: collapse; margin: 10px 0 2px; font-size: 0.86rem; }
	th, td { text-align: left; padding: 9px 18px 9px 0; vertical-align: top;
		border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
	td:last-child, th:last-child { padding-right: 0; }
	th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 0.75rem;
		text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap;
		padding-bottom: 7px; }
	.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.mono { font-family: var(--vscode-editor-font-family); }
	code { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
	.why { font-size: 0.92em; max-width: 46ch; margin-top: 5px; text-wrap: pretty; }
	/* The model name and its fit statistics are one label, not two columns. */
	td.model { white-space: nowrap; padding-right: 22px; }
	td.model .fit { display: block; font-size: 0.8em; margin-top: 2px; }
	a { color: var(--vscode-charts-blue, #3794FF); }

	/* The comparison is five narrow columns of figures and nothing else, so the
	   numbers sit next to the class they belong to instead of across a gap left
	   by prose in some other row. AGREEMENT takes the slack because it is the
	   only cell whose text length varies. */
	table.rates td, table.rates th { border-bottom: none; }
	table.rates col.c-model { width: 1%; }
	table.rates col.c-class { width: 1%; }
	table.rates td.cls { white-space: nowrap; padding-right: 26px; }
	table.rates col.c-num { width: 1%; }
	table.rates col.c-agree { width: auto; }
	table.rates td.num, table.rates th.num { padding-right: 24px; }
	/* One rule per model, not one per class: three rows of the same model are
	   one block, and ruling between them made each look like a model whose name
	   had gone missing. */
	table.rates tr.group-start:not(:nth-child(2)) td {
		border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.22));
	}
	table.rates tr.group-start td { padding-top: 14px; }
	table.rates tr.group-cont td { padding-top: 2px; }
	table.rates tr:last-child td { padding-bottom: 14px; }

	/* Two columns, and the reason is prose, so it may wrap and take the width. */
	table.absent col.c-model { width: 1%; }
	table.absent td:last-child { text-wrap: pretty; }
	.ok { color: var(--vscode-charts-green, #89D185); }
	.warn { color: var(--vscode-charts-yellow, #CCA700); }
	.bad { color: var(--vscode-charts-red, #F14C4C); }
	.unknown { color: var(--vscode-descriptionForeground); }
	.verdict-line { margin: 14px 0 0; text-wrap: pretty; }
	.note { margin: 14px 0 0; text-wrap: pretty; }
	.warn-box {
		border-left: 3px solid var(--vscode-charts-yellow, #CCA700);
		padding: 8px 12px; margin-top: 12px;
		background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
	}
	/* A withholding gate is the reason someone opened this page. */
	tr.binding td { background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.10)); }
	.chip {
		display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 9px;
		font-size: 0.74rem; font-weight: 400; white-space: nowrap; flex: none;
		color: var(--vscode-charts-yellow, #CCA700);
		border: 1px solid currentColor;
	}
	/* A gate someone has set is not a problem, so it does not borrow the
	   warning colour -- but it is worth finding without opening every group. */
	.chip.changed { color: var(--vscode-charts-blue, #3794FF); }
	summary .count + .chip { margin-left: 8px; }
	/* A hairline outline in a dim accent was near-invisible at this size. The
	   label is the one thing on the row that says how much to trust the number,
	   so it gets a filled ground and a weight that survives being small. */
	.basis {
		display: inline-block; padding: 2px 8px; border-radius: 4px;
		font-size: 0.68rem; font-weight: 700; letter-spacing: 0.07em;
		text-transform: uppercase; white-space: nowrap;
		border: 1px solid transparent;
	}
	.basis.derived {
		color: var(--vscode-charts-green, #89D185);
		border-color: var(--vscode-charts-green, #89D185);
		background: rgba(137, 209, 133, 0.14);
		background: color-mix(in srgb, var(--vscode-charts-green, #89D185) 16%, transparent);
	}
	.basis.judged {
		color: var(--vscode-charts-orange, #D18616);
		border-color: var(--vscode-charts-orange, #D18616);
		background: rgba(209, 134, 22, 0.16);
		background: color-mix(in srgb, var(--vscode-charts-orange, #D18616) 18%, transparent);
	}
	footer {
		margin-top: 30px; padding-top: 12px; font-size: 0.85rem;
		color: var(--vscode-descriptionForeground); text-wrap: pretty;
		border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
	}
`;
