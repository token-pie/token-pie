#!/usr/bin/env node
/**
 * Renders the panel from the rollup this machine actually has.
 *
 * The existing headless recipe takes hand-written fixture rollups, which
 * answers "does the renderer work" but never "what does *my* panel look like".
 * Those are different questions, and only the second one catches a section that
 * is silently empty on real data -- which is exactly how an advice floor sat
 * suppressing every card on a live account without a single test failing.
 *
 *   npm run preview              live data, dark, opens in a browser
 *   npm run preview -- --light   light theme
 *   npm run preview -- --why     why each recommendation did or did not appear
 *   npm run preview -- --file X  a saved rollup.json instead of the live one
 *   npm run preview -- --console  the debug console instead of the panel
 *   npm run preview -- --shot     render to PNG with headless Chrome
 *
 * `--shot` exists because structure is not appearance. A rate card table whose
 * every row had the same column count still rendered with a canyon between the
 * class and its figures, because a colspan sentence in another row was setting
 * the column width. Nothing short of looking at it catches that.
 *
 * No vscode import, so it runs from a plain shell.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { renderReport } from '../out/report.js';
import { project } from '../out/projection.js';
import { defaults, read } from '../out/tuning.js';
import { renderConsole } from '../out/console.js';
import { load as loadCard } from '../out/ratecard.js';
import { periodCoverage } from '../out/reconcile.js';
import { creditsByDay } from '../out/report.js';

// The preview reads the same ladder the panel does, so raising a floor in
// settings shows up here rather than only in the shipped extension.
const T = defaults();
import {
  advise
} from '../out/advice.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };

const EXT_ID = 'token-pie.token-pie';

/** Where VS Code keeps this extension's globalStorage, per platform. */
function storageDir() {
  const home = os.homedir();
  const base = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage')
      : path.join(home, '.config', 'Code', 'User', 'globalStorage');
  return path.join(base, EXT_ID);
}

const rollupFile = value('file') ?? path.join(storageDir(), 'rollup.json');
if (!fs.existsSync(rollupFile)) {
  console.error(`no rollup at ${rollupFile}`);
  console.error('Run Token Pie in VS Code at least once, or pass --file <rollup.json>.');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(rollupFile, 'utf8'));
const rollups = Object.values(data.rollups ?? {});
const CR = 1e-9;

/**
 * The allowance, from the readings the extension already saved. Absent is a
 * real state -- it is what the panel shows before a quota check -- so it is
 * passed through rather than invented.
 */
function entitlement() {
  const f = path.join(path.dirname(rollupFile), 'quota-readings.json');
  if (!fs.existsSync(f)) return undefined;
  const readings = JSON.parse(fs.readFileSync(f, 'utf8'));
  const last = readings[readings.length - 1];
  if (!last) return undefined;
  return {
    snapshots: [{
      name: last.quotaId, entitlement: last.entitlement,
      creditsUsed: last.creditsUsed,
      remaining: Math.floor(last.remaining), remainingExact: last.remaining,
      percentRemaining: (last.remaining / last.entitlement) * 100,
      hasQuota: last.remaining > 0, unlimited: false
    }],
    // Carried through so the panel can reconcile GitHub's consumption against
    // ours. Readings saved before these were recorded simply lack them, and
    // the reconciliation line withholds itself -- which is the live behaviour.
    resetDate: last.resetDate,
    organizations: [], raw: last
  };
}

const ent = entitlement();
const projection = project(ent, rollups, CR);

/* ------------------------------------------------------------------ why --- */

