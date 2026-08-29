#!/usr/bin/env node
/**
 * The page someone opens when the panel will not tell them something.
 *
 * Its job is to name the gate that is withholding, so the assertions worth
 * having are the ones about that: a gate the data fails is marked, a gate it
 * passes is not, and the one assumed constant everything rests on is described
 * as assumed rather than shown as a bare number.
 */
import fs from 'fs';
import { renderSpecs } from '../out/specs.js';
import { read, KNOBS, settings } from '../out/tuning.js';
import { parse } from '../out/ratecard.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const BUNDLED = new URL('../rate-card.json', import.meta.url).pathname;
const bundled = parse(JSON.parse(fs.readFileSync(BUNDLED, 'utf8')));
const card = { card: bundled, cards: [bundled], origin: 'bundled' };

const rollup = (over = {}) => ({
  day: '2026-08-26', model: 'claude-sonnet-5', workspace: 'w', operation: 'chat',
  selection: 'manual', source: 'measured', requests: 20, inputTokens: 100000,
  outputTokens: 5000, reasoningTokens: 0, cacheReadTokens: 90000,
  cacheWriteTokens: 9990, nanoAiu: 20e9, missRequests: 2, missInputTokens: 10000,
  missNanoAiu: 4e9, ...over
});

// 0.25 fresh / 0.02 cached / 1.00 output, the card this machine actually solves.
// The three columns must vary independently: proportional ones make X'X
// singular and the solver refuses, which is correct and useless as a fixture.
const OBSERVATIONS = [
  [1.3, 9.1, 0.4], [4.0, 2.2, 1.9], [0.7, 31.5, 0.2], [12.0, 6.4, 3.1],
  [2.5, 18.0, 0.9], [8.1, 1.1, 5.5], [0.4, 44.0, 2.7], [6.6, 12.8, 0.6]
];
const stats = (() => {
  const s = { n: 0, xx: [0, 0, 0, 0, 0, 0], xy: [0, 0, 0], sy: 0, syy: 0 };
  for (const [f, c, o] of OBSERVATIONS) {
    const y = f * 0.25 + c * 0.02 + o * 1.0;
    s.n++;
    s.xx[0] += f * f; s.xx[1] += f * c; s.xx[2] += f * o;
    s.xx[3] += c * c; s.xx[4] += c * o; s.xx[5] += o * o;
    s.xy[0] += f * y; s.xy[1] += c * y; s.xy[2] += o * y;
    s.sy += y; s.syy += y * y;
  }
  return s;
})();

const render = (over = {}) => renderSpecs({
  rollups: [rollup()], creditsPerNanoAiu: 1e-9, creditsPerNanoAiuIsDefault: true,
  prices: { 'claude-sonnet-5': stats }, readings: read(() => undefined).readings,
  card, pipeline: { databases: 1, spansScanned: 60, spansCounted: 20, costSpans: 20,
    recoveredMessages: 0, errors: [] },
  lastRefresh: new Date(), ...over
});
const html = render();
const flat = html.replace(/\s+/g, ' ');

console.log('the conversion is named as an assumption');
check('the setting is shown', /tokenPie\.creditsPerNanoAiu/.test(html), true);
check('and described as assumed when untouched',
  /assumed, never measured/.test(flat), true);
check('and as yours when you have set it',
  /<strong>set by you<\/strong>/.test(render({ creditsPerNanoAiuIsDefault: false })), true);
check('an unchecked conversion says how to check it',
  /Check Quota/.test(flat), true);

// The finding this page exists to make visible without reading source.
console.log('\nsolved against published');
check('the measured figure is shown', /0\.2500/.test(html), true);
check('beside the published one', /0\.2000/.test(html), true);
check('and named as the class it actually matches',
  /matches <strong>cache write<\/strong> instead/.test(flat), true);
check('classes that agree are not flagged',
  (flat.match(/>matches<\/span>/g) || []).length, 2);
