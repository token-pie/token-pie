#!/usr/bin/env node
/**
 * The gate ladder as data.
 *
 * Two things have to hold for the knobs to be trustworthy: a value typed by
 * hand into settings.json cannot break the pipeline, and every knob has to be
 * reachable from the panel that claims to show it. The rest is bookkeeping the
 * build enforces.
 */
import { KNOBS, defaults, read, contributions } from '../out/tuning.js';
import { advise } from '../out/advice.js';
import { solve } from '../out/pricing.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log('the ladder is well formed');
check('every knob has a unique id', new Set(KNOBS.map(k => k.id)).size, KNOBS.length);
check('every id is group.name', KNOBS.every(k => /^[a-z]+\.[a-zA-Z0-9]+$/.test(k.id)), true);
check('every knob says what it gates', KNOBS.every(k => k.gates.length > 10), true);
check('and why that value', KNOBS.every(k => k.why.length > 20), true);
check('and whether that value was derived or judged',
  KNOBS.every(k => k.basis === 'derived' || k.basis === 'judged'), true);
check('defaults sit inside their own bounds', KNOBS.every(k =>
  (k.min === undefined || k.default >= k.min) &&
  (k.max === undefined || k.default <= k.max)), true);

console.log('\nreading');
const { tuning, readings } = read(() => undefined);
check('nothing set reads as defaults',
  JSON.stringify(tuning), JSON.stringify(defaults()));
check('and nothing is marked overridden', readings.some(r => r.overridden), false);

const set = read(id => (id === 'advice.minHistoryRequests' ? 25 : undefined));
check('a set value is taken', set.tuning.advice.minHistoryRequests, 25);
check('and marked as overridden',
  set.readings.find(r => r.knob.id === 'advice.minHistoryRequests').overridden, true);
check('while its neighbours stay default', set.tuning.advice.minCreditsAtStake, 0.5);

// settings.json is hand-edited and validated by nothing before it reaches here.
// A minObservations of -5 would not loosen the gate, it would remove it.
console.log('\nhostile values are clamped, not obeyed');
check('below the floor clamps up', read(() => -5).tuning.pricing.minObservations, 4);
check('above the ceiling clamps down', read(() => 99).tuning.pricing.minR2, 1);
check('a string is ignored', read(() => 'lots').tuning.advice.minHistoryRequests, 10);
check('NaN is ignored', read(() => NaN).tuning.advice.minHistoryRequests, 10);
// Clamping silently would be the worst of both: the developer reads 0.99 back
// out of their own settings file and believes the gate moved.
const clamped = read(() => -5).readings.find(r => r.knob.id === 'pricing.minObservations');
check('a clamped value still counts as an override', clamped.overridden, true);
check('and reports what was actually asked for', clamped.requested, -5);
check('an accepted value reports no discrepancy',
  read(id => (id === 'pricing.minObservations' ? 8 : undefined))
    .readings.find(r => r.knob.id === 'pricing.minObservations').requested, undefined);

// A knob nothing reads is a lie told in a settings page.
console.log('\nthe knobs actually reach the code');
const stats = { n: 8, xx: [1, 0, 0, 1, 0, 1], xy: [1, 1, 1], sy: 3, syy: 3 };
check('minObservations withholds a rate card',
  solve(stats, 1e-9, read(id => (id === 'pricing.minObservations' ? 20 : undefined)).tuning),
  undefined);

const rollup = (over) => ({
  day: '2026-08-26', model: 'm', workspace: 'w', operation: 'chat', selection: 'manual',
  source: 'measured', requests: 20, inputTokens: 100000, outputTokens: 5000,
  reasoningTokens: 0, cacheReadTokens: 90000, cacheWriteTokens: 0, nanoAiu: 20e9,
  missRequests: 4, missInputTokens: 40000, missNanoAiu: 12e9, ...over
});
check('advice appears at the default floor', advise([rollup()], 1e-9, {}, undefined).length > 0, true);
check('and is withheld when the history floor is raised past it',
  advise([rollup()], 1e-9, {}, undefined,
    read(id => (id === 'advice.minHistoryRequests' ? 50 : undefined)).tuning).length, 0);
check('and when the materiality floor is raised past it',
  advise([rollup()], 1e-9, {}, undefined,
    read(id => (id === 'advice.minShareAtStake' ? 0.99 : undefined)
      ?? undefined).tuning).length, 0);

console.log('\nsettings projection');
const props = contributions();
check('one setting per knob', Object.keys(props).length, KNOBS.length);
check('all namespaced', Object.keys(props).every(k => k.startsWith('tokenPie.')), true);
check('each carries its rationale into the settings UI',
  Object.values(props).every(v => v.markdownDescription.includes('_')), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
