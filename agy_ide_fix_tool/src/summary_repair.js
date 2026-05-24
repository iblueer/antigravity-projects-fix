'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { areaConfig } = require('./areas');
const { encodeBytes, encodeString, encodeVarint, parseSummaryEntries } = require('./protobuf');
const { mirrorStateFromAgyhub } = require('./state');

const URI_RE = /file:\/\/\/[^\s)\]]+/g;

function encodeKey(field, wire) {
  return encodeVarint(field * 8 + wire);
}

function encodeUint(field, value) {
  return Buffer.concat([encodeKey(field, 0), encodeVarint(value)]);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function backupFile(filePath, label) {
  const backup = path.join(path.dirname(filePath), `${path.basename(filePath)}.${label}-backup-${timestamp()}`);
  fs.copyFileSync(filePath, backup);
  return backup;
}

function listConversations(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.pb') && !file.endsWith('.db')) continue;
    const cid = path.basename(file, path.extname(file));
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (!out.has(cid) || file.endsWith('.db')) {
      out.set(cid, { cid, file, fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return out;
}

function readSummaries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseSummaryEntries(fs.readFileSync(filePath), { tolerant: true });
}

function normalizeUri(uri) {
  try {
    return decodeURIComponent(uri).replace(/\/+$/, '');
  } catch (_) {
    return uri.replace(/\/+$/, '');
  }
}

function markdownTitle(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  const firstHeading = text.split(/\r?\n/).find((line) => line.startsWith('# '));
  if (!firstHeading) return null;
  return firstHeading.replace(/^#\s+/, '').replace(/^(Task Checklist|Implementation Plan|Walkthrough)\s*-\s*/i, '').trim() || null;
}

function titleFromBrain(brainDir) {
  const candidates = ['task.md', 'implementation_plan.md', 'walkthrough.md'];
  for (const name of candidates) {
    const title = markdownTitle(path.join(brainDir, name));
    if (title) return title;
  }
  return null;
}

function urisFromBrain(brainDir) {
  if (!fs.existsSync(brainDir)) return [];
  const uris = [];
  for (const file of fs.readdirSync(brainDir)) {
    if (!file.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(brainDir, file), 'utf8');
    for (const match of text.matchAll(URI_RE)) {
      uris.push(normalizeUri(match[0]));
    }
  }
  return Array.from(new Set(uris));
}

function projectRootFromUris(uris) {
  const counts = new Map();
  for (const uri of uris) {
    const marker = '/frontend/';
    let root = uri;
    const idx = root.indexOf(marker);
    if (idx >= 0) root = root.slice(0, idx);
    root = root.replace(/\/[^/]+\.(vue|ts|js|json|css|md|go|swift|tsx|jsx)$/i, '');
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function findProjectForUri(projectsDir, workspaceUri) {
  if (!projectsDir || !workspaceUri || !fs.existsSync(projectsDir)) return 'outside-of-project';
  for (const file of fs.readdirSync(projectsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, file), 'utf8'));
      const resources = parsed.projectResources?.resources || [];
      for (const resource of resources) {
        const folderUri = normalizeUri(resource.gitFolder?.folderUri || '');
        if (folderUri && normalizeUri(workspaceUri).startsWith(folderUri)) return parsed.id;
      }
    } catch (_) {
      /* skip broken project files */
    }
  }
  return 'outside-of-project';
}

function timeMessage(mtimeMs) {
  const seconds = Math.floor(mtimeMs / 1000);
  const nanos = Math.floor((mtimeMs - seconds * 1000) * 1_000_000);
  return Buffer.concat([encodeUint(1, seconds), encodeUint(2, nanos)]);
}

function gitMessage(workspaceUri) {
  return Buffer.concat([
    encodeString(1, workspaceUri),
    encodeString(2, workspaceUri),
    encodeString(4, 'main'),
  ]);
}

function buildSummaryPayload(plan) {
  const time = timeMessage(plan.mtimeMs);
  const git = gitMessage(plan.workspaceUri);
  const trajectory = crypto.randomUUID();
  const link = Buffer.concat([
    encodeBytes(1, git),
    encodeBytes(2, time),
    encodeString(3, trajectory),
    encodeString(7, plan.workspaceUri),
    encodeString(18, plan.project || 'outside-of-project'),
  ]);
  return Buffer.concat([
    encodeString(1, plan.title),
    encodeUint(2, plan.stepCount),
    encodeBytes(3, time),
    encodeString(4, trajectory),
    encodeUint(5, 1),
    encodeBytes(7, time),
    encodeBytes(9, git),
    encodeBytes(10, time),
    encodeBytes(15, Buffer.alloc(0)),
    encodeUint(16, Math.max(0, plan.stepCount - 1)),
    encodeBytes(17, link),
    encodeUint(22, 4),
  ]);
}

function buildAgyhubBuffer(summaries) {
  const entries = summaries.map((summary) => {
    const entry = Buffer.concat([
      encodeString(1, summary.cid),
      encodeBytes(2, summary.payload),
    ]);
    return encodeBytes(1, entry);
  });
  return Buffer.concat(entries);
}

function missingSummaryIds(area) {
  const conversations = listConversations(area.conversationDir);
  const summaries = readSummaries(area.agyhubSummaryPath);
  const summaryIds = new Set(summaries.map((item) => item.cid));
  return {
    conversations,
    summaries,
    ids: Array.from(conversations.keys()).filter((id) => !summaryIds.has(id)).sort(),
  };
}

function buildMissingSummaryPlan(area, id) {
  const { conversations, summaries, ids } = missingSummaryIds(area);
  const targetIds = id ? ids.filter((item) => item === id) : ids;
  const items = targetIds.map((cid) => {
    const conversation = conversations.get(cid);
    const brainDir = path.join(area.geminiDir, 'brain', cid);
    const title = titleFromBrain(brainDir);
    const workspaceUri = projectRootFromUris(urisFromBrain(brainDir));
    const project = findProjectForUri(area.projectsDir, workspaceUri);
    const reasons = [];
    if (!conversation) reasons.push('conversation file not found');
    if (!fs.existsSync(brainDir)) reasons.push('brain directory not found');
    if (!title) reasons.push('cannot infer title from brain markdown');
    if (!workspaceUri) reasons.push('cannot infer workspace URI from brain markdown');
    return {
      cid,
      canRepair: reasons.length === 0,
      reasons,
      title,
      workspaceUri,
      project,
      file: conversation?.file || null,
      mtimeMs: conversation?.mtimeMs || null,
      stepCount: Math.max(1, Math.round((conversation?.size || 0) / 360000)),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    area: { id: area.area, label: area.label },
    missingCount: ids.length,
    repairableCount: items.filter((item) => item.canRepair).length,
    skippedCount: items.filter((item) => !item.canRepair).length,
    items,
    summaries,
  };
}

function applyMissingSummaryRepair(flags = {}) {
  const area = areaConfig(flags.area || 'ide', flags);
  const plan = buildMissingSummaryPlan(area, flags.id);
  const repairable = plan.items.filter((item) => item.canRepair);
  const result = {
    generatedAt: new Date().toISOString(),
    area: plan.area,
    applied: false,
    missingCount: plan.missingCount,
    repairableCount: repairable.length,
    skippedCount: plan.skippedCount,
    repairedCount: 0,
    backups: { agyhub: null, state: null, stateMirror: null },
    items: plan.items.map(({ cid, canRepair, reasons, title, workspaceUri, project }) => ({ cid, canRepair, reasons, title, workspaceUri, project })),
  };
  if (!flags.apply || repairable.length === 0) return result;

  const agyhubBackup = backupFile(area.agyhubSummaryPath, 'summary-repair');
  const stateBackup = backupFile(area.stateDbPath, 'summary-repair');
  result.backups.agyhub = agyhubBackup;
  result.backups.state = stateBackup;
  try {
    const existing = readSummaries(area.agyhubSummaryPath);
    const appended = repairable.map((item) => ({
      cid: item.cid,
      payload: buildSummaryPayload(item),
    }));
    fs.writeFileSync(area.agyhubSummaryPath, buildAgyhubBuffer(existing.concat(appended)));
    const reparsed = readSummaries(area.agyhubSummaryPath);
    for (const item of repairable) {
      const hit = reparsed.find((summary) => summary.cid === item.cid);
      if (!hit) throw new Error(`summary write validation failed for ${item.cid}`);
      if (hit.title !== item.title) throw new Error(`summary title validation failed for ${item.cid}`);
      if (!hit.uris.includes(item.workspaceUri)) throw new Error(`summary workspace validation failed for ${item.cid}`);
    }
    const stateResult = mirrorStateFromAgyhub(area, reparsed, { apply: true });
    result.backups.stateMirror = stateResult.backup;
    result.applied = true;
    result.repairedCount = repairable.length;
    return result;
  } catch (error) {
    fs.copyFileSync(agyhubBackup, area.agyhubSummaryPath);
    fs.copyFileSync(stateBackup, area.stateDbPath);
    throw error;
  }
}

module.exports = {
  buildMissingSummaryPlan,
  applyMissingSummaryRepair,
  buildSummaryPayload,
};
