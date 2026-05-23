'use strict';

const fs = require('fs');
const path = require('path');

function collectFolderUris(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'folderUri' && typeof value === 'string') out.push(normalizeUri(value));
    else if (value && typeof value === 'object') collectFolderUris(value, out);
  }
  return out;
}

function normalizeUri(uri) {
  try {
    return decodeURIComponent(uri).replace(/\\/g, '/').replace(/\/+$/, '');
  } catch (_) {
    return uri.replace(/\\/g, '/').replace(/\/+$/, '');
  }
}

function readProjects(projectsDir) {
  const projects = [];
  const broken = [];
  let files = [];
  try {
    files = fs.readdirSync(projectsDir).filter((file) => file.endsWith('.json'));
  } catch (error) {
    return { projects, broken, error: error.message };
  }
  for (const file of files) {
    const fullPath = path.join(projectsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const uris = Array.from(new Set(collectFolderUris(data))).sort();
      projects.push({
        id: data.id || path.basename(file, '.json'),
        name: data.name || '',
        file,
        fullPath,
        uris,
        key: uris.length ? uris.join(' + ') : `(no-folder:${file})`,
      });
    } catch (error) {
      broken.push({ file, error: error.message });
    }
  }
  return { projects, broken, error: null };
}

function duplicateGroups(projects) {
  const groups = new Map();
  for (const project of projects) {
    if (!groups.has(project.key)) groups.set(project.key, []);
    groups.get(project.key).push(project);
  }
  return Array.from(groups.values())
    .filter((group) => group.length > 1 && !group[0].key.startsWith('(no-folder:'))
    .sort((a, b) => b.length - a.length);
}

module.exports = { readProjects, duplicateGroups, normalizeUri };