check('the card says where it came from and when',
  /Card in use: <strong>bundled<\/strong>/.test(flat), true);

console.log('\ngates');
const gatesPane = html.slice(html.indexOf('The gates'), html.indexOf('The pipeline'));
check('every threshold is listed, settings and rules alike',
  (gatesPane.match(/<code>tokenPie\.[a-zA-Z]/g) || []).length, KNOBS.length);
// Most are not choices: they exist so the panel cannot claim more than it
// measured, and offering them invites turning the honesty off.
check('only a handful are offered as settings',
  (html.match(/<code>tokenPie\.(minCreditsWorthMentioning|warnAtDaysLeft|historyDays|dailyBudget)<\/code>/g) || []).length,
  settings().length);
check('the rest keep their dotted paths and are not settings',
  /<code>tokenPie\.pricing\.minR2<\/code>/.test(html), true);
check('each says whether its value was derived or judged',
  (html.match(/class="basis (derived|judged)"/g) || []).length, KNOBS.length);
check('nothing is withholding on sufficient data',
  /No gate is currently withholding anything/.test(html), true);

// The whole point: "no recommendations" is not an answer, "needs 10, you have
// 5" is. A gate the data fails has to say so, and say by how much.
console.log('\na gate that is withholding says so');
const thin = render({ rollups: [rollup({ requests: 5 })] });
check('the summary counts it', /1 gate is currently withholding/.test(thin.replace(/\s+/g, ' ')), true);
check('the row is marked', /<tr class="binding">/.test(thin), true);
check('and says how far short the data is',
  /5 messages, needs 10/.test(thin), true);
check('gates that pass are still not marked',
  (thin.match(/<tr class="binding">/g) || []).length, 1);

console.log('\nclamped settings show both figures');
const clamped = render({ readings: read(id => (id === 'advice.minHistoryRequests' ? -3 : undefined)).readings });
check('the effective value is shown', /<td class="num mono">1<div/.test(clamped.replace(/\s+/g, ' ')), true);
check('and what was actually asked for', /you set -3/.test(clamped), true);

console.log('\nthe pipeline is countable end to end');
check('spans scanned', /60/.test(html), true);
check('cache writes reach the page', /9,990/.test(html), true);
check('errors surface when there are any',
  /disk on fire/.test(render({ pipeline: { databases: 1, spansScanned: 1, spansCounted: 1,
    costSpans: 1, recoveredMessages: 0, errors: ['disk on fire'] } })), true);

console.log('\nthe page is a safe webview');
check('no scripts', /<script/i.test(html), false);
check('a locked-down CSP', /default-src 'none'/.test(html), true);

// Seventeen gates expanded is the wall of text this page exists to replace.
console.log('\nthe gates collapse, and open themselves when they matter');
check('two groups: what you can change, and what you cannot',
  (html.match(/<details class="group"/g) || []).length, 2);
check('named for the reader\'s question, not the taxonomy',
  /What you can change/.test(html) && /Rules that keep the numbers honest/.test(html), true);
// The handful you can act on is worth showing without a click.
check('the settings group opens itself',
  (html.match(/<details class="group" open>/g) || []).length, 1);
check('each summary carries its own count',
  (html.match(/class="dim count"/g) || []).length, 2);
check('and the rules group says why it is not a list of choices',
  /would not reveal more/.test(html.replace(/\s+/g, ' ')), true);

const thinHtml = render({ rollups: [rollup({ requests: 5 })] });
check('a group holding a withholding rule opens itself too',
  (thinHtml.match(/<details class="group" open>/g) || []).length, 2);
check('and says so on its summary line',
  /1 withholding<\/span>/.test(thinHtml), true);

const edited = render({ readings: read(id => (id === 'history.days' ? 14 : undefined)).readings });
check('a group holding a changed gate opens itself too',
  (edited.match(/<details class="group" open>/g) || []).length, 1);
