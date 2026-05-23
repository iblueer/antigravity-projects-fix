'use strict';

const fs = require('fs');
const path = require('path');
const { areaConfig } = require('./areas');
const { encodeBytes, encodeString, parseSummaryEntries } = require('./protobuf');
const { assertNotRunning } = require('./processes');
const { mirrorStateFromAgyhub } = require('./state');

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

function buildSyncPlan(flags = {}) {
  const ag = areaConfig('ag', flags);
  const ide = areaConfig('ide', flags);
  const agConvs = listConversations(ag.conversationDir);
  const ideConvs = listConversations(ide.conversationDir);
  const agSummaries = readSummaries(ag.agyhubSummaryPath);
  const ideSummaries = readSummaries(ide.agyhubSummaryPath);
  const sharedConversationIds = Array.from(agConvs.keys()).filter((id) => ideConvs.has(id));
  const fileShapeConflicts = sharedConversationIds.filter((id) => !sameFileShape(agConvs.get(id), ideConvs.get(id)));

  return {
    ag,
    ide,
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
    },
    samples: {
      agConversationMissingInIde: diffIds(agConvs, ideConvs).slice(0, 10),
      ideConversationMissingInAg: diffIds(ideConvs, agConvs).slice(0, 10),
      agSummaryMissingInIde: diffIds(agSummaries, ideSummaries).slice(0, 10),
      ideSummaryMissingInAg: diffIds(ideSummaries, agSummaries).slice(0, 10),
      fileShapeConflicts: fileShapeConflicts.slice(0, 10),
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
  fs.mkdirSync(plan.target.conversationDir, { recursive: true });
  const backups = {
    conversations: fs.existsSync(plan.target.conversationDir) ? copyDirBackup(plan.target.conversationDir, 'sync') : null,
    agyhub: fs.existsSync(plan.target.agyhubSummaryPath) ? copyFileBackup(plan.target.agyhubSummaryPath, 'sync') : null,
    state: fs.existsSync(plan.target.stateDbPath) ? copyFileBackup(plan.target.stateDbPath, 'sync') : null,
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
    return { backups, copied: plan.copyableIds.length, summaries: plan.summaryIds.length, stateBackup: stateResult.backup };
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

function runSync(args = [], flags = {}) {
  const sub = args[0] || 'plan';
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
    const plan = buildOneWaySyncPlan(flags);
    printOneWaySyncPlan(plan, Boolean(flags.apply));
    if (!flags.apply) {
      console.log('  applied: no');
      console.log('  add --apply to copy files and update target indexes');
      return 0;
    }
    const result = applyOneWaySync(plan, flags);
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
