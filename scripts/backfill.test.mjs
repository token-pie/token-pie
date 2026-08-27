#!/usr/bin/env node
/**
 * Recovering history from chat transcripts.
 *
 * The trace database holds nothing from before it was switched on, so the
 * transcripts are the only record of earlier usage -- and they are a floor,
 * not a total. The rules that matter are: never overlap the two sources on a
 * day, never let the floor into the burn rate, and never count a message twice.
 */
import { backfill } from '../out/backfill.js';
import { RollupStore } from '../out/store.js';
import { project } from '../out/projection.js';
import os from 'os'; import path from 'path'; import fs from 'fs';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bf-'));
const day = d => Date.parse(`2026-08-${String(d).padStart(2, '0')}T10:00:00`);

// A fake VS Code user directory with one transcript spanning several days.
const user = path.join(dir, 'User');
const sess = path.join(user, 'workspaceStorage', 'abc', 'chatSessions');
fs.mkdirSync(sess, { recursive: true });
fs.writeFileSync(path.join(user, 'workspaceStorage', 'abc', 'workspace.json'),
  JSON.stringify({ folder: 'file:///repo/demo' }));
// Token and credit fields sit beside requestId, not inside result.metadata;
// only resolvedModel lives in the metadata.
const turn = (id, d) => ({
  requestId: id, timestamp: day(d),
  promptTokens: 1000, completionTokens: 100, copilotCredits: 2,
  result: { metadata: { resolvedModel: 'sonnet' } }
});
fs.writeFileSync(path.join(sess, 's1.json'), JSON.stringify({
  requests: [turn('a', 20), turn('b', 21), turn('c', 24), turn('d', 26)]
}));

console.log('\nhistory before the trace database is recovered');
let store = new RollupStore(path.join(dir, 'r.json'));
let r = await backfill(store, day(24), [user], day(27));
check('only days before the trace window', r.turnsCounted, 2);
check('days added', r.daysAdded, 2);
check('the trace database day is not touched',
  store.all().some(x => x.day === '2026-08-24'), false);
check('earliest recovered day', r.earliestDay, '2026-08-20');
check('transcripts counted', r.sessionFiles, 1);
check('workspace resolved from the folder', store.all()[0].workspace, 'demo');
check('marked as a floor, not a measurement', store.all()[0].source, 'reported');

console.log('\nrunning it again counts nothing twice');
const before = store.all().reduce((n, x) => n + x.requests, 0);
r = await backfill(store, day(24), [user], day(27));
check('no new messages', r.turnsCounted, 0);
check('totals unchanged', store.all().reduce((n, x) => n + x.requests, 0), before);

console.log('\nthe floor never drives the throttle projection');
// 4 credits of recovered history and nothing measured: a burn rate computed
// from an undercount would tell someone they are safe when they are not.
const ent = { snapshots: [{ name: 'q', entitlement: 100, remaining: 50,
  remainingExact: 50, percentRemaining: 50, hasQuota: true, unlimited: false }],
  resetDate: '2026-09-30T00:00:00.000Z' };
check('no rate from reported history alone',
  project(ent, store.all(), 1e-9, day(27)).verdict, 'no-rate');

console.log('\nwith no trace database at all, everything is recoverable');
store = new RollupStore(path.join(dir, 'r2.json'));
r = await backfill(store, undefined, [user], day(27));
check('every message counted', r.turnsCounted, 4);

console.log('\ntranscripts without cost figures');
fs.writeFileSync(path.join(sess, 's2.json'), JSON.stringify({
  requests: [{ requestId: 'z', timestamp: day(19), promptTokens: 500,
    result: { metadata: {} } }]
}));
store = new RollupStore(path.join(dir, 'r3.json'));
r = await backfill(store, day(24), [user], day(27));
check('a costless message is not invented into spend',
  store.all().every(x => x.model !== 'unknown' || x.nanoAiu === 0), true);
check('transcripts found', r.sessionFiles, 2);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
