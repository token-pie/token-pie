#!/usr/bin/env node
/**
 * The billable-span filter, against a database that does not use our word.
 *
 * `operation_name = 'chat'` was hardcoded. On a work machine whose
 * copilot-chat spelled it differently the query matched nothing, and the
 * failure was silent in the worst possible way: MIN(start_time_ms) is taken
 * over the whole table with no filter, so the panel reported when recording
 * began while ingesting none of it. Four days of transcript backfill were then
 * presented as a measured billing period, and 19,094 credits the extension had
 * simply not read were attributed to "another machine, another editor, the
 * CLI, or github.com".
 *
 * These are the three things that have to hold: an unfamiliar name still gets
 * ingested, the wrapper span that repeats its child's token counts still does
 * not get counted twice, and a database we genuinely cannot read says so.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestAll } from '../out/ingest.js';
import { RollupStore } from '../out/store.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const NANO = 'copilot_chat.copilot_usage_nano_aiu';

/** A trace database whose billable spans are named `operation`. */
function fixture(dir, { operation, wrapper, cost = true }) {
  const dbPath = path.join(dir, 'agent-traces.db');
  const db = new DatabaseSync(dbPath);
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

  const span = db.prepare(
    `INSERT INTO spans (span_id, trace_id, parent_span_id, name, start_time_ms, end_time_ms,
      status_code, operation_name, provider_name, agent_name, conversation_id,
      request_model, response_model, input_tokens, output_tokens, cached_tokens,
      reasoning_tokens, chat_session_id, ttft_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const attr = db.prepare('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)');

  const now = Date.now() - 60 * 60 * 1000;
  for (let i = 0; i < 4; i++) {
    const id = `s${i}`;
    span.run(id, `t${i}`, null, 'call', now + i * 60_000, now + i * 60_000 + 900,
      0, operation, 'github', 'panel/editAgent', 'sess',
      'claude-sonnet-5', 'claude-sonnet-5', 12_000, 800, 0, 0, 'sess', 500);
    if (cost) { attr.run(id, NANO, String(1_000_000_000)); }

    // The wrapper repeats its child's token counts verbatim and carries no
    // cost attribute. Counting it would double every agent turn.
    if (wrapper) {
      span.run(`w${i}`, `t${i}`, id, 'wrap', now + i * 60_000, now + i * 60_000 + 950,
        0, wrapper, 'github', 'panel/editAgent', 'sess',
        'claude-sonnet-5', 'claude-sonnet-5', 12_000, 800, 0, 0, 'sess', 500);
    }
  }
  db.close();
  return [{ path: dbPath, channel: 'Code', profile: 'default',
            userDir: path.join(dir, 'User'), sizeBytes: 0, mtime: Date.now() }];
}

async function run(name, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tp-ops-${name}-`));
  const dbs = fixture(dir, opts);
  const store = new RollupStore(path.join(dir, 'rollup.json'));
  const result = await ingestAll(store, dbs, undefined, []);
  return { result, store };
}

console.log('a database that spells the operation our way');
{
  const { result } = await run('chat', { operation: 'chat', wrapper: 'invoke_agent' });
  check('billable spans counted', result.spansCounted, 4);
  check('the wrapper is not counted twice', result.costSpans, 4);
  check('and nothing is reported wrong', result.errors.length + result.notices.length, 0);
}

console.log('\na database that does not');
{
  // The whole failure, reproduced: every span is billable and none is named
  // `chat`. Hardcoded, this ingested zero and said nothing.
  const { result } = await run('other', { operation: 'llm.chat', wrapper: 'invoke_agent' });
  check('an unfamiliar name is still ingested', result.spansCounted, 4);
  check('the wrapper beside it still is not', result.costSpans, 4);
  check('and this is not remarked on at all', result.errors.length + result.notices.length, 0);
}

console.log('\nthe wrapper alone is never billable');
{
  // Only the wrapper carries no cost attribute, so it must not become the
  // discovered name even though it is the only other one present.
  const { result } = await run('wrap', { operation: 'llm.chat', wrapper: 'invoke_agent' });
  check('one operation discovered, not two', result.spansCounted, 4);
}

console.log('\na database with nothing billable in it says so');
{
  // The work-machine shape: spans present, none carrying cost, so nothing is
  // discoverable and the `chat` fallback matches nothing either.
  const { result } = await run('none', { operation: 'llm.chat', wrapper: undefined, cost: false });
  check('nothing was ingested', result.spansCounted, 0);
  check('and it is reported', result.notices.length, 1);
  // Not an error. The status bar treats any error as a degraded install and
  // sends its click to the log instead of the report, so filing this as one
  // took the panel away from a machine whose only problem was an empty
  // database -- which is exactly the machine that needed to read the panel.
  check('as a finding, not a fault', result.errors.length, 0);
  const e = result.notices[0] ?? '';
  check('the error names what was looked for', e.includes('chat'), true);
  check('and what the database actually holds', e.includes('llm.chat (4)'), true);
  // The panel showed transcript backfill as measurement; the warning has to
  // say which of the two the credit figures came from.
  check('and which source the figures came from', e.includes('transcripts'), true);
}

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
