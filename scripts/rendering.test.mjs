#!/usr/bin/env node
/**
 * What the pages actually render as, measured rather than eyeballed.
 *
 * Two things are checked here because both were got wrong the same way --
 * by looking at the CSS and deciding it seemed fine. Spacing, and contrast.
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
 * Contrast is the same story: a chip styled as a dim accent on a dim tint of
 * the same accent reads as legible in the source and is unreadable on screen.
 * The ratio is computed against the effective background -- the first ancestor
 * that actually paints one -- in both themes.
 *
 * Skips when Chrome is absent rather than failing, since it is a rendering
 * check and there is nothing to render in.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { renderReport } from '../out/report.js';
import { project } from '../out/projection.js';
import { defaults } from '../out/tuning.js';
import { renderSpecs } from '../out/specs.js';
import { parse } from '../out/ratecard.js';
import { read } from '../out/tuning.js';
import { DARK, LIGHT, vars } from './themes.mjs';

const CHROME = process.env.CHROME ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome');

if (!fs.existsSync(CHROME)) {
  console.log(`  SKIP  no browser at ${CHROME}; set CHROME=<path> to run this`);
  process.exit(0);
}

/**
 * Cleanup that cannot fail the thing it is cleaning up after.
 *
 * Chrome does not exit promptly when it is given its own --user-data-dir: the
 * callback fires while it is still writing the profile, so deleting it races
 * and throws ENOTEMPTY. A leftover temp directory is worth nothing; a test run
 * lost to one is worth less. Retries first, and swallows what is left.
 */
function discard(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } catch {
    // The OS clears its own temp directory. Nothing here is worth a failure.
  }
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
]);

/**
 * The same allowance, where the pair is a repeat rather than a named couple.
 *
 * Seven rows of one chart are one figure, not seven blocks, and their classes
 * vary by state -- today, still to come -- so an exact-pair list cannot name
 * them without naming every combination.
 */
const TIGHT_REPEATS = [
  [/^div\.wk-row/, /^div\.wk-row/, 'the rows of one week chart are one figure']
];

