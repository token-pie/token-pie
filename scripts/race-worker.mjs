#!/usr/bin/env node
/** One VS Code window: save the shared store repeatedly. Used by responsive.test.mjs. */
import { RollupStore } from '../out/store.js';

const [, , file, tag] = process.argv;
const row = model => ({
  day: '2026-08-26', model, workspace: 'w', operation: 'panel/editAgent',
  selection: 'manual', source: 'measured', requests: 1, inputTokens: 10,
  outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  nanoAiu: 1e9, missRequests: 0, missInputTokens: 0, missNanoAiu: 0
});

for (let i = 0; i < 300; i++) {
  const store = new RollupStore(file);
  store.add(row(`${tag}-${i}`));
  try {
    store.save();
  } catch (err) {
    console.log(`ERR ${err.code ?? err.message}`);
    process.exit(1);
  }
}
console.log('ok');
