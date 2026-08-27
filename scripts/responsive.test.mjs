#!/usr/bin/env node
/**
 * The pipeline must not hold the only thread it shares with the editor.
 *
 * A synchronous pass over the trace databases and every transcript froze VS
 * Code for minutes on a machine with real history, and a frozen extension is
 * indistinguishable from a broken one -- the reported symptom was that the
 * status bar item had vanished. This measures the longest stretch during a
 * refresh in which a timer could not run.
 */
import { ingestAll } from '../out/ingest.js';
import { RollupStore } from '../out/store.js';
import { phaseLabel, YIELD_EVERY } from '../out/progress.js';
import os from 'os'; import path from 'path'; import fs from 'fs';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-resp-'));
const store = new RollupStore(path.join(dir, 'r.json'));

console.log('\nthe event loop keeps running during a refresh');
// A timer that should fire every 5ms. Whatever gap it observes is a stretch
// during which the editor would have been unresponsive.
let last = Date.now();
let worst = 0;
let ticks = 0;
const beat = setInterval(() => {
  const now = Date.now();
  worst = Math.max(worst, now - last);
  last = now;
  ticks++;
}, 5);

const phases = [];
last = Date.now();
await ingestAll(store, undefined, p => { if (!phases.includes(p.phase)) phases.push(p.phase); });
clearInterval(beat);

console.log(`  timer fired ${ticks} time(s); longest stall ${worst}ms`);
check('the loop was given turns during the work', ticks > 0, true);
// Anything approaching a second is a visible freeze; a real budget is far
// tighter, but the bar here is "not blocked for the whole run".
check('no single stall over 1s', worst < 1000, true);

console.log('\nphases are reported as they happen');
check('trace reading announced', phases.includes('reading-traces'), true);
check('history reading announced', phases.includes('reading-history'), true);

console.log('\nphase labels are readable, not internal names');
// Terse on purpose: these sit after "TP |" in a crowded status bar.
for (const ph of ['starting', 'reading-traces', 'reading-history', 'tidying', 'checking-quota']) {
  const l = phaseLabel({ phase: ph, done: 12, total: 34 }) ?? '';
  check(`"${l}" fits the bar`, l.length <= 14, true);
}
check('starting', phaseLabel({ phase: 'starting' }), 'starting');
check('traces', phaseLabel({ phase: 'reading-traces' }), 'usage');
check('history with a count',
  phaseLabel({ phase: 'reading-history', done: 3, total: 9 }), 'history 3/9');
check('history without one', phaseLabel({ phase: 'reading-history' }), 'history');
check('quota', phaseLabel({ phase: 'checking-quota' }), 'allowance');
check('ready is not a busy state', phaseLabel({ phase: 'ready' }), undefined);
check('idle is not a busy state', phaseLabel({ phase: 'idle' }), undefined);
check('failure is handled separately', phaseLabel({ phase: 'failed' }), undefined);
check('yield interval is sane', YIELD_EVERY > 0 && YIELD_EVERY <= 64, true);

console.log('\nthree marks, and only three');
// The icon says what the extension is doing -- showing, working, or broken --
// and never how much allowance is left. Severity is the background colour, so
// the icons that used to encode it must not come back.
const source = fs.readFileSync(new URL('../out/extension.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const glyph of ['$(flame)', '$(copilot)', '$(graph)', '$(error)']) {
  check(`${glyph} is not used`, source.includes(glyph), false);
}
const marks = [...source.matchAll(/\$\((sync~spin|pie-chart|warning)\)/g)].map(m => m[1]);
check('ready is the pie chart', marks.includes('pie-chart'), true);
check('working is the spinner', marks.includes('sync~spin'), true);
check('broken is the warning', marks.includes('warning'), true);
check('no fourth mark', new Set(marks).size, 3);

console.log('\nthe click follows the state');
check('broken opens the log', source.includes("'tokenPie.showLogs'"), true);
check('working is not clickable', /statusBar\.command = undefined/.test(source), true);
check('otherwise it opens the report', source.includes("'tokenPie.showReport'"), true);

const manifest = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
check('the log command is declared',
  manifest.contributes.commands.some(c => c.command === 'tokenPie.showLogs'), true);
// Per-database failures are collected, not thrown, so a refresh can "succeed"
// having read nothing at all.
check('survived errors still earn the warning mark',
  /degraded \? MARK\.broken : MARK\.ready/.test(source), true);
check('and route the click to the log',
  /degraded \? 'tokenPie\.showLogs'/.test(source), true);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
