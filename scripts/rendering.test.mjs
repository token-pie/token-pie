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
import { renderConsole } from '../out/console.js';
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
  pre.textContent = JSON.stringify({ rows, contrast });
  document.body.appendChild(pre);
})();</script>`;

/**
 * The page painted in a theme, the way the webview host paints it.
 *
 * Without this the probe measures against browser defaults -- black on white --
 * and every contrast reading is a fiction.
 */
function themed(html, theme) {
  const palette = theme === 'light' ? LIGHT : DARK;
  return html.replace('<style>',
    `<style>:root {\n${vars(palette)}\n}\n` +
    `html, body { background: var(--vscode-editor-background); }\n`);
}

function measure(html, file, theme = 'dark') {
  // The pages ship `default-src 'none'`, which is right for a webview and
  // blocks the probe, and every <details> is opened so nothing hides.
  const prepared = themed(html, theme)
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
      fs.rmSync(profile, { recursive: true, force: true });
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
  for (const theme of ['dark', 'light']) {
    console.log(`\n${name} (${theme})`);
    const { rows, contrast } = await measure(html, path.join(dir, `${name}-${theme}.html`), theme);

    check('something was measured', rows.length > 20, true);
    const cramped = rows.filter(r => r.gap < MIN_GAP
      && !DELIBERATELY_TIGHT.has(`${r.from}->${r.to}`));
    check(`no two blocks sit closer than ${MIN_GAP}px`,
      cramped.map(r => `${r.from}->${r.to}@${r.gap}px`).join(', '), '');
    console.log(`        ${rows.length} adjacent pairs, tightest ${
      Math.min(...rows.map(r => r.gap))}px`);

    const dim = contrast.filter(c => c.ratio < (c.large ? MIN_CONTRAST_LARGE : MIN_CONTRAST));
    check(`every run of text clears its WCAG bar`,
      dim.map(c => `${c.what} "${c.text}" ${c.px}px @${c.ratio}:1`).join(', '), '');
    const body = contrast.filter(c => !c.large);
    console.log(`        ${contrast.length} text runs, faintest body ${
      Math.min(...body.map(c => c.ratio))}:1`);
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
