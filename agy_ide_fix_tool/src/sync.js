'use strict';

const fs = require('fs');
const path = require('path');
const { areaConfig } = require('./areas');
const { encodeBytes, encodeString, parseSummaryEntries } = require('./protobuf');
const { assertNotRunning } = require('./processes');
const { mirrorStateFromAgyhub } = require('./state');
const { analyzeSharedConflicts, applyConflictDecisions, syncLogPath, writeSyncLog } = require('./conflicts');

function listConversations(dir) {
  const out = new Map();
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.db') && !file.endsWith('.pb')) continue;
      const cid = path.basename(file, path.extname(file));
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      out.set(cid, { cid, file, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  } catch (_) {
    /* absent area */
  }
  return out;
}

function readSummaries(filePath) {
  try {
    const summaries = parseSummaryEntries(fs.readFileSync(filePath));
    return new Map(summaries.map((item) => [item.cid, item]));
  } catch (_) {
    return new Map();
  }
}

function writeAgyhubSummaries(filePath, summaries) {
  const entries = summaries.map((summary) => {
    const entry = Buffer.concat([
      encodeString(1, summary.cid),
      encodeBytes(2, summary.payload),
    ]);
    return encodeBytes(1, entry);
  });
  fs.writeFileSync(filePath, Buffer.concat(entries));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function backupPath(filePath, label) {
  return path.join(path.dirname(filePath), `${path.basename(filePath)}.${label}-backup-${timestamp()}`);
}

function copyFileBackup(filePath, label) {
  const backup = backupPath(filePath, label);
  fs.copyFileSync(filePath, backup);
  return backup;
}

function copyDirBackup(dir, label) {
  const backup = `${dir.replace(/[/\\]+$/, '')}.${label}-backup-${timestamp()}`;
  fs.cpSync(dir, backup, { recursive: true });
  return backup;
}

function diffIds(left, right) {
  return Array.from(left.keys()).filter((id) => !right.has(id)).sort();
}

function sameFileShape(a, b) {
  return a && b && a.size === b.size;
}

function summarizeConflicts(conflicts, limit = 10) {
  return {
    counts: conflicts.counts,
    samples: conflicts.items.slice(0, limit).map((item) => ({
      cid: item.cid,
      action: item.decision.action,
      reason: item.decision.reason,
      ag: {
        file: item.ag.file,
        size: item.ag.size,
        stepCount: item.ag.stepCount,
        updatedAtMs: item.ag.updatedAtMs,
      },
      ide: {
        file: item.ide.file,
        size: item.ide.size,
        stepCount: item.ide.stepCount,
        updatedAtMs: item.ide.updatedAtMs,
      },
    })),
  };
}

function buildSyncPlan(flags = {}) {
  const ag = areaConfig('ag', flags);
  const ide = areaConfig('ide', flags);
  const agConvs = listConversations(ag.conversationDir);
  const ideConvs = listConversations(ide.conversationDir);
  const agSummaries = readSummaries(ag.agyhubSummaryPath);
  const ideSummaries = readSummaries(ide.agyhubSummaryPath);
  const sharedConversationIds = Array.from(agConvs.keys()).filter((id) => ideConvs.has(id));
  const fileShapeConflicts = sharedConversationIds.filter((id) => !sameFileShape(agConvs.get(id), ideConvs.get(id)));
  const conflicts = analyzeSharedConflicts(ag, ide, agConvs, ideConvs, agSummaries, ideSummaries);

  return {
    generatedAt: new Date().toISOString(),
    ag: {
      id: ag.area,
      label: ag.label,
      conversationDir: ag.conversationDir,
      agyhubSummaryPath: ag.agyhubSummaryPath,
      stateDbPath: ag.stateDbPath,
    },
    ide: {
      id: ide.area,
      label: ide.label,
      conversationDir: ide.conversationDir,
      agyhubSummaryPath: ide.agyhubSummaryPath,
      stateDbPath: ide.stateDbPath,
    },
    counts: {
      agConversations: agConvs.size,
      ideConversations: ideConvs.size,
      agSummaries: agSummaries.size,
      ideSummaries: ideSummaries.size,
      agConversationMissingInIde: diffIds(agConvs, ideConvs).length,
      ideConversationMissingInAg: diffIds(ideConvs, agConvs).length,
      agSummaryMissingInIde: diffIds(agSummaries, ideSummaries).length,
      ideSummaryMissingInAg: diffIds(ideSummaries, agSummaries).length,
      fileShapeConflicts: fileShapeConflicts.length,
      contentConflicts: conflicts.counts.total,
      autoReplaceAgFromIde: conflicts.counts.autoReplaceAgFromIde,
      autoReplaceIdeFromAg: conflicts.counts.autoReplaceIdeFromAg,
      keepBothConflicts: conflicts.counts.keepBoth,
      skippedSameSummaryConflicts: conflicts.counts.skippedSameSummary,
    },
    samples: {
      agConversationMissingInIde: diffIds(agConvs, ideConvs).slice(0, 10),
      ideConversationMissingInAg: diffIds(ideConvs, agConvs).slice(0, 10),
      agSummaryMissingInIde: diffIds(agSummaries, ideSummaries).slice(0, 10),
      ideSummaryMissingInAg: diffIds(ideSummaries, agSummaries).slice(0, 10),
      fileShapeConflicts: fileShapeConflicts.slice(0, 10),
      contentConflicts: summarizeConflicts(conflicts).samples,
    },
  };
}

function printSyncPlan(plan) {
  console.log('Antigravity bidirectional sync plan');
  console.log(`  Antigravity conversations: ${plan.counts.agConversations}`);
  console.log(`  Antigravity IDE conversations: ${plan.counts.ideConversations}`);
  console.log(`  Antigravity summaries: ${plan.counts.agSummaries}`);
  console.log(`  Antigravity IDE summaries: ${plan.counts.ideSummaries}`);
  console.log(`  conversations only in Antigravity: ${plan.counts.agConversationMissingInIde}`);
  console.log(`  conversations only in Antigravity IDE: ${plan.counts.ideConversationMissingInAg}`);
  console.log(`  summaries only in Antigravity: ${plan.counts.agSummaryMissingInIde}`);
  console.log(`  summaries only in Antigravity IDE: ${plan.counts.ideSummaryMissingInAg}`);
  console.log(`  same-id file size conflicts: ${plan.counts.fileShapeConflicts}`);
  console.log(`  same-id content conflicts: ${plan.counts.contentConflicts}`);
  console.log(`  auto replace Antigravity from IDE: ${plan.counts.autoReplaceAgFromIde}`);
  console.log(`  auto replace IDE from Antigravity: ${plan.counts.autoReplaceIdeFromAg}`);
  console.log(`  keep both conflicts: ${plan.counts.keepBothConflicts}`);
  for (const [name, values] of Object.entries(plan.samples)) {
    if (values.length) console.log(`  sample ${name}: ${values.join(', ')}`);
  }
}

function resolveDirection(flags) {
  const from = flags.from || 'ide';
  const to = flags.to || 'ag';
  if (!['ide', 'ag'].includes(from) || !['ide', 'ag'].includes(to) || from === to) {
    throw new Error('--from and --to must be ide/ag and cannot be the same');
  }
  return { from, to };
}

function buildOneWaySyncPlan(flags = {}) {
  const dir = resolveDirection(flags);
  const source = areaConfig(dir.from, flags);
  const target = areaConfig(dir.to, flags);
  const sourceConvs = listConversations(source.conversationDir);
  const targetConvs = listConversations(target.conversationDir);
  const sourceSummaries = readSummaries(source.agyhubSummaryPath);
  const targetSummaries = readSummaries(target.agyhubSummaryPath);
  const conversationIds = diffIds(sourceConvs, targetConvs);
  const summaryIds = diffIds(sourceSummaries, targetSummaries);
  const copyableIds = conversationIds.filter((id) => sourceSummaries.has(id));
  const missingSummaryForConversation = conversationIds.filter((id) => !sourceSummaries.has(id));
  return {
    source,
    target,
    sourceConvs,
    targetConvs,
    sourceSummaries,
    targetSummaries,
    conversationIds,
    summaryIds,
    copyableIds,
    missingSummaryForConversation,
  };
}

function oneWayPlanSummary(plan) {
  return {
    source: { id: plan.source.area, label: plan.source.label },
    target: { id: plan.target.area, label: plan.target.label },
    counts: {
      conversationsToCopy: plan.conversationIds.length,
      summariesToAdd: plan.summaryIds.length,
      copyableConversationSummaryPairs: plan.copyableIds.length,
      conversationsWithoutSourceSummary: plan.missingSummaryForConversation.length,
    },
    samples: {
      copyableIds: plan.copyableIds.slice(0, 10),
      conversationsWithoutSourceSummary: plan.missingSummaryForConversation.slice(0, 10),
    },
  };
}

function printOneWaySyncPlan(plan, apply) {
  console.log(`${plan.source.label} -> ${plan.target.label} sync ${apply ? 'apply' : 'plan'}`);
  console.log(`  conversations to copy: ${plan.conversationIds.length}`);
  console.log(`  summaries to add: ${plan.summaryIds.length}`);
  console.log(`  copyable conversation+summary pairs: ${plan.copyableIds.length}`);
  console.log(`  conversations without source summary: ${plan.missingSummaryForConversation.length}`);
  if (plan.copyableIds.length) console.log(`  sample copy: ${plan.copyableIds.slice(0, 10).join(', ')}`);
  if (plan.missingSummaryForConversation.length) {
    console.log(`  sample missing source summary: ${plan.missingSummaryForConversation.slice(0, 10).join(', ')}`);
  }
}

function applyOneWaySync(plan, flags) {
  assertNotRunning({ force: Boolean(flags.force) });
  const beforeState = mirrorStateFromAgyhub(plan.target, Array.from(plan.targetSummaries.values()), { apply: false });
  const needsStateRepair = !beforeState.error && (beforeState.missingCount > 0 || beforeState.staleCount > 0);
  if (!plan.copyableIds.length && !plan.summaryIds.length && !needsStateRepair) {
    return {
      backups: { conversations: null, agyhub: null, state: null },
      copied: 0,
      summaries: 0,
      stateBackup: null,
      stateRepair: {
        beforeCount: beforeState.beforeCount,
        targetCount: beforeState.targetCount,
        missingCount: beforeState.missingCount,
        staleCount: beforeState.staleCount,
      },
      skipped: true,
    };
  }
  fs.mkdirSync(plan.target.conversationDir, { recursive: true });
  const backups = {
    conversations: plan.copyableIds.length && fs.existsSync(plan.target.conversationDir) ? copyDirBackup(plan.target.conversationDir, 'sync') : null,
    agyhub: plan.summaryIds.length && fs.existsSync(plan.target.agyhubSummaryPath) ? copyFileBackup(plan.target.agyhubSummaryPath, 'sync') : null,
    state: (plan.summaryIds.length || needsStateRepair) && fs.existsSync(plan.target.stateDbPath) ? copyFileBackup(plan.target.stateDbPath, 'sync') : null,
  };
  try {
    for (const id of plan.copyableIds) {
      const source = plan.sourceConvs.get(id);
      const dest = path.join(plan.target.conversationDir, source.file);
      if (fs.existsSync(dest)) throw new Error(`target conversation exists unexpectedly: ${dest}`);
      fs.copyFileSync(source.fullPath, dest);
    }
    const targetSummaryIds = new Set(plan.targetSummaries.keys());
    const mergedSummaries = Array.from(plan.targetSummaries.values());
    for (const id of plan.summaryIds) {
      if (targetSummaryIds.has(id)) continue;
      const summary = plan.sourceSummaries.get(id);
      if (summary) mergedSummaries.push(summary);
    }
    writeAgyhubSummaries(plan.target.agyhubSummaryPath, mergedSummaries);
    const reparsed = readSummaries(plan.target.agyhubSummaryPath);
    for (const id of plan.summaryIds) {
      if (!reparsed.has(id)) throw new Error(`summary write validation failed for ${id}`);
    }
    const stateResult = mirrorStateFromAgyhub(plan.target, Array.from(reparsed.values()), { apply: true });
    return {
      backups,
      copied: plan.copyableIds.length,
      summaries: plan.summaryIds.length,
      stateBackup: stateResult.backup,
      stateRepair: {
        beforeCount: stateResult.beforeCount,
        targetCount: stateResult.targetCount,
        missingCount: stateResult.missingCount,
        staleCount: stateResult.staleCount,
      },
    };
  } catch (error) {
    if (backups.conversations) {
      fs.rmSync(plan.target.conversationDir, { recursive: true, force: true });
      fs.cpSync(backups.conversations, plan.target.conversationDir, { recursive: true });
    }
    if (backups.agyhub) fs.copyFileSync(backups.agyhub, plan.target.agyhubSummaryPath);
    if (backups.state) fs.copyFileSync(backups.state, plan.target.stateDbPath);
    throw error;
  }
}

function buildConflictPlan(flags = {}) {
  const ag = areaConfig('ag', flags);
  const ide = areaConfig('ide', flags);
  const agConvs = listConversations(ag.conversationDir);
  const ideConvs = listConversations(ide.conversationDir);
  const agSummaries = readSummaries(ag.agyhubSummaryPath);
  const ideSummaries = readSummaries(ide.agyhubSummaryPath);
  const conflicts = analyzeSharedConflicts(ag, ide, agConvs, ideConvs, agSummaries, ideSummaries);
  return {
    generatedAt: new Date().toISOString(),
    logPath: syncLogPath(),
    ...summarizeConflicts(conflicts, Number(flags.limit || 20)),
  };
}

function applySharedConflictResolution(flags = {}) {
  const ag = areaConfig('ag', flags);
  const ide = areaConfig('ide', flags);
  const agConvs = listConversations(ag.conversationDir);
  const ideConvs = listConversations(ide.conversationDir);
  const agSummaries = readSummaries(ag.agyhubSummaryPath);
  const ideSummaries = readSummaries(ide.agyhubSummaryPath);
  const conflicts = analyzeSharedConflicts(ag, ide, agConvs, ideConvs, agSummaries, ideSummaries);
  const operations = applyConflictDecisions(conflicts, agSummaries, ideSummaries);
  const changedAgSummary = operations.some((item) => item.action === 'replace-ag-from-ide');
  const changedIdeSummary = operations.some((item) => item.action === 'replace-ide-from-ag');
  const summaryBackups = { ag: null, ide: null };
  const stateBackups = { ag: null, ide: null };
  if (changedAgSummary) {
    summaryBackups.ag = copyFileBackup(ag.agyhubSummaryPath, 'conflict-resolve');
    writeAgyhubSummaries(ag.agyhubSummaryPath, Array.from(agSummaries.values()));
    stateBackups.ag = mirrorStateFromAgyhub(ag, Array.from(agSummaries.values()), { apply: true }).backup;
  }
  if (changedIdeSummary) {
    summaryBackups.ide = copyFileBackup(ide.agyhubSummaryPath, 'conflict-resolve');
    writeAgyhubSummaries(ide.agyhubSummaryPath, Array.from(ideSummaries.values()));
    stateBackups.ide = mirrorStateFromAgyhub(ide, Array.from(ideSummaries.values()), { apply: true }).backup;
  }
  writeSyncLog({
    kind: 'bidirectional-conflict-resolution',
    counts: conflicts.counts,
    operations: operations.length,
    summaryBackups,
    stateBackups,
  });
  return {
    generatedAt: new Date().toISOString(),
    logPath: syncLogPath(),
    counts: conflicts.counts,
    operations,
    summaryBackups,
    stateBackups,
  };
}

function applyBidirectionalSync(flags = {}) {
  const firstPlan = buildOneWaySyncPlan({ ...flags, from: 'ag', to: 'ide' });
  const first = applyOneWaySync(firstPlan, flags);
  const secondPlan = buildOneWaySyncPlan({ ...flags, from: 'ide', to: 'ag' });
  const second = applyOneWaySync(secondPlan, flags);
  const conflicts = applySharedConflictResolution(flags);
  return {
    generatedAt: new Date().toISOString(),
    logPath: syncLogPath(),
    directions: [
      { plan: oneWayPlanSummary(firstPlan), result: first },
      { plan: oneWayPlanSummary(secondPlan), result: second },
    ],
    conflicts,
  };
}

function runSync(args = [], flags = {}) {
  const sub = args[0] || 'plan';
  if (sub === 'conflicts') {
    const result = buildConflictPlan(flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('Antigravity same-id conflict inspection');
      console.log(`  content conflicts: ${result.counts.total}`);
      console.log(`  auto replace Antigravity from IDE: ${result.counts.autoReplaceAgFromIde}`);
      console.log(`  auto replace IDE from Antigravity: ${result.counts.autoReplaceIdeFromAg}`);
      console.log(`  keep both: ${result.counts.keepBoth}`);
      console.log(`  skipped same summary: ${result.counts.skippedSameSummary}`);
      console.log(`  log path: ${result.logPath}`);
      for (const sample of result.samples) console.log(`  sample ${sample.cid}: ${sample.action} (${sample.reason})`);
    }
    return 0;
  }
  if (sub === 'plan' && flags.json && (flags.from || flags.to)) {
    console.log(JSON.stringify(oneWayPlanSummary(buildOneWaySyncPlan(flags)), null, 2));
    return 0;
  }
  if (sub === 'plan' && flags.json) {
    console.log(JSON.stringify(buildSyncPlan(flags), null, 2));
    return 0;
  }
  if (sub === 'plan' && (flags.from || flags.to)) {
    const plan = buildOneWaySyncPlan(flags);
    printOneWaySyncPlan(plan, false);
    return 0;
  }
  if (sub === 'plan') {
    const plan = buildSyncPlan(flags);
    printSyncPlan(plan);
    return 0;
  }
  if (sub === 'apply') {
    if (flags.bidirectional) {
      const preview = {
        generatedAt: new Date().toISOString(),
        directions: [
          oneWayPlanSummary(buildOneWaySyncPlan({ ...flags, from: 'ag', to: 'ide' })),
          oneWayPlanSummary(buildOneWaySyncPlan({ ...flags, from: 'ide', to: 'ag' })),
        ],
        conflicts: buildConflictPlan(flags),
      };
      if (!flags.apply) {
        if (flags.json) console.log(JSON.stringify({ applied: false, ...preview }, null, 2));
        else {
          console.log('Antigravity bidirectional sync apply');
          for (const dir of preview.directions) {
            console.log(`  ${dir.source.label} -> ${dir.target.label}`);
            console.log(`    conversations to copy: ${dir.counts.conversationsToCopy}`);
            console.log(`    summaries to add: ${dir.counts.summariesToAdd}`);
          }
          console.log('  applied: no');
          console.log('  add --apply to copy files and update indexes');
        }
        return 0;
      }
      const result = applyBidirectionalSync(flags);
      if (flags.json) console.log(JSON.stringify({ applied: true, ...result }, null, 2));
      else {
        console.log('Antigravity bidirectional sync apply');
        for (const dir of result.directions) {
          console.log(`  ${dir.plan.source.label} -> ${dir.plan.target.label}`);
          console.log(`    copied conversations: ${dir.result.copied}`);
          console.log(`    added summaries: ${dir.result.summaries}`);
        }
        console.log('  applied: yes');
      }
      return 0;
    }
    const plan = buildOneWaySyncPlan(flags);
    if (flags.json && !flags.apply) {
      console.log(JSON.stringify({ applied: false, plan: oneWayPlanSummary(plan) }, null, 2));
      return 0;
    }
    printOneWaySyncPlan(plan, Boolean(flags.apply));
    if (!flags.apply) {
      console.log('  applied: no');
      console.log('  add --apply to copy files and update target indexes');
      return 0;
    }
    const result = applyOneWaySync(plan, flags);
    if (flags.json) {
      console.log(JSON.stringify({ applied: true, plan: oneWayPlanSummary(plan), result }, null, 2));
      return 0;
    }
    console.log(`  applied: yes`);
    console.log(`  copied conversations: ${result.copied}`);
    console.log(`  added summaries: ${result.summaries}`);
    console.log(`  backup conversations: ${result.backups.conversations || '(none)'}`);
    console.log(`  backup agyhub: ${result.backups.agyhub || '(none)'}`);
    console.log(`  backup state: ${result.backups.state || '(none)'}`);
    console.log(`  state repair backup: ${result.stateBackup || '(none)'}`);
    return 0;
  }
  if (sub !== 'plan') {
    console.error(`Unknown sync command: ${sub}`);
    return 2;
  }
  return 0;
}

module.exports = { buildSyncPlan, runSync };
