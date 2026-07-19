const readline = require('node:readline');

process.stdout.write(`${JSON.stringify({
  type: 'driver.ready',
  schemaVersion: 1,
  name: 'hanging-test-driver',
  kind: 'scripted-smoke',
  model: process.env.ACP_BENCHMARK_MODEL,
  capabilityProfile: 'acp',
  conversationCreated: false,
  appInspected: false,
  capabilities: ['acp']
})}\n`);

const input = readline.createInterface({ input: process.stdin });
input.on('line', () => {
  // Deliberately remain non-terminal after the timed start message.
});
setInterval(() => {}, 1_000);
