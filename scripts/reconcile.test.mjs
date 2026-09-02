#!/usr/bin/env node
/**
 * Two credit figures, one panel.
 *
 * The meter reads GitHub's consumption for the period; the breakdown reads
 * ours. The cases that matter are the ones where a difference means something
 * different: unseen spend on another machine, a miscalibrated conversion, and
 * the one that looks like unseen spend but is only a short history.
 */
/**
 * Pinned to UTC, before the modules under test load, so the credit totals
 * below are exact.
 *
 * This comment used to call the boundary behaviour correct: a day key is a
 * local calendar day and a reset date is a UTC instant, so a day near the
 * period edge fell either side depending where the machine was. That is not
 * correct, it is the bug -- east of UTC the period's own first day sorted
 * before its start and was dropped from what this machine could account for.
 * Pinning the suite to UTC is what kept it from ever being seen. The boundary
 * now has its own check below, run under a real offset zone.
 */
process.env.TZ = 'UTC';

import { execFileSync } from 'node:child_process';

const { periodCoverage, periodStartFrom, conversionConfidence } = await import('../out/reconcile.js');
const { advise } = await import('../out/advice.js');

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const DAY = 86_400_000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * History spanning the whole billing period, carrying `credits` in total.
 *
 * Days outside the period are excluded by design, so a fixture that merely
 * counts back from today under-fills the window and reads as unseen spend.
 */
function history(resetDate, credits, requests) {
  const start = periodStartFrom(resetDate);
  const days = Math.max(1, Math.round((Date.now() - start) / DAY) + 1);
  const map = new Map();
  for (let i = 0; i < days; i++) {
    map.set(iso(start + i * DAY), { credits: credits / days, requests: (requests ?? days) / days });
  }
  return map;
}

/**
 * Recording that has run since the period began.
 *
 * A verdict about where spend went depends on how much of the period this
 * machine was watching, so a fixture that means "we saw all of it" has to say
 * so. Passing nothing now means nothing was measured, which is its own case.
 */
const recordingAllPeriod = resetDate => periodStartFrom(resetDate);

/** History that only begins `days` ago, however long the period has run. */
function recent(days, credits) {
  const map = new Map();
  for (let i = 0; i < days; i++) {
    map.set(iso(Date.now() - (days - 1 - i) * DAY), { credits: credits / days, requests: 1 });
  }
  return map;
}

console.log('period start');
check('one calendar month before the reset', iso(periodStartFrom('2026-03-15')), '2026-02-15');
check('a 31st does not drift into the 3rd', new Date(periodStartFrom('2026-03-31')).getUTCMonth(), 2);
check('garbage in, nothing out', periodStartFrom('not-a-date'), undefined);

const resetIn = d => iso(Date.now() + d * DAY);
const RESET = resetIn(20);

console.log('\nwithheld without both figures');
check('no reset date', periodCoverage({ githubCredits: 20, creditsByDay: history(RESET, 20) }), undefined);
check('no GitHub figure', periodCoverage({ resetDate: RESET, creditsByDay: history(RESET, 20) }), undefined);

console.log('\nagreement');
const complete = periodCoverage({
  resetDate: RESET, githubCredits: 22.6, traceStartMs: recordingAllPeriod(RESET),
  creditsByDay: history(RESET, 22.4)
});
check('within rounding and 5% is agreement', complete.verdict, 'complete');
check('and the note does not allege unseen spend', complete.note.includes('outside'), false);

console.log('\nunseen spend');
const partial = periodCoverage({
  resetDate: RESET, githubCredits: 40, traceStartMs: recordingAllPeriod(RESET),
  creditsByDay: history(RESET, 22)
});
check('a large shortfall is spend elsewhere', partial.verdict, 'partial');
check('the gap is reported, not the ratio alone', Math.round(partial.unaccounted), 18);
check('share is the fraction we explain', Math.round(partial.share * 100), 55);

console.log('\nmeasuring more than we were billed');
const over = periodCoverage({
  resetDate: RESET, githubCredits: 10, traceStartMs: recordingAllPeriod(RESET),
  creditsByDay: history(RESET, 30)
});
check('points at the conversion, not at other machines', over.verdict, 'over');
check('and names the setting to check', over.note.includes('creditsPerNanoAiu'), true);

