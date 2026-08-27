#!/usr/bin/env node
/** Standalone wrapper around src/purge.ts. Run `npm run compile` first. */
import { purgeAll } from '../out/purge.js';

const results = purgeAll();
if (results.length === 0) {
	console.log('No agent-traces.db found.');
	process.exit(1);
}

let failed = false;
for (const r of results) {
	if (r.error) {
		failed = true;
		console.log(`FAILED  ${r.db}\n        ${r.error}`);
		continue;
	}
	console.log(
		`purged  ${r.attributeRows} attribute row(s), ${r.eventRows} event(s), ` +
		`${(r.bytesFreed / 1024).toFixed(1)} KB\n        ${r.db}`
	);
}
process.exit(failed ? 1 : 0);
