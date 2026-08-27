#!/usr/bin/env node
/**
 * Advice across differently-shaped developers.
 *
 * The detectors are hand-written, so the risk is not that they compute wrongly
 * -- the unit tests cover that -- but that they fire confidently on profiles
 * they were never designed against. Each profile below is a developer this
 * would actually be deployed to, and the assertion is as much about *silence*
 * as about advice: a card that appears for everyone is not a finding.
 */
import { advise } from '../out/advice.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const CR = 1e-9, nano = c => c / CR;
const ALLOWANCE = 1477;
const r = o => ({ day: '2026-08-26', workspace: 'w', operation: 'panel/editAgent',
  selection: 'manual', requests: 1, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 0, missRequests: 0, missInputTokens: 0,
  missNanoAiu: 0, ...o });
const ids = (rollups, allowance = ALLOWANCE) =>
  advise(rollups, CR, {}, allowance).map(a => a.id).sort().join(',');

console.log('\nprofiles that must stay silent');
// One model, cache warm throughout: nothing to say, and saying something anyway
// is how a tool trains people to ignore it.
check('disciplined single-model user', ids([
  r({ model: 'sonnet', requests: 40, inputTokens: 900000, outputTokens: 20000,
      cacheReadTokens: 860000, nanoAiu: nano(60) })]), '');

// Five requests is not a habit. An absolute credit floor let this through.
check('light user, 2.2 credits of history', ids([
  r({ model: 'sonnet', requests: 5, inputTokens: 30000, outputTokens: 900,
      cacheReadTokens: 20000, nanoAiu: nano(2.2), missRequests: 2,
      missInputTokens: 10000, missNanoAiu: nano(1.4) })]), '');

check('inline completions only, nothing billed', ids([
  r({ model: 'gpt-mini', operation: 'completions', requests: 900,
      inputTokens: 300000, outputTokens: 12000, nanoAiu: 0 })]), '');

check('no rollups at all', ids([]), '');

console.log('\nthe mini-model trap');
// The dearest agent model must never be compared against the model Copilot
// uses for thread titles: it cannot do the work, so the "saving" is fiction.
const heavy = [
  r({ model: 'sonnet', requests: 400, inputTokens: 9000000, outputTokens: 200000,
      cacheReadTokens: 8000000, nanoAiu: nano(2400) }),
  r({ model: 'gpt-mini', operation: 'title', requests: 300, inputTokens: 400000,
      outputTokens: 9000, nanoAiu: nano(12) })];
check('no cross-context comparison', ids(heavy).includes('model-mix'), false);

// Same numbers, but now the cheap model really is used for the same work.
const substitutable = [
  heavy[0],
  { ...heavy[1], operation: 'panel/editAgent' }];
check('a genuine substitute is compared', ids(substitutable).includes('model-mix'), true);

console.log('\nprofiles that must produce advice');
check('model hopper with a cold cache', ids([
  r({ model: 'sonnet', requests: 20, inputTokens: 500000, outputTokens: 9000,
      cacheReadTokens: 300000, nanoAiu: nano(70), missRequests: 8,
      missInputTokens: 200000, missNanoAiu: nano(50) }),
  r({ model: 'gpt-mini', operation: 'title', requests: 12, inputTokens: 90000,
      outputTokens: 1500, nanoAiu: nano(3) })]), 'cache-miss');

console.log('\nmateriality: urgent, or a real share of spend -- either will do');
// This block used to assert the opposite: that 100,000 credits remaining made
// the identical finding "noise". Observed on a real Business seat -- ~1,500
// credits left against 23 of spend put the floor at ~15 credits, so every card
// was suppressed and the advice section rendered empty. The finding below is
// 48% of everything that developer spent; a large allowance makes it less
// urgent, not less true.
const finding = [
  r({ model: 'sonnet', requests: 12, inputTokens: 260000, outputTokens: 6000,
      cacheReadTokens: 200000, nanoAiu: nano(30), missRequests: 4,
      missInputTokens: 60000, missNanoAiu: nano(18) })];
const stakeAt = allowance =>
  advise(finding, CR, {}, allowance).find(a => a.id === 'cache-miss').creditsAtStake;
check('fires when the allowance is nearly gone', ids(finding, 60).includes('cache-miss'), true);
check('and still fires when it is huge', ids(finding, 100000).includes('cache-miss'), true);
check('because it is half of what they spent', (stakeAt(100000) / 30 > 0.05), true);
// Previously compared one expression to itself and could not fail.
check('the allowance changes urgency, never the stake',
  stakeAt(60).toFixed(4), stakeAt(100000).toFixed(4));

// The protection the old assertion was reaching for, stated correctly: small
// by BOTH measures is still silent, however large the allowance.
check('trivial finding on a big spender stays silent', ids([
  r({ model: 'sonnet', requests: 200, inputTokens: 5000000, outputTokens: 120000,
      cacheReadTokens: 4900000, nanoAiu: nano(400), missRequests: 3,
      missInputTokens: 40000, missNanoAiu: nano(6) })], 100000), '');

console.log('\nno allowance known: fall back to share of spend');
// Called directly: passing `undefined` through `ids` would take its default
// parameter instead, which is how this check first passed for the wrong reason.
const unlimited = advise(finding, CR, {}).map(a => a.id);
check('unlimited plan still gets advice', unlimited.includes('cache-miss'), true);

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
