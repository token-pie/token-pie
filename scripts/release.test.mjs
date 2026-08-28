#!/usr/bin/env node
/**
 * The commit log decides the version, so the mapping has to be exact.
 *
 * A wrong bump is not a cosmetic error: a feature published as a patch tells
 * every consumer that nothing was added, and it cannot be taken back once the
 * Marketplace has it. These are the cases where the reading is not obvious —
 * a breaking change at major zero, a body-footer breaking change with no `!`,
 * a release with nothing user-facing in it at all.
 */
import { parse, commits, level, next, userFacing, render } from './conventional.mjs';
import { section, hasProse, bullets } from './changelog.mjs';

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log('a commit splits into its parts');
check('plain', parse('fix: the week chart lost its floor'),
  { type: 'fix', scope: undefined, breaking: false, subject: 'the week chart lost its floor' });
check('scoped', parse('feat(specs): show the rate card')?.scope, 'specs');
check('bang is breaking', parse('feat!: drop the old setting')?.breaking, true);
check('scoped bang is breaking', parse('feat(tuning)!: cut the knobs')?.breaking, true);
// The footer is the normative spelling; `!` is only its shorthand, and a commit
// that used the long form would otherwise release as a minor.
check('footer is breaking', parse('feat: cut the knobs', 'BREAKING CHANGE: 17 settings removed')?.breaking, true);
check('hyphenated footer too', parse('feat: x', 'BREAKING-CHANGE: y')?.breaking, true);
check('a footer mid-body still counts',
  parse('feat: x', 'some prose\n\nBREAKING CHANGE: y')?.breaking, true);
check('breaking in prose is not a footer', parse('feat: x', 'not a BREAKING CHANGE really')?.breaking, false);
check('history from before the hook is dropped', parse('made the thing work'), undefined);

console.log('\nthe level is the highest any commit demands');
const c = (t, b = false) => ({ type: t, breaking: b, subject: 'x' });
check('feat is minor', level([c('feat')]), 'minor');
check('fix is patch', level([c('fix')]), 'patch');
check('perf is patch', level([c('perf')]), 'patch');
check('revert is patch', level([c('revert')]), 'patch');
check('a feat among fixes still wins', level([c('fix'), c('feat'), c('fix')]), 'minor');
check('breaking beats a feat', level([c('feat'), c('fix', true)]), 'major');
check('chores alone release nothing', level([c('chore'), c('docs'), c('style')]), undefined);
check('nothing at all releases nothing', level([]), undefined);

console.log('\nthe level applies to the version');
check('patch', next('0.3.0', 'patch'), '0.3.1');
check('minor resets the patch', next('0.3.4', 'minor'), '0.4.0');
check('major resets both', next('1.4.2', 'major'), '2.0.0');
// SemVer says anything may change at major zero, so a breaking change there is
// not the milestone 1.0.0 announces. Bumping to 1.0.0 on the first `feat!`
// would declare a stable API the extension has not got.
check('major zero holds breaking at minor', next('0.3.0', 'major'), '0.4.0');
check('unless promotion is asked for', next('0.3.0', 'major', { promote: true }), '1.0.0');
check('past 1.0.0 the rule stops applying', next('1.0.0', 'major'), '2.0.0');
check('promotion does not inflate a minor', next('0.3.0', 'minor', { promote: true }), '0.4.0');

console.log('\nonly user-facing commits reach the notes');
check('kept and dropped', userFacing([c('feat'), c('chore'), c('fix'), c('docs'), c('test')]).length, 2);
check('a breaking chore is still user-facing', userFacing([c('chore', true)]).length, 1);

console.log('\nthe log parses into commits');
// A body with a blank line in it is why the format uses NUL and RS rather than
// newlines: splitting on those merged a commit into the one after it.
const log = [
  'fix: second\x00',
  'feat: first\x00a body\n\nwith a blank line\n',
  'chore: release\x00'
].join('\x1e') + '\x1e';
const parsed = commits('v0..HEAD', () => log);
check('every record found', parsed.length, 3);
check('oldest first', parsed[0].subject, 'release');
check('a multi-line body stays with its commit', parsed[1].subject, 'first');

