#!/usr/bin/env node
/**
 * Writes the gate ladder into `contributes.configuration`.
 *
 * Seventeen settings hand-maintained beside seventeen constants is two lists
 * that drift. `tuning.ts` is the list; this projects it. Run by the build, and
 * `--check` fails when package.json no longer matches, so a knob added in code
 * without a rebuild cannot ship invisible.
 */
import fs from 'fs';
import { contributions } from '../out/tuning.js';

const file = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const props = pkg.contributes.configuration.properties;

// Settings that are not gates keep their hand-written entries and their order.
const managed = contributions();
const kept = Object.fromEntries(Object.entries(props).filter(([k]) => !(k in managed)));
const next = { ...kept, ...managed };

const same = JSON.stringify(props) === JSON.stringify(next);
if (process.argv.includes('--check')) {
  if (!same) {
    console.error('package.json settings are out of sync with tuning.ts — run: npm run sync:settings');
    process.exit(1);
  }
  console.log(`settings in sync (${Object.keys(managed).length} generated)`);
  process.exit(0);
}
pkg.contributes.configuration.properties = next;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(same ? 'settings already in sync' : `settings written (${Object.keys(managed).length} generated)`);
