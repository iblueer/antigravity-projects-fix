#!/usr/bin/env node
'use strict';

const { runDoctor } = require('./doctor');
const { runRepair } = require('./repair');
const { runSync } = require('./sync');

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function printHelp() {
  console.log(`agyfix-session

Usage:
  agyfix-session doctor [--area ide|ag] [--all]
  agyfix-session doctor --all --json
  agyfix-session repair state --area ide --mirror-agyhub [--apply]
  agyfix-session sync plan
  agyfix-session sync plan --json
  agyfix-session sync conflicts [--json]
  agyfix-session sync plan --from ide --to ag
  agyfix-session sync apply --from ide --to ag [--apply]
  agyfix-session sync apply --bidirectional [--apply] [--json]

Options:
  --area <area>          Scan one area. Default: ide
  --all                  Scan Antigravity and Antigravity IDE
  --home <path>          Override home directory
  --project-dir <path>   Override ~/.gemini/config/projects
  --force                Bypass running-process protection for write commands
  --json                 Emit machine-readable JSON for doctor/sync
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'doctor';
  if (args.flags.help || args.flags.h) {
    printHelp();
    return 0;
  }
  if (command === 'doctor') return runDoctor(args.flags);
  if (command === 'repair') return runRepair(args._.slice(1), args.flags);
  if (command === 'sync') return runSync(args._.slice(1), args.flags);
  console.error(`Unknown command: ${command}`);
  printHelp();
  return 2;
}

if (require.main === module) {
  process.exitCode = main();
}
