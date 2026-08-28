#!/usr/bin/env node
/**
 * End-to-end check against a synthetic trace database.
 *
 * The real agent-traces.db only exists once a developer has enabled collection
 * and used Copilot, so this fixture is how we exercise schema detection,
 * incremental ingest, de-duplication and rollup before then. The fixture's
 * shape is a best guess at the upstream schema -- `npm run probe` against a
 * real database is what confirms it.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ingestAll } from '../out/ingest.js';
import { RollupStore, sum, groupBy } from '../out/store.js';
import { read } from '../out/tuning.js';
import { renderReport } from '../out/report.js';
import { emptyStats, accumulate } from '../out/pricing.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-pie-selftest-'));
const dbPath = path.join(dir, 'agent-traces.db');
const storePath = path.join(dir, 'rollup.json');

let failures = 0;
function check(label, actual, expected) {
	const ok = actual === expected;
	if (!ok) {
		failures++;
	}
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
}

const MODELS = ['gpt-5.6-luna', 'claude-sonnet-4.5', 'gpt-4o-mini-2024-07-18'];
const NANO_PER_MODEL = {
	'gpt-5.6-luna': 456_240_000,
	'claude-sonnet-4.5': 3_100_000_000,
	// Auxiliary calls (title, progress messages) really do report zero cost.
	'gpt-4o-mini-2024-07-18': 0
};
const SESSION_A = 'cc225095-5ea3-4165-b166-6af46f331d25';
const SESSION_B = '7f10be22-1111-4444-9999-0a0a0a0a0a0a';

function seed(db, { count, startMs, withCost = true, sessionId = SESSION_A }) {
	const insertSpan = db.prepare(
		`INSERT INTO spans (span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
			status_code, operation_name, provider_name, agent_name, conversation_id,
			request_model, response_model, input_tokens, output_tokens, cached_tokens,
			reasoning_tokens, chat_session_id, ttft_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	const insertAttr = db.prepare('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)');

	let nano = 0;
	for (let i = 0; i < count; i++) {
		const model = MODELS[i % MODELS.length];
		const when = startMs + i * 60_000;
		const spanId = `span-${startMs}-${i}`;
		const cost = withCost ? NANO_PER_MODEL[model] : 0;
		nano += cost;

		insertSpan.run(
			spanId, `trace-${startMs}-${i}`, null, `chat ${model}`, when, when + 900,
			0, 'chat', 'github', 'panel/editAgent', sessionId,
			model, model, 12_000 + i * 10, 800 + i, 9_000, 200, sessionId, 570
		);
		if (withCost) {
			insertAttr.run(spanId, 'copilot_chat.copilot_usage_nano_aiu', String(cost));
		}

		// Only providers that charge for cache writes report the count, and it
		// has no column on `spans` -- it exists solely as an attribute. Anthropic
		// emits it; the OpenAI models in this rotation do not, which is the split
		// the ingest has to carry through rather than flatten to zero.
		if (model.startsWith('claude')) {
			// Deliberately one token over the fresh count. On the real database
			// the two figures disagree by a few dozen tokens across thousands,
			// and a cache write can never exceed the input that missed the cache.
			insertAttr.run(spanId, 'gen_ai.usage.cache_creation.input_tokens',
				String(12_000 + i * 10 - 9_000 + 1));
		}

		// An agent turn also emits an invoke_agent span repeating the same token
		// counts, and an execute_tool span with none. Both must be excluded or
		// every agent turn is counted twice.
		insertSpan.run(
			`agent-${startMs}-${i}`, `trace-${startMs}-${i}`, null, 'invoke_agent GitHub Copilot Chat',
			when, when + 950, 1, 'invoke_agent', 'github', 'GitHub Copilot Chat', sessionId,
			model, model, 12_000 + i * 10, 800 + i, null, null, sessionId, null
		);
		insertSpan.run(
			`tool-${startMs}-${i}`, `trace-${startMs}-${i}`, `agent-${startMs}-${i}`,
			'execute_tool read_file', when + 10, when + 60, 1, 'execute_tool',
			null, null, sessionId, null, null, null, null, null, null, sessionId, null
		);
	}
	return nano;
}

const db = new DatabaseSync(dbPath);
// Mirrors github.copilot-chat 0.62.0, schema_version 1.
db.exec(`CREATE TABLE schema_version (version INTEGER)`);
db.exec(`INSERT INTO schema_version VALUES (1)`);
db.exec(`CREATE TABLE spans (
	span_id TEXT PRIMARY KEY, trace_id TEXT, parent_span_id TEXT, name TEXT,
	start_time_ms INTEGER, end_time_ms INTEGER, status_code INTEGER, status_message TEXT,
	operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
	request_model TEXT, response_model TEXT, input_tokens INTEGER, output_tokens INTEGER,
	cached_tokens INTEGER, reasoning_tokens INTEGER, tool_name TEXT, tool_call_id TEXT,
	tool_type TEXT, chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL
)`);
db.exec(`CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT)`);

const now = Date.now();
const firstBatchNano = seed(db, { count: 30, startMs: now - 3 * 60 * 60 * 1000 });
db.close();

// userDir points at a directory with no workspaceStorage, so workspace
// resolution degrades to "unknown" -- which is what we assert below.
const fixture = [{
	path: dbPath, channel: 'Code', profile: 'default',
	userDir: path.join(dir, 'User'), sizeBytes: 0, mtime: Date.now()
}];

console.log('\nfirst ingest');
const store = new RollupStore(storePath);
const first = await ingestAll(store, fixture, undefined, []);
check('databases read', first.dbCount, 1);
check('LLM spans counted', first.spansCounted, 30);
// One model in the rotation legitimately reports zero cost, as gpt-4o-mini does.
check('spans with non-zero billed cost', first.costSpans, 20);
check('invoke_agent + tool spans excluded', sum(store.all()).requests, 30);
check('nano_aiu total preserved', sum(store.all()).nanoAiu, firstBatchNano);
check('models separated', groupBy(store.all(), 'model').size, 3);
check('unresolvable workspace reported as unknown', [...groupBy(store.all(), 'workspace').keys()][0], 'unknown');

// `cacheWriteTokens` was declared, summed and hardcoded to zero, so the panel
// could not tell input that was written to cache -- billed at a premium -- from
// input that was merely not read from it.
const byModelFirst = groupBy(store.all(), 'model');
const anthropic = byModelFirst.get('claude-sonnet-4.5');
const openai = byModelFirst.get('gpt-4o-mini-2024-07-18');
check('cache writes are read from the attribute, not left at zero',
  anthropic.cacheWriteTokens > 0, true);
check('and never exceed the input that missed the cache',
  anthropic.cacheWriteTokens, Math.max(0, anthropic.inputTokens - anthropic.cacheReadTokens));
check('a provider that reports none is recorded as none, not as missing',
  openai.cacheWriteTokens, 0);

console.log('\nre-ingest with no new spans (de-duplication)');
const second = await ingestAll(store, fixture, undefined, []);
check('no double counting', sum(store.all()).requests, 30);
check('nothing newly counted', second.spansCounted, 0);

console.log('\nincremental ingest of newer spans');
const db2 = new DatabaseSync(dbPath);
const secondBatchNano = seed(db2, { count: 10, startMs: now - 30 * 60 * 1000, sessionId: SESSION_B });
db2.close();
const third = await ingestAll(store, fixture, undefined, []);
check('only new spans counted', third.spansCounted, 10);
check('running total correct', sum(store.all()).requests, 40);
check('nano_aiu accumulated', sum(store.all()).nanoAiu, firstBatchNano + secondBatchNano);
check('agent breakdown retained', groupBy(store.all(), 'operation').size, 1);

console.log('\npersistence across restart');
store.save();
const reopened = new RollupStore(storePath);
check('rollup survived reload', sum(reopened.all()).requests, 40);
check('cursor survived reload', (await ingestAll(reopened, fixture, undefined, [])).spansCounted, 0);

console.log('\nmissing cost attribute (graceful degradation)');
const db3 = new DatabaseSync(dbPath);
seed(db3, { count: 5, startMs: now - 5 * 60 * 1000, withCost: false });
db3.close();
const fourth = await ingestAll(reopened, fixture, undefined, []);
check('token-only spans still counted', fourth.spansCounted, 5);
check('cost coverage reported honestly', fourth.costSpans, 0);

console.log('\nreport rendering');
const html = renderReport({
	rollups: reopened.since(30),
	creditsPerNanoAiu: 1e-9,
	dbCount: 1,
	lastRefresh: new Date(),
	costCoverage: fourth.costSpans / fourth.spansCounted,
	warnings: []
, prices: store.priceStats(), depth: store.depthStats() });
check('html produced', html.startsWith('<!DOCTYPE html>'), true);
check('model appears in report', html.includes('claude-sonnet-4.5'), true);
check('auxiliary model appears in report', html.includes('gpt-4o-mini'), true);
check('no script tags in webview', /<script/i.test(html), false);

// A fixture run must read nothing outside its fixture. `backfill` defaults to
// the real user directories, so an unisolated call quietly mixed live
// transcripts into these counts and the numbers drifted as the machine was used.
{
  const isolated = new RollupStore(path.join(dir, 'isolation.json'));
  await ingestAll(isolated, fixture, undefined, []);
  const models = new Set(isolated.all().map(r => r.model));
  check('fixture run sees only fixture models', models.size, 3);
  check('and nothing marked as recovered history',
    isolated.all().some(r => r.source === 'reported'), false);
}

// Numbers must be named. This has been the single most repeated fault in the
// UI -- an icon that looked like a meter, a tile reading "275", a chart column
// of bare credits -- so it is checked rather than remembered.
{
  const strip = s => s.replace(/<style[\s\S]*?<\/style>/g, '');
  const bad = [];
  // Every <th> must sit over cells aligned the same way, or the header reads
  // as belonging to the column beside it.
  for (const m of strip(html).matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const head = /<tr>([\s\S]*?)<\/tr>/.exec(m[1]);
    if (!head) continue;
    const ths = [...head[1].matchAll(/<th([^>]*)>([^<]*)</g)];
    const firstBody = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)][1];
    if (!firstBody) continue;
    const tds = [...firstBody[1].matchAll(/<td([^>]*)>/g)];
    ths.forEach((th, i) => {
      if (!tds[i] || !th[2].trim()) return;
      const thNum = /class="[^"]*\bnum\b/.test(th[1]);
      const tdNum = /class="[^"]*\b(num|pct-only)\b/.test(tds[i][1]);
      if (thNum !== tdNum) bad.push(`"${th[2].trim()}" header/cell alignment`);
    });
  }
  check('every column header matches its column alignment', bad.join('; '), '');
}

// The composition bar must account for every credit the by-model table shows.
// An earlier version silently dropped the spend on models without a solved
// rate card -- a third of the bill, gone between two sections of one screen.
{
  const seg = [...html.matchAll(/class="swatch [^"]*"><\/i>([\s\S]*?)<strong>([\d.,]+)\s*cr<\/strong>/g)];
  if (seg.length > 0) {
    const shown = seg.reduce((n, m) => n + parseFloat(m[2].replace(/,/g, '')), 0);
    const total = sum(reopened.since(30)).nanoAiu * 1e-9;
    check('composition reconciles with total spend', Math.abs(shown - total) < 0.02, true);
  } else {
    check('composition falls back to token counts', /not by cost/.test(html), true);
  }
}

// The cost-weighted branch, with one model priced and one not, so the
// "not yet priced" remainder has to appear for the bar to add up.
{
  const CARD = { fresh: 0.25, cached: 0.02, output: 1.0 };
  const stats = emptyStats();
  for (const [f, c, o] of [[20000, 0, 300], [500, 19000, 700], [3000, 21000, 250],
                           [800, 24000, 900], [12000, 5000, 120], [200, 30000, 640],
                           [7000, 11000, 480]])
    accumulate(stats, f, c, o, ((f * CARD.fresh + c * CARD.cached + o * CARD.output) / 1000) / 1e-9);

  const row = (model, nanoAiu, input, cached, output) => ({
    day: '2026-08-26', model, workspace: 'w', operation: 'panel/editAgent',
    selection: 'manual', requests: 4, inputTokens: input, outputTokens: output,
    reasoningTokens: 0, cacheReadTokens: cached, cacheWriteTokens: 0, nanoAiu,
    missRequests: 0, missInputTokens: 0, missNanoAiu: 0
  });
  // priced: 50k fresh, 130k cached, 4.8k output -> 12.5 + 2.6 + 4.8 = 19.90 cr
  const priced = row('priced-model', 19.9 / 1e-9, 180000, 130000, 4800);
  const unpriced = row('unpriced-model', 6.1 / 1e-9, 40000, 10000, 900);

  const costHtml = renderReport({
    rollups: [priced, unpriced], creditsPerNanoAiu: 1e-9, dbCount: 1,
    lastRefresh: new Date(), costCoverage: 1, warnings: [], projection: undefined,
    prices: { 'priced-model': stats }, depth: store.depthStats()
  });
  check('table carries a credits column', /<th class="num">Credits<\/th>/.test(costHtml), true);
  check('and a tokens column', /<th class="num">Tokens<\/th>/.test(costHtml), true);
  check('unattributable spend is shown', /not measured yet/.test(costHtml), true);

  // Rows must account for every credit the by-model table shows.
  const rows = [...costHtml.matchAll(
    /<tr class="comp-(top|child)">\s*<td class="comp-name">([^<]+)<\/td>\s*(?:<td class="num rate">[^<]*<\/td>\s*)?<td class="num">([\d.,]+)<\/td>/g)]
    .filter(m => m[1] === 'top');
  const shown = rows.reduce((n, m) => n + parseFloat(m[3].replace(/,/g, '')), 0);
  check('rows reconcile with total spend', Math.abs(shown - 26.0) < 0.02, true);

  // Credits and tokens are read off the same rows, so the two shares cannot
  // drift onto different populations the way two prose percentages did.
  // Three top-level rows and two children beneath the first. The old count of
  // four came from a regex matching a mix of both levels.
  check('three top-level rows', rows.length, 3);
  check('two children under the first', (costHtml.match(/class="comp-child"/g) || []).length, 2);

  // The hierarchy has to hold, not merely happen to: the input subtotal is
  // exactly its two children, and children are outside the share columns.
  // Parsed with one literal regex -- building RegExp from a string put `\s`
  // through two escape layers and silently matched nothing, twice.
  const cells = Object.fromEntries([...costHtml.matchAll(
    /<td class="comp-name">([^<]+)<\/td>\s*(?:<td class="num rate">[^<]*<\/td>\s*)?<td class="num">([\d.,]+)<\/td>/g)]
    .map(m => [m[1].trim().replace(/&#39;/g, "'"), parseFloat(m[2].replace(/,/g, ''))]));
  check('subtotal equals its parts',
    Math.abs(cells['what you send'] -
      (cells['new, charged in full'] + cells['repeated, from cache'])) < 0.01, true);
  // Thinking tokens are billed inside output, not alongside it: a fourth
  // coefficient fitted against real reasoning-bearing requests came out at
  // -0.00008 credits per 1k with R2 unchanged. So the row is a CHILD -- it must
  // appear, priced at the output rate, and must not move the totals.
  const withThinking = renderReport({
    rollups: [{ ...priced, reasoningTokens: 1200 }, unpriced],
    creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(), costCoverage: 1,
    warnings: [], projection: undefined,
    prices: { 'priced-model': stats }, depth: store.depthStats()
  });
  check('thinking is reported', /thinking, never shown/.test(withThinking), true);
  check('and reported as a child, not a fourth category',
    /<tr class="comp-child">\s*<td class="comp-name">thinking, never shown/.test(withThinking), true);
  const thinkCredits = parseFloat(withThinking.match(
    /thinking, never shown<\/td>\s*(?:<td class="num rate">[^<]*<\/td>\s*)?<td class="num">([\d.,]+)<\/td>/)[1]);
  // 1.2k tokens at the solved output rate of 1.00 credits per 1k.
  check('priced at the output rate', Math.abs(thinkCredits - 1.20) < 0.01, true);
  const topsWith = [...withThinking.matchAll(
    /<tr class="comp-top">\s*<td class="comp-name">([^<]+)<\/td>\s*(?:<td class="num rate">[^<]*<\/td>\s*)?<td class="num">([\d.,]+)<\/td>/g)]
    .reduce((n, m) => n + parseFloat(m[2].replace(/,/g, '')), 0);
  check('and counted inside output, not added to the bill',
    Math.abs(topsWith - 26.0) < 0.02, true);
  check('a model with no thinking shows no row',
    /thinking, never shown/.test(costHtml), false);

  // The composition row states a fact nobody can act on. What is actionable is
  // that models differ, so the share sits beside the model names too.
  // Volume explains why a model's total is what it is: 21 messages carrying
  // 719k tokens is a different story from 21 short ones.
  // By project and by model both report a mean across sessions; on real data two
  // conversations in one project cost 2.25 and 1.56 credits a message.
  const convStore = new RollupStore(path.join(dir, 'conv.json'));
  const t0 = Date.parse('2026-08-26T17:33:00Z');
  for (let i = 0; i < 10; i++) convStore.observeConversation('a', t0 + i * 1000, 2.0e9, 'proj');
  for (let i = 0; i < 4; i++) convStore.observeConversation('b', t0 + i * 1000, 1.0e9, 'proj');
  convStore.observeConversation('c', t0, 0.5e9, 'unknown');
  const conv = convStore.conversationStats();
  check('conversations accumulate per session', Object.keys(conv).length, 3);
  check('with their request counts', conv.a.requests, 10);
  check('and their spend', conv.a.nanoAiu, 20e9);
  check('first and last are kept apart', conv.a.lastMs - conv.a.firstMs, 9000);

  const convHtml = renderReport({
    rollups: [priced], creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(),
    costCoverage: 1, warnings: [], projection: undefined,
    prices: {}, depth: {}, conversations: conv
  });
  check('the panel breaks spend down by conversation',
    /<th>By conversation<\/th>/.test(convHtml), true);
  check('labelled by project, not by uuid',
    /<td>proj <span class="dim">/.test(convHtml) && !/<td>a<\/td>/.test(convHtml), true);
  const each = [...convHtml.matchAll(
    /<tr[^>]*>\s*<td>proj[\s\S]*?<td class="num">(\d+)<\/td>\s*<td class="num">([\d.]+)<\/td>/g)]
    .map(m => [Number(m[1]), Number(m[2])]);
  check('cost per message is per conversation, not pooled',
    JSON.stringify(each), JSON.stringify([[10, 2.00], [4, 1.00]]));
  check('dearest first', convHtml.indexOf('20.00') < convHtml.indexOf('4.00'), true);

  // One conversation is not a comparison, and the comparison is the point.
  const single = renderReport({
    rollups: [priced], creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(),
    costCoverage: 1, warnings: [], projection: undefined,
    prices: {}, depth: {}, conversations: { a: conv.a }
  });
  check('withheld below two conversations', /By conversation/.test(single), false);

  // Bounded by age like the turn counters beside it, or the store grows forever.
  convStore.pruneTurns(1000);
  check('old conversations are pruned', Object.keys(convStore.conversationStats()).length, 0);

  // The two credit figures on the panel, reconciled.
  //
  // The meter reads GitHub's consumption for the period and the breakdown reads
  // ours; before this they were printed side by side with nothing saying why
  // they differ. Dated from today so the assertion does not expire.
  const today = new Date().toISOString().slice(0, 10);
  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const reset = nextMonth.toISOString().slice(0, 10);
  const dated = (r) => ({ ...r, day: today });
  const withQuota = (creditsUsed) => renderReport({
    rollups: [dated(priced), dated(unpriced)], creditsPerNanoAiu: 1e-9, dbCount: 1,
    lastRefresh: new Date(), costCoverage: 1, warnings: [],
    projection: {
      verdict: 'ok', quotaId: 'premium_interactions', entitlement: 1500,
      remaining: 1500 - creditsUsed, creditsUsed, resetDate: reset
    },
    prices: {}, depth: {}
  });

  // 19.9 + 6.1 = 26.0, exactly what GitHub billed.
  const agreed = withQuota(26.0);
  check('the panel reconciles GitHub\'s figure against ours',
    /GitHub bills/.test(agreed), true);
  check('agreement does not allege spend elsewhere',
    /accounts for\s+essentially all of it/.test(agreed), true);

  const elsewhere = withQuota(50.0);
  check('a shortfall is named as spend this machine cannot see',
    /cannot see/.test(elsewhere), true);
  check('and quantified rather than merely alleged',
    /24\.00 credits went somewhere/.test(elsewhere.replace(/\s+/g, ' ')), true);
  check('and says the breakdown below is only part of the story',
    /only what happened here/.test(elsewhere.replace(/\s+/g, ' ')), true);

  // Measuring more than we were billed is a calibration fault, not a discovery
  // about other machines, and must not be reported as one.
  const overMeasured = withQuota(10.0);
  check('over-measurement points at the conversion',
    /creditsPerNanoAiu/.test(overMeasured.split('What to change')[0]), true);
  check('and not at other machines',
    /cannot see/.test(overMeasured), false);

  // Without a reset date there is no period to compare over, and inventing one
  // would put a confident wrong number beside the meter.
  const noReset = renderReport({
    rollups: [dated(priced)], creditsPerNanoAiu: 1e-9, dbCount: 1,
    lastRefresh: new Date(), costCoverage: 1, warnings: [],
    projection: { verdict: 'ok', entitlement: 1500, remaining: 1474, creditsUsed: 26 },
    prices: {}, depth: {}
  });
  check('withheld when the billing period is unknown', /GitHub bills/.test(noReset), false);

  check('the breakdowns carry token counts',
    /<th>By model<\/th>[\s\S]*?<th class="num">Tokens<\/th>/.test(html), true);
  check('projects too',
    /<th>By project<\/th>[\s\S]*?<th class="num">Tokens<\/th>/.test(html), true);
  // Deliberately absent: a per-model rate blends three prices in whatever mix
  // the developer happened to use, so it would read as a property of the model
  // and be a property of the month. See ARCHITECTURE.md.
  check('but no pooled per-token rate beside the models',
    /<th>By model<\/th>[\s\S]*?<th class="num">Per token<\/th>/.test(html), false);

  check('the by-model table gains a thinking column',
    /<th class="num">Thinking<\/th>/.test(withThinking), true);
  check('and shows it as a share of that model\'s own replies',
    /<td class="num">25%<\/td>/.test(withThinking), true);
  check('a model reporting none shows a dash, not 0%',
    /<td class="num dim">&mdash;<\/td>/.test(withThinking), true);
  check('and the column is absent when nothing reports thinking',
    /<th class="num">Thinking<\/th>/.test(costHtml), false);

  // The two share columns show the divergence; nothing said what drives it, and
  // a reader who does not stop to compare 1% of tokens against 21% of credits
  // leaves without the finding. Stated as a multiple, measured from this
  // machine's own card -- a per-1k rate column was tried and removed.
  check('the cost gap between input and output is stated',
    /a token Copilot writes costs 4x one you send new/.test(costHtml), true);
  check('and against cached input too',
    /50x one it reads back from cache/.test(costHtml), true);
  check('still no per-1k rate column', /<th>Per 1k<\/th>/.test(costHtml), false);

  // Volume and cost were both shown and the price never was, so the reader had
  // to divide one column by the other to find out why 1% of the tokens is 21%
  // of the bill. Stated as a multiple of fresh input, which is shown as 1x so
  // the baseline is visible rather than implied.
  check('the price is on the rows, not only in the prose',
    /<th class="num">Per token<\/th>/.test(costHtml), true);

  // Two columns both called "Share" left position as the only clue to which
  // measure each belonged to.
  check('each share column names its own denominator',
    /% of spend<\/th>[\s\S]*?% of text<\/th>/.test(costHtml), true);
  check('and neither is called just "Share"',
    /<th class="num">Share<\/th>/.test(costHtml), false);
  const rate = label => (costHtml.match(new RegExp(
    `<td class="comp-name">${label}<\\/td>\\s*<td class="num rate">([^<]*)<\\/td>`)) || [])[1];
  check('fresh input is the baseline', rate('new, charged in full'), '1&times;');
  check('cache is a fraction of it', rate('repeated, from cache'), '0.08&times;');
  check('a reply costs four times a fresh token', rate("Copilot's replies"), '4&times;');
  // A parent blends two rates; a weighted average of prices is not a price.
  check('subtotals carry no price', rate('what you send'), '');
  check('nor does unpriced spend', rate('not measured yet'), '');

  // The row was called "new, charged in full" whatever the tokens were. But
  // input that misses the cache is usually also *written* to it, and a cache
  // write bills above plain input -- $2.50 per million against $2.00 on
  // claude-sonnet-5. The 0.25 credits per 1k the solver recovers for this class
  // is the published cache-write price, not the published input price, so the
  // old label denied a premium the row was already carrying.
  const written = renderReport({
    rollups: [{ ...priced, cacheWriteTokens: 50000 }], creditsPerNanoAiu: 1e-9,
    dbCount: 1, lastRefresh: new Date(), costCoverage: 1, warnings: [],
    projection: undefined, prices: { 'priced-model': stats }, depth: {}
  });
  check('a cache write is not described as charged in full',
    /charged in full/.test(written), false);
  check('it is named as what it is',
    /new, and cached for next time/.test(written), true);
  check('and the surcharge is explained as what buys the discount',
    /surcharge\s+paid once/.test(written), true);

  // Providers that do not bill for cache writes report none, and on those the
  // original wording was right. The label follows the data rather than picking.
  check('a model that writes no cache keeps the old wording',
    /new, charged in full/.test(costHtml), true);
  check('and carries no surcharge note', /surcharge/.test(costHtml), false);

  // Neither wording fits a mixed population, and asserting either would be a
  // claim about tokens that are half one thing and half the other.
  const mixed = renderReport({
    rollups: [{ ...priced, cacheWriteTokens: 25000 }], creditsPerNanoAiu: 1e-9,
    dbCount: 1, lastRefresh: new Date(), costCoverage: 1, warnings: [],
    projection: undefined, prices: { 'priced-model': stats }, depth: {}
  });
  check('a mixed row claims neither', /new to this request/.test(mixed), true);

  // A mark nobody can decode reads as a rendering fault, and a permanent
  // disclaimer trains the reader to stop looking at badges that matter. So the
  // sentence appears only when something on the page is actually marked.
  const unverified = renderReport({
    rollups: [{ ...priced, requests: 30, missRequests: 6, missInputTokens: 40000,
      missNanoAiu: 8e9, model: 'priced-model' }],
    creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(), costCoverage: 1,
    warnings: [], projection: undefined, prices: { 'priced-model': stats }, depth: {}
  });
  const marked = /<span class="stake estimated"/.test(unverified);
  check('an unverified conversion marks the findings it produced', marked, true);
  check('and the page says what the mark is',
    /The <strong>~<\/strong> on each figure is the credit/.test(unverified), true);

  // Command Palette was the only way in, which is not discoverable enough for
  // a page whose job is answering "why is the panel not telling me anything".
  check('the panel says where the console is',
    /debug console/.test(html) && /title bar/.test(html), true);

  check('labels avoid internal jargon',
    /input tokens|output tokens|not yet priced|\bturns?\b/.test(costHtml), false);
  check('what you send and what comes back are both named',
    'what you send' in cells && "Copilot's replies" in cells, true);
  check('top-level rows sum to total spend',
    Math.abs((cells['what you send'] + cells["Copilot's replies"] +
      cells['not measured yet']) - 26.0) < 0.02, true);

  check('the abstract per-1k rate column is gone', /<th>Per 1k<\/th>/.test(costHtml), false);

  // Every weakened figure must be distinguishable without reading the mark, so
  // the styling that carries it has to survive in the shipped stylesheet.
  check('the estimated chip style ships', /\.stake\.estimated/.test(html), true);

  // Both disclosures must advertise themselves the same way. A glyph triangle
  // at 0.75em was too faint to read as a control, and the two used different
  // ones, so the cards and the breakdown looked like unrelated components.
  check('one chevron serves both disclosures',
    /\.card-title::before,\s*\n?\s*details\.detail > summary::before/.test(html), true);
  check('it is drawn, not typed', /border-right: 1\.7px solid currentColor/.test(html), true);
  check('and it turns over when open',
    /details\.detail\[open\] > summary::before \{ transform: rotate\(-135deg\); \}/.test(html), true);
  check('the old glyph triangles are gone', /\\25B8|\\25BE/.test(html), false);

  // An <h2> closes nothing, so the breakdown was a bare sibling of the advice
  // cards. Sharing their chrome, it then read as a third recommendation rather
  // than reference. Each section has to be closed for the boundary to exist.
  check('recommendations and reference are separate sections',
    (html.match(/<section>/g) || []).length >= 2, true);
  check('every section is closed',
    (html.match(/<section\b/g) || []).length === (html.match(/<\/section>/g) || []).length, true);
  check('the breakdown sits outside the advice section',
    /<\/section>\s*(<!--[\s\S]*?-->)?\s*<section>\s*<h2>Where the credits went<\/h2>/.test(html), true);
  check('the unit every figure uses is defined',
    /Note: An <strong>AI Credit<\/strong> is GitHub's billing unit/
      .test(html.replace(/\s+/g, ' ')), true);
  // It rides in the dead space beside the pace tiles rather than standing as a
  // paragraph above the card, which cost 63px of height for the same words.
  // "cr" and "credits" were both in use, which reads as two units. One word.
  const visible = html.slice(html.indexOf('<body')).replace(/<[^>]+>/g, ' ');
  const abbreviated = visible.match(/[\d.,]+\s*\bcr\b[/\w]*/g) || [];
  check('the unit is never abbreviated to "cr"', abbreviated.join(', '), '');
  // The hero shares a row with a two-part column now, so a baseline would pin
  // it to the first line and strand it at the top.
  check('the hero is centred against the column beside it',
    /\.verdict-top \{ display: flex; align-items: center;/.test(html), true);
  check('footer identifiers are picked out of the prose',
    /footer code \{ font-weight: 700;/.test(html), true);
  check('it is spelled out beside a figure', /[\d.,]+\s+credits?\b/.test(visible), true);

  // A definition has to precede the first figure that uses it, so the note sits
  // under the verdict sentence -- not beside the pace tiles, where it followed
  // the meter and read as a caption for YOUR PACE.
  check('the note sits under the verdict sentence',
    /<p class="sentence">[\s\S]*?<p class="lede">/.test(html), true);
  // The meter is absent when no allowance is known, so only assert the order
  // when there is something to be ordered against.
  const meterAt = html.indexOf('class="meter-wrap"');
  check('and above the allowance meter when there is one',
    meterAt === -1 || html.indexOf('class="lede"') < meterAt, true);
  check('and not as a block above the verdict card',
    /<p class="lede">[\s\S]*?<section class="verdict"/.test(html), false);
  check('with a reference that is not a bare domain',
    /href="https:\/\/docs\.github\.com\/en\/copilot\/concepts\/billing\/[a-z-]+"/.test(html), true);
  check('the history window is stated', /up to the last 30 days/.test(html.replace(/\s+/g, ' ')), true);
  // `tokenPie.history.days` moves that window, and a note claiming 30 days on a
  // panel keeping 14 is a lie the reader has no way to catch.
  check('and follows the setting rather than being hardcoded',
    /up to the last 14 days/.test(renderReport({
      rollups: [priced], creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(),
      costCoverage: 1, warnings: [], projection: undefined, prices: {}, depth: {},
      tuning: read(id => (id === 'history.days' ? 14 : undefined)).tuning
    }).replace(/\s+/g, ' ')), true);
  check('the title carries the mark', /<svg class="logo"/.test(html), true);
  // A flex container's baseline comes from its first item. With the logo first,
  // <header>'s baseline alignment pinned the date to the image's bottom edge,
  // and every increase in logo size pushed the date further out of line.
  check('the title is not a flex container',
    /\bh1 \{[^}]*inline-flex/.test(html), false);
  check('the logo is aligned optically to the text',
    /\.logo \{ vertical-align:/.test(html), true);
  // The same three slices as images/icon.svg, the file the Marketplace icon is
  // generated from -- one mark across the listing, the tab and the page.
  const iconSvg = fs.readFileSync(new URL('../images/icon.svg', import.meta.url), 'utf8');
  // Compared as numbers, not as strings: the source writes "86.0" and "-0.00"
  // where the panel writes "86" and "0", which is the same geometry.
  const numbers = d => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const slices = iconSvg.match(/M 0 0 L [^"]+/g) || [];
  const drawn = html.match(/M 0 0 L [^"]+/g) || [];
  check('the icon source has three slices', slices.length, 3);
  check('and the panel draws three', drawn.length, 3);
  check('with the same geometry',
    JSON.stringify(slices.map(numbers).map(a => a.map(n => n + 0))),
    JSON.stringify(drawn.map(numbers).map(a => a.map(n => n + 0))));
  check('in theme colours, not the file\'s hex',
    /fill="var\(--vscode-charts-blue/.test(html), true);
  check('and a link to the repository readme',
    /<a class="repo" href="https:\/\/github\.com\/[^"]+#readme"/.test(html), true);

  // A webview is not a browser tab: navigating it away replaces the panel and
  // there is no back button to return with. Every link leaves for the user's
  // own browser, and carries noopener so the opened page cannot reach back
  // through window.opener.
  const anchors = html.match(/<a\b[^>]*>/g) || [];
  check('the panel has links at all', anchors.length > 0, true);
  const notExternal = anchors.filter(a => !/target="_blank"/.test(a));
  check('every link opens outside the panel', notExternal.join(' | '), '');
  const unsafe = anchors.filter(a => !/rel="[^"]*noopener/.test(a));
  check('and every link is noopener', unsafe.join(' | '), '');
  const offsite = anchors.filter(a => !/href="https:\/\//.test(a));
  check('and every link is https', offsite.join(' | '), '');
  // Reference before recommendations: you cannot act on advice about spend you
  // have not seen yet.
  check('the breakdown comes before what to change',
    html.indexOf('Where the credits went') < html.indexOf('What to change'), true);
  check('no recommendation is expanded on arrival',
    /<details class="card" open>/.test(html), false);
  check('the breakdown body sits inside the same region',
    /<summary>[\s\S]*?<\/summary>\s*<div class="detail-body">/.test(html), true);

  check('and its heading does not repeat its summary',
    /<h2>Where the credits went<\/h2>[\s\S]{0,200}?<summary>(?![\s\S]{0,40}Where the credits went)/.test(html), true);
  check('bounded and estimated are not styled identically',
    /\.stake\.estimated \{ border-style: dashed; \}/.test(html), true);
  // Blue adjacent to purple fails CVD separation; green must sit between them.
  check('cached uses the middle hue', /c-cached/.test(costHtml), true);
}

const credits = sum(reopened.all()).nanoAiu * 1e-9;
console.log(`\n  total: ${sum(reopened.all()).requests} requests, ${credits.toFixed(2)} credits`);

const outHtml = path.join(dir, 'report.html');
fs.writeFileSync(outHtml, html);
console.log(`  report written to ${outHtml}`);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
