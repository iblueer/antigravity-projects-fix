'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { areaConfig } = require('./areas');
const { parseSummaryEntries } = require('./protobuf');
const { mirrorStateFromAgyhub } = require('./state');
const { applyMissingSummaryRepair } = require('./summary_repair');
const { applyProjectRepair } = require('./project_repair');

function readAgyhubSummaries(filePath) {
  return parseSummaryEntries(fs.readFileSync(filePath));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function hasItemTable(filePath) {
  try {
    const out = execFileSync('sqlite3', ['-readonly', filePath, "select count(*) from ItemTable;"], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d+$/.test(out);
  } catch (_) {
    return false;
  }
}

function latestValidStateBackup(stateDbPath) {
  const dir = path.dirname(stateDbPath);
  const base = path.basename(stateDbPath);
  const files = fs.readdirSync(dir)
    .filter((file) => file.startsWith(`${base}.`) && file.includes('backup'))
    .map((file) => {
      const fullPath = path.join(dir, file);
      return { file, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.find((item) => fs.statSync(item.fullPath).size > 0 && hasItemTable(item.fullPath)) || null;
}

function restoreStateFromBackupIfNeeded(area, options = {}) {
  if (hasItemTable(area.stateDbPath)) return { restored: false, backup: null, unreadableBackup: null };
  if (!options.apply) return { restored: false, backup: null, unreadableBackup: null };
  const backup = latestValidStateBackup(area.stateDbPath);
  if (!backup) throw new Error(`Cannot read state and no valid backup found for ${area.stateDbPath}`);
  const unreadableBackup = `${area.stateDbPath}.unreadable-backup-${stamp()}`;
  if (fs.existsSync(area.stateDbPath)) fs.copyFileSync(area.stateDbPath, unreadableBackup);
  fs.copyFileSync(backup.fullPath, area.stateDbPath);
  if (!hasItemTable(area.stateDbPath)) throw new Error(`Restored backup is not readable: ${backup.fullPath}`);
  return { restored: true, backup: backup.fullPath, unreadableBackup };
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
  if (target === 'projects') {
    const result = applyProjectRepair(flags);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(`${result.area.label} project repair`);
    console.log(`  summaries missing project: ${result.missingProjectCount}`);
    console.log(`  projects to create: ${result.items.filter((item) => item.willCreateProject).length}`);
    console.log(`  project files to repair: ${result.items.filter((item) => item.projectJsonNeedsRepair).length}`);
    console.log(`  workspace storage to copy: ${result.items.filter((item) => item.workspaceStorageNeedsCopy).length}`);
    for (const item of result.items.slice(0, 10)) {
      console.log(`  ${item.cid}: ${item.currentProject || '(none)'} -> ${item.targetProjectName}`);
    }
    if (result.applied) {
      console.log('  applied: yes');
      console.log(`  projects created: ${result.projectsCreated}`);
      console.log(`  project files repaired: ${result.projectFilesRepaired}`);
      console.log(`  workspace storage copied: ${result.workspaceStorageCopied}`);
      console.log(`  summaries updated: ${result.summariesUpdated}`);
      console.log(`  agyhub backup: ${result.backups.agyhub}`);
      console.log(`  state backup: ${result.backups.state}`);
    } else {
      console.log('  applied: no');
      console.log('  add --apply to create missing projects and update summary project links');
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
  const restoredState = restoreStateFromBackupIfNeeded(area, { apply: Boolean(flags.apply) });
  const result = mirrorStateFromAgyhub(area, summaries, { apply: Boolean(flags.apply) });
  if (result.error) {
    console.error(`Cannot read state: ${result.error}`);
    return 1;
  }
  if (flags.json) {
    console.log(JSON.stringify({
      area: { id: area.area, label: area.label },
      applied: Boolean(result.applied),
      restoredState,
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
    if (restoredState.restored) console.log(`  restored state backup: ${restoredState.backup}`);
    console.log(`  backup: ${result.backup}`);
  } else {
    console.log('  applied: no');
    console.log('  add --apply to write state.vscdb');
  }
  return 0;
}

module.exports = { runRepair };
