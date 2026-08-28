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
import { renderConsole } from '../out/console.js';
import { read } from '../out/tuning.js';
import { parse } from '../out/ratecard.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const BUNDLED = new URL('../rate-card.json', import.meta.url).pathname;
const card = { card: parse(JSON.parse(fs.readFileSync(BUNDLED, 'utf8'))), origin: 'bundled' };

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

const render = (over = {}) => renderConsole({
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
check('every gate is listed', (html.match(/tokenPie\.(advice|pricing|report|projection|reconcile|history)\./g) || []).length, 17);
check('each says whether its value was derived or judged',
  (html.match(/class="basis (derived|judged)"/g) || []).length, 17);
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
