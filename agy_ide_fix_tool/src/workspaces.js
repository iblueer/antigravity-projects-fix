'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeBytes, parseFields } = require('./protobuf');
const { normalizeUri } = require('./projects');

const SIDEBAR_WORKSPACES_KEY = 'antigravityUnifiedStateSync.sidebarWorkspaces';

function sqliteValue(dbPath, key) {
  if (!fs.existsSync(dbPath)) return null;
  const escapedKey = String(key).replace(/'/g, "''");
  const sql = `select value from ItemTable where key='${escapedKey}';`;
  return execFileSync('sqlite3', ['-readonly', dbPath, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '');
}

function writeSqliteValue(dbPath, key, value) {
  const escapedKey = String(key).replace(/'/g, "''");
  const escapedValue = String(value).replace(/'/g, "''");
  const sql = `update ItemTable set value='${escapedValue}' where key='${escapedKey}';`;
  execFileSync('sqlite3', [dbPath, sql], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function backupFile(filePath, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backup = path.join(path.dirname(filePath), `${path.basename(filePath)}.${label}-backup-${stamp}`);
  fs.copyFileSync(filePath, backup);
  return backup;
}

function readSidebarWorkspaces(area) {
  const value = sqliteValue(area.stateDbPath, SIDEBAR_WORKSPACES_KEY);
  if (!value) return { entries: [], byUri: new Map(), rawValue: value };
  const decoded = Buffer.from(value, 'base64');
  const entries = [];
  for (const outer of parseFields(decoded)) {
    if (outer.field !== 1 || outer.wire !== 2) continue;
    const payload = decoded.subarray(outer.start, outer.end);
    const inner = parseFields(payload);
    const uriField = inner.find((item) => item.field === 1 && item.wire === 2);
    if (!uriField) continue;
    const uri = normalizeUri(payload.subarray(uriField.start, uriField.end).toString('utf8'));
    entries.push({ uri, payload });
  }
  return {
    entries,
    byUri: new Map(entries.map((item) => [item.uri, item])),
    rawValue: value,
  };
}

function encodeSidebarWorkspaces(entries) {
  return Buffer.concat(entries.map((item) => encodeBytes(1, item.payload))).toString('base64');
}

function sidebarWorkspacePlan(ag, ide) {
  const agWorkspaces = readSidebarWorkspaces(ag);
  const ideWorkspaces = readSidebarWorkspaces(ide);
  const missingInAg = ideWorkspaces.entries.filter((item) => !agWorkspaces.byUri.has(item.uri));
  const missingInIde = agWorkspaces.entries.filter((item) => !ideWorkspaces.byUri.has(item.uri));
  return {
    agWorkspaces,
    ideWorkspaces,
    counts: {
      agSidebarWorkspaces: agWorkspaces.entries.length,
      ideSidebarWorkspaces: ideWorkspaces.entries.length,
      sidebarWorkspacesMissingInAg: missingInAg.length,
      sidebarWorkspacesMissingInIde: missingInIde.length,
    },
    samples: {
      sidebarWorkspacesMissingInAg: missingInAg.slice(0, 10).map((item) => item.uri),
      sidebarWorkspacesMissingInIde: missingInIde.slice(0, 10).map((item) => item.uri),
    },
  };
}

function syncSidebarWorkspaces(ag, ide, options = {}) {
  const plan = sidebarWorkspacePlan(ag, ide);
  const merged = [];
  const seen = new Set();
  for (const item of [...plan.agWorkspaces.entries, ...plan.ideWorkspaces.entries]) {
    if (seen.has(item.uri)) continue;
    seen.add(item.uri);
    merged.push(item);
  }
  const value = encodeSidebarWorkspaces(merged);
  const agNeedsWrite = plan.counts.sidebarWorkspacesMissingInAg > 0;
  const ideNeedsWrite = plan.counts.sidebarWorkspacesMissingInIde > 0;
  const backups = { ag: null, ide: null };
  if (!options.apply || (!agNeedsWrite && !ideNeedsWrite)) {
    return { ...plan.counts, backups, applied: false };
  }
  if (agNeedsWrite) {
    backups.ag = backupFile(ag.stateDbPath, 'sidebar-workspaces-sync');
    writeSqliteValue(ag.stateDbPath, SIDEBAR_WORKSPACES_KEY, value);
  }
  if (ideNeedsWrite) {
    backups.ide = backupFile(ide.stateDbPath, 'sidebar-workspaces-sync');
    writeSqliteValue(ide.stateDbPath, SIDEBAR_WORKSPACES_KEY, value);
  }
  const after = sidebarWorkspacePlan(ag, ide);
  if (after.counts.sidebarWorkspacesMissingInAg || after.counts.sidebarWorkspacesMissingInIde) {
    if (backups.ag) fs.copyFileSync(backups.ag, ag.stateDbPath);
    if (backups.ide) fs.copyFileSync(backups.ide, ide.stateDbPath);
    throw new Error('sidebarWorkspaces validation failed; restored backups');
  }
  return {
    ...after.counts,
    backups,
    applied: true,
  };
}

module.exports = {
  SIDEBAR_WORKSPACES_KEY,
  sidebarWorkspacePlan,
  syncSidebarWorkspaces,
};