// The case this guard exists for: a fresh install two days old, mid-period.
// Its 2 credits against GitHub's 40 is not evidence of 38 spent elsewhere.
console.log('\na short history is not evidence');
const short = periodCoverage({
  resetDate: RESET, githubCredits: 40,
  traceStartMs: Date.now() - 2 * DAY, creditsByDay: recent(2, 2)
});
check('recording that started mid-period is inconclusive', short.verdict, 'inconclusive');
check('and says how much of the period was watched', short.note.includes('only recording for'), true);
// Denying that the gap is spend elsewhere, not asserting it. A substring
// cannot tell the two apart, so assert the verdict that gates the claim.
check('and does not reach the verdict that alleges it', short.verdict === 'partial', false);

// The work-machine failure, exactly. Chat-transcript backfill put history back
// before the period began while the trace database had been running for a day,
// so the old check -- which asked where history started -- passed, and a
// shortfall of 19,094 credits was reported as spend on other machines.
console.log('\nbackfill is not evidence of recording');
const backfilled = new Map([
  [iso(periodStartFrom(RESET) - 2 * DAY), { credits: 841, requests: 30 }],
  [iso(Date.now() - 1 * DAY), { credits: 20, requests: 1 }]
]);
const contaminated = periodCoverage({
  resetDate: RESET, githubCredits: 19114,
  traceStartMs: Date.now() - 1 * DAY, creditsByDay: backfilled
});
check('history reaching back before the period does not license a verdict',
  contaminated.verdict, 'inconclusive');
check('the note blames the gap on not watching', contaminated.note.includes('never watching'), true);
check('recorded share is reported', contaminated.recordedShare < 0.2, true);

console.log('\nnothing measured at all');
const unmeasured = periodCoverage({
  resetDate: RESET, githubCredits: 40, creditsByDay: recent(2, 2)
});
check('no trace database is inconclusive', unmeasured.verdict, 'inconclusive');
// The panel's footer names copilot_usage_nano_aiu as the source of every
// credit figure. When nothing was measured that is false, and the line that
// reconciles the two totals is where it has to be said.
check('and says the figures came from transcripts',
  unmeasured.note.includes('transcripts'), true);

console.log('\nnothing spent yet');
const idle = periodCoverage({ resetDate: RESET, githubCredits: 0, creditsByDay: history(RESET, 0) });
check('zero billed is inconclusive, not agreement', idle.verdict, 'inconclusive');

// The confidence vocabulary existed, was tested, and nothing ever emitted
// `estimated` -- so every credit figure claimed to be a measurement while
// resting on a multiplier nothing had checked. This is what emits it.
console.log('\nwhat the check makes of the conversion');
const cov = v => ({ periodStart: 0, githubCredits: 20, localCredits: 20, localRequests: 5,
  unaccounted: 0, share: 1, verdict: v, note: '' });
check('unchecked is an estimate', conversionConfidence(undefined).confidence, 'estimated');
check('and says how to check it',
  conversionConfidence(undefined).why.includes('Check Quota'), true);
check('agreement makes it a measurement', conversionConfidence(cov('complete')).confidence, 'measured');
check('with nothing to caveat', conversionConfidence(cov('complete')).why, undefined);
check('measuring more than billed impugns it', conversionConfidence(cov('over')).confidence, 'estimated');
check('and names the setting', conversionConfidence(cov('over')).why.includes('creditsPerNanoAiu'), true);

// A shortfall is spend elsewhere. That says nothing about the multiplier
// either way, so it leaves it unconfirmed rather than blaming it.
check('a partial match leaves it unconfirmed', conversionConfidence(cov('partial')).confidence, 'estimated');
check('without claiming it is wrong',
  conversionConfidence(cov('partial')).why.includes('probably wrong'), false);
check('a hand-set conversion is still unverified',
  conversionConfidence(undefined, true).confidence, 'estimated');
check('and the wording says so', conversionConfidence(undefined, true).why.includes('you set'), true);

