#!/usr/bin/env node
/**
 * The second opinion.
 *
 * The solver measures; this checks the measurement against what GitHub says it
 * should be. The case that matters is the one that caught a real mislabelling:
 * a solved figure that matches a *different* published class than the one it is
 * named after is a correct measurement with a wrong label, and must be reported
 * as that rather than as a discrepancy.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse, lookup, compare, slug, load, isDue, REFRESH_INTERVAL_MS }
  from '../out/ratecard.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const BUNDLED = new URL('../rate-card.json', import.meta.url).pathname;
const card = parse(JSON.parse(fs.readFileSync(BUNDLED, 'utf8')));

console.log('the shipped card');
check('parses', card !== undefined, true);
check('states where it came from', card.source.includes('docs.github.com'), true);
check('and when it was read', /^\d{4}-\d{2}-\d{2}$/.test(card.retrieved), true);
check('credits are a hundred to the dollar', card.creditsPerDollar, 100);

console.log('\njoining telemetry ids to published names');
check('a display name folds to a slug', slug('GPT-5.6 Luna (Default)'), 'gpt-5-6-luna');
check('and the telemetry id folds to the same one', slug('gpt-5.6-luna'), 'gpt-5-6-luna');
check('so they join', lookup(card, 'gpt-5.6-luna').name, 'GPT-5.6 Luna');
check('claude joins too', lookup(card, 'claude-sonnet-5').name, 'Claude Sonnet 5');
// Response models carry a training date the price table does not.
check('a dated response model falls back to the undated name',
  lookup(card, 'claude-sonnet-5-2026-01-01').name, 'Claude Sonnet 5');
check('a model not in the table is absent, not guessed',
  lookup(card, 'copilot-nes-lysithea-24'), undefined);
check('the default variant is preferred', lookup(card, 'gpt-5.6-luna').variant, 'default');
check('and the long-context row is reachable',
  lookup(card, 'gpt-5.6-luna', 'long').input, 0.04);

console.log('\nunits');
const sonnet = lookup(card, 'claude-sonnet-5');
check('$2.00 per million is 0.20 credits per 1k', sonnet.input, 0.2);
check('$0.20 per million is 0.02', sonnet.cached, 0.02);
check('$2.50 per million is 0.25', sonnet.cacheWrite, 0.25);
check('$10.00 per million is 1.00', sonnet.output, 1);
check('a model that bills no cache write reports none',
  lookup(card, 'gemini-3.5-flash').cacheWrite, undefined);

// This is the whole reason the comparison exists. The solver recovered
// 0.25/0.02/1.00 for claude-sonnet-5 and the panel called the first one the
// input price. It is the cache-write price, and the machine has to say so.
console.log('\nthe mislabelling this exists to catch');
const c = compare(card, 'claude-sonnet-5', { fresh: 0.25, cached: 0.02, output: 1.00003 });
const fresh = c.classes.find(x => x.label === 'fresh input');
check('fresh input does not match the published input price', fresh.matchedAs === 'input', false);
check('it matches the cache-write price instead', fresh.matchedAs, 'cache write');
check('and the expected figure is still shown for comparison', fresh.published, 0.2);
check('cached input matches its own class',
  c.classes.find(x => x.label === 'cached input').matchedAs, 'cached input');
check('output matches its own class despite solver noise',
  c.classes.find(x => x.label === 'output').matchedAs, 'output');

console.log('\na figure matching nothing is reported as matching nothing');
const off = compare(card, 'claude-sonnet-5', { fresh: 7, cached: 7, output: 7 });
check('no class is claimed', off.classes.every(x => x.matchedAs === undefined), true);
check('but the published figures are still there to compare',
  off.classes[0].published, 0.2);

console.log('\nan unknown model compares against nothing rather than guessing');
const unknown = compare(card, 'copilot-nes-lysithea-24', { fresh: 1, cached: 1, output: 1 });
check('no published row', unknown.published, undefined);
check('and no class is matched', unknown.classes.every(x => x.matchedAs === undefined), true);

// This parses whatever a URL returned. Half a card would price some models and
// silently skip others while looking complete.
console.log('\nparsing refuses rather than half-succeeds');
check('not an object', parse('nope'), undefined);
check('no models', parse({ source: 's', retrieved: 'r', creditsPerDollar: 100, models: [] }), undefined);
check('a bad conversion', parse({ ...card, creditsPerDollar: 0 }), undefined);
check('one malformed row rejects the whole card',
  parse({ ...card, models: [...card.models, { name: 'x', vendor: 'y', variant: 'default', input: 'free' }] }),
  undefined);
check('an unknown variant rejects it',
  parse({ ...card, models: [{ name: 'x', vendor: 'y', variant: 'medium', input: 1, cachedInput: 1, output: 1 }] }),
  undefined);
check('a negative price rejects it',
  parse({ ...card, models: [{ name: 'x', vendor: 'y', variant: 'default', input: -1, cachedInput: 1, output: 1 }] }),
  undefined);

console.log('\nwhich card is in use, and why');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-card-'));
const cachePath = path.join(dir, 'cache.json');
check('nothing cached falls back to bundled', load({ bundledPath: BUNDLED }).origin, 'bundled');
check('a user override wins outright',
  load({ bundledPath: BUNDLED, override: { ...card, source: 'mine' } }).origin, 'user');
check('a malformed override does not blank the card',
  load({ bundledPath: BUNDLED, override: { models: 'lots' } }).origin, 'bundled');

const now = Date.now();
const fresher = { ...card, retrieved: '2099-01-01' };
fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, url: 'u', card: fresher }));
check('a newer fetched card is used', load({ bundledPath: BUNDLED, cachePath, now }).origin, 'fetched');
check('and is not flagged stale while fresh',
  load({ bundledPath: BUNDLED, cachePath, now }).note, undefined);
check('but is flagged once the week is up',
  load({ bundledPath: BUNDLED, cachePath, now: now + REFRESH_INTERVAL_MS + 1 }).note, 'due for refresh');

// An extension update ships a newer table than the last fetch. Preferring the
// fetch there would roll the prices backwards.
fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, url: 'u', card: { ...card, retrieved: '2020-01-01' } }));
check('a fetched card older than the bundled one is not a downgrade path',
  load({ bundledPath: BUNDLED, cachePath, now }).origin, 'bundled');

fs.writeFileSync(cachePath, 'not json');
check('a corrupt cache falls back silently', load({ bundledPath: BUNDLED, cachePath, now }).origin, 'bundled');
check('and a corrupt cache is due for refresh', isDue(cachePath, now), true);
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
