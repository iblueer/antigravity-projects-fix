#!/usr/bin/env node
'use strict';

/*
 * antigravity-projects-fix
 * -------------------------------------------------------------------------
 * Fixes the Google Antigravity 2.0 bug where one project folder gets split
 * into many duplicate sidebar entries ("MyApp", "MyApp 2", ... "MyApp 41").
 *
 * Antigravity tracks each workspace by a generated UUID instead of by its
 * folder path. On migration / re-sync it keeps minting a NEW UUID for the
 * SAME folder, so the Projects panel fills up with numbered duplicates.
 *
 * The panel is rendered from the JSON files in:
 *     ~/.gemini/config/projects/<uuid>.json
 *
 * This tool reads that folder, groups the entries by their real folderUri,
 * and lets you either consolidate (keep one per folder) or purge (remove
 * all). Every destructive action is dry-run by default and makes a backup.
 *
 * Zero dependencies. Node >= 16.7 (uses fs.cpSync). Cross-platform.
 * Not affiliated with Google LLC.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const VERSION = '1.0.0';

// ---------------------------------------------------------------- ANSI color
const useColor =
  process.stdout.isTTY && !process.argv.includes('--no-color') && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const cyan = (s) => c('36', s);

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) args.flags[ch] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------------------------------------------------------------- helpers
function defaultProjectsDir() {
  return path.join(os.homedir(), '.gemini', 'config', 'projects');
}

/** Pull every folderUri found anywhere in a project JSON object. */
function collectFolderUris(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'folderUri' && typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') collectFolderUris(v, out);
  }
  return out;
}

/** Normalize a folderUri so two spellings of the same path compare equal. */
function normalizeUri(uri) {
  let s = uri;
  try {
    s = decodeURIComponent(uri);
  } catch (_) {
    /* leave as-is if it is not valid percent-encoding */
  }
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

/** Strip a trailing " 2", " 17" ... so we can spot the "base" name. */
function baseName(name) {
  return String(name || '').replace(/\s+\d+$/, '').trim();
}

function readProjects(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'missing' : e.message, entries: [] };
  }
  const entries = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const json = JSON.parse(fs.readFileSync(full, 'utf8'));
      const uris = collectFolderUris(json).map(normalizeUri).sort();
      entries.push({
        file,
        full,
        id: json.id || path.basename(file, '.json'),
        name: json.name || '(unnamed)',
        uris,
        key: uris.length ? uris.join(' + ') : `(no-folder:${file})`,
        mtime: fs.statSync(full).mtimeMs,
      });
    } catch (e) {
      entries.push({ file, full, name: '(unparseable)', uris: [], key: `(bad:${file})`, broken: true });
    }
  }
  return { entries };
}

function groupByFolder(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.key)) groups.set(e.key, []);
    groups.get(e.key).push(e);
  }
  // sort each group so the "keeper" is first: base name (no number) wins,
  // then shortest name, then oldest file.
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const an = /\s\d+$/.test(a.name) ? 1 : 0;
      const bn = /\s\d+$/.test(b.name) ? 1 : 0;
      if (an !== bn) return an - bn;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return (a.mtime || 0) - (b.mtime || 0);
    });
  }
  return groups;
}

