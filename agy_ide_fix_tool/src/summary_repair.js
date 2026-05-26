'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { areaConfig } = require('./areas');
const { encodeBytes, encodeString, encodeVarint, parseSummaryEntries } = require('./protobuf');
const { mirrorStateFromAgyhub } = require('./state');

const URI_RE = /file:\/\/\/[^\s)\]]+/g;
const ABS_PATH_RE = /\/Users\/[^\s)\]<>"]+/g;
const ACTIVE_DOCUMENT_RE = /Active Document:\s*([^\s]+)(?:\s+\(|\s*$)/;
const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

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

function fileUriFromPath(filePath) {
  if (!filePath || !filePath.startsWith('/')) return null;
  return `file://${filePath.split('/').map((part, idx) => (idx === 0 ? '' : encodeURIComponent(part))).join('/')}`;
}

function pathFromUri(uri) {
  const normalized = normalizeUri(uri);
  if (normalized.startsWith('file://')) return normalized.replace(/^file:\/\//, '');
  return normalized;
}

function workspaceRootFromPath(filePath) {
  if (!filePath || !filePath.startsWith('/')) return null;
  let cursor = filePath;
  if (/\.[A-Za-z0-9]+$/.test(cursor)) cursor = path.dirname(cursor);
  const original = cursor;
  for (let i = 0; i < 8 && cursor !== path.dirname(cursor); i += 1) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor;
    cursor = path.dirname(cursor);
  }
  const githubIdx = original.indexOf('/GitHub/');
  if (githubIdx >= 0) {
    const parts = original.slice(githubIdx + '/GitHub/'.length).split('/').filter(Boolean);
    if (parts[0]) return original.slice(0, githubIdx + '/GitHub/'.length) + parts[0];
  }
  return original;
}

function cleanTitle(text) {
  if (!text) return null;
  return text
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .replace(/^(帮我|请|麻烦|能不能|可以)?\s*/, '')
    .trim()
    .slice(0, 80) || null;
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
    let root = workspaceRootFromPath(pathFromUri(uri));
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  const root = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return root ? fileUriFromPath(root) || root : null;
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

function registeredProjectRoots(projectsDir) {
  const roots = [];
  if (!projectsDir || !fs.existsSync(projectsDir)) return roots;
  for (const file of fs.readdirSync(projectsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, file), 'utf8'));
      const resources = parsed.projectResources?.resources || [];
      for (const resource of resources) {
        const folderUri = normalizeUri(resource.gitFolder?.folderUri || '');
        if (folderUri) roots.push({ uri: folderUri, id: parsed.id });
      }
    } catch (_) {
      /* skip broken project files */
    }
  }
  return roots.sort((a, b) => b.uri.length - a.uri.length);
}

function preferredWorkspaceUri(projectsDir, primaryUris, fallbackUris) {
  for (const uri of primaryUris) {
    const root = workspaceRootFromPath(pathFromUri(uri));
    if (root) return fileUriFromPath(root);
  }
  const roots = registeredProjectRoots(projectsDir);
  for (const uri of fallbackUris) {
    const normalized = normalizeUri(uri);
    const hit = roots.find((root) => normalized.startsWith(root.uri));
    if (hit) return hit.uri;
  }
  return projectRootFromUris(fallbackUris);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      /* skip malformed transcript lines */
    }
  }
  return out;
}

