#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { evaluateSnapshot } = require('./scenario');

function main() {
  const snapshotArg = process.argv[2];
  if (!snapshotArg) {
    console.error('Usage: node benchmark/evaluate.js <benchmark-state.json>');
    process.exitCode = 2;
    return;
  }

  const snapshotFile = path.resolve(snapshotArg);
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  } catch (error) {
    console.error(JSON.stringify({ success: false, error: error.message, snapshotFile }, null, 2));
    process.exitCode = 2;
    return;
  }

  const evaluation = evaluateSnapshot(snapshot);
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  process.exitCode = evaluation.success ? 0 : 1;
}

if (require.main === module) main();

module.exports = { main };
