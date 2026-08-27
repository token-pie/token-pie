#!/usr/bin/env node
/** Thread-depth bucketing: the "asking later costs more" insight. */
import { depthBucket, DEPTH_BUCKETS, RollupStore } from '../out/store.js';
import { renderReport } from '../out/report.js';
import os from 'os'; import path from 'path'; import fs from 'fs';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

console.log('\nbucket boundaries');
check('first turn', depthBucket(1), '1st message');
check('lower edge of second bucket', depthBucket(2), '2nd-3rd');
check('upper edge of second bucket', depthBucket(3), '2nd-3rd');
check('third bucket', depthBucket(4), '4th-7th');
check('fourth bucket', depthBucket(15), '8th-15th');
check('open-ended tail', depthBucket(400), '16th on');
check('buckets are contiguous',
  DEPTH_BUCKETS.every((b, i) => i === 0 || b.min === DEPTH_BUCKETS[i - 1].max + 1), true);

console.log('\nturn ordinals survive a restart');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-depth-'));
const file = path.join(dir, 'r.json');
let store = new RollupStore(file);
check('first turn of a session', store.nextTurn('s1', Date.now()), 1);
check('second', store.nextTurn('s1', Date.now()), 2);
check('a different session starts over', store.nextTurn('s2', Date.now()), 1);
store.save();
store = new RollupStore(file);
check('counter reloaded, not reset', store.nextTurn('s1', Date.now()), 3);

console.log('\ncold starts excluded from the trend');
store.observeDepth(2, 5e9, false);   // cold: whole context at full price
store.observeDepth(2, 1e9, true);
store.observeDepth(9, 2e9, true);
const d = store.depthStats();
check('cold request counted in the total', d['2nd-3rd'].requests, 2);
check('but not in the warm average', d['2nd-3rd'].warmRequests, 1);
check('warm cost excludes it', d['2nd-3rd'].warmNanoAiu, 1e9);

console.log('\nstale sessions are pruned');
store.nextTurn('old', Date.now() - 200 * 86400000);
store.pruneTurns(90 * 86400000);
check('old thread forgotten', store.nextTurn('old', Date.now()), 1);
check('recent thread kept', store.nextTurn('s1', Date.now()), 4);

console.log('\nthe section says what to do about it');
const html = renderReport({
  rollups: [{ day: '2026-08-26', model: 'm', workspace: 'w', operation: 'panel/editAgent',
    selection: 'manual', requests: 10, inputTokens: 1000, outputTokens: 100, reasoningTokens: 0,
    cacheReadTokens: 500, cacheWriteTokens: 0, nanoAiu: 10e9,
    missRequests: 0, missInputTokens: 0, missNanoAiu: 0 }],
  creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(), costCoverage: 1,
  warnings: [], projection: { verdict: 'ok', remaining: 500 }, prices: {},
  depth: {
    '2nd-3rd': { requests: 4, nanoAiu: 4e9, warmRequests: 4, warmNanoAiu: 4e9 },
    '8th-15th': { requests: 3, nanoAiu: 9e9, warmRequests: 3, warmNanoAiu: 9e9 }
  }
});
check('section rendered', /What to change/.test(html), true);
check('states the multiple', /<strong>3\.0&times;<\/strong> what your/.test(html), true);
check('names the remedy in plain words', /Start a new chat when you change subject/.test(html), true);
check('average message cost given', /Each message you send costs\s*<strong>1\.00 credits<\/strong>/.test(html), true);
check('translates the allowance into messages', /<strong>500 messages<\/strong> left/.test(html), true);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
