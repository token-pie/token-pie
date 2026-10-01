#!/usr/bin/env node
/**
 * Setup guards trace collection against missing Copilot registrations.
 *
 * Running "Token Pie: Enable Local Trace Collection" without an active GitHub
 * Copilot session threw an unhandled rejection when VS Code's configuration
 * editing service refused to write unregistered settings.
 *
 * This suite verifies:
 *   - The setup path guards root.update() in a try/catch
 *   - Unregistered configuration errors are caught and guided
 *   - First-run does not nudge users who do not have Copilot installed
 *   - Diagnostics and setup share the copilot extension probe
 *   - All log messages pass through redactPaths
 *
 * Usage: npm run test:setup (or node scripts/setup.test.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const check = (label, got, want) => {
	const ok = Object.is(got, want);
	if (!ok) failures++;
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const src = fs.readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');

console.log('copilot extension probe');
check('probes for github.copilot-chat',
	src.includes("vscode.extensions.getExtension('github.copilot-chat')"), true);
check('probes for github.copilot fallback',
	src.includes("vscode.extensions.getExtension('github.copilot')"), true);
check('doctor uses the unified probe',
	src.includes('copilotExtension()?.packageJSON'), true);

console.log('\nfirst-run onboarding');
check('firstRun checks if copilot is installed',
	/if\s*\(!copilotExtension\(\)\)\s*\{\s*return;\s*\}/.test(src), true);

console.log('\nsetup registration guard');
check('setup inspects globalValue before updating',
	src.includes('root.inspect(DB_EXPORTER_SETTING)?.globalValue !== true'), true);
check('setup wraps updates in try/catch',
	/try\s*\{[\s\S]*?root\.update\(DB_EXPORTER_SETTING[\s\S]*?\}\s*catch\s*\(err/.test(src), true);
check('catches unregistered configuration',
	src.includes("rawMsg.includes('not a registered configuration')"), true);
check('prompts user to sign in to GitHub Copilot',
	src.includes("'Sign in to GitHub Copilot'"), true);
check('offers open settings JSON fallback',
	src.includes("'Open Settings (JSON)'"), true);
check('triggers copilot sign-in flow',
	src.includes('promptCopilotSignIn()'), true);

console.log('\npath redaction');
check('failed setup log is redacted',
	src.includes('output.appendLine(`Token Pie: failed to write trace collection settings: ${safe}`)'), true);
check('failed sign-in trigger log is redacted',
	src.includes('output.appendLine(`Token Pie: failed to trigger Copilot sign-in: ${safe}`)'), true);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed.`);
	process.exit(1);
} else {
	console.log('\nAll checks passed.');
}
