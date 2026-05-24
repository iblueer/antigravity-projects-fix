'use strict';

const fs = require('fs');
const { areaConfig } = require('./areas');
const { parseSummaryEntries } = require('./protobuf');
const { mirrorStateFromAgyhub } = require('./state');
const { applyMissingSummaryRepair } = require('./summary_repair');

function readAgyhubSummaries(filePath) {
  return parseSummaryEntries(fs.readFileSync(filePath));
}

function runRepair(args = [], flags = {}) {
  const target = args[0] || '';
  if (target === 'summary') {
    const result = applyMissingSummaryRepair(flags);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(`${result.area.label} missing summary repair`);
    console.log(`  missing summaries: ${result.missingCount}`);
    console.log(`  repairable: ${result.repairableCount}`);
    console.log(`  skipped: ${result.skippedCount}`);
    for (const item of result.items.slice(0, 10)) {
      console.log(`  ${item.cid}: ${item.canRepair ? item.title : item.reasons.join('; ')}`);
    }
    if (result.applied) {
      console.log('  applied: yes');
      console.log(`  repaired: ${result.repairedCount}`);
      console.log(`  agyhub backup: ${result.backups.agyhub}`);
      console.log(`  state backup: ${result.backups.state}`);
      console.log(`  state mirror backup: ${result.backups.stateMirror}`);
    } else {
      console.log('  applied: no');
      console.log('  add --apply to append repairable summaries and update state.vscdb');
    }
    return 0;
  }
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
  if (flags.json) {
    console.log(JSON.stringify({
      area: { id: area.area, label: area.label },
      applied: Boolean(result.applied),
      ...result,
    }, null, 2));
    return 0;
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