let failures = 0;
const check = (label, got, want) => {
  const ok = Object.is(got, want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

/**
 * WCAG AA: 4.5:1 for body text, 3:1 once text is large enough to carry itself
 * (24px, or 18.66px when bold). Holding a 2.5rem figure to the body bar would
 * force a colour it does not need.
 */
const MIN_CONTRAST = 4.5;
const MIN_CONTRAST_LARGE = 3;

const PROBE = `<script>(() => {
  const rows = [];
  const contrast = [];
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

  // Horizontal overflow. The sidebar is a third the width the panel was laid
  // out for, and a page that scrolls sideways in a column that narrow is
  // unusable -- so anything genuinely wider than the column, a six-column
  // table, must scroll inside its own box instead of pushing the page.
  const overflow = [];
  const limit = document.body.getBoundingClientRect().right;
  for (const e of document.querySelectorAll('*')) {
    // The root element is the viewport, which headless will not shrink below
    // ~485px, and body is the ruler everything else is measured against.
    if (e === document.documentElement || e === document.body) continue;
    if (e.closest('.tw')) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.right > limit + 1) {
      overflow.push({
        what: e.tagName.toLowerCase() +
          (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : ''),
        over: Math.round(r.right - limit)
      });
    }
  }

  // Contrast, against whatever actually paints behind the text rather than
  // against what the rule nearest it declares.
  const rgb = v => (v.match(/[\\d.]+/g) || []).map(Number);
  const opaque = e => {
    for (let n = e; n && n !== document.documentElement.parentNode; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.85)) return c;
    }
    return [0, 0, 0];
  };
  const lum = c => {
    const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  for (const e of document.querySelectorAll('*')) {
    const text = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!text) continue;
    const st = getComputedStyle(e);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.9) continue;
    const fg = rgb(st.color);
    if (fg.length < 3) continue;
    const px = parseFloat(st.fontSize) || 0;
    const bold = Number(st.fontWeight) >= 700 || st.fontWeight === 'bold';
    contrast.push({
      large: px >= 24 || (bold && px >= 18.66),
      px: Math.round(px * 10) / 10,
      ratio: Math.round(ratio(fg, opaque(e)) * 100) / 100,
      what: e.tagName.toLowerCase() +
        (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : ''),
      text: (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 26)
    });
  }

  const pre = document.createElement('pre');
  pre.id = 'measurements';
  pre.textContent = JSON.stringify({ rows, contrast, overflow,
    body: { client: document.body.clientWidth, scroll: document.body.scrollWidth } });
  document.body.appendChild(pre);
})();</script>`;

/**
 * The page painted in a theme, the way the webview host paints it.
 *
 * Without this the probe measures against browser defaults -- black on white --
 * and every contrast reading is a fiction.
 */
function themed(html, theme, narrow) {
  // Opened, because a closed <details> renders no box to measure and its body
  // is muted prose -- the kind of run that has failed contrast here before.
  html = html.replace(/<details class="hint">/g, '<details class="hint" open>');
  const palette = theme === 'light' ? LIGHT : DARK;
  let out = html.replace('<style>',
    `<style>:root {\n${vars(palette)}\n}\n` +
    `html, body { background: var(--vscode-editor-background); }\n`);
  if (!narrow) {
    return out;
  }
  // Headless ignores --window-size for --dump-dom, and a media query keys off
  // the viewport, so neither the flag nor a clamp on the body can put the
  // narrow stylesheet into effect. The breakpoint is unconditioned instead and
  // the body constrained to match: what is under test is the narrow rules at a
  // narrow width, which is what a split editor gives you.
  out = out.replace(/@media \(max-width: \d+px\) \{/g, '@media all {');
  return out.replace('</style>',
    `body { width: ${narrow}px !important; max-width: ${narrow}px !important; ` +
    `margin: 0 !important; }</style>`);
}

/**
 * Width is the viewport, not a clamp on the body.
 *
 * It was the latter, and that measured the wrong thing entirely: media queries
 * key off the viewport, so a 320px body inside a wide window is a narrow box
 * wearing the wide stylesheet. Every narrow-layout rule went unexercised and
 * the check still passed. Headless will not go below about 485px, which is
 * under the panel's 560px breakpoint, so a real narrow render is reachable --
 * just not an arbitrarily small one.
 */
function measure(html, file, theme = 'dark', narrow) {
  // The pages ship `default-src 'none'`, which is right for a webview and
  // blocks the probe, and every <details> is opened so nothing hides.
  const prepared = themed(html, theme, narrow)
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, '')
    .replace(/<details([^>]*?)(?<! open)>/g, '<details$1 open>') + PROBE;
  fs.writeFileSync(file, prepared);
  // Its own profile directory: without one, headless Chrome opens the default
  // profile that a running Chrome already holds, and the two fight over its
  // locks. The visible browser is what loses -- tabs come back as crashed
  // renderers, which is a rendering check breaking the thing it renders in.
  //
  // Given a fresh profile Chrome dumps the DOM in about two seconds and then
  // never exits, so the dump is read as it streams and the process is killed
  // the moment it is complete rather than waited on.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-chrome-'));
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ['--headless', '--disable-gpu', '--virtual-time-budget=2000',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking',
      '--window-size=1400,6000', '--dump-dom', `file://${file}`]);

    let out = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      discard(profile);
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('browser produced no measurements in 30s')), 30000);

    child.stdout.on('data', chunk => {
      out += chunk;
      const m = /<pre id="measurements">([\s\S]*?)<\/pre>/.exec(out);
      if (!m) return;
      finish(null, JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')));
    });
    child.on('error', e => finish(e));
    child.on('close', () => finish(new Error('browser exited before the probe reported')));
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-spacing-'));
const bundled = parse(JSON.parse(fs.readFileSync(
  new URL('../rate-card.json', import.meta.url).pathname, 'utf8')));

/** `n` days ago, as a day key. Relative so the coverage note stays reachable. */
const today = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` +
         `-${String(d.getDate()).padStart(2, '0')}`;
};

const rollup = (over = {}) => ({
  day: '2026-08-26', model: 'claude-sonnet-5', workspace: 'w', operation: 'chat',
  selection: 'manual', source: 'measured', requests: 20, inputTokens: 100000,
  outputTokens: 5000, reasoningTokens: 0, cacheReadTokens: 90000,
  cacheWriteTokens: 9990, nanoAiu: 20e9, missRequests: 4, missInputTokens: 40000,
  missNanoAiu: 12e9, ...over
});

const pages = {
  console: renderSpecs({
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
  }),
  // The same panel with the notes the ordinary one has nothing to say.
  //
  // The harness measures every adjacent pair, so what it never renders it can
  // never check. The reconciliation line sat flush against the table beneath
  // it in a shipped build, and this was green: the fixture had complete
  // coverage and no backfill, so neither note existed to be measured.
  reconciled: renderReport({
    rollups: [
      rollup({ day: today(2) }),
      rollup({ day: today(1), source: 'reported', nanoAiu: 4e9 }),
      rollup({ day: today(0), model: 'gpt-5.6-luna' })
    ],
    creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(), costCoverage: 1,
    warnings: ['a warning, so the banner is measured too'], prices: {}, depth: {},
    history: { traceStartDay: today(2), recoveredMessages: 3 },
    projection: { verdict: 'ok', quotaId: 'premium_interactions', entitlement: 1500,
      remaining: 1450, percentRemaining: 96.7, creditsUsed: 50, burnPerDay: 5,
      daysToReset: 20, sustainableDailyBurn: 72,
      resetDate: new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10) }
  })
};

/*
 * The day figure at the amber threshold.
 *
 * Its hue is the state, so the state has to be rendered to be measured --
 * `--vscode-editorWarning-foreground` is the token most likely to fail contrast
 * on a light background, and the panel has twice shipped a colour that read
 * fine in dark and vanished in light. `over` uses the same mechanism with the
 * error token, so measuring one proves the wiring for both.
 */
{
  const now = Date.now();
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` +
              `-${String(d.getDate()).padStart(2, '0')}`;
  const t = defaults();
  t.projection.dailyBudgetPercent = 1;              // 15 of a 1500 allowance
  const rollups = [rollup({ day, nanoAiu: 13e9 })]; // 87% of it
  const ent = { snapshots: [{ name: 'premium_interactions', entitlement: 1500,
    remaining: 1450, remainingExact: 1450, percentRemaining: 96.7,
    hasQuota: true, unlimited: false }],
    resetDate: new Date(now + 20 * 86400000).toISOString() };
  const p = project(ent, rollups, 1e-9, now, t);
  if (p.todayShare === undefined) {
    throw new Error('the budgeted fixture produced no day figure to measure');
  }
  pages.budgeted = renderReport({
    rollups, creditsPerNanoAiu: 1e-9, dbCount: 1, lastRefresh: new Date(),
    costCoverage: 1, warnings: [], prices: {}, depth: {}, tuning: t, projection: p
  });
}