function prettyKey(key) {
  return key.replace(/file:\/\/\//gi, '').replace(/\s\+\s/g, '  +  ');
}

function isAntigravityRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /Antigravity\.exe/i.test(out);
    }
    const out = execSync('pgrep -i antigravity || true', {
      encoding: 'utf8',
      shell: '/bin/sh',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch (_) {
    return null; // could not determine
  }
}

function backup(dir) {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const dest = `${dir.replace(/[/\\]+$/, '')}.backup-${stamp}`;
  fs.cpSync(dir, dest, { recursive: true });
  return dest;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function confirm(flags, message) {
  if (flags.yes || flags.y) return true;
  const a = await ask(`${message} ${dim('[y/N]')} `);
  return a === 'y' || a === 'yes';
}

async function guardRunning(flags) {
  if (flags.force) return;
  const running = isAntigravityRunning();
  if (running === true) {
    console.log(
      red('\n  Antigravity appears to be RUNNING.') +
        '\n  Close it completely first, or the files may be locked or rewritten.' +
        dim('\n  (use --force to override)\n')
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------- commands
function cmdScan(dir) {
  const { error, entries } = readProjects(dir);
  if (error === 'missing') {
    console.log(yellow(`\n  No projects folder found at:\n  ${dir}`));
    console.log(dim('  Nothing to scan. (Is Antigravity installed for this user?)\n'));
    return { groups: new Map(), entries: [] };
  }
  if (error) {
    console.log(red(`\n  Could not read ${dir}: ${error}\n`));
    process.exit(1);
  }

  const groups = groupByFolder(entries);
  let dupes = 0;

  console.log(bold(`\n  Antigravity projects in ${dim(dir)}\n`));
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of sorted) {
    const n = list.length;
    if (n > 1) dupes += n - 1;
    const head = n > 1 ? red(`${n}×`) : green(`${n}×`);
    console.log(`  ${head} ${cyan(prettyKey(key))}`);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const tag = i === 0 ? green('keep') : red('dup ');
      console.log(`      ${dim(tag)} ${e.name}  ${dim(e.id)}`);
    }
  }

  console.log(
    '\n  ' +
      bold(`${entries.length}`) +
      ` project files  →  ` +
      bold(`${groups.size}`) +
      ` real folder(s)  →  ` +
      (dupes ? red(`${dupes} duplicate(s)`) : green('no duplicates')) +
      '\n'
  );
  if (dupes) {
    console.log(dim('  Run with `consolidate --apply` to keep one entry per folder,'));
    console.log(dim('  or `purge --apply` to remove every project entry.\n'));
  }
  return { groups, entries };
}

async function cmdConsolidate(dir, flags) {
  const { groups, entries } = cmdScan(dir);
  if (!entries.length) return;
  const toDelete = [];
  for (const list of groups.values()) {
    for (let i = 1; i < list.length; i++) toDelete.push(list[i]);
  }
  if (!toDelete.length) {
    console.log(green('  Already consolidated — nothing to do.\n'));
    return;
  }

  const apply = flags.apply;
  console.log(
    (apply ? bold('  Will remove ') : bold('  [dry-run] would remove ')) +
      red(`${toDelete.length}`) +
      ` duplicate entr${toDelete.length === 1 ? 'y' : 'ies'}, keeping ` +
      green(`${groups.size}`) +
      `.\n`
  );
  if (!apply) {
    console.log(dim('  Re-run with --apply to perform it.\n'));
    return;
  }

  await guardRunning(flags);
  if (!(await confirm(flags, `  Remove ${toDelete.length} duplicate project files?`))) {
    console.log(dim('  Cancelled.\n'));
    return;
  }
  doDelete(dir, toDelete, flags);
}

async function cmdPurge(dir, flags) {
  const { entries } = readProjects(dir);
  if (!entries.length) {
    console.log(yellow('\n  No project entries to purge.\n'));
    return;
  }
  const apply = flags.apply;
  console.log(
    (apply ? bold('\n  Will remove ') : bold('\n  [dry-run] would remove ')) +
      red(`ALL ${entries.length}`) +
      ` project entr${entries.length === 1 ? 'y' : 'ies'}.\n`
  );
  if (!apply) {
    console.log(dim('  Re-run with --apply to perform it.\n'));
    return;
  }

  await guardRunning(flags);
  if (!(await confirm(flags, `  Permanently remove all ${entries.length} project entries?`))) {
    console.log(dim('  Cancelled.\n'));
    return;
  }
  doDelete(dir, entries, flags);
}

function doDelete(dir, list, flags) {
  if (!flags['no-backup']) {
    const dest = backup(dir);
    console.log(dim(`  Backup: ${dest}`));
  }
  let removed = 0;
  for (const e of list) {
    try {
      fs.rmSync(e.full, { force: true });
      removed++;
    } catch (err) {
      console.log(red(`  Failed to remove ${e.file}: ${err.message}`));
    }
  }
  console.log(green(`  Removed ${removed} file(s).`));
  console.log(dim('  Reopen Antigravity to verify the Projects panel.\n'));
}

function cmdRestore(backupDir, dir, flags) {
  if (!backupDir) {
    console.log(red('\n  Usage: restore <backup-dir>\n'));
    process.exit(1);
  }
  if (!fs.existsSync(backupDir)) {
    console.log(red(`\n  Backup not found: ${backupDir}\n`));
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(backupDir).filter((f) => f.toLowerCase().endsWith('.json'));
  for (const f of files) fs.copyFileSync(path.join(backupDir, f), path.join(dir, f));
  console.log(green(`\n  Restored ${files.length} project file(s) to ${dir}\n`));
}

function help() {
  console.log(`
${bold('antigravity-projects-fix')} ${dim('v' + VERSION)}
Fix the Antigravity 2.0 bug that splits one project into "Name", "Name 2", ...

${bold('USAGE')}
  antigravity-projects-fix <command> [options]

${bold('COMMANDS')}
  scan                 Show projects grouped by folder + duplicate count (default)
  consolidate          Keep one entry per folder, remove the duplicates
  purge                Remove every project entry (clean slate)
  restore <dir>        Copy project files back from a backup folder

${bold('OPTIONS')}
  --apply              Actually perform the change (consolidate/purge are
                       dry-run without this)
  -y, --yes            Skip the confirmation prompt
  --no-backup          Do not create a backup before deleting
  --force              Skip the "is Antigravity running?" safety check
  --dir <path>         Override the projects folder
                       ${dim('(default: ~/.gemini/config/projects)')}
  --no-color           Disable colored output
  -h, --help           Show this help
  -v, --version        Show version

${bold('EXAMPLES')}
  antigravity-projects-fix scan
  antigravity-projects-fix consolidate            ${dim('# preview')}
  antigravity-projects-fix consolidate --apply    ${dim('# do it (with backup)')}
  antigravity-projects-fix purge --apply --yes
  antigravity-projects-fix restore ~/.gemini/config/projects.backup-...

${dim('Close Antigravity before applying changes. Not affiliated with Google LLC.')}
`);
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const flags = args.flags;
  if (flags.h || flags.help) return help();
  if (flags.v || flags.version) return console.log(VERSION);

  const dir = flags.dir && typeof flags.dir === 'string' ? flags.dir : defaultProjectsDir();
  const cmd = args._[0] || 'scan';

  switch (cmd) {
    case 'scan':
      cmdScan(dir);
      break;
    case 'consolidate':
      await cmdConsolidate(dir, flags);
      break;
    case 'purge':
      await cmdPurge(dir, flags);
      break;
    case 'restore':
      cmdRestore(args._[1], dir, flags);
      break;
    default:
      console.log(red(`\n  Unknown command: ${cmd}`));
      help();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(red('Error: ' + (e && e.stack ? e.stack : e)));
  process.exit(1);
});
