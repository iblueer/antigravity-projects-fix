'use strict';

const fs = require('fs');
const path = require('path');
const { selectedAreas } = require('./areas');
const { parseSummaryEntries } = require('./protobuf');
const { readProjects, duplicateGroups } = require('./projects');
const { readStateSummaries, readStateUuidRefs } = require('./state');

function listConversations(dir) {
  const conversations = new Map();
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.db') && !file.endsWith('.pb')) continue;
      const cid = path.basename(file, path.extname(file));
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (!conversations.has(cid) || file.endsWith('.db')) {
        conversations.set(cid, { cid, kind: path.extname(file).slice(1), file, fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
    return { conversations, error: null };
  } catch (error) {
    return { conversations, error: error.message };
  }
}

function readAgyhubSummaries(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const summaries = parseSummaryEntries(buf);
    return { summaries, ids: new Set(summaries.map((item) => item.cid)), error: null };
  } catch (error) {
    return { summaries: [], ids: new Set(), error: error.message };
  }
}

function difference(left, right) {
  return Array.from(left).filter((item) => !right.has(item)).sort();
}

function areaDoctor(area, projectInfo) {
  const conv = listConversations(area.conversationDir);
  const agyhub = readAgyhubSummaries(area.agyhubSummaryPath);
  const state = readStateSummaries(area.stateDbPath, area.stateFormat);
  const refs = readStateUuidRefs(area.stateDbPath);
  const convIds = new Set(conv.conversations.keys());
  const summaryIds = agyhub.ids;
  const stateIds = state.ids;
  const projectIds = new Set(projectInfo.projects.map((project) => project.id));
  const orphanSummaries = agyhub.summaries.filter((summary) => summary.project && summary.project !== 'outside-of-project' && !projectIds.has(summary.project));

  return {
    area,
    counts: {
      conversations: conv.conversations.size,
      agyhubSummaries: agyhub.summaries.length,
      stateSummaries: state.summaries.length,
      stateSummariesUnparsed: state.summaries.filter((item) => item.parseError).length,
      orphanSummaryProjectLinks: orphanSummaries.length,
      conversationMissingFromAgyhub: difference(convIds, summaryIds).length,
      agyhubMissingConversation: difference(summaryIds, convIds).length,
      agyhubMissingFromState: difference(summaryIds, stateIds).length,
      stateMissingFromAgyhub: difference(stateIds, summaryIds).length,
    },
    samples: {
      conversationMissingFromAgyhub: difference(convIds, summaryIds).slice(0, 10),
      agyhubMissingFromState: difference(summaryIds, stateIds).slice(0, 10),
      stateMissingFromAgyhub: difference(stateIds, summaryIds).slice(0, 10),
      orphanSummaries: orphanSummaries.slice(0, 10).map((item) => ({ cid: item.cid, title: item.title, project: item.project })),
    },
    errors: {
      conversations: conv.error,
      agyhub: agyhub.error,
      state: state.error,
      stateRefs: Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, value.error])),
    },
    refs: Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, value.ids.size])),
  };
}

function printAreaReport(report) {
  console.log(`\n${report.area.label}`);
  console.log(`  conversations: ${report.counts.conversations}`);
  console.log(`  agyhub summaries: ${report.counts.agyhubSummaries}`);
  console.log(`  state summaries: ${report.counts.stateSummaries}`);
  if (report.counts.stateSummariesUnparsed) console.log(`  state summaries with unparsed payload: ${report.counts.stateSummariesUnparsed}`);
  console.log(`  conversation missing from agyhub: ${report.counts.conversationMissingFromAgyhub}`);
  console.log(`  agyhub missing conversation file: ${report.counts.agyhubMissingConversation}`);
  console.log(`  agyhub missing from state: ${report.counts.agyhubMissingFromState}`);
  console.log(`  state missing from agyhub: ${report.counts.stateMissingFromAgyhub}`);
  console.log(`  orphan summary project links: ${report.counts.orphanSummaryProjectLinks}`);
  for (const [name, error] of Object.entries(report.errors)) {
    if (error && typeof error === 'string') console.log(`  warn ${name}: ${error}`);
  }
  if (report.samples.conversationMissingFromAgyhub.length) {
    console.log(`  sample conversation missing from agyhub: ${report.samples.conversationMissingFromAgyhub.join(', ')}`);
  }
  if (report.samples.agyhubMissingFromState.length) {
    console.log(`  sample agyhub missing from state: ${report.samples.agyhubMissingFromState.join(', ')}`);
  }
  if (report.samples.stateMissingFromAgyhub.length) {
    console.log(`  sample state missing from agyhub: ${report.samples.stateMissingFromAgyhub.join(', ')}`);
  }
}

function runDoctor(flags = {}) {
  const areas = selectedAreas(flags);
  const projectInfo = readProjects(areas[0].projectsDir);
  const duplicates = duplicateGroups(projectInfo.projects);

  console.log('Antigravity session manager doctor');
  console.log(`projects: ${projectInfo.projects.length} from ${areas[0].projectsDir}`);
  console.log(`duplicate project groups: ${duplicates.length}`);
  if (projectInfo.broken.length) console.log(`broken project files: ${projectInfo.broken.length}`);
  for (const group of duplicates.slice(0, 5)) {
    console.log(`  duplicate: ${group[0].key}`);
    for (const project of group.slice(0, 4)) console.log(`    - ${project.name || project.id} (${project.id})`);
    if (group.length > 4) console.log(`    ... ${group.length - 4} more`);
  }

  const reports = areas.map((area) => areaDoctor(area, projectInfo));
  for (const report of reports) printAreaReport(report);
  return reports.some((report) => {
    if (report.errors.conversations || report.errors.agyhub || report.errors.state) return true;
    return Object.values(report.errors.stateRefs).some(Boolean);
  }) ? 1 : 0;
}

module.exports = { runDoctor };
