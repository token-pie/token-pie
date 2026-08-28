#!/usr/bin/env node
/**
 * One model is one row, and a floor says it is a floor.
 *
 * Three defects a work machine's panel showed at once, all of them making the
 * page state something it had not measured:
 *
 *   - `copilot/claude-sonnet-4.6` and `claude-sonnet-4-6` are the same model
 *     and were two rows, so its 359 credits read as 305 and 54 and its share
 *     of spend was split between them.
 *   - `Chosen by` was a column of em-dashes on a machine whose spans never
 *     record who picked the model, which reads as missing data.
 *   - Every credit on the page came from chat transcripts and nothing said so,
 *     under a footer naming the cost record it had never read.
 */
import { renderReport, creditsOf } from '../out/report.js';
import { bareModel, modelKey } from '../out/ratecard.js';
import { selectionMix } from '../out/advice.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const day = new Date().toISOString().slice(0, 10);
const roll = (model, over) => ({
  day, model, workspace: 'w', operation: 'chat', selection: 'unknown',
  source: 'reported', requests: 1, inputTokens: 1000, outputTokens: 100,
  reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 1e9,
  missRequests: 0, missInputTokens: 0, missNanoAiu: 0, ...over
});
const render = rollups => renderReport({
  rollups, creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(),
  costCoverage: 1, warnings: [], prices: {}, depth: {}
});

console.log('a route is not an identity');
check('the vendor prefix goes', bareModel('copilot/claude-opus-4.6'), 'claude-opus-4.6');
check('a doubled gateway prefix goes too',
  bareModel('aitk-foundry/Microsoft Foundry/(AK-AIF)gpt-5.6-luna'), 'gpt-5.6-luna');
check('and the deployment label with it',
  bareModel('Microsoft Foundry/(AK-AIF)gpt-5.6-luna'), 'gpt-5.6-luna');
check('a bare name is left alone', bareModel('claude-sonnet-5'), 'claude-sonnet-5');
// Punctuation differs between the request and response fields, so stripping
// the route is not enough on its own.
check('. and - are the same model', modelKey('copilot/claude-opus-4.6'), modelKey('claude-opus-4-6'));
check('both gateway spellings agree',
  modelKey('aitk-foundry/Microsoft Foundry/(AK-AIF)gpt-5.6-luna'),
  modelKey('Microsoft Foundry/(AK-AIF)gpt-5.6-luna'));
check('different models stay different',
  modelKey('claude-opus-4-6') === modelKey('claude-sonnet-4-6'), false);
check('an empty route does not erase the name', bareModel('/'), '/');

console.log('\ntwo spellings are one row');
{
  const html = render([
    roll('copilot/claude-sonnet-4.6', { requests: 12, nanoAiu: 305e9 }),
    roll('claude-sonnet-4-6', { requests: 2, nanoAiu: 54e9 })
  ]);
  // Scoped to the table: the model is named elsewhere on the page too, and
  // counting across the whole document measured the wrong thing.
  const table = html.slice(html.indexOf('By model'), html.indexOf('By project'));
  check('the model is one row', (table.match(/claude-sonnet-4[.-]6/g) || []).length, 1);
  check('carrying both spellings\' credits', /<td class="num">359<\/td>/.test(table), true);
  check('and both spellings\' messages', /<td class="num">14<\/td>/.test(table), true);
  check('so its share is the whole of it, not half', /100%/.test(table), true);
  // The label is the spelling with the most requests behind it, so the table
  // shows what the account actually uses rather than whichever came first.
  check('labelled by the busier spelling', /claude-sonnet-4\.6/.test(table), true);
}

console.log('\nselection follows identity too');
{
  const rollups = [
    roll('copilot/claude-opus-4.6', { selection: 'auto', nanoAiu: 60e9 }),
    roll('claude-opus-4-6', { selection: 'auto', nanoAiu: 40e9 })
  ];
  // Matched on the raw string, this saw 60 of the 100 credits and could have
  // called a wholly auto-selected model mixed.
  check('both spellings reach the mix',
    selectionMix(rollups, 'claude-opus-4.6', 1e-9).credits, 100);
  check('and the dominant mode is not diluted',
    selectionMix(rollups, 'copilot/claude-opus-4.6', 1e-9).dominant, 'auto');
}

console.log('\na dimension that does not apply is not a column');
{
  const blank = render([roll('claude-sonnet-5'), roll('gpt-5.6-luna')]);
  check('no Chosen by column when nothing reports it', /Chosen by/.test(blank), false);
  check('and no column of dashes standing in for it',
    /<td class="dim sel">/.test(blank), false);
  const known = render([roll('claude-sonnet-5', { selection: 'auto' })]);
  check('the column returns when something does', /Chosen by/.test(known), true);
}

console.log('\na floor says it is a floor');
{
  const all = render([roll('claude-sonnet-5', { source: 'reported' })]);
  check('a wholly backfilled page says nothing was measured',
    /Nothing on this page was measured/.test(all), true);
  check('and does not claim the cost record it never read',
    /Credits come from <code>copilot_chat/.test(all), false);
  check('while still naming what it did read', /copilotCredits/.test(all), true);

  const mixed = render([
    roll('claude-sonnet-5', { source: 'measured', nanoAiu: 30e9 }),
    roll('claude-sonnet-5', { source: 'reported', nanoAiu: 10e9 })
  ]);
  check('a mixed page quantifies the floor', /<strong>10\.00<\/strong> of these/.test(mixed), true);
  check('against the total it is part of', /40\.00 credits come from chat/.test(mixed), true);
  check('and keeps the measured footer', /Credits come from <code>copilot_chat/.test(mixed), true);

  const clean = render([roll('claude-sonnet-5', { source: 'measured' })]);
  check('a measured page says none of it', /come from chat transcripts/.test(clean), false);
}

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
