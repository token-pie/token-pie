#!/usr/bin/env node
/**
 * The models view, against docs/models-view.spec.md.
 *
 * Written from the spec's invariants rather than from the implementation, and
 * every state it names has a fixture here -- including the ones that only
 * exist on a bad day, which is the class this project keeps shipping. Each
 * check below can fail: none of them assert that a function returns what the
 * function computes.
 *
 * Usage: npm run test:models
 */
process.env.TZ = 'UTC';

const fs = await import('node:fs');
const { modelsView, renderModels, compactModels } = await import('../out/models.js');
const { parse } = await import('../out/ratecard.js');

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const card = parse(JSON.parse(fs.readFileSync(new URL('../rate-card.json', import.meta.url))));
if (!card) {
  console.log('  FAIL  the bundled rate card does not parse');
  process.exit(1);
}

const model = (id, name = id, over = {}) => ({ id, name, maxInputTokens: 128000, ...over });
const roll = (id, over = {}) => ({
  day: '2026-09-01', model: id, workspace: 'w', operation: 'chat', selection: 'manual',
  source: 'measured', requests: 4, inputTokens: 1000, outputTokens: 100, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 20e9,
  missRequests: 0, missInputTokens: 0, missNanoAiu: 0, ...over
});
const view = over => modelsView({
  card, rollups: [], prices: {}, creditsPerNanoAiu: 1e-9, minObservations: 6, ...over
});

/* --------------------------------------------------------- the invariants --- */

console.log('no blank money');
{
  // Every offered row either carries a price or says the card has none. A
  // dash where a number belongs is how "0% used today" happened.
  const v = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna'),
    model('some-unreleased-model', 'Unreleased')] });
  const offered = v.rows.filter(r => r.state !== 'gone');
  check('every row is priced or says why not',
    offered.every(r => r.rates !== undefined || r.state === 'unpriced'), true);
  const html = renderModels(v);
  check('and the unpriced one says so on the page',
    /not in the published card/.test(html), true);
  check('never a bare zero in a money column', /<td class="num">0<\/td>/.test(html), false);
}

console.log('\nthe cheapest is anchored');
{
  const v = view({ available: [
    model('gpt-5.6-luna', 'GPT-5.6 Luna'),
    model('gpt-5.6-terra', 'GPT-5.6 Terra'),
    model('claude-sonnet-5', 'Claude Sonnet 5')] });
  const live = v.rows.filter(r => r.state === 'offered' && r.variant === 'default');
  check('exactly one cheapest input', live.filter(r => r.cheapestInput).length, 1);
  // Sonnet 5 and Terra share an input price but not an output price, so the
  // output mark must not simply follow the input mark.
  check('and the output mark is computed separately',
    live.find(r => r.cheapestOutput)?.name, 'GPT-5.6 Luna');

  // A tie marks both, rather than picking one arbitrarily and reporting a
  // difference that does not exist.
  const tied = view({ available: [
    model('gpt-5.6-sol', 'GPT-5.6 Sol'), model('claude-sonnet-5', 'Claude Sonnet 5')] });
  const marks = tied.rows.filter(r => r.cheapestInput).length;
  check('a tie marks every row that ties', marks, 2);
}

console.log('\nmeasurement is gated, and says so');
{
  // One billed message against a gate of six. The cell must carry the
  // shortfall, not a figure fitted to one sample and not a zero.
  const thin = view({
    available: [model('claude-sonnet-5', 'Claude Sonnet 5')],
    rollups: [roll('claude-sonnet-5', { requests: 1 })],
    prices: { 'claude-sonnet-5': { n: 5 } }
  });
  check('below the gate there is no figure', thin.rows[0].measured, undefined);
  check('and the shortfall is stated', thin.rows[0].shortfall, 'needs 6, has 5');

  // The boundary itself: exactly the gate.
  const met = view({
    available: [model('claude-sonnet-5', 'Claude Sonnet 5')],
    rollups: [roll('claude-sonnet-5', { requests: 4, nanoAiu: 20e9 })],
    prices: { 'claude-sonnet-5': { n: 6 } }
  });
  check('at the gate the figure appears', met.rows[0].measured, 5);
  check('and the shortfall goes', met.rows[0].shortfall, undefined);
}

