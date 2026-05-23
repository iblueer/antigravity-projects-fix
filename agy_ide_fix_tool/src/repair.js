'use strict';

const fs = require('fs');
const { areaConfig } = require('./areas');
const { parseSummaryEntries } = require('./protobuf');
const { mirrorStateFromAgyhub } = require('./state');

function readAgyhubSummaries(filePath) {
  return parseSummaryEntries(fs.readFileSync(filePath));
}

function runRepair(args = [], flags = {}) {
  const target = args[0] || '';
  if (target !== 'state') {
    console.error(`Unknown repair target: ${target || '(missing)'}`);
    return 2;
  }
  if (!flags['mirror-agyhub']) {
    console.error('repair state currently requires --mirror-agyhub');
    return 2;
  }
  const area = areaConfig(flags.area || 'ide', flags);
  const summaries = readAgyhubSummaries(area.agyhubSummaryPath);
  const result = mirrorStateFromAgyhub(area, summaries, { apply: Boolean(flags.apply) });
  if (result.error) {
    console.error(`Cannot read state: ${result.error}`);
    return 1;
  }
  console.log(`${area.label} state repair`);
  console.log(`  state summaries before: ${result.beforeCount}`);
  console.log(`  agyhub summaries target: ${result.targetCount}`);
  console.log(`  missing from state: ${result.missingCount}`);
  console.log(`  stale in state: ${result.staleCount}`);
  if (result.applied) {
    console.log(`  applied: yes`);
    console.log(`  backup: ${result.backup}`);
  } else {
    console.log('  applied: no');
    console.log('  add --apply to write state.vscdb');
  }
  return 0;
}

module.exports = { runRepair };
