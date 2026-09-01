import { Rollup } from './store';
// Two formatters, because the two shapes differ: the inline line reads
// "resets in 13h" and wants the unit attached, while the figure draws the
// number and its unit as separate elements and takes report's pair.
import { Projection, dayPressure, fmtDays as fmtDaysInline } from './projection';
import { Tuning, defaults } from './tuning';
import {
	weekBars, periodBars, fmtCredits, fmtCreditsWith, fmtDays, dayUnit, escapeHtml,
	creditsOf
} from './report';
import { periodStartFrom, resetInstantFrom } from './reconcile';
import { sum } from './store';

/**
 * The panel, for a column three hundred pixels wide.
 *
 * Not the panel scaled down. That was tried: every table scrolls sideways,
 * every finding sets two words to the line, and the result was a worse way to
 * read the same page. What survives a narrow column is figures and bars, so
 * this carries the two headline figures, the meter, the week, and a way to the
 * full report -- and deliberately not the breakdowns, the period chart or the
 * findings, all of which need width to mean anything.
 *
 * Its own stylesheet rather than the panel's. Sharing one would make every
 * change to the panel a change here, and the two have different jobs.
 */
export interface CompactInput {
	rollups: Rollup[];
	creditsPerNanoAiu: number;
	projection?: Projection;
	tuning?: Tuning;
	/** Anything the pipeline wants to say. Shown as a single line, not a list. */
	warnings?: string[];
	/** Billed credits per local day, where GitHub could answer for one. */
	billedDays?: Map<string, number>;
	/** The models reduction, rendered by its own module. */
	modelsHtml?: string;
}

/** A figure and its unit, the sidebar's only heading. */
function figure(value: string, unit: string, tone = ''): string {
	return `<div class="fig ${tone}"><span class="n">${value}</span>
		<span class="u">${escapeHtml(unit)}</span></div>`;
}

function meter(p: Projection): string {
	if (p.entitlement === undefined || p.remaining === undefined || p.entitlement <= 0) {
		return '';
	}
	const used = Math.max(0, p.entitlement - p.remaining);
	const frac = Math.min(1, used / p.entitlement);
	const over = p.remaining <= 0;
	return `<div class="line">${fmtCredits(used)} of ${fmtCredits(p.entitlement)} used</div>
		<div class="bar${over ? ' bar-over' : ''}"><span style="width:${(frac * 100).toFixed(1)}%"></span></div>
		<div class="line dim">${
			over ? 'nothing left' : `${fmtCreditsWith(p.remaining)} left`}${
			p.daysToReset !== undefined ? ` &middot; resets in ${fmtDaysInline(p.daysToReset)}` : ''}</div>`;
}

/**
 * Today, on the same terms the panel states it.
 *
 * Withheld only when there is no allowance to pace against at all. A day with
 * requests and no billable spend still says so: the panel learned that leaving
 * a figure out leaves its space behind, and in a column that narrow the space
 * is the whole view.
 */
function today(p: Projection, tuning: Tuning): string {
	const pressure = dayPressure(p, tuning);
	if (pressure === undefined || p.todayShare === undefined) {
		return p.todayCredits === undefined ? '' : `
			<div class="sec">
			${figure(fmtCredits(p.todayCredits), 'today')}
			<div class="line dim">credits spent &middot; no budget to pace against</div>
			</div>`;
	}
	return `
		<div class="sec">
		${figure(String(Math.round(p.todayShare * 100)), '% used today', `t-${pressure}`)}
		<div class="line dim">${fmtCredits(p.todayCredits ?? 0)} of
			${fmtCredits(p.todayBudget ?? 0)} budgeted</div>
		</div>`;
}

/**
 * Your pace against the one that lasts.
 *
 * The sidebar had every figure except the comparison between two of them,
 * which is the question the panel is built around: at this rate, do I finish
 * the period? Two numbers side by side answer it without a sentence.
 */
function pace(p: Projection): string {
	if (p.burnPerDay === undefined && p.sustainableDailyBurn === undefined) {
		return '';
	}
	const hot = p.burnPerDay !== undefined && p.sustainableDailyBurn !== undefined
		&& p.burnPerDay > p.sustainableDailyBurn;
	// A pair, so a missing half is a dash rather than a single figure with
	// nothing to compare it to.
	const cell = (v: string, k: string, tone = '') =>
		`<div class="pc ${tone}"><span class="pv">${v}</span><span class="pk">${k}</span></div>`;
	return `<div class="sec pair">
		${cell(p.burnPerDay === undefined ? '&mdash;' : fmtCredits(p.burnPerDay),
			'your pace', hot ? 't-over' : '')}
		${cell(p.sustainableDailyBurn === undefined ? '&mdash;' : fmtCredits(p.sustainableDailyBurn),
			'sustainable')}
	</div>`;
}

