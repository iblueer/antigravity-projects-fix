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

// ---------------------------------------------------------------- node version guard
// fs.cpSync was added in Node 16.7.0. Fail fast with a clear message.
const [nodeMaj, nodeMin] = process.versions.node.split('.').map(Number);
if (nodeMaj < 16 || (nodeMaj === 16 && nodeMin < 7)) {
  process.stderr.write(
    `\n  This tool requires Node.js >= 16.7. You have ${process.version}.\n` +
    `  Please upgrade: https://nodejs.org\n\n`
  );
  process.exit(1);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const VERSION = '1.2.0';

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
    return { error: e.code === 'ENOENT' ? 'missing' : e.message, entries: [], broken: [] };
  }
  const entries = [];
  const broken = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      broken.push({ file, reason: `read error: ${e.message}` });
      continue;
    }
    try {
      const json = JSON.parse(raw);
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
      broken.push({ file, reason: `invalid JSON: ${e.message}` });
    }
  }
  return { entries, broken };
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
  try {
    fs.cpSync(dir, dest, { recursive: true });
  } catch (e) {
    // Surface as a clear error with recovery hint instead of a raw exception.
    throw new Error(
      `Backup failed: ${e.message}\n` +
      `  The backup was not created — aborting to protect your data.\n` +
      `  Fix the issue above, or re-run with --no-backup if you're sure.`
    );
  }
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
  const { error, entries, broken } = readProjects(dir);
  if (error === 'missing') {
    console.log(yellow(`\n  No projects folder found at:\n  ${dir}`));
    console.log(dim('  Nothing to scan. (Is Antigravity installed for this user?)\n'));
    return { groups: new Map(), entries: [] };
  }
  if (error) {
    console.log(red(`\n  Could not read ${dir}: ${error}\n`));
    process.exit(1);
  }

  if (broken && broken.length) {
    console.log(yellow(`\n  Warning: ${broken.length} file(s) could not be parsed and will be skipped:`));
    for (const b of broken) console.log(dim(`    ${b.file} — ${b.reason}`));
    console.log('');
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
  const { entries, broken } = readProjects(dir);
  if (broken && broken.length) {
    console.log(yellow(`\n  Warning: ${broken.length} file(s) could not be parsed and will be skipped:`));
    for (const b of broken) console.log(dim(`    ${b.file} — ${b.reason}`));
    console.log('');
  }
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
    // backup() throws with a clear message on failure — let it propagate so we
    // never start deleting without a safety net.
    const dest = backup(dir);
    console.log(dim(`  Backup: ${dest}`));
  }
  let removed = 0;
  const failed = [];
  for (const e of list) {
    try {
      fs.rmSync(e.full, { force: true });
      removed++;
    } catch (err) {
      failed.push({ file: e.file, reason: err.message });
    }
  }
  if (failed.length) {
    console.log(yellow(`\n  Warning: ${failed.length} file(s) could not be removed:`));
    for (const f of failed) console.log(dim(`    ${f.file} — ${f.reason}`));
    console.log(dim('  These files were NOT deleted. Use restore if the result looks wrong.'));
  }
  console.log(green(`\n  Removed ${removed} file(s).`) + (failed.length ? yellow(` (${failed.length} failed)`) : ''));
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

function shortFolder(key) {
  if (key.startsWith('(')) return key;
  return key.replace(/\/+$/, '').split('/').pop() || key;
}

