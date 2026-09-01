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
  check('and the unpriced one is labelled beside its name',
    /Unreleased<span class="tag unpriced">not published<\/span>/.test(html), true);
  // The label sits with the name; the money columns still exist and hold a
  // dash apiece. A colspan sentence across them broke the row's geometry and
  // left the figures nowhere.
  check('and its money columns are still four dashes',
    (html.match(/<td class="num dim">&mdash;<\/td>/g) || []).length >= 4, true);
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
  check('and the shortfall is stated in English', thin.rows[0].shortfall, '5 of 6 billed');

  // The boundary itself: exactly the gate.
  const met = view({
    available: [model('claude-sonnet-5', 'Claude Sonnet 5')],
    rollups: [roll('claude-sonnet-5', { requests: 4, nanoAiu: 20e9 })],
    prices: { 'claude-sonnet-5': { n: 6 } }
  });
  check('at the gate the figure appears', met.rows[0].measured, 5);
  check('and the shortfall goes', met.rows[0].shortfall, undefined);
  // A figure with no unit in a column headed "your cost/message" could be
  // credits, dollars or messages.
  check('and it carries its unit', /5\.00 credits/.test(renderModels(met)), true);

  // Nothing billed at all is not the same sentence as some-but-not-enough.
  const none = view({ available: [model('claude-sonnet-5', 'Claude Sonnet 5')] });
  check('nothing billed says so', none.rows[0].shortfall, 'not yet billed');

  // A long-context variant is the same model at a different rate, so there is
  // no separate measurement for it: a dash, not a blank.
  const long = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')] });
  const html = renderModels(long);
  check('and a variant with no measurement of its own shows a dash',
    (html.match(/<td class="num dim">&mdash;<\/td>/g) || []).length >= 1, true);
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
    /class="tag gone">not offered</.test(renderModels(v)), true);
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

console.log('\nan unread card admits it');
{
  // The first rule here flagged a card whose prices took effect before the
  // billing period started -- which is nearly always true, since prices are
  // set before the periods they apply to. It printed a warning on every
  // render, which is the fastest way to teach someone to ignore warnings.
  //
  // What is worth saying is that the card has not been *read* in a long time:
  // that is a fetch not happening, not a price being old.
  const readAt = Date.parse(card.retrieved);
  const fresh = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')],
    now: readAt + 3 * 86400000 });
  check('a card read this week says nothing', fresh.stale, undefined);

  const old = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')],
    now: readAt + 40 * 86400000 });
  check('one unread for a month says so', /last read 40 days ago/.test(old.stale ?? ''), true);

  // The boundary: four missed weekly fetches, not three.
  const edge = view({ available: [model('gpt-5.6-luna', 'GPT-5.6 Luna')],
    now: readAt + 27 * 86400000 });
  check('and it holds its tongue until then', edge.stale, undefined);
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
  check('with input and output kept apart', /class="msep">\/</.test(side), true);
  // Every other bar in this column is spend against a quota. A price ratio
  // drawn in that vocabulary says a model is consuming something it has not
  // consumed, so the block draws no bar at all.
  check('and no bar borrowing the quota vocabulary',
    /class="bar/.test(side), false);
  // No blended multiple anywhere: the ratio it would need is a property of
  // your prompts, not of the models.
  check('and no invented multiple', /\dx|×/.test(side), false);
}

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
