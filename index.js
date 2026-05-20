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

const VERSION = '1.4.0';

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

/**
 * Candidate locations where Antigravity may keep its project registry.
 * The install path is NOT the same on every machine: it varies by OS, by
 * Antigravity version, by env overrides, and by Electron's user-data dir.
 * We list every plausible spot, most-likely first, and let the caller pick
 * the one that actually contains project JSON files.
 */
function candidateProjectsDirs() {
  const home = os.homedir();
  const dirs = [];
  const add = (...p) => {
    const full = path.join(...p);
    if (!dirs.includes(full)) dirs.push(full);
  };

  // 1. Explicit override wins.
  if (process.env.GEMINI_HOME) add(process.env.GEMINI_HOME, 'config', 'projects');

  // 2. The known default (current Antigravity 2.x on Windows/macOS/Linux).
  add(home, '.gemini', 'config', 'projects');

  // 3. XDG config dir (some Linux setups).
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) add(xdg, 'gemini', 'config', 'projects');
  add(home, '.config', 'gemini', 'config', 'projects');

  // 4. Electron user-data dirs, in case a future build moves the registry there.
  if (process.platform === 'win32') {
    if (process.env.APPDATA) add(process.env.APPDATA, 'Antigravity', 'config', 'projects');
    if (process.env.LOCALAPPDATA) add(process.env.LOCALAPPDATA, 'Antigravity', 'config', 'projects');
  } else if (process.platform === 'darwin') {
    add(home, 'Library', 'Application Support', 'Antigravity', 'config', 'projects');
  }

  return dirs;
}

/** Does this directory hold at least one project JSON with a folderUri? */
function looksLikeProjectsDir(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (_) {
    return false;
  }
  if (!files.length) return false;
  // Peek at up to a few files; a real registry file contains "folderUri".
  for (const f of files.slice(0, 5)) {
    try {
      if (fs.readFileSync(path.join(dir, f), 'utf8').includes('folderUri')) return true;
    } catch (_) {
      /* skip unreadable file */
    }
  }
  return false;
}

/**
 * Pick the projects dir to operate on: the first candidate that actually
 * contains project files. Falls back to the canonical default so error
 * messages still point somewhere sensible.
 * @returns {{ dir: string, found: boolean, checked: string[] }}
 */
function resolveProjectsDir() {
  const candidates = candidateProjectsDirs();
  for (const dir of candidates) {
    if (looksLikeProjectsDir(dir)) return { dir, found: true, checked: candidates };
  }
  // Nothing matched. If one merely exists (even if empty), prefer it; else default.
  const existing = candidates.find((d) => {
    try { return fs.statSync(d).isDirectory(); } catch (_) { return false; }
  });
  return { dir: existing || candidates[0], found: false, checked: candidates };
}

function defaultProjectsDir() {
  return resolveProjectsDir().dir;
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function backupError(e) {
  const err = new Error(
    `Backup failed: ${e.message}\n` +
    `  The backup was not created — aborting to protect your data.\n` +
    `  Fix the issue above, or re-run with --no-backup if you're sure.`
  );
  err.expected = true;
  return err;
}

function backup(dir) {
  const dest = `${dir.replace(/[/\\]+$/, '')}.backup-${timestamp()}`;
  try {
    fs.cpSync(dir, dest, { recursive: true });
  } catch (e) {
    // Surface as a clear, user-facing error (no stack trace) with a recovery
    // hint instead of a raw exception.
    throw backupError(e);
  }
  return dest;
}

/** Back up only the named files from `dir` into a timestamped sibling folder. */
function backupFiles(dir, fileNames, label) {
  const dest = `${dir.replace(/[/\\]+$/, '')}.${label}-backup-${timestamp()}`;
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fileNames) fs.copyFileSync(path.join(dir, f), path.join(dest, f));
  } catch (e) {
    throw backupError(e);
  }
  return dest;
}

/**
 * Replace every ASCII occurrence of `from` with `to` inside a Buffer, in place.
 * Only valid when both are the same byte length — UUID→UUID is always 36 chars —
 * which keeps the file byte-length identical so the SQLite/protobuf layout
 * stays intact. Returns the number of replacements made.
 */
function replaceAsciiInBuffer(buf, from, to) {
  const f = Buffer.from(from, 'ascii');
  const t = Buffer.from(to, 'ascii');
  if (f.length !== t.length) throw new Error('refusing non-length-preserving replace');
  let count = 0;
  let pos = 0;
  for (;;) {
    const i = buf.indexOf(f, pos);
    if (i === -1) break;
    t.copy(buf, i);
    count++;
    pos = i + f.length;
  }
  return count;
}

/** Count ASCII occurrences of `needle` in a Buffer without modifying it. */
function countAsciiInBuffer(buf, needle) {
  const n = Buffer.from(needle, 'ascii');
  let count = 0;
  let pos = 0;
  for (;;) {
    const i = buf.indexOf(n, pos);
    if (i === -1) break;
    count++;
    pos = i + n.length;
  }
  return count;
}

