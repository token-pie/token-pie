#!/usr/bin/env node
/**
 * The two sources are checked against each other, not against themselves.
 *
 * Every other fixture in this suite is built from the same assumptions as the
 * code it exercises: `roll()` hands the projection rollups that carry cost,
 * so in the tests spans always carry cost. 825 checks could not catch the one
 * thing that actually happened, because no fixture had ever represented it.
 *
 * What happened: on 30 August Copilot stopped writing cost onto its chat
 * spans. Helper calls and embeddings kept flowing, so nothing looked broken.
 * GitHub went on billing -- 983 credits over the period -- while this machine
 * measured 81. Four views read measurement and reported the absence as a fact:
 * "0% used today", a pace of 13.68 against a real 39, a week of empty bars
 * under "nothing yet", and a period strip of blank columns. The month, which
 * reads GitHub, was right the whole time. The panel even printed the shortfall
 * in prose an inch below the empty chart.
 *
 * So the rule here is not another fixture. It is an invariant across the two
 * sources, which a self-consistent fixture cannot fake:
 *
 *   When GitHub says credits were spent and measurement says none were, no
 *   view may draw a zero. It shows the billed figure, or it says it does not
 *   know -- but it never reports silence as an idle day.
 *
 * And its converse, so the rule has teeth rather than banning zeros outright:
 * when GitHub agrees nothing was spent, the zeros are the truth and must show.
 *
 * Usage: npm run test:sources
 */
process.env.TZ = 'UTC';

const { project } = await import('../out/projection.js');
const { renderReport, weekBars, spendByDay } = await import('../out/report.js');
const { renderCompact } = await import('../out/sidebar.js');
const { defaults } = await import('../out/tuning.js');

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const NOW = Date.now();
const day = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` +
         `-${String(d.getDate()).padStart(2, '0')}`;
};
const TODAY = day(NOW);
const reset = new Date(NOW + 6 * 86400000).toISOString();

/**
 * A span that was recorded and cost nothing, which is the shape of the fault.
 *
 * Not an empty list: an empty database is a state everyone thinks to test. A
 * database full of requests that all bill zero is the one that fooled four
 * views, because every count in the pipeline is non-zero and only the money
 * is missing.
 */
const freeSpan = (over = {}) => ({
  day: TODAY, model: 'gpt-4o-mini', workspace: 'w', operation: 'chat',
  selection: 'auto', source: 'measured', requests: 1, inputTokens: 1600,
  outputTokens: 40, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  nanoAiu: 0, missRequests: 1, missInputTokens: 1600, missNanoAiu: 0, ...over
});

/** GitHub, billing normally, whatever the spans do or do not say. */
const billing = (used, remaining) => ({
  snapshots: [{
    name: 'premium_interactions', entitlement: used + remaining,
    remaining, remainingExact: remaining,
    percentRemaining: (remaining / (used + remaining)) * 100,
    creditsUsed: used, hasQuota: true, unlimited: false
  }],
  resetDate: reset
});

const panel = (rollups, projection, billedDays) => renderReport({
  rollups, creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(),
  costCoverage: 1, warnings: [], prices: {}, depth: {}, projection, billedDays
});
const compact = (rollups, projection, billedDays) => renderCompact({
  rollups, creditsPerNanoAiu: 1e-9, tuning: defaults(), projection, billedDays,
  warnings: []
});

/* ------------------------------------------------------- the fault itself --- */

console.log('spans recorded, none of them billed');
{
  // Twelve requests, all free, while GitHub bills 374 today and 983 this
  // period. Every counter in the pipeline is healthy; only the money is gone.
  const rollups = Array.from({ length: 12 }, () => freeSpan());
  const ent = billing(983, 517);
  const billed = new Map([[TODAY, 374]]);
  const p = project(ent, rollups, 1e-9, NOW, defaults(), 374);

  check('the day is what was billed, not what was traced', p.todayCredits, 374);
  check('and the pace is too', p.burnPerDay > 30, true);
  check('the month never depended on spans', Math.round(p.percentRemaining), 34);

  const html = panel(rollups, p, billed);
  check('the panel does not call this an idle week', /nothing yet/.test(html), false);
  check('the week carries the billed figure', /374/.test(html), true);
  check('and the day figure is not zero', /\b0\s*<span class="unit">% used today/.test(html), false);

  const side = compact(rollups, p, billed);
  check('the sidebar agrees with the panel', /nothing yet/.test(side), false);
}

console.log('\nnothing recorded at all');
{
  // The same fault one step further: the exporter is not even writing rows.
  const ent = billing(983, 517);
  const billed = new Map([[TODAY, 374]]);
  const p = project(ent, [], 1e-9, NOW, defaults(), 374);

  check('the day still reports what was billed', p.todayCredits, 374);
  check('the pace still has a figure', p.burnPerDay > 30, true);
  const html = panel([], p, billed);
  check('an empty database is not an idle week', /nothing yet/.test(html), false);
}

/* ------------------------------------------------- and the converse of it --- */

console.log('\ngenuinely idle, and the zeros are the truth');
{
  // GitHub agrees nothing moved. A rule that merely banned zeros would pass
  // this by drawing something, which is the same lie in the other direction.
  const ent = billing(0, 1500);
  const p = project(ent, [], 1e-9, NOW, defaults(), 0);

  check('the day is zero because the day was zero', p.todayCredits, 0);
  const html = panel([], p, new Map([[TODAY, 0]]));
  check('and the week says so plainly', /nothing yet/.test(html), true);
}

/* ------------------------------------- the merge rule the views depend on --- */

console.log('\nwhere the two disagree about one day');
{
  // Two readings of the same day, one of them from the party doing the
  // billing. It replaces the measurement rather than adding to it.
  const merged = spendByDay([freeSpan({ nanoAiu: 5e9 })], 1e-9, new Map([[TODAY, 374]]));
  check('billing wins', merged.get(TODAY), 374);

  // A day GitHub cannot answer for keeps what was measured, so nothing that
  // already drew stops drawing. The billed record starts the day it is added
  // and can never be backfilled: GitHub reports a total, not a history.
  const older = day(NOW - 3 * 86400000);
  const kept = spendByDay([freeSpan({ day: older, nanoAiu: 5e9 })], 1e-9,
    new Map([[TODAY, 374]]));
  check('and measurement keeps the days it cannot', kept.get(older), 5);

  const bars = weekBars([], 1e-9, new Date(), new Map([[TODAY, 374]]));
  check('a week of billed days draws', /nothing yet/.test(bars), false);
}

/* --------------------------------------------- the figures, one by one --- */

/*
 * Enumerated rather than sampled, so a fifth view added later has to answer
 * the same question the other four failed: where does your number come from
 * when the spans carry no cost?
 */
console.log('\nevery headline figure survives a silent exporter');
{
  const ent = billing(983, 517);
  const p = project(ent, [freeSpan()], 1e-9, NOW, defaults(), 374);
  for (const [name, value] of [
    ['percent left this month', p.percentRemaining],
    ['credits used', p.creditsUsed],
    ['spent today', p.todayCredits],
    ['pace per day', p.burnPerDay],
    ['sustainable per day', p.sustainableDailyBurn]
  ]) {
    check(`${name} is a real figure`, value !== undefined && value > 0, true);
  }
}

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
