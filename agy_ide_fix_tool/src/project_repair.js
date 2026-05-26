'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { areaConfig } = require('./areas');
const { encodeBytes, encodeString, encodeVarint, parseFields, parseSummaryEntries } = require('./protobuf');
const { readProjects, normalizeUri } = require('./projects');
const { mirrorStateFromAgyhub } = require('./state');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function backupFile(filePath, label) {
  const backup = path.join(path.dirname(filePath), `${path.basename(filePath)}.${label}-backup-${timestamp()}`);
  fs.copyFileSync(filePath, backup);
  return backup;
}

function encodeKey(field, wire) {
  return encodeVarint(field * 8 + wire);
}

function encodeRawField(source, field) {
  if (field.wire === 0 || field.wire === 1 || field.wire === 5) {
    return Buffer.concat([encodeKey(field.field, field.wire), source.subarray(field.start, field.end)]);
  }
  if (field.wire === 2) {
    return encodeBytes(field.field, source.subarray(field.start, field.end));
  }
  throw new Error(`unsupported wire type ${field.wire}`);
}

function replaceOrAppendField(source, fieldNo, replacement) {
  const parts = [];
  let replaced = false;
  for (const field of parseFields(source)) {
    if (field.field === fieldNo) {
      if (!replaced) parts.push(replacement);
      replaced = true;
    } else {
      parts.push(encodeRawField(source, field));
    }
  }
  if (!replaced) parts.push(replacement);
  return Buffer.concat(parts);
}

function updateSummaryProjectPayload(payload, projectId) {
  const parts = [];
  let updated = false;
  for (const field of parseFields(payload)) {
    if (field.field === 17 && field.wire === 2) {
      const link = payload.subarray(field.start, field.end);
      const updatedLink = replaceOrAppendField(link, 18, encodeString(18, projectId));
      parts.push(encodeBytes(17, updatedLink));
      updated = true;
    } else {
      parts.push(encodeRawField(payload, field));
    }
  }
  return updated ? Buffer.concat(parts) : payload;
}

function readSummaries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseSummaryEntries(fs.readFileSync(filePath), { tolerant: true });
}

function buildAgyhubBuffer(summaries) {
  return Buffer.concat(summaries.map((summary) => {
    const entry = Buffer.concat([
      encodeString(1, summary.cid),
      encodeBytes(2, summary.payload),
    ]);
    return encodeBytes(1, entry);
  }));
}

function projectNameFromUri(uri) {
  const normalized = normalizeUri(uri).replace(/^file:\/\//, '').replace(/\/+$/, '');
  return decodeURIComponent(path.basename(normalized)) || 'Project';
}

function projectForUri(projects, workspaceUri) {
  const normalized = normalizeUri(workspaceUri);
  return projects
    .filter((project) => project.uris.some((uri) => normalized.startsWith(normalizeUri(uri))))
    .sort((a, b) => Math.max(...b.uris.map((uri) => uri.length)) - Math.max(...a.uris.map((uri) => uri.length)))[0] || null;
}

function createProjectFile(projectsDir, workspaceUri) {
  const id = crypto.randomUUID();
  const project = {
    id,
    name: projectNameFromUri(workspaceUri),
    projectResources: {
      resources: [
        {
          gitFolder: {
            folderUri: workspaceUri,
            defaultBranch: 'main',
            allowWrite: true,
          },
        },
      ],
    },
  };
  fs.mkdirSync(projectsDir, { recursive: true });
  const fullPath = path.join(projectsDir, `${id}.json`);
  fs.writeFileSync(fullPath, `${JSON.stringify(project, null, 2)}\n`);
  return { id, name: project.name, fullPath, uri: workspaceUri, created: true };
}

function projectJsonNeedsRepair(project, workspaceUri) {
  if (!project || !project.fullPath) return false;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(project.fullPath, 'utf8'));
  } catch (_) {
    return false;
  }
  const resources = data.projectResources?.resources || [];
  return resources.some((resource) => {
    const gitFolder = resource.gitFolder;
    return gitFolder && normalizeUri(gitFolder.folderUri || '') === normalizeUri(workspaceUri) && gitFolder.allowWrite !== true;
  });
}

function repairProjectJson(project, workspaceUri) {
  const data = JSON.parse(fs.readFileSync(project.fullPath, 'utf8'));
  let changed = false;
  for (const resource of data.projectResources?.resources || []) {
    const gitFolder = resource.gitFolder;
    if (gitFolder && normalizeUri(gitFolder.folderUri || '') === normalizeUri(workspaceUri) && gitFolder.allowWrite !== true) {
      gitFolder.allowWrite = true;
      changed = true;
    }
  }
  if (!changed) return null;
  const backup = backupFile(project.fullPath, 'project-json-repair');
  fs.writeFileSync(project.fullPath, `${JSON.stringify(data, null, 2)}\n`);
  return backup;
}