console.log('\navailability is not inferred from usage');
{
  // The frontier case: spent on it all month, and it is not on the menu any
  // more. Dropping the row silently is what makes that invisible.
  const v = view({
    available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')],
    rollups: [roll('claude-opus-4-8', { requests: 40, nanoAiu: 800e9 })],
    prices: { 'claude-opus-4-8': { n: 40 } }
  });
  const gone = v.rows.find(r => r.state === 'gone');
  check('a model you used but cannot pick is still listed', gone?.name, 'claude-opus-4-8');
  check('and the page says what happened to it',
    /no longer offered/.test(renderModels(v)), true);
  check('it sorts below what you can actually use',
    v.rows.indexOf(gone) > 0, true);
}

console.log('\nthe API\'s silence is a state');
{
  // Never asked, or refused. Different from "offers nothing", and the view
  // must not render an empty table for either.
  const v = view({ available: undefined });
  check('nothing is claimed about your account', v.banner !== undefined, true);
  check('and the table is not empty', v.rows.length > 0, true);
  check('no row claims to be offered',
    v.rows.every(r => r.state !== 'offered'), true);
}

console.log('\none model, one row');
{
  // The degenerate account. A multiple column would read "1x" against
  // nothing; the marks still have to be coherent.
  const v = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')] });
  check('it is the cheapest of itself', v.rows[0].cheapestInput, true);
  check('and the page still renders', renderModels(v).length > 0, true);
}

console.log('\nthe long tier is a row, not a footnote');
{
  const v = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')] });
  const long = v.rows.find(r => r.variant === 'long');
  check('a differently priced long context is its own row', long !== undefined, true);
  check('at the price the card publishes for it', long?.rates.input, 40);
  check('and it is marked as such', /long context/.test(renderModels(v)), true);

  // Sonnet 5 has no separate long tier, so it must not gain a duplicate row
  // printing the default price twice.
  const single = view({ available: [model('claude-sonnet-5', 'Claude Sonnet 5')] });
  check('a model without one gets no second row', single.rows.length, 1);
}

console.log('\na stale card admits it');
{
  const fresh = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')],
    periodStart: Date.parse('2026-01-01') });
  check('a card newer than the period is not flagged', fresh.stale, undefined);

  const old = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')],
    periodStart: Date.parse('2027-01-01') });
  check('one older than it is', /took effect/.test(old.stale ?? ''), true);
}

console.log('\nthe unit is stated, once');
{
  const html = renderModels(view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')] }));
  check('per 1M tokens, on the page', /Credits per 1M tokens/.test(html), true);
  check('and never per 1k', /per 1k/.test(html), false);
  // Luna is 20 credits per 1M. Printed as 0.02 it would be per 1k, which is
  // the same number in a different unit and unreadable beside the tooltips.
  check('at the magnitude the editor shows', /<td class="num[^"]*">20<\/td>/.test(html), true);
}

console.log('\nthe sidebar reduction');
{
  const v = view({
    available: [model('gpt-5.6-luna', 'GPT-5.6 Luna'), model('claude-sonnet-5', 'Claude Sonnet 5')],
    rollups: [roll('claude-sonnet-5', { requests: 20, nanoAiu: 400e9 })]
  });
  const side = compactModels(v, [roll('claude-sonnet-5', { requests: 20, nanoAiu: 400e9 })], 1e-9);
  check('it names the cheapest', /GPT-5.6 Luna/.test(side), true);
  check('and what you actually spend on', /Claude Sonnet 5/.test(side), true);
  check('with input and output kept apart', /in .*out/.test(side), true);
  // No blended multiple anywhere: the ratio it would need is a property of
  // your prompts, not of the models.
  check('and no invented multiple', /\dx|×/.test(side), false);
}

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
