#!/usr/bin/env node
/**
 * The recommendations. Every card makes a numeric claim about the user's own
 * spend, so every card needs a fixture that pins the arithmetic.
 */
import { advise, cacheSplit, selectionMix } from '../out/advice.js';
import { emptyStats, accumulate } from '../out/pricing.js';

/** Sufficient statistics for a model that bills exactly at `card`. */
const statsFor = (card) => {
  const s = emptyStats();
  // Non-collinear baskets, enough of them to clear MIN_OBSERVATIONS.
  for (const [f, c, o] of [[20000, 0, 300], [500, 19000, 700], [3000, 21000, 250],
                           [800, 24000, 900], [12000, 5000, 120], [200, 30000, 640],
                           [7000, 11000, 480]])
    accumulate(s, f, c, o, ((f * card.fresh + c * card.cached + o * card.output) / 1000) / CR);
  return s;
};
const SONNET_CARD = { fresh: 0.25, cached: 0.02, output: 1.00 };
const LUNA_CARD = { fresh: 0.02, cached: 0.002, output: 0.08 };

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};
const near = (label, actual, expected, tol = 1e-6) => {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const CR = 1e-9;                       // credits per nano-AIU
const nano = credits => credits / CR;

const row = (o) => ({
  day: '2026-08-26', workspace: 'w', operation: 'panel/editAgent', selection: 'manual',
  requests: 1, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 0,
  missRequests: 0, missInputTokens: 0, missNanoAiu: 0, ...o
});

/* 5 cached requests at 5e-5 cr/token, 2 uncached at 3e-4 cr/token. */
const sonnet = row({
  model: 'claude-sonnet-5', requests: 7,
  inputTokens: 180_000, outputTokens: 4_800, cacheReadTokens: 130_000,
  nanoAiu: nano(19.00),
  missRequests: 2, missInputTokens: 40_000, missNanoAiu: nano(12.00)
});
const luna = row({
  model: 'gpt-5.6-luna', requests: 3,
  inputTokens: 55_000, outputTokens: 300, cacheReadTokens: 50_000,
  nanoAiu: nano(0.93)
});

console.log('\ncache split arithmetic');
const split = cacheSplit('claude-sonnet-5', sonnet, CR);
near('cached rate, credits per token', split.hitRate, 5e-5, 1e-12);
near('uncached rate, credits per token', split.missRate, 3e-4, 1e-12);
near('cost multiple', split.factor, 6, 1e-9);
near('excess credits over cached rates', split.excessCredits, 10, 1e-6);
check('baseline request count', split.hitRequests, 5);

console.log('\ncache advice on a mixed model');
let out = advise([sonnet, luna], CR);
const cache = out.find(a => a.id === 'cache-miss');
check('card produced', Boolean(cache), true);
near('stake is the measured excess', cache.creditsAtStake, 10, 1e-6);
check('stake is measured, not a bound', cache.bounded, false);
check('headline carries the request count', cache.headline.includes('2 requests'), true);
check('evidence names the model', cache.evidence.includes('claude-sonnet-5'), true);

console.log('\nmeasured findings outrank larger bounded ones');
const mix = out.find(a => a.id === 'model-mix');
check('model-mix card produced', Boolean(mix), true);
check('model-mix is a bound', mix.bounded, true);
check('its stake is the larger number', mix.creditsAtStake > cache.creditsAtStake, true);
check('yet cache-miss is ranked first', out[0].id, 'cache-miss');
near('bound assumes every turn could move', mix.creditsAtStake, 19 * (1 - (0.93 / 55_300) / (19 / 184_800)), 1e-6);

console.log('\nguards');
// One cached request is not a baseline rate.
const thin = row({ model: 'm', requests: 2, inputTokens: 40_000, outputTokens: 100,
  cacheReadTokens: 19_000, nanoAiu: nano(6),
  missRequests: 1, missInputTokens: 20_000, missNanoAiu: nano(5) });
check('single-sample baseline rejected', cacheSplit('m', thin, CR), undefined);

// Uncached costing 1.2x cached is variance, not a finding.
const mild = row({ model: 'm', requests: 6, inputTokens: 60_000, outputTokens: 400,
  cacheReadTokens: 40_000, nanoAiu: nano(5.2),
  missRequests: 2, missInputTokens: 20_000, missNanoAiu: nano(1.2) });
check('sub-threshold multiple produces no card',
  advise([mild], CR).some(a => a.id === 'cache-miss'), false);

// A model that never missed cannot produce a cache finding.
check('all-cached model produces no card',
  advise([luna], CR).some(a => a.id === 'cache-miss'), false);
check('empty rollup produces nothing', advise([], CR).length, 0);
check('zero-cost rollup produces nothing',
  advise([row({ model: 'm', requests: 4, inputTokens: 8_000, outputTokens: 40 })], CR).length, 0);

console.log('\nbackground requests');
const title = row({ model: 'gpt-4o-mini', operation: 'title', requests: 8,
  inputTokens: 12_000, outputTokens: 200, cacheReadTokens: 6_000, nanoAiu: nano(4.0),
  missRequests: 4, missInputTokens: 6_000, missNanoAiu: nano(2.0) });
out = advise([sonnet, title], CR);
const aux = out.find(a => a.id === 'auxiliary');
check('card produced', Boolean(aux), true);
near('stake is the background spend', aux.creditsAtStake, 4.0, 1e-6);
check('user-facing agent excluded from it', aux.evidence.includes('panel/editAgent'), false);
check('background operation named', aux.evidence.includes('title'), true);

console.log('\nauto-selected models');
// Same spend, but Auto chose the expensive model rather than the user.
const autoSonnet = { ...sonnet, selection: 'auto' };
const autoOnly = selectionMix([autoSonnet, luna], 'claude-sonnet-5', CR);
check('dominant selection', autoOnly.dominant, 'auto');
near('auto share of that spend', autoOnly.autoShare, 1, 1e-9);

out = advise([autoSonnet, luna], CR);
const autoMix = out.find(a => a.id === 'model-mix');
check('headline names Auto as the chooser', autoMix.headline.startsWith('Auto picked'), true);
check('remedy is not "switch models"', autoMix.detail.includes('"switch models" is not the lever'), true);
check('evidence reports the auto share', autoMix.evidence.includes('100% of that spend auto-selected'), true);
const autoCache = out.find(a => a.id === 'cache-miss');
check('cache remedy blames Auto for the switching',
  autoCache.detail.includes('Auto is doing the switching here'), true);

// Hand-picked spend keeps the original framing.
out = advise([sonnet, luna], CR);
check('manual headline unchanged',
  out.find(a => a.id === 'model-mix').headline.startsWith('claude-sonnet-5 took'), true);
check('manual cache remedy unchanged',
  out.find(a => a.id === 'cache-miss').detail.includes('Finishing a thread on the model'), true);

// A model reached both ways reports the split rather than picking a side.
const half = { ...sonnet, nanoAiu: sonnet.nanoAiu / 2, missNanoAiu: sonnet.missNanoAiu / 2 };
const split2 = selectionMix([{ ...half, selection: 'auto' }, { ...half, selection: 'manual' }],
  'claude-sonnet-5', CR);
near('even split reports half auto', split2.autoShare, 0.5, 1e-9);

console.log('\ncache split with a solved rate card');
// 40k tokens re-read fresh at 0.25 that would have cost 0.02 warm.
const exactSplit = cacheSplit('claude-sonnet-5', sonnet, CR,
  { fresh: 0.25, cached: 0.02, output: 1.0, n: 7, r2: 1 });
check('reported as exact', exactSplit.exact, true);
near('multiple is fresh over cached', exactSplit.factor, 12.5, 1e-9);
near('excess is the token delta, no output cost', exactSplit.excessCredits, 9.2, 1e-9);
check('the average-based fallback is not exact',
  cacheSplit('claude-sonnet-5', sonnet, CR).exact, false);

let priced = advise([sonnet, luna], CR, { 'claude-sonnet-5': statsFor(SONNET_CARD) });
const exactCache = priced.find(a => a.id === 'cache-miss');
near('advice uses the exact excess', exactCache.creditsAtStake, 9.2, 1e-6);
check('evidence says no output cost is mixed in',
  exactCache.evidence.includes('no output cost is mixed into either side'), true);
check('unpriced advice says the opposite',
  advise([sonnet, luna], CR).find(a => a.id === 'cache-miss')
    .evidence.includes('output cost is mixed in'), true);

console.log('\nmodel comparison as a priced counterfactual');
priced = advise([sonnet, luna], CR,
  { 'claude-sonnet-5': statsFor(SONNET_CARD), 'gpt-5.6-luna': statsFor(LUNA_CARD) });
const mixExact = priced.find(a => a.id === 'model-mix');
// sonnet's own basket: 50k fresh, 130k cached, 4.8k output.
const at = (card) => (50000 * card.fresh + 130000 * card.cached + 4800 * card.output) / 1000;
near('saving is the re-priced basket', mixExact.creditsAtStake, 19 - at(LUNA_CARD), 1e-6);
check('headline states the counterfactual cost',
  mixExact.headline.includes(`would have cost ${at(LUNA_CARD).toFixed(2)}`), true);
check('evidence names the basket', mixExact.evidence.includes('fresh + 130.0k cached'), true);
check('still labelled a bound', mixExact.bounded, true);
check('and says why it remains one',
  mixExact.detail.includes('same number of turns'), true);
check('unpriced comparison admits it is confounded',
  advise([sonnet, luna], CR).find(a => a.id === 'model-mix')
    .evidence.includes('confounded by output mix'), true);

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