/**
 * Locate the conversations folder. Chats live next to the project registry:
 *   <base>/.gemini/config/projects   ←  projectsDir
 *   <base>/.gemini/antigravity/conversations
 * Honors an explicit --conversations override.
 */
function resolveConversationsDir(projectsDir, flags) {
  if (flags.conversations && typeof flags.conversations === 'string') return flags.conversations;
  const geminiDir = path.dirname(path.dirname(projectsDir)); // .../.gemini
  return path.join(geminiDir, 'antigravity', 'conversations');
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

// Merge: re-point chats from duplicate projects onto one keeper per folder,
// THEN remove the duplicate project entries. No chat is deleted — only the
// project UUID embedded inside each chat database is rewritten to the keeper.
async function cmdMerge(dir, flags) {
  const { groups, entries } = cmdScan(dir);
  if (!entries.length) return;

  // dupId -> keeperId, for every non-keeper entry in each folder group.
  const remap = new Map();
  let dupCount = 0;
  for (const list of groups.values()) {
    const keeper = list[0];
    for (let i = 1; i < list.length; i++) {
      if (list[i].id && keeper.id && list[i].id !== keeper.id) {
        remap.set(list[i].id, keeper.id);
        dupCount++;
      }
    }
  }
  if (!remap.size) {
    console.log(green('  Nothing to merge — no duplicate projects.\n'));
    return;
  }

  // Find the conversations folder and the chat databases inside it.
  const convDir = resolveConversationsDir(dir, flags);
  let convFiles;
  try {
    convFiles = fs.readdirSync(convDir).filter((f) => /\.(db|db-wal)$/i.test(f));
  } catch (_) {
    console.log(yellow(`\n  Conversations folder not found at:\n  ${convDir}`));
    console.log(
      dim('  Can\'t re-point chats. Use `consolidate` to just remove duplicates,\n') +
      dim('  or pass the right path with --conversations <path>.\n')
    );
    return;
  }

  // Plan: which files reference a duplicate UUID, and how many times.
  const plan = [];
  for (const f of convFiles) {
    const full = path.join(convDir, f);
    let buf;
    try { buf = fs.readFileSync(full); } catch (_) { continue; }
    const edits = [];
    for (const [dupId, keepId] of remap) {
      const c = countAsciiInBuffer(buf, dupId);
      if (c) edits.push({ from: dupId, to: keepId, count: c });
    }
    if (edits.length) plan.push({ file: f, full, edits, size: buf.length });
  }

  const chatsAffected = new Set(plan.map((p) => p.file.replace(/\.(db|db-wal)$/i, ''))).size;
  const totalRefs = plan.reduce((s, p) => s + p.edits.reduce((a, e) => a + e.count, 0), 0);

  const apply = flags.apply;
  console.log(
    (apply ? bold('\n  Will re-point ') : bold('\n  [dry-run] would re-point ')) +
      cyan(`${chatsAffected} chat(s)`) +
      ` (${totalRefs} reference${totalRefs === 1 ? '' : 's'}) to their keeper project, then remove ` +
      red(`${dupCount}`) +
      ` duplicate entr${dupCount === 1 ? 'y' : 'ies'}.\n`
  );
  if (!plan.length) {
    console.log(
      dim('  No chats reference the duplicate projects — `consolidate` would be enough here.\n')
    );
  }
  console.log(dim('  Chats are never deleted — only their "belongs to project" pointer changes.'));
  if (!apply) {
    console.log(dim('  Re-run with --apply to perform it.\n'));
    return;
  }

  await guardRunning(flags);
  if (
    !(await confirm(
      flags,
      `\n  Re-point ${chatsAffected} chat(s) and remove ${dupCount} duplicate project(s)?`
    ))
  ) {
    console.log(dim('  Cancelled.\n'));
    return;
  }

  // Back up the project registry AND every chat file we're about to touch.
  if (!flags['no-backup']) {
    const pdest = backup(dir);
    console.log(dim(`  Backup (projects): ${pdest}`));
    if (plan.length) {
      const cdest = backupFiles(convDir, plan.map((p) => p.file), 'merge');
      console.log(dim(`  Backup (chats):    ${cdest}`));
    }
  }

  // Rewrite the embedded UUIDs — length-preserving, with a size assertion.
  let edited = 0;
  const failed = [];
  for (const p of plan) {
    try {
      const buf = fs.readFileSync(p.full);
      const before = buf.length;
      for (const e of p.edits) replaceAsciiInBuffer(buf, e.from, e.to);
      if (buf.length !== before) throw new Error(`size changed in memory (${before} → ${buf.length})`);
      fs.writeFileSync(p.full, buf);
      if (fs.statSync(p.full).size !== before) throw new Error('written size mismatch');
      edited++;
    } catch (err) {
      failed.push({ file: p.file, reason: err.message });
    }
  }
  if (failed.length) {
    console.log(yellow(`\n  Warning: ${failed.length} chat file(s) could not be re-pointed:`));
    for (const f of failed) console.log(dim(`    ${f.file} — ${f.reason}`));
    console.log(dim('  Restore from the chat backup above if the result looks wrong.'));
  }
  console.log(green(`  Re-pointed ${edited} file(s).`));

  // Now remove the duplicate project entries (backup already taken above).
  const toDelete = [];
  for (const list of groups.values()) {
    for (let i = 1; i < list.length; i++) toDelete.push(list[i]);
  }
  let removed = 0;
  for (const e of toDelete) {
    try { fs.rmSync(e.full, { force: true }); removed++; } catch (_) { /* reported below */ }
  }
  console.log(green(`  Removed ${removed} duplicate project entr${removed === 1 ? 'y' : 'ies'}.`));
  console.log(dim('  Reopen Antigravity — your chats should now sit under one project.\n'));
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
  // Route each backed-up file to the right place by type: project registry
  // files (.json) go to the projects folder; chat databases (.db / .db-wal /
  // .db-shm) go to the conversations folder. This handles both the plain
  // `*.backup-*` (projects) and the `conversations.merge-backup-*` (chats).
  const convDir = resolveConversationsDir(dir, flags);
  const files = fs.readdirSync(backupDir);
  let proj = 0;
  let chat = 0;
  for (const f of files) {
    const src = path.join(backupDir, f);
    if (!fs.statSync(src).isFile()) continue;
    const lower = f.toLowerCase();
    let target = null;
    if (lower.endsWith('.json')) target = dir;
    else if (/\.(db|db-wal|db-shm)$/.test(lower)) target = convDir;
    if (!target) continue;
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(src, path.join(target, f));
    if (target === dir) proj++; else chat++;
  }
  const parts = [];
  if (proj) parts.push(`${proj} project file(s) → ${dir}`);
  if (chat) parts.push(`${chat} chat file(s) → ${convDir}`);
  if (!parts.length) {
    console.log(yellow(`\n  Nothing recognizable to restore in ${backupDir}\n`));
    return;
  }
  console.log(green('\n  Restored ' + parts.join('\n           ') + '\n'));
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
  merge                Re-point chats onto one keeper, then remove duplicates
                       ${dim('(no chat is deleted — experimental)')}
  purge                Remove every project entry (clean slate)
  restore <dir>        Copy project files back from a backup folder

${bold('INTERACTIVE KEYS')}
  ↑/↓ move   space toggle   a all   n none   d duplicates   enter apply   q quit

${bold('OPTIONS')}
  --apply              Actually perform the change (consolidate/merge/purge are
                       dry-run without this)
  -y, --yes            Skip the confirmation prompt
  --no-backup          Do not create a backup before deleting
  --force              Skip the "is Antigravity running?" safety check
  --dir <path>         Override the projects folder
                       ${dim('(default: ~/.gemini/config/projects)')}
  --conversations <path>  Override the chats folder for ${cyan('merge')}
                       ${dim('(default: ~/.gemini/antigravity/conversations)')}
  --no-color           Disable colored output
  -h, --help           Show this help
  -v, --version        Show version

${bold('EXAMPLES')}
  antigravity-projects-fix scan
  antigravity-projects-fix consolidate            ${dim('# preview')}
  antigravity-projects-fix consolidate --apply    ${dim('# do it (with backup)')}
  antigravity-projects-fix merge                  ${dim('# preview chat re-pointing')}
  antigravity-projects-fix merge --apply          ${dim('# keep chats, group under one')}
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

  let dir;
  if (rawDir && typeof rawDir === 'string') {
    dir = rawDir; // user override — trust it (already validated above)
  } else {
    const resolved = resolveProjectsDir();
    dir = resolved.dir;
    if (resolved.found) {
      // Only announce auto-detection if it landed somewhere other than the
      // canonical default, so the common case stays quiet.
      const canonical = path.join(os.homedir(), '.gemini', 'config', 'projects');
      if (path.resolve(dir) !== path.resolve(canonical)) {
        console.log(dim(`  Using detected projects folder: ${dir}`));
      }
    } else {
      // Couldn't find a populated registry anywhere. Show every place we
      // looked so the user can point --dir at the right one.
      console.log(yellow('\n  Could not auto-detect an Antigravity projects folder.'));
      console.log(dim('  Looked in:'));
      for (const c of resolved.checked) console.log(dim(`    ${c}`));
      console.log(
        dim('\n  If your install lives elsewhere, pass it explicitly:\n') +
        dim('    node index.js scan --dir "/path/to/.gemini/config/projects"\n')
      );
      // Fall through with the best-guess dir; the command will report "missing"
      // cleanly if it really isn't there.
    }
  }
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
    case 'merge':
      await cmdMerge(dir, flags);
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
  // Expected errors (e.g. backup failure) show only the friendly message.
  // Unexpected errors show the stack so issues can be reported.
  if (e && e.expected) {
    console.error('\n  ' + red(e.message) + '\n');
  } else {
    console.error(red('\n  Unexpected error: ' + (e && e.stack ? e.stack : e)));
    console.error(dim('  Please report this at the project Issues page.\n'));
  }
  process.exit(1);
});
