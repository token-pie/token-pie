#!/usr/bin/env node
/**
 * The log is written to be pasted, so nothing in it may name you.
 *
 * Four times this failed the same way, and each fix covered only the site
 * that had just been noticed:
 *
 *   - the quota check printed the GitHub login and the whole organization
 *     list as plain lines, directly above the raw dump that does strip them,
 *     under a heading promising identifiers were removed;
 *   - purge and diagnostics printed the trace-database path while every
 *     other site in the same file redacted it -- on Windows that path is
 *     `C:\Users\<name>`;
 *   - ingest notices reached the panel and the sidebar unredacted, because
 *     `redactPaths` had been applied to `errors` and notices arrived later;
 *   - the quota check's own failure line skipped what the refresh path does.
 *
 * A reviewer catches one site. This reads every one of them, so the next
 * `appendLine` that interpolates a path or an account has to answer for it.
 *
 * Usage: npm run test:redaction
 */
import fs from 'fs';
import path from 'path';

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const holds = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
};

const root = path.resolve(new URL('..', import.meta.url).pathname);

/**
 * What carries an identity: a filesystem path, or the account behind it.
 *
 * `err`/`message` are here because a raw filesystem error quotes the file it
 * failed on, which is how the home directory reached the log the first time.
 */
const RISKY = /\b(\w*\.(db|path|dir|file|home)\b|\w*(Path|Dir|Db)\b|login\b|organizations\b|homedir\b|err\b|error\b|message\b)/;

/**
 * Expressions that mention something risky and disclose none of it.
 *
 * Each is a value derived from an identifier rather than the identifier: a
 * presence test, or a count. Anything else has to be wrapped at the point of
 * use, which is the readable form anyway.
 */
const SAFE = new Set([
  "e.login ? '(signed in)' : '(absent)'",  // whether, never who
  'e.organizations.length'                 // how many, never which
]);

/** Locals a file has already put through `redactPaths`, so `safe` passes. */
const redactedLocals = src =>
  new Set([...src.matchAll(/const\s+(\w+)\s*=\s*redactPaths\(/g)].map(m => m[1]));

/** The span of the argument list, from the paren after `name` to its match. */
function args(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') { depth++; }
    else if (src[i] === ')') { depth--; if (depth === 0) { return src.slice(open + 1, i); } }
  }
  return '';
}

/** Every `${...}` in a template, brace-balanced so a nested object survives. */
function interpolations(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '{') { continue; }
    let depth = 0;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '{') { depth++; }
      else if (text[j] === '}') { depth--; if (depth === 0) { out.push(text.slice(i + 2, j)); i = j; break; } }
    }
  }
  return out;
}

/** Wrapped where it is used: `redactPaths(...)` around the whole expression. */
const wrapped = expr => {
  const e = expr.trim();
  return e.startsWith('redactPaths(') && args(e, e.indexOf('(')).length === e.length - 'redactPaths('.length - 1;
};

/**
 * Every offending interpolation in one file's log calls.
 *
 * Returned rather than asserted so the rule can be run against invented
 * source below: a check nobody has watched fail is a check that proves
 * nothing, and this one exists because five of those shipped.
 */
export function leaks(src, sink = 'output.appendLine') {
  const found = [];
  const clean = redactedLocals(src);
  let at = 0;
  for (;;) {
    const i = src.indexOf(`${sink}(`, at);
    if (i < 0) { return found; }
    const arg = args(src, i + sink.length);
    at = i + sink.length + arg.length;
    const parts = arg.includes('${') ? interpolations(arg)
      : /^\s*['"`]/.test(arg) ? [] : [arg];
    for (const expr of parts) {
      const e = expr.trim();
      if (!RISKY.test(e) || wrapped(e) || SAFE.has(e) || clean.has(e)) { continue; }
      found.push(`${src.slice(0, i).split('\n').length}: ${e.slice(0, 60)}`);
    }
  }
}

console.log('the rule notices');
check('a bare path', leaks('output.appendLine(`  ${db.path}`);').length, 1);
check('a bare login', leaks('output.appendLine(`account ${e.login}`);').length, 1);
check('a caught error', leaks('output.appendLine(`failed: ${err.message}`);').length, 1);
check('a variable argument', leaks('output.appendLine(detail);').length, 0);
check('the same one named', leaks('output.appendLine(dbPath);').length, 1);

console.log('\nand does not cry wolf');
check('a wrapped path', leaks('output.appendLine(`  ${redactPaths(db.path)}`);').length, 0);
check('a wrapped ternary', leaks(
  'output.appendLine(`${redactPaths(err instanceof Error ? err.message : String(err))}`);'
).length, 0);
check('a presence test', leaks("output.appendLine(`${e.login ? '(signed in)' : '(absent)'}`);").length, 0);
check('a plain string', leaks("output.appendLine('nothing here names you');").length, 0);
check('a count of something else', leaks('output.appendLine(`${rollups.length} rows`);').length, 0);
// The wrapper has to cover the whole expression, not merely appear in it --
// `${redactPaths(a)}: ${b}` was how the purge line leaked while looking fixed.
check('a half-wrapped line', leaks('output.appendLine(`${redactPaths(r.db)}: ${r.error}`);').length, 1);

console.log('\nthe extension holds to it');
const src = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const found = leaks(src);
check('every log line is redacted or discloses nothing', found.length, 0);
for (const f of found) { console.log(`        src/extension.ts:${f}`); }

// The views take the same text. Redacting at the sink missed this entirely:
// `errors` was mapped and `notices`, added later, was not.
console.log('\nand so does what the views are handed');
const clean = redactedLocals(src);
for (const field of ['lastErrors', 'lastNotices']) {
  const lines = src.split('\n').filter(l => new RegExp(`^\\s*${field}\\s*=`).test(l));
  const safeRhs = l => {
    const rhs = l.slice(l.indexOf('=') + 1).trim().replace(/;$/, '');
    return rhs.includes('redactPaths') || rhs === '[]'
      || [...clean].some(name => rhs === `[${name}]`);
  };
  holds(`${field} is redacted wherever it is set`,
    lines.length > 0 && lines.every(safeRhs),
    lines.join(' | ') || 'never assigned');
}

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
