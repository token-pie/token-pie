#!/usr/bin/env node
/**
 * The rate-card fit. It claims to recover real prices, so it has to recover a
 * known one exactly and refuse when the evidence does not support one.
 */
import { emptyStats, accumulate, solve, costOf, mergeStats } from '../out/pricing.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};
const near = (label, actual, expected, tol) => {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const CR = 1e-9;
// The real claude-sonnet-5 card, in credits per 1k tokens.
const CARD = { fresh: 0.25, cached: 0.02, output: 1.00 };
const bill = (f, c, o) => ((f * CARD.fresh + c * CARD.cached + o * CARD.output) / 1000) / CR;

console.log('\nrecovers a known rate card');
// Recorded spans from a real session, to the token.
const real = [[24401, 0, 342], [1, 24400, 359], [596, 24400, 627], [864, 24995, 709],
              [945, 25858, 763], [998, 26802, 778], [3161, 27799, 754]];
let s = emptyStats();
for (const [f, c, o] of real) accumulate(s, f, c, o, bill(f, c, o));
let p = solve(s, CR);
check('a price is returned', Boolean(p), true);
near('fresh input', p.fresh, 0.25, 1e-6);
near('cached input', p.cached, 0.02, 1e-6);
near('output', p.output, 1.00, 1e-6);
near('output is 4x fresh input', p.output / p.fresh, 4, 1e-5);
near('cached is 0.08x fresh input', p.cached / p.fresh, 0.08, 1e-5);
near('perfect fit', p.r2, 1, 1e-9);
check('observation count reported', p.n, 7);
near('costOf reproduces a bill', costOf(p, 3161, 27799, 754), 2.10023, 1e-4);

console.log('\nrefuses when the evidence does not support a card');
s = emptyStats();
for (const [f, c, o] of real.slice(0, 5)) accumulate(s, f, c, o, bill(f, c, o));
check('five observations is too few', solve(s, CR), undefined);

// Every request identical: the classes cannot be separated.
s = emptyStats();
for (let i = 0; i < 8; i++) accumulate(s, 1000, 5000, 200, bill(1000, 5000, 200));
check('collinear observations rejected', solve(s, CR), undefined);

// Costs that are not a linear rate card at all.
s = emptyStats();
for (const [f, c, o] of real) accumulate(s, f, c, o, bill(f, c, o) * (1 + Math.sin(f) * 0.4));
check('a poor fit is rejected', solve(s, CR), undefined);

// Zero-cost requests carry no rate information and must not drag it down.
s = emptyStats();
for (const [f, c, o] of real) accumulate(s, f, c, o, bill(f, c, o));
for (let i = 0; i < 10; i++) accumulate(s, 250, 0, 70, 0);
p = solve(s, CR);
near('free requests ignored', p.output / p.fresh, 4, 1e-5);
check('and not counted as observations', p.n, 7);

console.log('\nstatistics are additive');
const a = emptyStats(), b = emptyStats();
real.slice(0, 4).forEach(([f, c, o]) => accumulate(a, f, c, o, bill(f, c, o)));
real.slice(4).forEach(([f, c, o]) => accumulate(b, f, c, o, bill(f, c, o)));
const merged = solve(mergeStats(a, b), CR);
near('merged halves match the whole', merged.output / merged.fresh, 4, 1e-5);
check('merged observation count', merged.n, 7);

console.log('\nthe credits constant scales the card');
p = solve(s, 2e-9);
near('doubling the constant doubles the price', p.fresh, 0.5, 1e-6);

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