function titleFromConversationHistory(content) {
  const match = content.match(/^## Conversation [^:]+:\s*(.+)$/m);
  return cleanTitle(match?.[1]);
}

function titleFromUserRequest(content) {
  const match = content.match(USER_REQUEST_RE);
  if (!match) return null;
  return cleanTitle(match[1]);
}

function pathsFromTranscriptContent(content) {
  const paths = [];
  const active = content.match(ACTIVE_DOCUMENT_RE)?.[1];
  if (active) paths.push(active);
  for (const match of content.matchAll(ABS_PATH_RE)) {
    paths.push(match[0]);
  }
  return paths.filter((item) => item.startsWith('/Users/'));
}

function transcriptInfo(brainDir) {
  const transcriptPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
  const lines = readJsonl(transcriptPath);
  const uris = [];
  const primaryUris = [];
  let title = null;
  let titleSource = null;
  for (const entry of lines) {
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!content) continue;
    if (!title && entry.type === 'CONVERSATION_HISTORY') {
      title = titleFromConversationHistory(content);
      if (title) titleSource = 'transcript conversation history';
    }
    if (!title && entry.type === 'USER_INPUT') {
      title = titleFromUserRequest(content);
      if (title) titleSource = 'transcript user request';
    }
    for (const match of content.matchAll(URI_RE)) uris.push(normalizeUri(match[0]));
    const active = content.match(ACTIVE_DOCUMENT_RE)?.[1];
    if (active) {
      const uri = fileUriFromPath(active);
      if (uri) primaryUris.push(normalizeUri(uri));
    }
    for (const filePath of pathsFromTranscriptContent(content)) {
      const uri = fileUriFromPath(filePath);
      if (uri) uris.push(normalizeUri(uri));
    }
  }
  return {
    title,
    titleSource,
    uris: Array.from(new Set(uris)),
    primaryUris: Array.from(new Set(primaryUris)),
    stepCount: lines.length || null,
    transcriptPath: fs.existsSync(transcriptPath) ? transcriptPath : null,
  };
}

function sourceQuality({ title, workspaceUri, transcript }) {
  if (title && workspaceUri && transcript?.titleSource === 'transcript conversation history') return 'high';
  if (title && workspaceUri) return 'medium';
  return 'low';
}

function planMissingItem(area, cid, conversations) {
  const conversation = conversations.get(cid);
  const brainDir = path.join(area.geminiDir, 'brain', cid);
  const brainTitle = titleFromBrain(brainDir);
  const brainUris = urisFromBrain(brainDir);
  const transcript = transcriptInfo(brainDir);
  const title = brainTitle || transcript.title;
  const workspaceUri = preferredWorkspaceUri(area.projectsDir, brainUris.concat(transcript.primaryUris), brainUris.concat(transcript.uris));
  const project = findProjectForUri(area.projectsDir, workspaceUri);
  const reasons = [];
  if (!conversation) reasons.push('conversation file not found');
  if (!fs.existsSync(brainDir)) reasons.push('brain directory not found');
  if (!title) reasons.push('cannot infer title from brain markdown or transcript');
  if (!workspaceUri) reasons.push('cannot infer workspace URI from brain markdown or transcript');
  const strategy = [
    brainTitle || brainUris.length ? 'brain-markdown' : null,
    transcript.transcriptPath ? 'transcript-jsonl' : null,
    conversation ? 'conversation-file-metadata' : null,
  ].filter(Boolean).join('+') || 'none';
  return {
    cid,
    canRepair: reasons.length === 0,
    reasons,
    title,
    workspaceUri,
    project,
    repairStrategy: strategy,
    confidence: sourceQuality({ title, workspaceUri, transcript }),
    evidence: {
      titleSource: brainTitle ? 'brain markdown' : transcript.titleSource,
      workspaceUriSource: brainUris.length ? 'brain markdown' : (transcript.uris.length ? 'transcript' : null),
      transcriptPath: transcript.transcriptPath,
    },
    file: conversation?.file || null,
    mtimeMs: conversation?.mtimeMs || null,
    stepCount: Math.max(1, transcript.stepCount || Math.round((conversation?.size || 0) / 360000)),
  };
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
  const items = targetIds.map((cid) => planMissingItem(area, cid, conversations));
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
    items: plan.items.map(({ cid, canRepair, reasons, title, workspaceUri, project, repairStrategy, confidence, evidence }) => ({
      cid,
      canRepair,
      reasons,
      title,
      workspaceUri,
      project,
      repairStrategy,
      confidence,
      evidence,
    })),
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