export function renderCompact(input: CompactInput): string {
	const tuning = input.tuning ?? defaults();
	const p = input.projection;
	const totals = sum(input.rollups);
	const measured = creditsOf(totals.nanoAiu, input.creditsPerNanoAiu);

	// No quota yet: say which of the two situations it is rather than showing a
	// dash. A sidebar with one dash in it is indistinguishable from a broken one.
	const head = p === undefined || p.verdict === 'unknown'
		? `${figure('&mdash;', 'no allowance yet')}
		   <div class="line dim">Run <strong>Token Pie: Check Quota</strong> to sign in.</div>
		   ${measured > 0 ? `<div class="line">${fmtCreditsWith(measured)} measured here so far</div>` : ''}`
		: `${p.percentRemaining !== undefined
			? figure(String(Math.round(p.percentRemaining)), '% left this month')
			: figure(fmtDays(p.daysToReset), `${dayUnit(p.daysToReset)} to reset`)}
		   ${meter(p)}`;

	// Thirty columns in three hundred pixels is about eight pixels each, which
	// the narrow layout already renders and the harness already measures.
	const period = p?.resetDate !== undefined
		? periodBars(input.rollups, input.creditsPerNanoAiu, periodStartFrom(p.resetDate),
			Date.now(), input.billedDays, resetInstantFrom(p.resetDate))
		: '';
	const week = weekBars(input.rollups, input.creditsPerNanoAiu, new Date(), input.billedDays);
	const warning = (input.warnings ?? [])[0];

	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';">
<style>${STYLES}</style></head>
<body>
	${head}
	${period ? `<div class="sec">${period}</div>` : ''}
	${p ? pace(p) : ''}
	${p ? today(p, tuning) : ''}
	${week ? `<div class="sec">${week}</div>` : ''}
	${input.modelsHtml ?? ''}
	${warning ? `<div class="warn">${escapeHtml(warning)}</div>` : ''}
	<a class="more" href="command:tokenPie.showReport">Open the full report</a>
</body></html>`;
}

const STYLES = `
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
	       color: var(--vscode-foreground); padding: 12px 14px 16px; }
	/* A section, not a spacer div: a zero-height box makes every gap measured
	   against it zero, which is an artefact of the markup rather than a fact
	   about the layout. */
	.fig { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
	.fig + .line, .bar + .line { margin-top: 0; }
	.sec { margin-top: 18px; }
	body > .sec:first-child { margin-top: 0; }
	.fig .n { font-size: 1.9rem; font-weight: 600; line-height: 1;
	          color: var(--vscode-charts-blue, #4a9eff); }
	.fig .u { font-size: 0.82rem; color: var(--vscode-descriptionForeground); }
	/* The state is the figure's own colour here: there is no card to tint and
	   no bar of its own to carry it, and these are large enough for the 3:1
	   that size of text needs. */
	/* Orange, not the warning yellow, which measured 3.11:1 on light -- over
	   the 3:1 large-text bar by a hair, and the same state reads orange in the
	   panel's hero, where yellow could not clear it at all. One colour for one
	   meaning, at 4.0:1 in both themes. */
	/* Name over role on the left, rates on the right. No bar -- every other bar
	   in this column is spend against a quota, and a price ratio drawn the same
	   way says a model is consuming something it has not consumed.

	   align-items: center, so the rates sit against the middle of the two-line
	   block. Baselined to the first line they read as belonging to the name and
	   leave the role hanging under nothing. */
	.mrow { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
	.mid { min-width: 0; }
	.mname { font-size: 0.8rem; font-weight: 600; line-height: 1.35;
	         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.mrole { font-size: 0.68rem; line-height: 1.35; letter-spacing: 0.02em; }
	/* The cheapest is the one worth noticing, so it takes the link colour a
	   theme contrast-checks; the other is a plain fact and stays neutral. */
	.mrole.best { color: var(--vscode-textLink-foreground, #4daafc); }
	.mrole.yours { color: var(--vscode-descriptionForeground); }
	/* Tabular, so the digits of one model sit under the digits of the other. */
	.mrate { margin-left: auto; white-space: nowrap; font-size: 0.82rem;
	         font-variant-numeric: tabular-nums; font-weight: 600; }
	.msep { color: var(--vscode-descriptionForeground); font-weight: 400;
	        margin: 0 3px; }
	.models .wk-head { margin-bottom: 2px; }
	/* Its own line: at 300px the unit cannot share the heading with the word
	   Models, and "per 1M" without the noun says the scale but not the thing. */
	.munit { font-size: 0.68rem; color: var(--vscode-descriptionForeground);
	         margin-bottom: 8px; }
	.t-near .n { color: var(--vscode-charts-orange, #bf6a02); }
	.t-over .n { color: var(--vscode-errorForeground, #f14c4c); }
	.line { font-size: 0.78rem; line-height: 1.5; }
	.dim { color: var(--vscode-descriptionForeground); }
	.bar { height: 6px; border-radius: 3px; margin: 5px 0;
	       background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); overflow: hidden; }
	.bar span { display: block; height: 100%; border-radius: 3px;
	            background: var(--vscode-charts-blue, #4a9eff); }
	.bar-over span { background: var(--vscode-charts-red, #f14c4c); }
	/* A file path is one word, and this column is 300px. Without this the text
	   sets on a single line and runs out of the sidebar. */
	.warn { margin-top: 12px; padding: 7px 9px; border-radius: 4px; font-size: 0.74rem;
	        line-height: 1.5; overflow-wrap: anywhere;
	        background: var(--vscode-inputValidation-warningBackground, rgba(255,190,0,0.1));
	        border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,190,0,0.4)); }
	/* Two figures, because one rate means nothing without the other. */
	.pair { display: flex; gap: 18px; }
	.pc { display: flex; flex-direction: column; gap: 2px; }
	.pv { font-size: 1.05rem; font-weight: 600; line-height: 1.1; }
	.pc.t-over .pv { color: var(--vscode-errorForeground, #f14c4c); }
	.pk { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em;
	      color: var(--vscode-descriptionForeground); }

	/* The period strip, borrowed from the panel. Shorter here: the column has
	   less height to spend and the shape reads at any height. */
	.pd-head { display: flex; justify-content: space-between; align-items: baseline;
	           gap: 8px; font-size: 0.68rem; text-transform: uppercase;
	           letter-spacing: 0.07em; color: var(--vscode-descriptionForeground);
	           margin-bottom: 7px; }
	.pd-peak { letter-spacing: 0; text-transform: none; font-size: 0.66rem; }
	.pd-plot { display: flex; align-items: flex-end; gap: 1px; height: 30px; }
	.pd-col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end;
	          background: rgba(128, 128, 128, 0.1);
	          background: color-mix(in srgb,
	              var(--vscode-editorWidget-border, rgba(128,128,128,0.22)) 45%, transparent);
	          border-radius: 1px; }
	.pd-fill { display: block; width: 100%; border-radius: 1px;
	           background: var(--vscode-charts-blue, #4a9eff); }
	.pd-today { outline: 1px solid var(--vscode-charts-blue, #4a9eff); outline-offset: 1px; }
	.pd-axis { display: flex; justify-content: space-between; margin-top: 5px;
	           font-size: 0.64rem; color: var(--vscode-descriptionForeground); }

	.more { display: block; margin-top: 16px; font-size: 0.78rem;
	        color: var(--vscode-textLink-foreground, #4a9eff); }

	/* The week, borrowed from the panel. Its markup is shared; its measurements
	   are not -- a column this narrow has no room for the panel's track floor. */
	.wk-head { display: flex; justify-content: space-between; align-items: baseline;
	           gap: 8px; font-size: 0.68rem; text-transform: uppercase;
	           letter-spacing: 0.07em; color: var(--vscode-descriptionForeground);
	           margin-bottom: 7px; }
	.wk-total { letter-spacing: 0; text-transform: none; font-size: 0.78rem;
	            color: var(--vscode-foreground); font-weight: 600; }
	.wk-row { display: flex; align-items: center; gap: 7px; padding: 2px 0; font-size: 0.73rem; }
	.wk-day { flex: 0 0 2.2em; color: var(--vscode-descriptionForeground); }
	.wk-track { flex: 1 1 auto; height: 7px; border-radius: 4px; min-width: 20px;
	            background: var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); }
	.wk-fill { display: block; height: 100%; border-radius: 4px;
	           background: var(--vscode-charts-blue, #4a9eff); }
	.wk-val { flex: 0 0 auto; min-width: 2.2em; text-align: right;
	          font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
	.wk-today .wk-day { color: var(--vscode-foreground); font-weight: 600; }
	.wk-future { opacity: 0.55; }
`;
