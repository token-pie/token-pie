#!/usr/bin/env node
/**
 * The ranking of doubt.
 *
 * `weakest` is the rule that stops a badge being forgotten downstream, so the
 * cases that matter here are the combining ones: a measured total built on an
 * estimated conversion is estimated, and nothing ever combines its way back to
 * being a measurement.
 */
import { CONFIDENCE_ORDER, rank, weakest, measured, bounded, estimated, prefix }
  from '../out/confidence.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log('ordering');
check('measured is the most trustworthy', rank('measured'), 0);
check('estimated is the least', rank('estimated'), CONFIDENCE_ORDER.length - 1);
check('bounded sits between', rank('bounded') > rank('measured') && rank('bounded') < rank('estimated'), true);

console.log('\ncombining always weakens');
check('no inputs is a measurement', weakest(), 'measured');
check('all measured stays measured', weakest('measured', 'measured'), 'measured');
check('one bound weakens the whole', weakest('measured', 'bounded'), 'bounded');
check('an estimate dominates a bound', weakest('bounded', 'estimated'), 'estimated');
check('order of inputs is irrelevant', weakest('estimated', 'measured'), weakest('measured', 'estimated'));

// The case this rule exists for: every credit figure in the panel is built on
// the nano-AIU conversion. If that is ever solved rather than assumed, the
// totals inherit the doubt even though the token counts are exact.
check('an estimated conversion taints an exact count',
  weakest('measured', 'measured', 'estimated'), 'estimated');

console.log('\nconstructors');
check('measured carries no reason', measured(5).why, undefined);
check('bounded carries its reason', bounded(5, 'assumes X').why, 'assumes X');
check('estimated carries its reason', estimated(5, 'because Y').confidence, 'estimated');
check('the value survives', measured(5).value, 5);

console.log('\nmarks are distinct and never empty-by-accident');
check('a measurement is unmarked', prefix('measured'), '');
check('a bound is marked', prefix('bounded').trim(), '≤');
check('an estimate is marked', prefix('estimated').trim(), '~');
check('the two weak marks differ', prefix('bounded') === prefix('estimated'), false);

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