check('marked as changed rather than as a problem',
  /1 changed<\/span>/.test(edited), true);

// A price published this month says nothing about what was billed last month.
console.log('\nprices are not applied backwards');
const older = { ...bundled, effective: '2020-01-01', retrieved: '2020-01-01' };
const twoCards = { card: bundled, cards: [older, bundled], origin: 'bundled' };
// The window has to actually contain the change date, or there is nothing to
// straddle: the fixture day alone sits two days before it.
const spanning = render({
  card: twoCards,
  rollups: [rollup(), rollup({ day: '2026-09-02' })]
});
check('a window spanning a price change withholds the comparison',
  /the comparison is withheld/.test(spanning.replace(/\s+/g, ' ')), true);
check('and names the date the prices changed',
  /Published prices changed on 2026-08-28/.test(spanning.replace(/\s+/g, ' ')), true);
// Withheld belongs with the other models that have no comparison, not as a
// malformed row inside a table of figures.
check('and it sits in the not-compared list, not in the comparison',
  spanning.indexOf('the comparison is withheld') > spanning.indexOf('Not compared'), true);

const settled = render({ card: { card: older, cards: [older], origin: 'bundled' } });
check('a window inside one regime compares normally',
  /the comparison is withheld/.test(settled), false);
check('history predating every card says the comparison is an assumption',
  /assumption rather than a record/.test(render().replace(/\s+/g, ' ')), true);

// The console and the panel must not disagree about whether the figures on
// them are measurements; both call conversionConfidence.
console.log('\nthe conversion states what it makes everything else');
check('an unchecked conversion makes derived figures estimated',
  /therefore <strong class="warn">estimated<\/strong>/.test(html.replace(/\s+/g, ' ')), true);
check('and says the panel marks them',
  /marked <strong>~<\/strong>/.test(html.replace(/\s+/g, ' ')), true);
const confirmed = render({ coverage: {
  periodStart: 0, githubCredits: 20, localCredits: 20, localRequests: 20,
  unaccounted: 0, share: 1, verdict: 'complete', note: '' } });
check('a reconciled conversion makes them measurements',
  /therefore <strong class="ok">measured<\/strong>/.test(confirmed.replace(/\s+/g, ' ')), true);
check('and says nothing is marked',
  /carry no doubt mark/.test(confirmed), true);

// A table where some rows use rowspan and others colspan gives the browser no
// consistent column count to size against, and the header stops lining up with
// anything below it. Every row spans exactly five.
// Column counts were uniform and the table still rendered wrong: a colspan
// sentence laid out across columns 2-5 set the width of the CLASS column, so
// the figures sat a canyon away from the class they belonged to. The models
// that have no comparison are their own table now, and the comparison holds
// nothing but figures.
console.log('\nthe rate card is two tables, because it is two things');
// Needs both kinds of model: one the solver could price and one it could not.
const mixed = render({ rollups: [rollup(), rollup({ model: 'gpt-5.6-luna', requests: 3 })] });
const section = mixed.slice(mixed.indexOf('The rate card'), mixed.indexOf('The gates'));
const cols = tr => [...tr.matchAll(/<t[dh]([^>]*)>/g)]
  .reduce((n, m) => n + Number((/colspan="(\d+)"/.exec(m[1]) || [, 1])[1]), 0);
const rowsOf = table => [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[0]);
const rates = section.slice(section.indexOf('<table class="rates">'));
check('the comparison table has no colspan at all',
  /colspan/.test(rates.slice(0, rates.indexOf('</table>'))), false);
check('every comparison row is five columns',
  new Set(rowsOf(rates.slice(0, rates.indexOf('</table>'))).map(cols)).size, 1);
check('no rowspan anywhere', /rowspan=/.test(mixed), false);
check('models without a card are listed separately', /<h3>Not compared<\/h3>/.test(mixed), true);
check('and that list is two columns', cols(rowsOf(
  section.slice(section.indexOf('<table class="absent">')))[0]), 2);

