#!/usr/bin/env node
/**
 * Two credit figures, one panel.
 *
 * The meter reads GitHub's consumption for the period; the breakdown reads
 * ours. The cases that matter are the ones where a difference means something
 * different: unseen spend on another machine, a miscalibrated conversion, and
 * the one that looks like unseen spend but is only a short history.
 */
import { periodCoverage, periodStartFrom, conversionConfidence } from '../out/reconcile.js';
import { advise } from '../out/advice.js';

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
  resetDate: RESET, githubCredits: 22.6, creditsByDay: history(RESET, 22.4)
});
check('within rounding and 5% is agreement', complete.verdict, 'complete');
check('and the note does not allege unseen spend', complete.note.includes('outside'), false);

console.log('\nunseen spend');
const partial = periodCoverage({
  resetDate: RESET, githubCredits: 40, creditsByDay: history(RESET, 22)
});
check('a large shortfall is spend elsewhere', partial.verdict, 'partial');
check('the gap is reported, not the ratio alone', Math.round(partial.unaccounted), 18);
check('share is the fraction we explain', Math.round(partial.share * 100), 55);

console.log('\nmeasuring more than we were billed');
const over = periodCoverage({
  resetDate: RESET, githubCredits: 10, creditsByDay: history(RESET, 30)
});
check('points at the conversion, not at other machines', over.verdict, 'over');
check('and names the setting to check', over.note.includes('creditsPerNanoAiu'), true);

// The case this guard exists for: a fresh install two days old, mid-period.
// Its 2 credits against GitHub's 40 is not evidence of 38 spent elsewhere.
console.log('\na short history is not evidence');
const short = periodCoverage({
  resetDate: RESET, githubCredits: 40, creditsByDay: recent(2, 2)
});
check('history starting mid-period is inconclusive', short.verdict, 'inconclusive');
check('and says why', short.note.includes('into the'), true);

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