if (flag('why')) {
  const totalCredits = rollups.reduce((n, r) => n + r.nanoAiu, 0) * CR;
  const requests = rollups.reduce((n, r) => n + r.requests, 0);
  const remaining = projection.remaining;
  const cards = advise(rollups, CR, data.prices ?? {}, remaining);

  const fmt = (n) => n === undefined ? '—' : n.toFixed(2);
  console.log(`\nrollup      ${rollupFile}`);
  console.log(`spend       ${fmt(totalCredits)} credits over ${requests} requests`);
  console.log(`allowance   ${remaining === undefined ? 'unknown' : `${fmt(remaining)} remaining`}`);

  console.log(`\nhistory floor`);
  const enough = requests >= T.advice.minHistoryRequests;
  console.log(`  ${enough ? 'pass' : 'BLOCKS ALL ADVICE'}  ${requests} requests vs ${T.advice.minHistoryRequests} required`);

  const urgentFloor = remaining !== undefined && remaining > 0
    ? remaining * T.advice.minShareOfAllowance : undefined;
  const patternFloor = Math.max(T.advice.minCreditsAtStake, totalCredits * T.advice.minShareAtStake);
  console.log(`\nmateriality — a finding needs to clear EITHER`);
  console.log(`  urgent   >= ${urgentFloor === undefined ? 'n/a (no allowance)' : `${fmt(urgentFloor)} cr`}`);
  console.log(`  pattern  >= ${fmt(patternFloor)} cr`);
  console.log(`  so the effective bar is ${fmt(Math.min(urgentFloor ?? Infinity, patternFloor))} cr`);

  const models = [...new Set(rollups.map(r => r.model))];
  const priced = Object.entries(data.prices ?? {}).filter(([, p]) => p.n >= 6).map(([m]) => m);
  console.log(`\ndetector inputs`);
  console.log(`  models seen        ${models.length}  ${models.join(', ')}`);
  console.log(`  models with a rate card  ${priced.length}  ${priced.join(', ') || '(none)'}`);
  console.log(`  cache-miss needs a model with both missed and hit requests`);
  for (const m of models) {
    const t = rollups.filter(r => r.model === m)
      .reduce((a, r) => ({ req: a.req + r.requests, miss: a.miss + r.missRequests }), { req: 0, miss: 0 });
    console.log(`    ${m}: ${t.miss} missed of ${t.req}${t.miss === 0 || t.miss === t.req ? '  <- no split, cannot compare' : ''}`);
  }

  console.log(`\nrecommendations rendered: ${cards.length}`);
  for (const c of cards) {
    console.log(`  ${c.confidence.padEnd(9)} ${fmt(c.creditsAtStake)} cr  ${c.id}`);
  }
  if (cards.length === 0) {
    console.log('  (none — compare the stakes above against the bar)');
  }
  console.log();
  if (!flag('open')) process.exit(0);
}

/* --------------------------------------------------------------- render --- */

// Dark and light stand-ins for the variables the webview inherits from VS Code.
// Values are lifted from the default themes; the assertion below is what keeps
// this list from drifting out of step with the stylesheet.
const DARK = {
  'foreground': '#cccccc', 'font-family': 'system-ui, -apple-system, sans-serif',
  'font-size': '13px', 'editor-background': '#1f1f1f',
  'editor-font-family': 'Menlo, Monaco, monospace',
  'descriptionForeground': '#9d9d9d', 'widget-border': '#3c3c3c',
  'editorWidget-background': '#252526', 'editorWidget-border': '#454545',
  'list-hoverBackground': '#2a2d2e', 'charts-foreground': '#cccccc',
  'charts-blue': '#3794ff', 'charts-green': '#89d185', 'charts-purple': '#b180d7',
  'charts-red': '#f14c4c', 'charts-yellow': '#cca700',
  'inputValidation-warningBackground': '#352a05', 'inputValidation-warningBorder': '#b89500',
  'charts-orange': '#d18616', 'panel-border': '#2b2b2b',
  'textBlockQuote-background': '#2a2a2a'
};
const LIGHT = {
  ...DARK, 'foreground': '#3b3b3b', 'editor-background': '#ffffff',
  'descriptionForeground': '#6a6a6a', 'widget-border': '#d4d4d4',
  'editorWidget-background': '#f8f8f8', 'editorWidget-border': '#c8c8c8',
  'list-hoverBackground': '#f0f0f0', 'charts-foreground': '#3b3b3b',
  'charts-blue': '#1a85ff', 'charts-green': '#388a34', 'charts-purple': '#652d90',
  'inputValidation-warningBackground': '#fff8c5',
  'charts-orange': '#bf6a02', 'panel-border': '#e5e5e5',
  'textBlockQuote-background': '#f3f3f3'
};

