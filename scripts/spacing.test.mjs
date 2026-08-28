#!/usr/bin/env node
/**
 * Vertical spacing, measured rather than eyeballed.
 *
 * Margins here were set per element as each cramped pair was noticed, which is
 * why fixing them never stayed fixed: a margin tuned against a neighbour that
 * later moves leaves a zero nobody sees again until it is on screen. Two
 * shipped that way -- a lede flush against the first pane, a verdict line
 * flush against the gate groups -- both margins deliberately zeroed for a
 * layout that no longer existed.
 *
 * So this renders both pages in a real engine and measures the gap between
 * every pair of adjacent block elements. Padding counts: it sits inside the
 * border box, so a 0px box gap can still read as comfortable and a 10px one
 * can still read as cramped. What is asserted is what the eye sees.
 *
 * Skips when Chrome is absent rather than failing, since it is a rendering
 * check and there is nothing to render in.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { renderReport } from '../out/report.js';
import { renderConsole } from '../out/console.js';
import { parse } from '../out/ratecard.js';
import { read } from '../out/tuning.js';

const CHROME = process.env.CHROME ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome');

if (!fs.existsSync(CHROME)) {
  console.log(`  SKIP  no browser at ${CHROME}; set CHROME=<path> to run this`);
  process.exit(0);
}

/** Below this, two blocks read as one. */
const MIN_GAP = 8;

/**
 * Pairs that are meant to be tight, and why.
 *
 * Some blocks are parts of one component -- a meter's caption belongs against
 * its bar, a tile's figure against its label -- and spacing them apart would be
 * the bug. An allow-list rather than a lower floor, so each exemption is a
 * decision somebody made on purpose and anything new still fails.
 */
const DELIBERATELY_TIGHT = new Map([
  ['div.meter-head->div.meter', 'the caption labels the bar directly beneath it'],
  ['div.meter->div.meter-foot', 'and the footnote labels the same bar'],
  ['div.v->div.k', "a tile's figure and its unit are one reading"],
  ['div.stem->div.tick', 'a chart column and its own axis label']
]);

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

const PROBE = `<script>(() => {
  const rows = [];
  const label = e => e.tagName.toLowerCase() +
    (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
  // Inline elements sit inside a line box; the gap between two of them is
  // leading, not layout, and asserting on it would be noise.
  const block = e => {
    const d = getComputedStyle(e).display;
    return d !== 'inline' && d !== 'inline-block' && d !== 'none';
  };
  const walk = parent => {
    const kids = [...parent.children]
      .filter(e => !['SCRIPT','STYLE','COLGROUP'].includes(e.tagName) && block(e));
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i-1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
      if (b.top < a.bottom) continue;
      const pa = parseFloat(getComputedStyle(kids[i-1]).paddingBottom) || 0;
      const pb = parseFloat(getComputedStyle(kids[i]).paddingTop) || 0;
      rows.push({ gap: Math.round(b.top - a.bottom + pa + pb),
                  from: label(kids[i-1]), to: label(kids[i]) });
    }
    for (const k of kids) {
      if (k.children.length && !['TABLE','THEAD','TBODY','TR'].includes(k.tagName)) walk(k);
    }
  };
  walk(document.body);
  const pre = document.createElement('pre');
  pre.id = 'measurements';
  pre.textContent = JSON.stringify(rows);
  document.body.appendChild(pre);
})();</script>`;

function measure(html, file) {
  // The pages ship `default-src 'none'`, which is right for a webview and
  // blocks the probe, and every <details> is opened so nothing hides.
  const prepared = html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, '')
    .replace(/<details([^>]*?)(?<! open)>/g, '<details$1 open>') + PROBE;
  fs.writeFileSync(file, prepared);
  return new Promise((resolve, reject) => {
    execFile(CHROME, ['--headless', '--disable-gpu', '--virtual-time-budget=2000',
      '--window-size=1400,6000', '--dump-dom', `file://${file}`],
      { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        const m = /<pre id="measurements">([\s\S]*?)<\/pre>/.exec(stdout ?? '');
        if (!m) return reject(new Error('probe produced no measurements'));
        resolve(JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')));
      });
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-spacing-'));
const bundled = parse(JSON.parse(fs.readFileSync(
  new URL('../rate-card.json', import.meta.url).pathname, 'utf8')));

const rollup = (over = {}) => ({
  day: '2026-08-26', model: 'claude-sonnet-5', workspace: 'w', operation: 'chat',
  selection: 'manual', source: 'measured', requests: 20, inputTokens: 100000,
  outputTokens: 5000, reasoningTokens: 0, cacheReadTokens: 90000,
  cacheWriteTokens: 9990, nanoAiu: 20e9, missRequests: 4, missInputTokens: 40000,
  missNanoAiu: 12e9, ...over
});

const pages = {
  console: renderConsole({
    rollups: [rollup(), rollup({ model: 'gpt-5.6-luna', requests: 3 })],
    creditsPerNanoAiu: 1e-9, creditsPerNanoAiuIsDefault: true, prices: {},
    readings: read(() => undefined).readings,
    card: { card: bundled, cards: [bundled], origin: 'bundled' },
    pipeline: { databases: 1, spansScanned: 60, spansCounted: 23, costSpans: 23,
      recoveredMessages: 0, errors: [] },
    lastRefresh: new Date()
  }),
  panel: renderReport({
    rollups: [rollup(), rollup({ day: '2026-08-27', model: 'gpt-5.6-luna' })],
    creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(), costCoverage: 1,
    warnings: [], prices: {}, depth: {},
    projection: { verdict: 'ok', quotaId: 'premium_interactions', entitlement: 1500,
      remaining: 1450, percentRemaining: 96.7, creditsUsed: 50, burnPerDay: 5,
      daysToReset: 20, sustainableDailyBurn: 72 }
  })
};

for (const [name, html] of Object.entries(pages)) {
  console.log(`\n${name}`);
  const rows = await measure(html, path.join(dir, `${name}.html`));
  check('something was measured', rows.length > 20, true);
  const cramped = rows.filter(r => r.gap < MIN_GAP
    && !DELIBERATELY_TIGHT.has(`${r.from}->${r.to}`));
  check(`no two blocks sit closer than ${MIN_GAP}px`,
    cramped.map(r => `${r.from}->${r.to}@${r.gap}px`).join(', '), '');
  const worst = Math.min(...rows.map(r => r.gap));
  console.log(`        ${rows.length} adjacent pairs, tightest ${worst}px`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