console.log('\nthe section reads as release notes');
const notes = render([
  { type: 'feat', subject: 'a week beside the verdict' },
  { type: 'fix', scope: 'specs', subject: 'the narrow layout' },
  { type: 'fix', scope: 'specs', subject: 'the narrow layout' },
  { type: 'feat', breaking: true, subject: 'cut the knobs to ten' }
], '0.4.0', '2026-08-28');
check('the heading carries the date', notes.split('\n')[0], '## 0.4.0 - 2026-08-28');
// Preflight and the audit both find a section by `## <version> ` or newline;
// a heading they cannot find passes the build for the wrong reason.
check('and stays findable by version', notes.startsWith('## 0.4.0 '), true);
check('breaking leads', notes.indexOf('### Breaking') < notes.indexOf('### Added'), true);
check('added before fixed', notes.indexOf('### Added') < notes.indexOf('### Fixed'), true);
check('a breaking feat is not also listed as added',
  (notes.match(/cut the knobs/g) || []).length, 1);
check('the scope is the lead', notes.includes('- **specs:** the narrow layout'), true);
check('the same subject twice is one line',
  (notes.match(/the narrow layout/g) || []).length, 1);
check('empty sections are left out', notes.includes('### Faster'), false);
check('every bullet is a bullet the audit counts',
  (notes.match(/^- /gm) || []).length, 3);

console.log('\nan entry can be found in the changelog');
const LOG = [
  '# Changelog',
  '',
  '## 0.4.0 - 2026-08-28',
  '',
  '### Added',
  '',
  '- the newest thing',
  '',
  '## 0.3.01 - 2026-08-01',
  '',
  '- a version that merely starts the same way',
  '',
  '## 0.3.0',
  '',
  '- an undated heading, as the older entries are',
  ''
].join('\n');
check('found by a dated heading', section(LOG, '0.4.0')?.heading, '## 0.4.0 - 2026-08-28');
check('and by an undated one', section(LOG, '0.3.0')?.heading, '## 0.3.0');
// `0.3.0` must not match `0.3.01`: publishing one version's notes under
// another's tag is silent, and only visible on the published Release.
check('a longer version is not a match', section(LOG, '0.3')?.heading, undefined);
check('a version that is not there', section(LOG, '9.9.9'), undefined);
// The body used to come back empty: matching to `(?=^## |$)` with the `m` flag
// ends at the first line break, so the check passed on a good entry by luck.
check('the body is everything under the heading',
  section(LOG, '0.4.0')?.body.includes('- the newest thing'), true);
check('and stops at the next version',
  section(LOG, '0.4.0')?.body.includes('starts the same way'), false);
check('trailing blank lines are trimmed',
  section(LOG, '0.4.0')?.body.endsWith('- the newest thing'), true);

console.log('\nan empty entry is not release notes');
// This is what stands between a bad parse and a published Release: a Release
// is the artefact people subscribe to, and a blank one cannot be un-sent.
check('a heading alone has no prose', hasProse(section('# Changelog\n\n## 1.0.0\n\n', '1.0.0')), false);
check('subheadings are structure, not prose',
  hasProse(section('# Changelog\n\n## 1.0.0\n\n### Added\n\n', '1.0.0')), false);
check('a bullet is prose', hasProse(section(LOG, '0.4.0')), true);
check('a missing entry has no prose', hasProse(undefined), false);

console.log('\nbullets are counted the way the audit counts them');
check('one per line', bullets(section(LOG, '0.4.0')), 1);
check('a dash mid-sentence is not a bullet',
  bullets(section('# Changelog\n\n## 1.0.0\n\n- one - two\nnot - a bullet\n', '1.0.0')), 1);
check('a missing entry counts zero', bullets(undefined), 0);

console.log(failures ? `\n${failures} failed\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
