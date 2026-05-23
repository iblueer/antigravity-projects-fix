'use strict';

const { execFileSync } = require('child_process');

function listAntigravityProcesses() {
  try {
    const out = execFileSync('ps', ['aux'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        if (/\/Applications\/Antigravity\.app\/Contents\/MacOS\/Antigravity(?:\s|$)/.test(line)) return true;
        if (/language_server .*--override_ide_name antigravity/.test(line)) return true;
        return false;
      });
  } catch (_) {
    return null;
  }
}

function assertNotRunning(options = {}) {
  if (options.force) return;
  const processes = listAntigravityProcesses();
  if (processes === null) {
    throw new Error('cannot inspect running processes; use --force to bypass');
  }
  if (processes.length) {
    throw new Error(`Antigravity appears to be running:\n${processes.map((line) => `  ${line}`).join('\n')}`);
  }
}

module.exports = { assertNotRunning, listAntigravityProcesses };