// width:1% shrinks a column to its longest *word* unless nowrap comes with it,
// which wrapped "fresh input" onto two lines and broke a model id into five.
check('shrink-to-fit columns are paired with nowrap',
  /table\.rates td\.cls \{[^}]*white-space: nowrap/.test(html), true);
check('and the model column is not overridden back to wrapping',
  /table\.absent td\.model \{[^}]*white-space: normal/.test(html), false);

console.log('\nlinks are links');
check('the source is a hyperlink, not a pasted address',
  /<a href="https:\/\/docs\.github\.com[^"]*"[^>]*>GitHub(&#39;|')s published prices<\/a>/
    .test(html.replace(/\s+/g, ' ')), true);
check('no bare url is rendered as text',
  /<code>https?:/.test(html), false);
check('and it opens outside the panel',
  [...html.matchAll(/<a\s[^>]*>/g)].every(a => /target="_blank"/.test(a[0])
    && /rel="noopener noreferrer"/.test(a[0])), true);

// The basis label is the one thing on a row saying how much to trust the
// number, and a hairline outline in a dim accent was near-invisible.
console.log('\nthe basis label is legible');
check('it has a filled ground, not only an outline',
  /\.basis\.judged \{[^}]*background:/.test(html), true);
check('with a fallback where color-mix is unsupported',
  /\.basis\.judged \{[^}]*background: rgba\(/.test(html), true);

// Four sections open at once is a page you scroll rather than read. Closed,
// each summary has to carry its own answer or collapsing has just hidden the
// information instead of organising it.
console.log('\nthe page is four answers before it is four sections');
check('every section is a pane', (html.match(/<details class="pane"/g) || []).length, 4);
check('none opens for an ordinary page', /<details class="pane" open>/.test(html), false);
check('the conversion says it was never checked',
  /The conversion<\/span>\s*<span class="state warn">never checked/.test(html.replace(/\s+/g, ' ')), true);
check('the rate card counts the disagreements',
  /The rate card<\/span> <span class="state warn">1 disagreement</.test(html.replace(/\s+/g, ' ')), true);
const exposed = settings().length;
check('the gates summarise as settings against fixed rules',
  new RegExp(`The gates</span> <span class="state ok">${exposed} settings ` +
    `\u00b7 ${KNOBS.length - exposed} fixed rules<`)
    .test(html.replace(/\s+/g, ' ')), true);
check('a reconciled conversion says so on the closed line',
  /The conversion<\/span> <span class="state ok">checked against GitHub</.test(
    confirmed.replace(/\s+/g, ' ')), true);

// Closed is the default, not the rule: a pane with something wrong in it opens
// itself, or the finding is one click further away than the problem it reports.
check('gates open themselves when one is withholding',
  /<details class="pane" open>\s*<summary>.{0,80}?The gates/
    .test(thinHtml.replace(/\s+/g, ' ')), true);
const broken = render({ pipeline: { databases: 1, spansScanned: 1, spansCounted: 1,
  costSpans: 1, recoveredMessages: 0, errors: ['disk on fire'] } });
check('and the pipeline opens itself on an error',
  /The pipeline<\/span> <span class="state bad">1 error</.test(broken.replace(/\s+/g, ' ')), true);
check('with the pane open', (broken.match(/<details class="pane" open>/g) || []).length, 1);

// "65 messages from 0 spans" reads as a contradiction rather than as a cursor
// that has not moved yet.
const unscanned = render({ pipeline: { databases: 0, spansScanned: 0, spansCounted: 0,
  costSpans: 0, recoveredMessages: 0, errors: [] } });
check('a pipeline that has not scanned says so without contradicting itself',
  /message[s]? on record</.test(unscanned), true);
check('and does not claim messages came from zero spans',
  /from 0 spans/.test(unscanned), false);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