const theme = flag('light') ? LIGHT : DARK;

// The console reads defaults here: a preview cannot see VS Code's settings, and
// showing overrides that are not in effect would be worse than showing none.
const body = flag('console')
  ? renderConsole({
      rollups, creditsPerNanoAiu: CR, creditsPerNanoAiuIsDefault: CR === 1e-9,
      prices: data.prices ?? {},
      readings: read(() => undefined).readings,
      card: loadCard({
        bundledPath: new URL('../rate-card.json', import.meta.url).pathname,
        cachePath: path.join(storageDir(), 'rate-card.json')
      }),
      coverage: periodCoverage({
        resetDate: projection?.resetDate,
        githubCredits: projection?.creditsUsed ?? (projection?.entitlement !== undefined
          && projection?.remaining !== undefined
          ? Math.max(0, projection.entitlement - projection.remaining) : undefined),
        creditsByDay: creditsByDay(rollups, CR)
      }),
      pipeline: {
        databases: 1, spansScanned: 0, spansCounted: rollups.reduce((n, r) => n + r.requests, 0),
        costSpans: rollups.filter(r => r.nanoAiu > 0).reduce((n, r) => n + r.requests, 0),
        recoveredMessages: rollups.filter(r => r.source === 'reported')
          .reduce((n, r) => n + r.requests, 0),
        errors: []
      },
      lastRefresh: new Date()
    })
  : renderReport({
      rollups, creditsPerNanoAiu: CR, dbCount: 1, lastRefresh: new Date(),
      costCoverage: 1, warnings: [], projection,
      prices: data.prices ?? {}, depth: data.depth ?? {},
      conversations: data.conversations ?? {}
    });

// A variable the stylesheet uses but this file does not define renders as a
// browser default and silently misrepresents the panel -- the exact failure
// this script exists to prevent.
const used = [...new Set([...body.matchAll(/var\(--vscode-([a-zA-Z0-9-]+)/g)].map(m => m[1]))];
const missing = used.filter(v => !(v in theme));
if (missing.length) {
  console.error(`preview theme is missing ${missing.length} variable(s) the panel uses:`);
  for (const v of missing) console.error(`  --vscode-${v}`);
  process.exit(1);
}

const vars = Object.entries(theme).map(([k, v]) => `  --vscode-${k}: ${v};`).join('\n');
const html = `<!doctype html><meta charset="utf-8"><title>Token Pie — preview</title>
<style>:root {\n${vars}\n}
html { background: var(--vscode-editor-background); }
body { margin: 0; padding: 22px; background: var(--vscode-editor-background);
       color: var(--vscode-foreground); font-family: var(--vscode-font-family);
       font-size: var(--vscode-font-size); }</style>
${body}`;

const out = path.join(os.tmpdir(),
  `token-pie-${flag('console') ? 'console' : 'preview'}-${flag('light') ? 'light' : 'dark'}.html`);
fs.writeFileSync(out, html);
console.log(`${flag('light') ? 'light' : 'dark'}  ${out}`);
console.log(`${rollups.length} rollups, ${used.length} theme variables, all defined`);

if (flag('shot')) {
  const chrome = process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.env.CHROME ?? 'google-chrome';
  if (!fs.existsSync(chrome)) {
    console.error(`no headless browser at ${chrome}; set CHROME=<path>`);
    process.exit(1);
  }
  // Every <details> forced open: a collapsed page screenshots as a list of
  // summaries and says nothing about the tables inside them.
  const opened = out.replace(/\.html$/, '-open.html');
  fs.writeFileSync(opened, html.replace(/<details([^>]*?)(?<! open)>/g, '<details$1 open>'));
  const png = out.replace(/\.html$/, '.png');
  execFile(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars',
    '--virtual-time-budget=1500', `--window-size=${value('width') ?? 1500},${value('height') ?? 4200}`,
    `--screenshot=${png}`, `file://${opened}`], () => {
      console.log(`shot  ${png}`);
    });
} else if (!flag('no-open')) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [out], () => {});
}
