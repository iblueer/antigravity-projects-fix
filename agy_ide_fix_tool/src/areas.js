'use strict';

const os = require('os');
const path = require('path');

function homeDir() {
  return os.homedir();
}

function areaConfig(name, flags = {}) {
  const home = flags.home ? path.resolve(flags.home) : homeDir();
  const area = name === 'ag' || name === 'antigravity' ? 'ag' : 'ide';
  const geminiName = area === 'ag' ? 'antigravity' : 'antigravity-ide';
  const appSupportName = area === 'ag' ? 'Antigravity' : 'Antigravity IDE';
  const geminiDir = flags[`${area}-gemini-dir`] || path.join(home, '.gemini', geminiName);
  const userDir = flags[`${area}-user-dir`] || path.join(home, 'Library', 'Application Support', appSupportName, 'User');

  return {
    area,
    label: area === 'ag' ? 'Antigravity' : 'Antigravity IDE',
    stateFormat: area === 'ag' ? 'direct-base64-payload' : 'wrapped-base64-payload',
    geminiDir,
    conversationDir: path.join(geminiDir, 'conversations'),
    agyhubSummaryPath: path.join(geminiDir, 'agyhub_summaries_proto.pb'),
    userDir,
    stateDbPath: path.join(userDir, 'globalStorage', 'state.vscdb'),
    projectsDir: flags['project-dir'] || path.join(home, '.gemini', 'config', 'projects'),
  };
}

function selectedAreas(flags = {}) {
  if (flags.all) return [areaConfig('ag', flags), areaConfig('ide', flags)];
  return [areaConfig(flags.area || 'ide', flags)];
}

module.exports = { areaConfig, selectedAreas };