// Interactive checkbox picker: choose exactly which entries to delete.
async function cmdInteractive(dir, flags) {
  const { error, entries, broken } = readProjects(dir);
  if (error === 'missing') {
    console.log(yellow(`\n  No projects folder found at:\n  ${dir}\n`));
    return;
  }
  if (error) {
    console.log(red(`\n  Could not read ${dir}: ${error}\n`));
    process.exit(1);
  }
  if (broken && broken.length) {
    console.log(yellow(`\n  Warning: ${broken.length} file(s) could not be parsed and will be skipped:`));
    for (const b of broken) console.log(dim(`    ${b.file} — ${b.reason}`));
    console.log('');
  }
  if (!entries.length) {
    console.log(green('\n  No project entries — nothing to do.\n'));
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(red('\n  Interactive mode needs a real terminal (TTY).'));
    console.log(dim('  Run it directly in your terminal, or use `consolidate` / `purge`.\n'));
    process.exit(1);
  }

  // Order by biggest groups first; keeper first within each group.
  const groups = [...groupByFolder(entries).values()].sort((a, b) => b.length - a.length);
  const ordered = [];
  const firstOfGroup = new Set();
  for (const list of groups) {
    list.forEach((e, idx) => {
      if (idx === 0) firstOfGroup.add(ordered.length);
      ordered.push(e);
    });
  }

  // Default: pre-select every duplicate (everything except one keeper per folder).
  const selected = new Set();
  ordered.forEach((_, i) => {
    if (!firstOfGroup.has(i)) selected.add(i);
  });

  let cursor = 0;
  let top = 0;
  let prev = 0;
  const pageSize = Math.max(5, (process.stdout.rows || 24) - 7);
  const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

  const draw = () => {
    if (cursor < top) top = cursor;
    else if (cursor >= top + pageSize) top = cursor - pageSize + 1;
    const end = Math.min(top + pageSize, ordered.length);
    const out = [];
    out.push(bold('  Select entries to DELETE'));
    out.push(dim('  ↑/↓ move · space toggle · a all · n none · d duplicates · enter apply · q quit'));
    out.push(dim(top > 0 ? `      ↑ ${top} more` : ' '));
    for (let i = top; i < end; i++) {
      const e = ordered[i];
      const box = selected.has(i) ? red('[x]') : '[ ]';
      const ptr = i === cursor ? cyan('❯') : ' ';
      const nm = pad(e.name, 22);
      const name = i === cursor ? bold(nm) : nm;
      const tag = firstOfGroup.has(i) ? green('keep?') : dim('dup  ');
      out.push(` ${ptr} ${box} ${name} ${tag} ${dim(shortFolder(e.key))}  ${dim(e.id.slice(0, 8))}`);
    }
    out.push(dim(end < ordered.length ? `      ↓ ${ordered.length - end} more` : ' '));
    const sel = selected.size;
    out.push(
      '  ' +
        (sel ? red(`${sel} to delete`) : green('0 to delete')) +
        dim(`  ·  keeping ${ordered.length - sel}`)
    );
    if (prev) process.stdout.write(`\x1b[${prev}A`);
    process.stdout.write('\x1b[0J' + out.join('\n') + '\n');
    prev = out.length;
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  draw();

  await new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (process.stdin.unref) process.stdin.unref();
    };

    const finish = async () => {
      const toDelete = [...selected].sort((a, b) => a - b).map((i) => ordered[i]);
      console.log('');
      if (!toDelete.length) {
        console.log(yellow('  Nothing selected — nothing to do.\n'));
        return;
      }
      console.log(bold(`  Review: ${red(toDelete.length + ' to delete')}, keeping ${ordered.length - toDelete.length}`));
      for (const e of toDelete.slice(0, 12)) {
        console.log('   ' + red('✕ ') + e.name + dim('  ' + shortFolder(e.key)));
      }
      if (toDelete.length > 12) console.log(dim(`   … and ${toDelete.length - 12} more`));

      // Warn if any folder would be left with zero entries.
      const delByKey = {};
      const sizeByKey = {};
      ordered.forEach((e) => (sizeByKey[e.key] = (sizeByKey[e.key] || 0) + 1));
      toDelete.forEach((e) => (delByKey[e.key] = (delByKey[e.key] || 0) + 1));
      const gone = Object.keys(delByKey).filter((k) => delByKey[k] === sizeByKey[k]);
      if (gone.length) {
        console.log(
          yellow(`  ⚠ ${gone.length} folder(s) will have NO entry left: ${gone.map(shortFolder).join(', ')}`)
        );
      }
      console.log('');

      await guardRunning(flags);
      if (!(await confirm(flags, `  Delete ${toDelete.length} selected entr${toDelete.length === 1 ? 'y' : 'ies'}?`))) {
        console.log(dim('  Cancelled.\n'));
        return;
      }
      doDelete(dir, toDelete, flags);
    };

    const onKey = async (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log(dim('\n  Cancelled.\n'));
        process.exit(130);
      }
      let act = true;
      switch (key.name) {
        case 'up': case 'k': cursor = (cursor - 1 + ordered.length) % ordered.length; break;
        case 'down': case 'j': cursor = (cursor + 1) % ordered.length; break;
        case 'pageup': cursor = Math.max(0, cursor - pageSize); break;
        case 'pagedown': cursor = Math.min(ordered.length - 1, cursor + pageSize); break;
        case 'home': cursor = 0; break;
        case 'end': cursor = ordered.length - 1; break;
        case 'space': selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor); break;
        case 'a': ordered.forEach((_, i) => selected.add(i)); break;
        case 'n': selected.clear(); break;
        case 'd':
          selected.clear();
          ordered.forEach((_, i) => { if (!firstOfGroup.has(i)) selected.add(i); });
          break;
        case 'q': case 'escape':
          cleanup();
          console.log(dim('\n  Cancelled — nothing changed.\n'));
          resolve();
          return;
        case 'return':
          cleanup();
          await finish();
          resolve();
          return;
        default: act = false;
      }
      if (act) draw();
    };

    process.stdin.on('keypress', onKey);
  });
}

function help() {
  console.log(`
${bold('antigravity-projects-fix')} ${dim('v' + VERSION)}
Fix the Antigravity 2.0 bug that splits one project into "Name", "Name 2", ...

${bold('USAGE')}
  antigravity-projects-fix <command> [options]

${bold('COMMANDS')}
  scan                 Show projects grouped by folder + duplicate count (default)
  interactive, i       Checkbox UI — pick exactly which entries to delete
  consolidate          Keep one entry per folder, remove the duplicates
  purge                Remove every project entry (clean slate)
  restore <dir>        Copy project files back from a backup folder

${bold('INTERACTIVE KEYS')}
  ↑/↓ move   space toggle   a all   n none   d duplicates   enter apply   q quit

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

// Safety net: if the process dies while raw mode is active (e.g. kill signal,
// uncaught error), restore the terminal so the shell isn't left broken.
process.on('exit', () => {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch (_) {
    // Best-effort; stdin may already be destroyed.
  }
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const flags = args.flags;
  if (flags.h || flags.help) return help();
  if (flags.v || flags.version) return console.log(VERSION);

  // Validate --dir early: must exist and be a directory, not a file or typo.
  const rawDir = flags.dir;
  if (rawDir !== undefined) {
    if (typeof rawDir !== 'string' || !rawDir.trim()) {
      console.log(red('\n  --dir requires a path argument. Example: --dir ~/.gemini/config/projects\n'));
      process.exit(1);
    }
    let stat;
    try { stat = fs.statSync(rawDir); } catch (_) { /* will be caught per-command */ }
    if (stat && !stat.isDirectory()) {
      console.log(red(`\n  --dir path is not a directory: ${rawDir}\n`));
      process.exit(1);
    }
  }

  const dir = rawDir && typeof rawDir === 'string' ? rawDir : defaultProjectsDir();
  const cmd = args._[0] || 'scan';

  switch (cmd) {
    case 'scan':
      cmdScan(dir);
      break;
    case 'interactive':
    case 'i':
      await cmdInteractive(dir, flags);
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
