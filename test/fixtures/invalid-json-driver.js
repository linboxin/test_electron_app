#!/usr/bin/env node

const readline = require('readline');

process.stdout.write(`${JSON.stringify({
  type: 'driver.ready',
  schemaVersion: 1,
  name: 'invalid-json-test-driver',
  kind: 'agent',
  model: process.env.ACP_BENCHMARK_MODEL,
  conversationCreated: false,
  appInspected: false,
  capabilities: ['acp']
})}\n`);
process.stdout.write('this is not JSON\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  try {
    if (JSON.parse(line).type === 'stop') {
      input.close();
      process.stdin.pause();
    }
  } catch {}
});
input.on('close', () => process.exit(0));
