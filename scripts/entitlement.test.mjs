#!/usr/bin/env node
/**
 * Regression tests against real recorded responses.
 *
 * The premium_interactions entry in the Free fixture is the whole point: it
 * reports 0% remaining with has_quota false, and an earlier version of
 * governingSnapshot picked it -- reporting "0% left" to an account with 99% of
 * its chat allowance intact.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshots, governingSnapshot, isBinding, daysUntilReset, hasCopilotAccess }
  from '../out/entitlement.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const load = n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const free = load('entitlement-free.json');
const snaps = parseSnapshots(free.quota_snapshots);
const ent = {
  snapshots: snaps,
  resetDate: free.quota_reset_date_utc,
  accessTypeSku: free.access_type_sku,
  chatEnabled: free.chat_enabled
};

console.log('\nfree plan entitlement');
check('three snapshots parsed', snaps.length, 3);
check('quota_id used as name', snaps[0].name, 'chat');
check('fractional remainder kept', snaps.find(s => s.name === 'chat').remainingExact, 198.5);
check('integer remaining kept', snaps.find(s => s.name === 'chat').remaining, 198);
check('credits_used captured', snaps.find(s => s.name === 'chat').creditsUsed, 1);

console.log('\nbinding-quota selection (the has_quota bug)');
check('premium_interactions is NOT binding', isBinding(snaps.find(s => s.name === 'premium_interactions')), false);
check('chat IS binding', isBinding(snaps.find(s => s.name === 'chat')), true);
check('completions IS binding', isBinding(snaps.find(s => s.name === 'completions')), true);
check('governing snapshot is chat', governingSnapshot(ent).name, 'chat');
check('governing is not the 0% phantom', governingSnapshot(ent).percentRemaining, 99.2);

console.log('\nreset date');
const now = Date.parse('2026-08-26T11:39:24.284Z');
check('days until reset', Math.round(daysUntilReset(ent, now) * 10) / 10, 5.5);

console.log('\naccount without copilot');
const none = load('entitlement-no-access.json');
check('no access detected', hasCopilotAccess({
  accessTypeSku: none.access_type_sku, chatEnabled: none.chat_enabled, snapshots: []
}), false);
check('free account has access', hasCopilotAccess(ent), true);

console.log('\nexhausted Business seat');
// A real payload from a Business seat that had hit its limit. `has_quota` came
// back false *because* the quota was spent, alongside entitlement 10000 and
// credits_used 19114 -- requiring has_quota===true made Token Pie go blind at
// the exact moment Copilot itself showed "Quota reached".
const raw = load('entitlement-business-exhausted.json');
const business = {
  snapshots: parseSnapshots(raw.quota_snapshots),
  resetDate: raw.quota_reset_date_utc,
  accessTypeSku: raw.access_type_sku,
  chatEnabled: raw.chat_enabled
};
check('Copilot access recognised', hasCopilotAccess(business), true);
const g = governingSnapshot(business);
check('the exhausted allowance governs', g && g.name, 'premium_interactions');
check('its entitlement is kept', g && g.entitlement, 10000);
check('nothing remains', g && g.remainingExact, 0);
check('what GitHub says was spent', g && g.creditsUsed, 19114);
check('unlimited allowances still excluded',
  business.snapshots.filter(isBinding).map(s => s.name).join(), 'premium_interactions');

console.log(failures === 0 ? '\nAll entitlement checks passed.\n' : `\n${failures} failed.\n`);
process.exit(failures ? 1 : 0);