for (const [name, html] of Object.entries(pages)) {
  for (const theme of ['dark', 'light']) {
    console.log(`\n${name} (${theme})`);
    const { rows, contrast, overflow } = await measure(
      html, path.join(dir, `${name}-${theme}.html`), theme);

    check('something was measured', rows.length > 20, true);
    const cramped = rows.filter(r => r.gap < MIN_GAP
      && !DELIBERATELY_TIGHT.has(`${r.from}->${r.to}`)
      && !TIGHT_REPEATS.some(([a, b]) => a.test(r.from) && b.test(r.to)));
    check(`no two blocks sit closer than ${MIN_GAP}px`,
      cramped.map(r => `${r.from}->${r.to}@${r.gap}px`).join(', '), '');
    console.log(`        ${rows.length} adjacent pairs, tightest ${
      Math.min(...rows.map(r => r.gap))}px`);

    check('nothing pushes the page sideways',
      overflow.map(o => `${o.what} +${o.over}px`).join(', '), '');

    const dim = contrast.filter(c => c.ratio < (c.large ? MIN_CONTRAST_LARGE : MIN_CONTRAST));
    check(`every run of text clears its WCAG bar`,
      dim.map(c => `${c.what} "${c.text}" ${c.px}px @${c.ratio}:1`).join(', '), '');
    const body = contrast.filter(c => !c.large);
    console.log(`        ${contrast.length} text runs, faintest body ${
      Math.min(...body.map(c => c.ratio))}:1`);
  }
}

// A sidebar was tried and reverted -- the tables are too dense for a column
// that narrow -- but an editor group can still be split thin, and a page that
// scrolls sideways is unusable at any width.
console.log('\npanel in a narrow editor split (320px)');
{
  const { rows, overflow, body } = await measure(
    pages.panel, path.join(dir, 'panel-narrow.html'), 'dark', 320);
  check('nothing pushes the page sideways',
    overflow.map(o => `${o.what} +${o.over}px`).join(', '), '');
  check('so the page itself does not scroll horizontally', body.scroll, body.client);
  check('and it still lays out', rows.length > 15, true);
  // clientWidth carries the padding, so this is the 320px box plus 28px of it.
  check('and the narrow layout is the one being measured', body.client < 560, true);
  console.log(`        ${rows.length} adjacent pairs at ${body.client}px`);
}

discard(dir);
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
