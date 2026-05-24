'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeBytes, encodeVarint, readVarint, parseFields } = require('./protobuf');

function appSupportDir() {
  if (process.env.AGY_SESSION_TRAY_DIR) return process.env.AGY_SESSION_TRAY_DIR;
  return path.join(os.homedir(), 'Library', 'Application Support', 'AgySessionTray');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function syncLogPath() {
  return path.join(ensureDir(appSupportDir()), 'sync.log');
}

function writeSyncLog(entry) {
  const file = syncLogPath();
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  fs.appendFileSync(file, line);
  return file;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function bufferHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function encodeKey(field, wire) {
  return encodeVarint(field * 8 + wire);
}

function canonicalSummaryPayload(payload) {
  if (!payload || !payload.length) return Buffer.alloc(0);
  const chunks = [];
  for (const item of parseFields(payload)) {
    if (item.field === 15) continue;
    const value = payload.subarray(item.start, item.end);
    if (item.wire === 2) chunks.push(encodeBytes(item.field, value));
    else chunks.push(Buffer.concat([encodeKey(item.field, item.wire), value]));
  }
  return Buffer.concat(chunks);
}

function sqliteScalar(dbPath, sql) {
  try {
    return execFileSync('sqlite3', ['-readonly', dbPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function parseTime(payload) {
  if (!payload || !payload.length) return null;
  try {
    let seconds = null;
    let nanos = 0;
    for (const item of parseFields(payload)) {
      if (item.field === 1 && item.wire === 0) seconds = readVarint(payload, item.start).value;
      if (item.field === 2 && item.wire === 0) nanos = readVarint(payload, item.start).value;
    }
    if (seconds === null) return null;
    return seconds * 1000 + Math.floor(nanos / 1_000_000);
  } catch (_) {
    return null;
  }
}

function summaryMetrics(summary) {
  const out = {
    hasSummary: Boolean(summary && summary.payload && summary.payload.length),
    title: summary ? summary.title || '' : '',
    stepCount: null,
    updatedAtMs: null,
    payloadHash: null,
    canonicalPayloadHash: null,
  };
  if (!out.hasSummary) return out;
  out.payloadHash = bufferHash(summary.payload);
  try {
    out.canonicalPayloadHash = bufferHash(canonicalSummaryPayload(summary.payload));
    for (const item of parseFields(summary.payload)) {
      if (item.field === 2 && item.wire === 0) out.stepCount = readVarint(summary.payload, item.start).value;
      if ((item.field === 3 || item.field === 10) && item.wire === 2) {
        const time = parseTime(summary.payload.subarray(item.start, item.end));
        if (time !== null) out.updatedAtMs = Math.max(out.updatedAtMs || 0, time);
      }
    }
  } catch (_) {
    /* keep partial metrics */
  }
  return out;
}

function dbStepCount(filePath) {
  if (!filePath.endsWith('.db')) return null;
  const value = sqliteScalar(filePath, 'select count(*) from steps;');
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inspectConversation(area, conversation, summary) {
  const metrics = summaryMetrics(summary);
  const stat = fs.statSync(conversation.fullPath);
  const dbSteps = dbStepCount(conversation.fullPath);
  return {
    area: area.area,
    label: area.label,
    cid: conversation.cid,
    file: conversation.file,
    path: conversation.fullPath,
    kind: path.extname(conversation.file).slice(1),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(conversation.fullPath),
    stepCount: dbSteps !== null ? dbSteps : metrics.stepCount,
    updatedAtMs: metrics.updatedAtMs || stat.mtimeMs,
    summary: metrics,
  };
}

function decideConflict(agItem, ideItem) {
  if (agItem.sha256 === ideItem.sha256) {
    return { action: 'skip-identical', reason: 'conversation file hash matches' };
  }
  const agSteps = agItem.stepCount;
  const ideSteps = ideItem.stepCount;
  if (Number.isFinite(agSteps) && Number.isFinite(ideSteps) && agSteps !== ideSteps) {
    return agSteps > ideSteps
      ? { action: 'replace-ide-from-ag', winner: 'ag', loser: 'ide', reason: `Antigravity has more steps (${agSteps} > ${ideSteps})` }
      : { action: 'replace-ag-from-ide', winner: 'ide', loser: 'ag', reason: `Antigravity IDE has more steps (${ideSteps} > ${agSteps})` };
  }
  if (agItem.summary.payloadHash && ideItem.summary.payloadHash && agItem.summary.payloadHash === ideItem.summary.payloadHash) {
    return { action: 'skip-same-summary', reason: 'summary payload matches even though conversation file differs' };
  }
  if (
    agItem.summary.canonicalPayloadHash &&
    ideItem.summary.canonicalPayloadHash &&
    agItem.summary.canonicalPayloadHash === ideItem.summary.canonicalPayloadHash
  ) {
    return { action: 'skip-stable-metadata', reason: 'summary differs only in stable local metadata field 15' };
  }
  if (Number.isFinite(agItem.updatedAtMs) && Number.isFinite(ideItem.updatedAtMs) && Math.abs(agItem.updatedAtMs - ideItem.updatedAtMs) > 1000) {
    return agItem.updatedAtMs > ideItem.updatedAtMs
      ? { action: 'replace-ide-from-ag', winner: 'ag', loser: 'ide', reason: 'Antigravity summary updatedAt is newer' }
      : { action: 'replace-ag-from-ide', winner: 'ide', loser: 'ag', reason: 'Antigravity IDE summary updatedAt is newer' };
  }
  return { action: 'keep-both', reason: 'cannot prove one side is a continuation of the other' };
}

function analyzeSharedConflicts(ag, ide, agConvs, ideConvs, agSummaries, ideSummaries) {
  const ids = Array.from(agConvs.keys()).filter((id) => ideConvs.has(id)).sort();
  const items = [];
  for (const id of ids) {
    const agItem = inspectConversation(ag, agConvs.get(id), agSummaries.get(id));
    const ideItem = inspectConversation(ide, ideConvs.get(id), ideSummaries.get(id));
    if (agItem.sha256 === ideItem.sha256) continue;
    const decision = decideConflict(agItem, ideItem);
    items.push({ cid: id, ag: agItem, ide: ideItem, decision });
  }
  const counts = {
    total: items.length,
    autoReplaceAgFromIde: items.filter((item) => item.decision.action === 'replace-ag-from-ide').length,
    autoReplaceIdeFromAg: items.filter((item) => item.decision.action === 'replace-ide-from-ag').length,
    keepBoth: items.filter((item) => item.decision.action === 'keep-both').length,
    skippedSameSummary: items.filter((item) => item.decision.action === 'skip-same-summary').length,
    skippedStableMetadata: items.filter((item) => item.decision.action === 'skip-stable-metadata').length,
  };
  return { counts, items };
}

function backupForOverwrite(targetPath, label) {
  const dir = ensureDir(path.join(appSupportDir(), 'backups', new Date().toISOString().slice(0, 10)));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `${path.basename(targetPath)}.${label}.${stamp}.backup`);
  fs.copyFileSync(targetPath, backup);
  return backup;
}

function conflictCopyPath(sourceFile, label) {
  const dir = ensureDir(path.join(appSupportDir(), 'conflicts', new Date().toISOString().slice(0, 10)));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${sourceFile}.${label}.${stamp}`);
}

function replaceConversation(source, target, label) {
  const backup = backupForOverwrite(target.path, label);
  fs.copyFileSync(source.path, target.path);
  return backup;
}

function applyConflictDecisions(conflicts, agSummaries, ideSummaries) {
  const operations = [];
  for (const item of conflicts.items) {
    if (item.decision.action === 'replace-ide-from-ag') {
      const backup = replaceConversation(item.ag, item.ide, 'replace-from-ag');
      if (agSummaries.has(item.cid)) ideSummaries.set(item.cid, agSummaries.get(item.cid));
      operations.push({ cid: item.cid, action: item.decision.action, backup, reason: item.decision.reason });
      writeSyncLog({ kind: 'conversation-overwrite', cid: item.cid, action: item.decision.action, source: item.ag.path, target: item.ide.path, backup, reason: item.decision.reason });
      continue;
    }
    if (item.decision.action === 'replace-ag-from-ide') {
      const backup = replaceConversation(item.ide, item.ag, 'replace-from-ide');
      if (ideSummaries.has(item.cid)) agSummaries.set(item.cid, ideSummaries.get(item.cid));
      operations.push({ cid: item.cid, action: item.decision.action, backup, reason: item.decision.reason });
      writeSyncLog({ kind: 'conversation-overwrite', cid: item.cid, action: item.decision.action, source: item.ide.path, target: item.ag.path, backup, reason: item.decision.reason });
      continue;
    }
    if (item.decision.action === 'keep-both') {
      const agConflictCopy = conflictCopyPath(item.ide.file, 'ide-conflict-copy');
      const ideConflictCopy = conflictCopyPath(item.ag.file, 'ag-conflict-copy');
      fs.copyFileSync(item.ide.path, agConflictCopy);
      fs.copyFileSync(item.ag.path, ideConflictCopy);
      operations.push({ cid: item.cid, action: item.decision.action, agConflictCopy, ideConflictCopy, reason: item.decision.reason });
      writeSyncLog({ kind: 'conversation-conflict-copy', cid: item.cid, agConflictCopy, ideConflictCopy, reason: item.decision.reason });
    }
  }
  return operations;
}

module.exports = {
  analyzeSharedConflicts,
  applyConflictDecisions,
  syncLogPath,
  writeSyncLog,
};
