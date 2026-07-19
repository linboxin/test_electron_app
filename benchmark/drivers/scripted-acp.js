#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { performance } = require('perf_hooks');
const { RpcClient } = require('../protocol');

const finalDelayMs = Math.max(0, Number(
  process.argv.find((argument) => argument.startsWith('--final-delay-ms='))?.split('=')[1]
) || 0);
const finalErrorEnvironmentName = process.argv.find(
  (argument) => argument.startsWith('--final-error-env=')
)?.split('=')[1];

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function call(client, action, args) {
  const startedAt = performance.now();
  emit({ type: 'tool.start', toolKind: 'acp', tool: action, args });
  try {
    const response = await client.request('actions/call', { action, args });
    emit({
      type: 'tool.end',
      toolKind: 'acp',
      tool: action,
      durationMs: performance.now() - startedAt,
      hostDurationMs: response.durationMs,
      result: response.result
    });
    return response;
  } catch (error) {
    emit({
      type: 'tool.error',
      toolKind: 'acp',
      tool: action,
      durationMs: performance.now() - startedAt,
      error: error.message
    });
    throw error;
  }
}

async function run(start) {
  if (!start?.app?.acpHome || !start?.app?.appId) {
    throw new Error('Timed start message did not include the isolated ACP target');
  }
  const manifestFile = path.join(
    start.app.acpHome,
    'apps',
    `${start.app.appId}.json`
  );
  const registration = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const client = await RpcClient.connect(registration);
  try {
    await call(client, 'add_task', { title: 'Prepare launch checklist', priority: 'high' });
    await call(client, 'set_task_done', { taskId: 2, done: true });
    await call(client, 'search_employees', { query: 'Chen' });
    await call(client, 'set_theme', { theme: 'dark' });
    if (finalDelayMs) await new Promise((resolve) => setTimeout(resolve, finalDelayMs));
    emit({
      type: 'final',
      completed: true,
      reportedMatchCount: 5,
      text: 'Scripted ACP smoke driver completed four calls; Chen has 5 matches. This is not an agent benchmark.',
      ...(finalErrorEnvironmentName && process.env[finalErrorEnvironmentName]
        ? { error: process.env[finalErrorEnvironmentName] }
        : {})
    });
  } finally {
    await client.close();
  }
}

emit({
  type: 'driver.ready',
  schemaVersion: 1,
  name: 'scripted-acp-smoke',
  kind: 'scripted-smoke',
  model: process.env.ACP_BENCHMARK_MODEL,
  capabilityProfile: 'acp',
  conversationCreated: false,
  appInspected: false,
  capabilities: ['acp']
});

const input = readline.createInterface({ input: process.stdin });
let started = false;
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error(`Invalid harness message: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (message.type === 'start' && !started) {
    started = true;
    void run(message).then(
      () => {
        input.close();
        process.exitCode = 0;
      },
      (error) => {
        console.error(error.stack || error.message);
        emit({ type: 'final', error: error.message });
        input.close();
        process.exitCode = 1;
      }
    );
  }
  if (message.type === 'stop') input.close();
});
