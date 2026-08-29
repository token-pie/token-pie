#!/usr/bin/env node
/**
 * Projection maths, including the cases that decide the status bar colour.
 *
 * Pinned to UTC, and set before the module under test is loaded.
 *
 * A burn rate is credits over elapsed days; a day key is a LOCAL calendar day;
 * a reset date is a UTC instant from GitHub. Where local midnight falls
 * therefore moves the denominator and the horizon, and that is correct -- a
 * developer in +14 really does have different day boundaries. What is not
 * correct is a test asserting "6h left" without saying which zone it means.
 * It passed for a year on machines west of UTC and failed the first time the
 * release workflow ran it on a runner set to UTC.
 */
process.env.TZ = 'UTC';

const { project, statusLabel, barLabel, dayLabel, dayPressure } = await import('../out/projection.js');
const { defaults } = await import('../out/tuning.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const NOW = Date.parse('2026-08-26T12:00:00Z');

/** A day key, built the way ingest's dayKey() builds them: local, which is UTC here. */
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` +
         `-${String(d.getDate()).padStart(2, '0')}`;
};
const ent = (remaining, entitlement, resetDate) => ({
  snapshots: [{ name: 'premium_interactions', entitlement, remaining, remainingExact: remaining,
                percentRemaining: (remaining / entitlement) * 100, hasQuota: true, unlimited: false }],
  resetDate
});
// `days` days of history ending now, spending `credits` in total.
const roll = (credits, days) => {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = dayKey(NOW - i * 86400000);
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
// 5 day keys spanning 4.5 days to noon, 100 credits => 22.22/day; 5 remaining
// is 0.225 days, or 5.4 hours. The 6h this used to expect was the same sum in
// a timezone where local midnight falls earlier, making the window 4.73 days.
p = project(ent(5, 1500, '2026-09-05T00:00:00.000Z'), roll(100, 5), 1e-9, NOW);
check('label in hours', statusLabel(p), '5h left');

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

console.log('\ntoday, against what today was allowed to cost');
const onDay = (nano, day = dayKey(NOW), source = 'measured') => ({
  day, model: 'm', workspace: 'w', operation: 'chat', selection: 'manual', source,
  requests: 1, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: nano
});
{
  // Nothing set, so it falls back to the sustainable pace: what remains over
  // the days left is already the pace that lasts to the reset. A budget exists
  // before anyone configures one.
  const p = project(ent(100, 1500, '2026-09-01T00:00:00.000Z'), [onDay(9e9)], 1e-9, NOW);
  // Whole calendar days, counting today, up to the day the allowance refills.
  check('whole days are what it divides by', p.daysToCover, 6);
  check('a budget exists without one being set', Math.round(p.todayBudget), 18);
  check('and it is what today had over those days',
    Math.round(p.todayBudget), Math.round((100 + 9) / p.daysToCover));
  check('today is measured', p.todayCredits, 9);
  check('and stated as a share of it', Math.round(p.todayShare * 100), 50);
  check('which is what the bar says', dayLabel(p), '50% used today');
  check('and it is not pressing yet', dayPressure(p), 'under');
  // A bare percentage beside "97% left" would be read as remaining. Only one
  // of the two readings is a reason to stop.
  check('the direction is stated, never implied', dayLabel(p).includes('used'), true);
}
{
  // A figure that is set overrides the pace: it is a stricter promise.
  const t = defaults();
  t.projection.dailyBudgetPercent = 1;           // 1% of 1500 = 15 credits
  const at = n => project(ent(100, 1500, '2026-09-01T00:00:00.000Z'), [onDay(n)], 1e-9, NOW, t);
  check('the setting wins over the pace', at(1e9).todayBudget, 15);
  check('under the warn line', dayPressure(at(9e9), t), 'under');
  check('at the warn line', dayPressure(at(12e9), t), 'near');
  check('at the budget', dayPressure(at(15e9), t), 'over');
  // Not clamped: a figure that stopped at 100 would hide how far over it went.
  check('and past it, uncapped', dayLabel(at(18e9)), '120% used today');
}

console.log('\na budget you can spend to the line');
{
  // 1000 at the start of today, 10 days to reset: the pace is 100 a day. The
  // denominator is what today HAD, not what is left now -- `remaining` already
  // has today's spend taken out, so dividing by it shrank the budget as the
  // spend against it grew. Exactly 100 spent reported 111% used over ten days
  // and 159% over three, and a budget that recedes cannot be spent to.
  const at = (spent, days = 10) => project(
    { snapshots: [{ name: 'q', entitlement: 1500, remaining: 1000 - spent,
      remainingExact: 1000 - spent, percentRemaining: (1000 - spent) / 15,
      hasQuota: true, unlimited: false }],
      resetDate: new Date(NOW + days * 86400000).toISOString() },
    [onDay(spent * 1e9)], 1e-9, NOW);
  check('the budget does not move as the day is spent',
    [0, 50, 100, 200].map(n => Math.round(at(n).todayBudget)).join(), '100,100,100,100');
  check('nothing spent is nothing used', Math.round(at(0).todayShare * 100), 0);
  check('half of it is half used', Math.round(at(50).todayShare * 100), 50);
  check('spending exactly the pace is exactly full', Math.round(at(100).todayShare * 100), 100);
  check('and twice it is twice', Math.round(at(200).todayShare * 100), 200);
  // The error grew as the reset approached, which is when the figure matters.
  check('and it holds with the reset in sight',
    Math.round(at(100, 2.7).todayShare * 100), 30);
}

console.log('\ntwo horizons on one item');
{
  const at = (rem, days, spent) => project(
    { snapshots: [{ name: 'q', entitlement: 1500, remaining: rem, remainingExact: rem,
      percentRemaining: rem / 15, hasQuota: true, unlimited: false }],
      resetDate: new Date(NOW + days * 86400000).toISOString() },
    [onDay(spent * 1e9)], 1e-9, NOW);

  // Two percentages side by side with different denominators is the reading
  // problem: 97% is of the allowance, 30% is of today's share of it.
  check('the month is named when both are percentages',
    barLabel(at(1456, 3, 0)), '97% left this month · 0% used today');
  // ...and only then. "3.3d to reset this month" is not a sentence, and no
  // reader was going to take a day figure beside it for a share of a month.
  check('and not when it is a duration',
    barLabel(at(0, 3, 200)).includes('this month'), false);
  check('an exhausted allowance says only when it returns',
    barLabel(at(0, 3, 200)), '3.0d to reset');
  // Over the day, framed as used. As remaining this reads "-18% left" exactly
  // when the item turns red, which is when it has to be at its clearest.
  check('over the day still reads forwards',
    barLabel(at(1000, 3, 400)).endsWith('86% used today'), true);
}

console.log('\nwhat cannot be a budget');
{
  // Nothing to pace against, so no figure rather than a percentage of an unknown.
  const none = project(undefined, [onDay(9e9)], 1e-9, NOW);
  check('an unlimited plan gets no day figure', dayLabel(none), undefined);
  check('and no pressure to report', dayPressure(none), undefined);
}

console.log('\nyesterday is not today, and a floor is not a measurement');
{
  const p = project(ent(100, 1500, '2026-09-01T00:00:00.000Z'),
    [onDay(99e9, dayKey(NOW - 86400000)), onDay(9e9)], 1e-9, NOW);
  check('only today counts', p.todayCredits, 9);
  // Backfill omits retried and cancelled messages, so a budget checked against
  // it says you have room you may not have.
  const floored = project(ent(100, 1500, '2026-09-01T00:00:00.000Z'),
    [onDay(50e9, dayKey(NOW), 'reported'), onDay(9e9)], 1e-9, NOW);
  check('and only what was measured', floored.todayCredits, 9);
}

console.log(failures === 0 ? '\nAll projection checks passed.\n' : `\n${failures} failed.\n`);
process.exit(failures ? 1 : 0);
