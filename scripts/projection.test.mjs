#!/usr/bin/env node
/** Projection maths, including the cases that decide the status bar colour. */
import { project, statusLabel } from '../out/projection.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const NOW = Date.parse('2026-08-26T12:00:00Z');
const ent = (remaining, entitlement, resetDate) => ({
  snapshots: [{ name: 'premium_interactions', entitlement, remaining, remainingExact: remaining,
                percentRemaining: (remaining / entitlement) * 100, hasQuota: true, unlimited: false }],
  resetDate
});
// `days` days of history ending now, spending `credits` in total.
const roll = (credits, days) => {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(NOW - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, model: 'm', workspace: 'w', operation: 'chat', selection: 'manual', requests: 1,
               inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
               cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: (credits / days) / 1e-9 });
  }
  return out;
};

console.log('\nwill exhaust before reset');
// 100 left, 20/day, resets in 10 days -> gone in 5.
let p = project(ent(100, 1500, '2026-09-05T00:00:00.000Z'), roll(100, 5), 1e-9, NOW);
check('verdict', p.verdict, 'will-exhaust');
// roll() lays days back from now, so elapsed is ~4.x days and the rate is
// correspondingly higher. Assert the shape and a sane range, not a magic number.
check('days to exhaust in range', p.daysToExhaust > 4 && p.daysToExhaust < 6, true);
check('label shape', /^\d\.\dd left$/.test(statusLabel(p)), true);
check('exhaust date is before reset', p.exhaustDate < new Date('2026-09-05'), true);

console.log('\ncomfortably on track');
// 1400 left, 20/day, resets in 6 days.
p = project(ent(1400, 1500, '2026-09-01T00:00:00.000Z'), roll(100, 5), 1e-9, NOW);
check('verdict', p.verdict, 'ok');
check('label shows percent', statusLabel(p), '93% left');
// Bare "93%" reads as easily as 93% used, which is the opposite and alarming.
check('and says which direction it means', statusLabel(p).endsWith(' left'), true);

console.log('\ntight: survives the period but barely');
// 130 left, 20/day => 6.5 days; resets in 6 days.
p = project(ent(130, 1500, '2026-09-01T00:00:00.000Z'), roll(100, 5), 1e-9, NOW);
check('verdict', p.verdict, 'tight');

console.log('\nguards');
check('no entitlement', project(undefined, roll(100, 5), 1e-9, NOW).verdict, 'unknown');
check('no history yet', project(ent(100, 1500, '2026-09-01T00:00:00.000Z'), [], 1e-9, NOW).verdict, 'no-rate');
// A single burst on one day must not project a rate.
check('too little history', project(ent(100, 1500, '2026-09-01T00:00:00.000Z'), roll(50, 1), 1e-9, NOW).verdict, 'no-rate');
p = project(ent(100, 1500, '2026-09-01T00:00:00.000Z'), [], 1e-9, NOW);
// 100 remaining over the 5.5 days until reset.
check('sustainable burn still offered', Math.round(p.sustainableDailyBurn), 18);

console.log('\nsub-day horizon renders as hours');
p = project(ent(5, 1500, '2026-09-05T00:00:00.000Z'), roll(100, 5), 1e-9, NOW);
check('label in hours', statusLabel(p), '6h left');

console.log('\nan exhausted allowance');
const spent = { snapshots: [{ name: 'premium_interactions', entitlement: 10000,
  remaining: 0, remainingExact: 0, percentRemaining: 0, creditsUsed: 19114,
  hasQuota: false, unlimited: false }], resetDate: '2026-09-01T00:00:00.000Z' };
let x = project(spent, roll(400, 5), 1e-9, NOW);
check('verdict', x.verdict, 'exhausted');
check('no burn rate is projected from it', x.daysToExhaust, undefined);
check('what GitHub says was spent is carried', x.creditsUsed, 19114);
check('the label counts to the reset', /^\d+(\.\d)?d to reset$/.test(statusLabel(x)), true);
check('percent remaining is zero', x.percentRemaining, 0);

console.log('\nunknown is not one situation');
// Each of these told the user "no quota data yet, run Check Quota". For the
// last three that command has already run and cannot resolve the state, so the
// instruction has no effect.
check('not signed in', project(undefined, [], 1e-9, NOW).unknownReason, 'not-signed-in');

const unlimitedOnly = { snapshots: [
  { name: 'chat', unlimited: true, hasQuota: true },
  { name: 'completions', unlimited: true, hasQuota: true }], resetDate: undefined };
check('signed in, every allowance unlimited',
  project(unlimitedOnly, [], 1e-9, NOW).unknownReason, 'no-binding-quota');

const phantomOnly = { snapshots: [
  { name: 'premium_interactions', entitlement: 0, remaining: 0, hasQuota: false }],
  resetDate: undefined };
check('signed in, only phantom allowances',
  project(phantomOnly, [], 1e-9, NOW).unknownReason, 'no-binding-quota');

const noRemaining = { snapshots: [
  { name: 'chat', entitlement: 300, hasQuota: true, unlimited: false }], resetDate: undefined };
check('a limit but no remaining figure',
  project(noRemaining, [], 1e-9, NOW).unknownReason, 'no-remaining-figure');

console.log(failures === 0 ? '\nAll projection checks passed.\n' : `\n${failures} failed.\n`);
process.exit(failures ? 1 : 0);
