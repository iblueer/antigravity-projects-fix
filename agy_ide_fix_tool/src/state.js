'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeBytes, encodeString, parseSummaryEntries } = require('./protobuf');

const SUMMARY_KEY = 'antigravityUnifiedStateSync.trajectorySummaries';
const AGENT_KEY = 'jetskiStateSync.agentManagerInitState';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function sqliteValue(dbPath, key) {
  if (!fs.existsSync(dbPath)) return { value: null, error: 'state.vscdb not found' };
  try {
    const escapedKey = String(key).replace(/'/g, "''");
    const sql = `select value from ItemTable where key='${escapedKey}';`;
    const value = execFileSync('sqlite3', ['-readonly', dbPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { value: value.replace(/\n$/, ''), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function decodeBase64(value) {
  if (!value) return Buffer.alloc(0);
  return Buffer.from(value, 'base64');
}

function readStateSummaries(dbPath) {
  const row = sqliteValue(dbPath, SUMMARY_KEY);
  if (row.error || !row.value) return { summaries: [], ids: new Set(), error: row.error };
  try {
    const decoded = decodeBase64(row.value);
    const summaries = parseSummaryEntries(decoded, { encodedPayload: true, tolerant: true });
    return { summaries, ids: new Set(summaries.map((item) => item.cid)), error: null };
  } catch (error) {
    return { summaries: [], ids: new Set(), error: error.message };
  }
}

function backupFile(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backup = path.join(path.dirname(filePath), `${path.basename(filePath)}.backup-${stamp}`);
  fs.copyFileSync(filePath, backup);
  return backup;
}

function buildStateSummaryValue(agyhubSummaries) {
  const entries = agyhubSummaries.map((summary) => {
    const encodedPayload = Buffer.from(summary.payload).toString('base64');
    const entry = Buffer.concat([
      encodeString(1, summary.cid),
      encodeString(2, encodedPayload),
    ]);
    return encodeBytes(1, entry);
  });
  return Buffer.concat(entries).toString('base64');
}

function writeSqliteValue(dbPath, key, value) {
  const escapedValue = String(value).replace(/'/g, "''");
  const escapedKey = String(key).replace(/'/g, "''");
  const sql = `update ItemTable set value='${escapedValue}' where key='${escapedKey}';`;
  execFileSync('sqlite3', [dbPath, sql], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function mirrorStateFromAgyhub(area, agyhubSummaries, options = {}) {
  const before = readStateSummaries(area.stateDbPath);
  const beforeIds = before.ids;
  const agyhubIds = new Set(agyhubSummaries.map((item) => item.cid));
  const missing = agyhubSummaries.filter((item) => !beforeIds.has(item.cid));
  const stale = before.summaries.filter((item) => !agyhubIds.has(item.cid));
  const result = {
    beforeCount: before.summaries.length,
    targetCount: agyhubSummaries.length,
    missingCount: missing.length,
    staleCount: stale.length,
    backup: null,
    applied: false,
    error: before.error,
  };
  if (before.error) return result;
  if (!options.apply) return result;
  const value = buildStateSummaryValue(agyhubSummaries);
  const backup = backupFile(area.stateDbPath);
  result.backup = backup;
  writeSqliteValue(area.stateDbPath, SUMMARY_KEY, value);
  const after = readStateSummaries(area.stateDbPath);
  const afterIds = after.ids;
  const missingAfter = Array.from(agyhubIds).filter((id) => !afterIds.has(id));
  const staleAfter = Array.from(afterIds).filter((id) => !agyhubIds.has(id));
  if (after.summaries.length !== agyhubSummaries.length || missingAfter.length || staleAfter.length) {
    fs.copyFileSync(backup, area.stateDbPath);
    throw new Error(`state validation failed; restored backup ${backup}`);
  }
  result.applied = true;
  return result;
}

function readStateUuidRefs(dbPath) {
  const out = {};
  for (const key of [SUMMARY_KEY, AGENT_KEY]) {
    const row = sqliteValue(dbPath, key);
    if (row.error || !row.value) {
      out[key] = { ids: new Set(), error: row.error || 'missing key' };
      continue;
    }
    let text = row.value;
    try {
      text = decodeBase64(row.value).toString('utf8');
    } catch (_) {
      /* use raw text */
    }
    out[key] = { ids: new Set(text.match(UUID_RE) || []), error: null };
  }
  return out;
}

module.exports = { mirrorStateFromAgyhub, readStateSummaries, readStateUuidRefs, SUMMARY_KEY, AGENT_KEY };