function workspaceStorageDir(area) {
  return path.join(area.userDir, 'workspaceStorage');
}

function readWorkspaceStorage(area) {
  const root = workspaceStorageDir(area);
  const byUri = new Map();
  if (!fs.existsSync(root)) return { root, byUri };
  for (const dir of fs.readdirSync(root)) {
    const fullPath = path.join(root, dir);
    const workspaceJson = path.join(fullPath, 'workspace.json');
    if (!fs.existsSync(workspaceJson)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(workspaceJson, 'utf8'));
      if (parsed.folder) byUri.set(normalizeUri(parsed.folder), { dir, fullPath, workspaceJson });
    } catch (_) {
      /* skip broken workspace storage */
    }
  }
  return { root, byUri };
}

function copyWorkspaceStorage(source, target) {
  fs.mkdirSync(path.dirname(target.fullPath), { recursive: true });
  fs.cpSync(source.fullPath, target.fullPath, { recursive: true, errorOnExist: true });
}

function buildProjectRepairPlan(flags = {}) {
  const area = areaConfig(flags.area || 'ag', flags);
  const otherArea = areaConfig(area.area === 'ag' ? 'ide' : 'ag', flags);
  const projectInfo = readProjects(area.projectsDir);
  const summaries = readSummaries(area.agyhubSummaryPath);
  const projectIds = new Set(projectInfo.projects.map((project) => project.id));
  const knownByUri = new Map();
  const targetWorkspaceStorage = readWorkspaceStorage(area);
  const sourceWorkspaceStorage = readWorkspaceStorage(otherArea);
  const items = [];

  for (const summary of summaries) {
    const workspaceUri = summary.uris?.[0] || null;
    const projectMissing = !summary.project || summary.project === 'outside-of-project' || !projectIds.has(summary.project);
    if (!workspaceUri) continue;
    let project = projectForUri(projectInfo.projects, workspaceUri);
    let willCreateProject = false;
    if (!project) {
      const key = normalizeUri(workspaceUri);
      if (!knownByUri.has(key)) {
        knownByUri.set(key, { id: null, uri: workspaceUri, name: projectNameFromUri(workspaceUri), created: true });
      }
      project = knownByUri.get(key);
      willCreateProject = true;
    }
    const normalizedUri = normalizeUri(workspaceUri);
    const sourceStorage = sourceWorkspaceStorage.byUri.get(normalizedUri) || null;
    const targetStorage = targetWorkspaceStorage.byUri.get(normalizedUri) || null;
    const workspaceStorageNeedsCopy = Boolean(sourceStorage && !targetStorage);
    const needsProjectJsonRepair = !willCreateProject && projectJsonNeedsRepair(project, workspaceUri);
    if (!projectMissing && !needsProjectJsonRepair && !workspaceStorageNeedsCopy) continue;
    items.push({
      cid: summary.cid,
      title: summary.title,
      workspaceUri,
      projectMissing,
      currentProject: summary.project || null,
      targetProject: project.id,
      targetProjectName: project.name || projectNameFromUri(workspaceUri),
      willCreateProject,
      projectJsonNeedsRepair: needsProjectJsonRepair,
      projectFile: project.fullPath || null,
      workspaceStorageNeedsCopy,
      workspaceStorageSource: sourceStorage?.fullPath || null,
      workspaceStorageTarget: sourceStorage ? path.join(targetWorkspaceStorage.root, sourceStorage.dir) : null,
    });
  }

  const projectRepairs = new Map();
  for (const item of items) {
    if (!item.projectJsonNeedsRepair || !item.targetProject || !item.projectFile) continue;
    projectRepairs.set(item.targetProject, {
      id: item.targetProject,
      name: item.targetProjectName,
      file: item.projectFile,
      workspaceUri: item.workspaceUri,
    });
  }

  const workspaceStorageRepairs = new Map();
  for (const item of items) {
    if (!item.workspaceStorageNeedsCopy || !item.workspaceStorageSource || !item.workspaceStorageTarget) continue;
    workspaceStorageRepairs.set(item.workspaceUri, {
      workspaceUri: item.workspaceUri,
      source: item.workspaceStorageSource,
      target: item.workspaceStorageTarget,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    area: { id: area.area, label: area.label },
    projectsDir: area.projectsDir,
    missingProjectCount: items.filter((item) => item.projectMissing).length,
    projectsToCreate: Array.from(knownByUri.values()).length,
    projectFilesToRepair: projectRepairs.size,
    workspaceStorageToCopy: workspaceStorageRepairs.size,
    projectRepairs: Array.from(projectRepairs.values()),
    workspaceStorageRepairs: Array.from(workspaceStorageRepairs.values()),
    items,
    summaries,
    areaConfig: area,
  };
}

function applyProjectRepair(flags = {}) {
  const plan = buildProjectRepairPlan(flags);
  const result = {
    generatedAt: new Date().toISOString(),
    area: plan.area,
    applied: false,
    missingProjectCount: plan.missingProjectCount,
    projectsCreated: 0,
    projectFilesRepaired: 0,
    workspaceStorageCopied: 0,
    summariesUpdated: 0,
    backups: { agyhub: null, state: null, projects: [] },
    items: plan.items.map(({ cid, title, workspaceUri, projectMissing, currentProject, targetProject, targetProjectName, willCreateProject, projectJsonNeedsRepair, workspaceStorageNeedsCopy }) => ({
      cid,
      title,
      workspaceUri,
      projectMissing,
      currentProject,
      targetProject,
      targetProjectName,
      willCreateProject,
      projectJsonNeedsRepair,
      workspaceStorageNeedsCopy,
    })),
  };
  if (!flags.apply || plan.items.length === 0) return result;

  const projectInfo = readProjects(plan.areaConfig.projectsDir);
  const projectById = new Map(projectInfo.projects.map((project) => [project.id, project]));
  const createdProjects = new Map();
  for (const item of plan.items) {
    if (item.targetProject) continue;
    const key = normalizeUri(item.workspaceUri);
    if (!createdProjects.has(key)) createdProjects.set(key, createProjectFile(plan.areaConfig.projectsDir, item.workspaceUri));
    const created = createdProjects.get(key);
    item.targetProject = created.id;
    item.targetProjectName = created.name;
  }
  for (const repair of plan.projectRepairs) {
    const project = projectById.get(repair.id);
    if (!project) continue;
    const backup = repairProjectJson(project, repair.workspaceUri);
    if (backup) {
      result.projectFilesRepaired += 1;
      result.backups.projects.push(backup);
    }
  }
  for (const repair of plan.workspaceStorageRepairs) {
    copyWorkspaceStorage({ fullPath: repair.source }, { fullPath: repair.target });
    result.workspaceStorageCopied += 1;
  }

  const targetByCid = new Map(plan.items.filter((item) => item.projectMissing).map((item) => [item.cid, item.targetProject]));
  const agyhubBackup = backupFile(plan.areaConfig.agyhubSummaryPath, 'project-repair');
  const stateBackup = backupFile(plan.areaConfig.stateDbPath, 'project-repair');
  result.backups.agyhub = agyhubBackup;
  result.backups.state = stateBackup;
  try {
    const updated = plan.summaries.map((summary) => {
      const projectId = targetByCid.get(summary.cid);
      if (!projectId) return summary;
      return { ...summary, payload: updateSummaryProjectPayload(summary.payload, projectId) };
    });
    fs.writeFileSync(plan.areaConfig.agyhubSummaryPath, buildAgyhubBuffer(updated));
    const reparsed = readSummaries(plan.areaConfig.agyhubSummaryPath);
    for (const item of plan.items.filter((candidate) => candidate.projectMissing)) {
      const hit = reparsed.find((summary) => summary.cid === item.cid);
      if (!hit || hit.project !== item.targetProject) throw new Error(`project repair validation failed for ${item.cid}`);
    }
    mirrorStateFromAgyhub(plan.areaConfig, reparsed, { apply: true });
    result.applied = true;
    result.projectsCreated = createdProjects.size;
    result.summariesUpdated = targetByCid.size;
    result.items = plan.items.map(({ cid, title, workspaceUri, projectMissing, currentProject, targetProject, targetProjectName, willCreateProject, projectJsonNeedsRepair, workspaceStorageNeedsCopy }) => ({
      cid,
      title,
      workspaceUri,
      projectMissing,
      currentProject,
      targetProject,
      targetProjectName,
      willCreateProject,
      projectJsonNeedsRepair,
      workspaceStorageNeedsCopy,
    }));
    return result;
  } catch (error) {
    fs.copyFileSync(agyhubBackup, plan.areaConfig.agyhubSummaryPath);
    fs.copyFileSync(stateBackup, plan.areaConfig.stateDbPath);
    throw error;
  }
}

module.exports = {
  buildProjectRepairPlan,
  applyProjectRepair,
  updateSummaryProjectPayload,
};
