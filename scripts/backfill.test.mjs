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
import { clearTurnCache } from '../out/sessions.js';
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

console.log('\nunchanged transcripts are not reopened');
{
  const f = path.join(dir, 'inc.json');
  const st = new RollupStore(f);
  let r = await backfill(st, undefined, [user], day(27));
  const parsedFirst = r.filesParsed;
  check('the first pass reads them', parsedFirst > 0, true);

  r = await backfill(st, undefined, [user], day(27));
  check('a second pass reads nothing', r.filesParsed, 0);
  check('and accounts for them as unchanged', r.filesUnchanged >= parsedFirst, true);

  // A restart clears the in-memory parse cache but not the store on disk.
  st.save();
  clearTurnCache();
  const reopened = new RollupStore(f);
  r = await backfill(reopened, undefined, [user], day(27));
  check('a restart still reads nothing', r.filesParsed, 0);
  check('no turns counted twice', r.turnsCounted, 0);

  // Appending to a transcript changes its size and mtime, so it must be reread
  // -- and the turns already counted must not be counted again.
  const before = reopened.all().reduce((n, x) => n + x.requests, 0);
  const doc = JSON.parse(fs.readFileSync(path.join(sess, 's1.json'), 'utf8'));
  doc.requests.push({ requestId: 'new-one', timestamp: day(22),
    promptTokens: 900, completionTokens: 80, copilotCredits: 1,
    result: { metadata: { resolvedModel: 'sonnet' } } });
  fs.writeFileSync(path.join(sess, 's1.json'), JSON.stringify(doc));
  fs.utimesSync(path.join(sess, 's1.json'), new Date(), new Date());

  r = await backfill(reopened, undefined, [user], day(27));
  check('a changed transcript is reread', r.filesParsed, 1);
  check('only the new turn is counted', r.turnsCounted, 1);
  check('totals moved by exactly one',
    reopened.all().reduce((n, x) => n + x.requests, 0), before + 1);
}

console.log('\nthe bookkeeping does not grow without bound');
{
  const f = path.join(dir, 'prune.json');
  const st = new RollupStore(f);
  await backfill(st, undefined, [user], day(27));
  check('turn ids recorded', st.backfilledTurns().size > 0, true);
  // Move the window on by a year: everything recorded is now out of range.
  await backfill(st, undefined, [user], day(27) + 365 * 86400000);
  check('ids outside the window are forgotten', st.backfilledTurns().size, 0);
  check('digests for files that no longer exist are dropped',
    st.backfilledFile(path.join(sess, 'gone.json')), undefined);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