console.log('\nand what findings make of that');
const rollup = {
  day: '2026-08-26', model: 'm', workspace: 'w', operation: 'chat', selection: 'manual',
  source: 'measured', requests: 20, inputTokens: 100000, outputTokens: 5000,
  reasoningTokens: 0, cacheReadTokens: 90000, cacheWriteTokens: 0, nanoAiu: 20e9,
  missRequests: 4, missInputTokens: 40000, missNanoAiu: 12e9
};
const withConv = c => advise([rollup], 1e-9, {}, undefined, undefined, c);
check('a confirmed conversion leaves findings measured',
  withConv({ confidence: 'measured' })[0].confidence, 'measured');
check('an unconfirmed one weakens them',
  withConv(conversionConfidence(undefined))[0].confidence, 'estimated');
check('and carries the reason to the reader',
  withConv(conversionConfidence(undefined))[0].why.includes('Check Quota'), true);
check('the default is not to weaken, so existing callers are unaffected',
  advise([rollup], 1e-9, {}, undefined)[0].confidence, 'measured');

console.log('\nthe first day of a period belongs to it, wherever you are');
{
  // Run out of process, because Date caches the zone: the point is a machine
  // actually running east of UTC, not a variable set after the fact.
  const probe = `
    const { periodCoverage } = require('${new URL('../out/reconcile.js', import.meta.url).pathname}');
    const r = periodCoverage({
      resetDate: '2026-10-01',
      githubCredits: 990,
      creditsByDay: new Map([
        ['2026-09-01', { credits: 240, requests: 500 }],
        ['2026-09-02', { credits: 70, requests: 161 }]
      ]),
      traceStartMs: Date.parse('2026-08-27T00:00:00Z'),
      billedByDay: new Map([['2026-09-01', 690], ['2026-09-02', 300]]),
      now: Date.parse('2026-09-02T15:43:00Z')
    });
    process.stdout.write(JSON.stringify({
      local: r.localCredits, billed: r.billedInPeriod, verdict: r.verdict }));
  `;
  const run = tz => JSON.parse(execFileSync(process.execPath, ['-e', probe],
    { encoding: 'utf8', env: { ...process.env, TZ: tz } }));

  const utc = run('UTC');
  // +05:30: local midnight on the 1st is 18:30 on the 31st, half a day the
  // wrong side of a UTC period start.
  const ist = run('Asia/Kolkata');
  // -08:00, to catch a fix that merely leans the other way.
  const la = run('America/Los_Angeles');

  check('the period\'s first day counts in UTC', utc.local, 310);
  check('and east of it', ist.local, 310);
  check('and west of it', la.local, 310);
  check('the billed total does not move with the zone either', ist.billed, 990);

  // What the drop actually cost: 690 of 990 credits reported as spend on a
  // machine that does not exist.
  check('so a fresh period is not blamed on another machine', ist.verdict, 'unattributed');
}

console.log('\nwhat this machine could not attribute is not spend elsewhere');
{
  const day = (a, b) => new Map([['2026-09-01', a], ['2026-09-02', b]]);
  const base = {
    resetDate: '2026-10-01', githubCredits: 990,
    creditsByDay: new Map([['2026-09-01', { credits: 240, requests: 500 }],
      ['2026-09-02', { credits: 70, requests: 161 }]]),
    traceStartMs: Date.parse('2026-08-27T00:00:00Z'),
    now: Date.parse('2026-09-02T10:13:00Z')
  };

  // GitHub's own total, differenced per day, accounts for the whole period --
  // so every credit was spent on a day this install was running. It could only
  // pin 310 of them to messages, which is a measurement gap, not a location.
  const seen = periodCoverage({ ...base, billedByDay: day(690, 300) });
  check('all of it seen here is not partial coverage', seen.verdict, 'unattributed');
  check('and the note does not invent another machine',
    /another machine|another editor|github\.com/.test(seen.note), false);
  check('it names the real cause instead', /no cost|conversion/.test(seen.note), true);

  // The genuine case survives: this machine was off for the first day, so the
  // billed record cannot account for the period and the spend really is
  // somewhere it could not see.
  const missed = periodCoverage({ ...base, billedByDay: day(0, 300) });
  check('a period this machine did not watch is still partial', missed.verdict, 'partial');
  check('and that note does say elsewhere',
    /another machine/.test(missed.note), true);

  // No billed record at all -- an install too new to have one. Nothing is
  // claimed either way beyond what was already claimed.
  const blind = periodCoverage({ ...base, billedByDay: undefined });
  check('and with no billed record it is unchanged', blind.verdict, 'partial');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
