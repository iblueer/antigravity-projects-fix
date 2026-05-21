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
const { execSync, execFileSync } = require('child_process');

const VERSION = '1.7.0';

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
    // Match by process NAME (not full command line) so this tool's own path —
    // which contains "antigravity" — never counts as a false positive.
    const sh = (cmd) => {
      try {
        return execSync(cmd, { encoding: 'utf8', shell: '/bin/sh', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (_) {
        return '';
      }
    };
    const pg = sh('pgrep -i antigravity 2>/dev/null || true');
    if (pg.trim()) return true;
    // Fallback when pgrep is missing: match the command name column only.
    const ps = sh('ps -A -o comm= 2>/dev/null | grep -i antigravity | grep -iv grep || true');
    if (ps.trim()) return true;
    // If neither tool produced usable output, we genuinely can't tell.
    return pg === '' && ps === '' ? null : false;
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

function backupSingleFile(filePath, label) {
  return backupFiles(path.dirname(filePath), [path.basename(filePath)], label);
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

/** Write a Buffer to `dest` atomically: write a temp sibling, then rename over. */
function writeFileAtomic(dest, buf) {
  const tmp = dest + '.agfix-tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/** Read a protobuf varint as a safe JavaScript number. */
function readProtoVarintNumber(buf, offset, limit = buf.length) {
  let value = 0n;
  let shift = 0n;
  const start = offset;
  while (offset < limit && offset - start < 10) {
    const byte = buf[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return { value: Number(value), offset };
    }
    shift += 7n;
  }
  return null;
}

function skipProtoVarint(buf, offset, limit = buf.length) {
  const start = offset;
  while (offset < limit && offset - start < 10) {
    if ((buf[offset++] & 0x80) === 0) return offset;
  }
  return null;
}

function skipProtoGroup(buf, offset, limit, startField) {
  const parts = [];
  while (offset < limit) {
    const tag = readProtoVarintNumber(buf, offset, limit);
    if (!tag || tag.value === 0) return null;
    offset = tag.offset;
    const wire = tag.value & 7;
    const field = Math.floor(tag.value / 8);
    if (!field) return null;
    if (wire === 4) {
      if (field !== startField) return null;
      return { offset, sig: `group:${parts.join(',')}` };
    }
    const skipped = skipProtoValue(buf, offset, limit, wire, field);
    if (!skipped) return null;
    offset = skipped.offset;
    parts.push(`${field}:${wire}:${skipped.sig}`);
  }
  return null;
}

function skipProtoValue(buf, offset, limit, wire, field) {
  if (wire === 0) {
    const next = skipProtoVarint(buf, offset, limit);
    return next === null ? null : { offset: next, sig: 'v' };
  }
  if (wire === 1) {
    if (offset + 8 > limit) return null;
    return { offset: offset + 8, sig: 'fixed64' };
  }
  if (wire === 2) {
    const len = readProtoVarintNumber(buf, offset, limit);
    if (!len) return null;
    const next = len.offset + len.value;
    if (next > limit) return null;
    return { offset: next, sig: String(len.value) };
  }
  if (wire === 3) return skipProtoGroup(buf, offset, limit, field);
  if (wire === 5) {
    if (offset + 4 > limit) return null;
    return { offset: offset + 4, sig: 'fixed32' };
  }
  return null;
}

function parseProtoFieldStream(buf, start = 0, end = buf.length) {
  let offset = start;
  const parts = [];
  const wireCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 5: 0 };
  while (offset < end) {
    const tag = readProtoVarintNumber(buf, offset, end);
    if (!tag || tag.value === 0) return null;
    offset = tag.offset;
    const wire = tag.value & 7;
    const field = Math.floor(tag.value / 8);
    if (!field || wire === 4 || wireCounts[wire] === undefined) return null;
    const skipped = skipProtoValue(buf, offset, end, wire, field);
    if (!skipped) return null;
    offset = skipped.offset;
    wireCounts[wire]++;
    parts.push(`${field}:${wire}:${skipped.sig}`);
  }
  return { fields: parts.length, wireCounts, fingerprint: parts.join('|') };
}

function parseDelimitedProtoStream(buf) {
  let offset = 0;
  const parts = [];
  while (offset < buf.length) {
    const len = readProtoVarintNumber(buf, offset);
    if (!len) return null;
    offset = len.offset;
    const end = offset + len.value;
    if (end > buf.length) return null;
    const inner = len.value === 0 ? { fields: 0, fingerprint: '' } : parseProtoFieldStream(buf, offset, end);
    if (!inner) return null;
    parts.push(`${len.value}:${inner.fields}:${inner.fingerprint}`);
    offset = end;
  }
  return parts.length ? { records: parts.length, fingerprint: parts.join('|') } : null;
}

/**
 * Best-effort protobuf wire-structure fingerprint. It never looks at string
 * contents; it only records field numbers, wire types, and length-delimited
 * sizes. A UUID->UUID rewrite should leave this unchanged.
 */
function protobufStructureFingerprint(buf) {
  const delimited = parseDelimitedProtoStream(buf);
  if (delimited && delimited.records > 1) {
    return {
      kind: 'length-delimited protobuf stream',
      count: delimited.records,
      fingerprint: 'delimited|' + delimited.fingerprint,
    };
  }
  const message = parseProtoFieldStream(buf);
  if (message && message.fields) {
    return {
      kind: 'protobuf message',
      count: message.fields,
      fingerprint: 'message|' + message.fingerprint,
    };
  }
  if (delimited) {
    return {
      kind: 'length-delimited protobuf stream',
      count: delimited.records,
      fingerprint: 'delimited|' + delimited.fingerprint,
    };
  }
  return null;
}

function describeProtoStructure(structure) {
  if (!structure) return 'unrecognized protobuf structure';
  if (structure.kind.includes('stream')) return `${structure.count} protobuf record(s)`;
  return `${structure.count} protobuf field(s)`;
}

function parseProtoFieldsWithData(buf, start = 0, end = buf.length) {
  let offset = start;
  const fields = [];
  while (offset < end) {
    const tag = readProtoVarintNumber(buf, offset, end);
    if (!tag || tag.value === 0) return null;
    offset = tag.offset;
    const wire = tag.value & 7;
    const field = Math.floor(tag.value / 8);
    if (!field || wire === 4) return null;
    let dataStart = offset;
    let dataEnd = offset;
    if (wire === 0) {
      const next = skipProtoVarint(buf, offset, end);
      if (next === null) return null;
      dataEnd = next;
      offset = next;
    } else if (wire === 1) {
      dataEnd = offset + 8;
      if (dataEnd > end) return null;
      offset = dataEnd;
    } else if (wire === 2) {
      const len = readProtoVarintNumber(buf, offset, end);
      if (!len) return null;
      dataStart = len.offset;
      dataEnd = dataStart + len.value;
      if (dataEnd > end) return null;
      offset = dataEnd;
    } else if (wire === 3) {
      const group = skipProtoGroup(buf, offset, end, field);
      if (!group) return null;
      dataEnd = group.offset;
      offset = group.offset;
    } else if (wire === 5) {
      dataEnd = offset + 4;
      if (dataEnd > end) return null;
      offset = dataEnd;
    } else {
      return null;
    }
    fields.push({ field, wire, data: buf.subarray(dataStart, dataEnd) });
  }
  return fields;
}

function isTextUuid(s) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}

function incMap(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function summarizeProtoUuidPaths(buf, projectIds, maxDepth = 6) {
  const projectSet = new Set(projectIds.map((id) => String(id).toLowerCase()));
  const uuidPaths = new Map();
  const projectPaths = new Map();
  const walk = (chunk, prefix, depth) => {
    if (depth > maxDepth || !chunk.length) return;
    const fields = parseProtoFieldsWithData(chunk);
    if (!fields) return;
    for (const f of fields) {
      const p = prefix ? `${prefix}.${f.field}/${f.wire}` : `${f.field}/${f.wire}`;
      if (f.wire !== 2) continue;
      const s = f.data.toString('ascii');
      if (isTextUuid(s)) {
        incMap(uuidPaths, p);
        if (projectSet.has(s.toLowerCase())) incMap(projectPaths, p);
      }
      walk(f.data, p, depth + 1);
    }
  };
  walk(buf, '', 0);
  return { uuidPaths, projectPaths };
}

function quoteSqliteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function sqliteProjectUuidLocations(dbFiles, projectIds) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { return null; }
  const locations = new Map();
  const needles = projectIds.map((id) => Buffer.from(id, 'ascii'));
  for (const dbPath of dbFiles) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();
      for (const t of tables) {
        const table = t.name;
        const cols = db.prepare(`PRAGMA table_info(${quoteSqliteIdent(table)})`).all();
        for (const col of cols) {
          const type = String(col.type || '').toLowerCase();
          if (type && !/(text|blob|char|clob|varchar)/.test(type)) continue;
          const tableSql = quoteSqliteIdent(table);
          const colSql = quoteSqliteIdent(col.name);
          const stmt = db.prepare(`SELECT COUNT(*) AS c FROM ${tableSql} WHERE instr(${colSql}, ?) > 0`);
          let rowsInDb = 0;
          for (const needle of needles) {
            const row = stmt.get(needle);
            rowsInDb += Number((row && row.c) || 0);
          }
          if (rowsInDb) {
            const key = `${table}.${col.name}`;
            const cur = locations.get(key) || { dbs: 0, rows: 0 };
            cur.dbs++;
            cur.rows += rowsInDb;
            locations.set(key, cur);
          }
        }
      }
    } catch (_) {
      /* skip unreadable/locked db */
    } finally {
      try { if (db) db.close(); } catch (_) { /* ignore */ }
    }
  }
  return locations;
}

/** Locate a `sqlite3` CLI on PATH, or null. Best-effort, cross-platform. */
function findSqlite3Binary() {
  const probe = process.platform === 'win32' ? 'where sqlite3' : 'command -v sqlite3 2>/dev/null';
  try {
    const out = execSync(probe, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const first = out.split(/\r?\n/)[0].trim();
    return first && fs.existsSync(first) ? first : (first || null);
  } catch (_) {
    return null;
  }
}

/**
 * A SQLite "checkpointer" — the only safe way to fold a persistent WAL into the
 * main .db before we byte-edit it. Antigravity keeps large persistent WAL files
 * (verified: multi-MB, tens of thousands of frames), and a WAL's frames are
 * checksummed, so raw-editing the .db-wal would corrupt the chat database.
 *
 * Prefers Node's built-in `node:sqlite` (Node >= 22, no install). Falls back to
 * a `sqlite3` CLI if present. Returns null when neither is available — callers
 * must then REFUSE to edit rather than risk corruption.
 */
function getCheckpointer() {
  // 1. Built-in node:sqlite (Node >= 22; may require the runtime to expose it).
  try {
    const { DatabaseSync } = require('node:sqlite');
    // smoke-test that it actually constructs (some builds need a flag)
    return {
      kind: 'node:sqlite',
      checkpoint(dbPath) {
        const db = new DatabaseSync(dbPath);
        try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); }
        finally { db.close(); }
      },
      integrity(dbPath) {
        const db = new DatabaseSync(dbPath);
        try {
          const r = db.prepare('PRAGMA integrity_check').get();
          return (r && (r.integrity_check || r['integrity_check'])) || 'unknown';
        } finally { db.close(); }
      },
    };
  } catch (_) { /* fall through */ }

  // 2. sqlite3 CLI.
  const bin = findSqlite3Binary();
  if (bin) {
    return {
      kind: 'sqlite3',
      checkpoint(dbPath) {
        execFileSync(bin, [dbPath, 'PRAGMA wal_checkpoint(TRUNCATE);'], { stdio: ['ignore', 'ignore', 'pipe'] });
      },
      integrity(dbPath) {
        return execFileSync(bin, [dbPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
      },
    };
  }
  return null;
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

/** The .gemini base dir, derived from the projects dir. */
function geminiBaseDir(projectsDir) {
  return path.dirname(path.dirname(projectsDir)); // .../.gemini
}

function resolveAgyhubSummariesFile(projectsDir, flags) {
  const override = flags['agyhub-summaries'] || flags.agyhub;
  if (override && typeof override === 'string') return override;
  return path.join(geminiBaseDir(projectsDir), 'antigravity', 'agyhub_summaries_proto.pb');
}

function planAgyhubSummariesUpdate(filePath, remap) {
  if (!isFile(filePath)) return null;
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return null; }
  const edits = [];
  let refs = 0;
  for (const [dupId, keepId] of remap) {
    const count = countAsciiInBuffer(buf, dupId);
    if (count) {
      edits.push({ from: dupId, to: keepId, count });
      refs += count;
    }
  }
  if (!edits.length) return null;
  return {
    file: path.basename(filePath),
    full: filePath,
    size: buf.length,
    edits,
    refs,
    structure: protobufStructureFingerprint(buf),
  };
}

function applyAgyhubSummariesUpdate(plan) {
  const original = fs.readFileSync(plan.full);
  const before = protobufStructureFingerprint(original);
  if (!before) throw new Error('could not verify protobuf structure before editing');
  const buf = Buffer.from(original);
  let made = 0;
  for (const e of plan.edits) made += replaceAsciiInBuffer(buf, e.from, e.to);
  if (made !== plan.refs) {
    throw new Error(`expected ${plan.refs} UUID replacement(s), made ${made}`);
  }
  if (buf.length !== original.length) throw new Error('size changed in memory');
  const after = protobufStructureFingerprint(buf);
  if (!after || after.fingerprint !== before.fingerprint) {
    throw new Error('protobuf structure changed after UUID rewrite');
  }
  writeFileAtomic(plan.full, buf);
  const written = fs.readFileSync(plan.full);
  if (written.length !== original.length) throw new Error('written size mismatch');
  const writtenStructure = protobufStructureFingerprint(written);
  if (!writtenStructure || writtenStructure.fingerprint !== before.fingerprint) {
    throw new Error('protobuf structure changed on disk after write');
  }
  for (const e of plan.edits) {
    if (countAsciiInBuffer(written, e.from) !== 0) {
      throw new Error('duplicate project UUID still present after write');
    }
  }
  return { made, structure: before };
}

/** Electron user-data dir for Antigravity (holds globalStorage/workspaceStorage). */
function electronUserDir() {
  const home = os.homedir();
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Antigravity', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Antigravity', 'User');
  }
  return path.join(home, '.config', 'Antigravity', 'User'); // linux default
}

/** A standard 36-char UUID → its 16 raw bytes, or null if not a standard UUID. */
function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

/** List files under dir (recursive), optionally filtered by extension, bounded by cap. */
function walkFiles(dir, exts, cap, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (out.length >= cap) return out;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, exts, cap, out);
    else if (!exts || exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push(full);
  }
  return out;
}

/**
 * Count how many of `files` contain at least one of the `needles` (Buffers),
 * plus the total number of occurrences. Read-only. Files larger than `maxBytes`
 * are skipped (and counted) so a huge artifact can't blow up memory.
 */
function scanFilesFor(files, needles, maxBytes = 64 * 1024 * 1024) {
  let filesWith = 0;
  let occ = 0;
  let skipped = 0;
  for (const f of files) {
    let buf;
    try {
      if (fs.statSync(f).size > maxBytes) { skipped++; continue; }
      buf = fs.readFileSync(f);
    } catch (_) { continue; }
    let found = false;
    for (const n of needles) {
      if (!n || !n.length) continue;
      let pos = 0;
      for (;;) {
        const i = buf.indexOf(n, pos);
        if (i === -1) break;
        occ++; found = true; pos = i + n.length;
      }
    }
    if (found) filesWith++;
  }
  return { filesWith, occ, skipped };
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
function cmdScan(dir, opts = {}) {
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
  if (dupes && !opts.quietHint) {
    console.log(dim('  Run with `consolidate --apply` to keep one entry per folder,'));
    console.log(dim('  or `merge --apply` to also keep your chats grouped.\n'));
  }
  return { groups, entries };
}

async function cmdConsolidate(dir, flags) {
  const { groups, entries } = cmdScan(dir, { quietHint: true });
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
  console.log(
    yellow('  Note: ') +
      dim('chats created under a removed duplicate may disappear from the\n') +
      dim('  sidebar (they are not deleted, just unlinked). To keep them grouped,\n') +
      dim('  try `merge` instead — or run `diagnose` first if unsure. A backup is\n') +
      dim('  made, so `restore <backup-dir>` brings everything back.\n')
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
// stored project UUID pointer is rewritten to the keeper.
async function cmdMerge(dir, flags) {
  const { groups, entries } = cmdScan(dir, { quietHint: true });
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

  // Find the conversations folder and its chat databases (.db files).
  const convDir = resolveConversationsDir(dir, flags);
  let dbFiles;
  try {
    dbFiles = fs.readdirSync(convDir).filter((f) => f.toLowerCase().endsWith('.db'));
  } catch (_) {
    console.log(yellow(`\n  Conversations folder not found at:\n  ${convDir}`));
    console.log(
      dim('  No SQLite chat DBs will be scanned. Pass the right path with --conversations <path>,\n') +
      dim('  or run `diagnose` to see where things live.\n')
    );
    dbFiles = [];
  }

  // Plan, per chat. We scan BOTH the .db AND its sibling .db-wal for the
  // duplicate UUID, because Antigravity keeps large persistent WALs and the
  // live value may live only in the WAL. The actual EDIT always targets the
  // .db after the WAL has been folded in via checkpoint.
  const plan = [];
  for (const db of dbFiles) {
    const dbPath = path.join(convDir, db);
    const walPath = dbPath + '-wal';
    let dbBuf;
    try { dbBuf = fs.readFileSync(dbPath); } catch (_) { continue; }
    let walSize = 0;
    let walBuf = Buffer.alloc(0);
    try {
      const st = fs.statSync(walPath);
      if (st.isFile() && st.size > 0) { walSize = st.size; walBuf = fs.readFileSync(walPath); }
    } catch (_) { /* no wal */ }
    const edits = [];
    for (const [dupId, keepId] of remap) {
      if (countAsciiInBuffer(dbBuf, dupId) || (walSize && countAsciiInBuffer(walBuf, dupId))) {
        edits.push({ from: dupId, to: keepId });
      }
    }
    if (edits.length) plan.push({ db, dbPath, walPath, walSize, edits });
  }

  const agyhubFile = resolveAgyhubSummariesFile(dir, flags);
  const agyhubPlan = planAgyhubSummariesUpdate(agyhubFile, remap);
  const targetParts = [];
  if (plan.length) targetParts.push(`${plan.length} chat DB(s)`);
  if (agyhubPlan) targetParts.push(`${agyhubPlan.refs} agyhub summary reference(s)`);
  const targetSummary = targetParts.length ? targetParts.join(' and ') : '0 chat/project reference(s)';

  const apply = flags.apply;
  console.log(
    (apply ? bold('\n  Will re-point ') : bold('\n  [dry-run] would re-point ')) +
      cyan(targetSummary) +
      ` to their keeper project, then remove up to ` +
      red(`${dupCount}`) +
      ` duplicate entr${dupCount === 1 ? 'y' : 'ies'}.\n`
  );

  if (agyhubPlan) {
    const structure = agyhubPlan.structure;
    const structureMsg = structure ? describeProtoStructure(structure) : 'structure not recognized yet';
    console.log(dim(`  Found ${agyhubPlan.refs} duplicate project UUID reference(s) in ${agyhubPlan.file} (${structureMsg}).`));
    if (!structure) {
      console.log(yellow('  Apply will refuse to edit that protobuf file unless its wire structure can be verified.'));
    }
  }

  // A2 — fail-safe when nothing is detected. Do NOT imply consolidate is safe.
  if (!plan.length && !agyhubPlan) {
    console.log(yellow('  Detected 0 chats/project references linked to the duplicates by known methods.'));
    console.log(dim('  That can mean there genuinely are none — OR that your machine stores the'));
    console.log(dim('  chat→project link differently (e.g. 16-byte binary, or another file).'));
    console.log(red('  Do NOT assume `consolidate` is safe yet') + dim(' — it could unlink chats.'));
    console.log(dim('  Run `diagnose` and share the output so we can support your setup:\n'));
    console.log(dim('    npx antigravity-projects-fix diagnose\n'));
    return;
  }

  console.log(dim('  Chats are never deleted — only their "belongs to project" pointer changes.'));
  const pendingWal = plan.filter((p) => p.walSize > 0).length;
  if (pendingWal) {
    console.log(dim(`  ${pendingWal} of ${plan.length} chat(s) have a pending WAL that must be checkpointed first.`));
  }
  if (!apply) {
    console.log(dim('  Re-run with --apply to perform it.\n'));
    return;
  }

  await guardRunning(flags);

  // A WAL must be folded into the .db before we can safely byte-edit it.
  // Editing a .db-wal directly corrupts the chat database (frames are
  // checksummed). If any chat has a pending WAL, we need a SQLite engine.
  let engine = null;
  if (pendingWal > 0) {
    engine = getCheckpointer();
    if (!engine) {
      console.log(red('\n  Cannot merge safely: some chats have pending WAL data that must be'));
      console.log(red('  checkpointed first, and no SQLite engine is available to do it.'));
      console.log(dim('  Editing WAL files directly would corrupt your chats, so I won\'t.'));
      console.log(dim('  Fix: run with Node ≥ 22 (built-in SQLite) or install the `sqlite3` CLI,'));
      console.log(dim('  then re-run `merge --apply`. Nothing was changed.\n'));
      return;
    }
    console.log(dim(`  Using ${engine.kind} to checkpoint WALs.`));
  }

  if (!(await confirm(flags, `\n  Re-point ${targetSummary} and remove duplicate project(s)?`))) {
    console.log(dim('  Cancelled.\n'));
    return;
  }

  // Back up the project registry, affected chat DB files, and agyhub summary file.
  let chatBackupDir = null;
  let agyhubBackupDir = null;
  if (!flags['no-backup']) {
    const pdest = backup(dir);
    console.log(dim(`  Backup (projects): ${pdest}`));
    if (plan.length) {
      const chatFiles = [];
      for (const p of plan) {
        for (const ext of ['', '-wal', '-shm']) {
          if (fs.existsSync(p.dbPath + ext)) chatFiles.push(p.db + ext);
        }
      }
      chatBackupDir = backupFiles(convDir, chatFiles, 'merge');
      console.log(dim(`  Backup (chats):    ${chatBackupDir}`));
    }
    if (agyhubPlan) {
      agyhubBackupDir = backupSingleFile(agyhubPlan.full, 'agyhub');
      console.log(dim(`  Backup (agyhub):   ${agyhubBackupDir}`));
    }
  }

  // Apply per chat: checkpoint (if WAL) → length-preserving byte-edit (atomic)
  // → integrity check. On any failure, restore that chat from backup.
  let edited = 0;
  const failed = [];
  for (const p of plan) {
    try {
      if (p.walSize > 0) engine.checkpoint(p.dbPath); // folds WAL into .db, truncates WAL
      const buf = fs.readFileSync(p.dbPath);
      const before = buf.length;
      let made = 0;
      for (const e of p.edits) made += replaceAsciiInBuffer(buf, e.from, e.to);
      if (made === 0) throw new Error('UUID not found in .db after checkpoint (different storage?)');
      if (buf.length !== before) throw new Error('size changed in memory');
      writeFileAtomic(p.dbPath, buf);
      if (fs.statSync(p.dbPath).size !== before) throw new Error('written size mismatch');
      if (engine) {
        const integ = engine.integrity(p.dbPath);
        if (integ !== 'ok') throw new Error('integrity_check failed: ' + integ);
      }
      edited++;
    } catch (err) {
      failed.push({ chat: p.db, reason: err.message, edits: p.edits });
      if (chatBackupDir) {
        for (const ext of ['', '-wal', '-shm']) {
          const b = path.join(chatBackupDir, p.db + ext);
          if (fs.existsSync(b)) { try { fs.copyFileSync(b, p.dbPath + ext); } catch (_) { /* best effort */ } }
        }
      }
    }
  }
  if (failed.length) {
    console.log(yellow(`\n  ${failed.length} chat(s) could not be re-pointed (restored from backup):`));
    for (const f of failed) console.log(dim(`    ${f.chat} — ${f.reason}`));
  }
  if (plan.length) console.log(green(`  Re-pointed ${edited} chat DB(s).`));

  let agyhubFailed = null;
  if (agyhubPlan) {
    try {
      const result = applyAgyhubSummariesUpdate(agyhubPlan);
      console.log(
        green(`  Updated ${result.made} agyhub summary reference(s).`) +
        dim(` Verified ${describeProtoStructure(result.structure)} before/after.`)
      );
    } catch (err) {
      agyhubFailed = err;
      if (agyhubBackupDir) {
        const backupFile = path.join(agyhubBackupDir, path.basename(agyhubPlan.full));
        if (fs.existsSync(backupFile)) {
          try { fs.copyFileSync(backupFile, agyhubPlan.full); } catch (_) { /* best effort */ }
        }
      }
      console.log(yellow(`\n  Could not update ${agyhubPlan.file} (restored from backup):`));
      console.log(dim(`    ${err.message}`));
    }
  }

  // Only remove a duplicate entry if NO chat that referenced it failed —
  // otherwise removing it would orphan those chats.
  const unsafeDups = new Set();
  for (const f of failed) for (const e of f.edits) unsafeDups.add(e.from);
  if (agyhubFailed) for (const e of agyhubPlan.edits) unsafeDups.add(e.from);
  const toDelete = [];
  for (const list of groups.values()) {
    for (let i = 1; i < list.length; i++) {
      if (!unsafeDups.has(list[i].id)) toDelete.push(list[i]);
    }
  }
  let removed = 0;
  for (const e of toDelete) {
    try { fs.rmSync(e.full, { force: true }); removed++; } catch (_) { /* ignore */ }
  }
  console.log(green(`  Removed ${removed} duplicate project entr${removed === 1 ? 'y' : 'ies'}.`));
  if (unsafeDups.size) {
    console.log(yellow(`  Kept ${unsafeDups.size} duplicate(s) whose references couldn't be re-pointed (so they stay accessible).`));
  }
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
  console.log(
    yellow('  Note: ') +
      dim('this unlinks EVERY chat from the sidebar (chats are not deleted, just\n') +
      dim('  orphaned). A backup is made, so `restore <backup-dir>` brings it all back.\n')
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
  // .db-shm) go to the conversations folder, and the agyhub summaries protobuf
  // goes to the Antigravity data folder. This handles project, chat, and agyhub
  // backup folders created by merge/consolidate/purge.
  const convDir = resolveConversationsDir(dir, flags);
  const agyhubFile = resolveAgyhubSummariesFile(dir, flags);
  const agyhubDir = path.dirname(agyhubFile);
  const agyhubName = path.basename(agyhubFile).toLowerCase();
  const files = fs.readdirSync(backupDir);
  let proj = 0;
  let chat = 0;
  let agyhub = 0;
  for (const f of files) {
    const src = path.join(backupDir, f);
    if (!fs.statSync(src).isFile()) continue;
    const lower = f.toLowerCase();
    let target = null;
    if (lower.endsWith('.json')) target = dir;
    else if (/\.(db|db-wal|db-shm)$/.test(lower)) target = convDir;
    else if (lower === agyhubName || lower === 'agyhub_summaries_proto.pb') target = agyhubDir;
    if (!target) continue;
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(src, path.join(target, f));
    if (target === dir) proj++;
    else if (target === agyhubDir) agyhub++;
    else chat++;
  }
  const parts = [];
  if (proj) parts.push(`${proj} project file(s) → ${dir}`);
  if (chat) parts.push(`${chat} chat file(s) → ${convDir}`);
  if (agyhub) parts.push(`${agyhub} agyhub file(s) → ${agyhubDir}`);
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

/**
 * diagnose — read-only. Figures out WHERE the chat→project association lives on
 * this machine by searching every data store for the duplicate project UUIDs
 * (as text AND as 16-byte binary) and for the project folder path. Prints only
 * counts and short hashes — safe to paste into a bug report.
 *
 * Why it exists: `merge` assumed each chat embeds its project UUID as 36-char
 * text. That held on the author's machine but not on every setup, so merge
 * could find nothing to re-point. This maps the real linkage per machine.
 */
function cmdDiagnose(dir, flags) {
  const CAP = 5000;
  const redactHome = (p) => {
    const h = os.homedir();
    return p && p.startsWith(h) ? '~' + p.slice(h.length).replace(/\\/g, '/') : p;
  };

  console.log(bold('\n  antigravity-projects-fix — diagnose ') + dim('(read-only · safe to share)'));
  console.log(dim('  Paste this whole output into the GitHub issue. No paths or chat text are shown.\n'));

  // --- environment ---
  console.log(bold('  Environment'));
  console.log(`    platform   : ${process.platform}`);
  console.log(`    node       : ${process.version}`);

  const { error, entries, broken } = readProjects(dir);
  if (error === 'missing') {
    console.log(red(`    projects   : NOT FOUND at ${redactHome(dir)}`));
    console.log(dim('\n  Can\'t diagnose without the projects folder. Try --dir <path>.\n'));
    return;
  }
  if (error) {
    console.log(red(`    projects   : ERROR (${error})`));
    return;
  }

  const groups = groupByFolder(entries);
  // Duplicate UUIDs (non-keeper). If none, fall back to ALL project UUIDs so the
  // linkage can still be mapped.
  const dupIds = [];
  for (const list of groups.values()) for (let i = 1; i < list.length; i++) if (list[i].id) dupIds.push(list[i].id);
  const usingDups = dupIds.length > 0;
  const probeIds = usingDups ? dupIds : entries.map((e) => e.id).filter(Boolean);

  const convDir = resolveConversationsDir(dir, flags);
  const agyhubFile = resolveAgyhubSummariesFile(dir, flags);
  const base = geminiBaseDir(dir);
  const brainDir = path.join(base, 'antigravity', 'brain');
  const userDir = electronUserDir();
  const stateDb = path.join(userDir, 'globalStorage', 'state.vscdb');
  const wsStorage = path.join(userDir, 'workspaceStorage');

  const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };
  console.log(`    projects   : ${redactHome(dir)}  (${entries.length} entries, ${groups.size} folders, ${dupIds.length} duplicates)`);
  console.log(`    conversations : ${exists(convDir) ? 'FOUND' : 'NOT FOUND'}  ${redactHome(convDir)}`);
  console.log(`    agyhub summaries: ${exists(agyhubFile) ? 'FOUND' : 'NOT FOUND'}  ${redactHome(agyhubFile)}`);
  console.log(`    brain      : ${exists(brainDir) ? 'FOUND' : 'NOT FOUND'}`);
  console.log(`    state.vscdb: ${exists(stateDb) ? 'FOUND' : 'NOT FOUND'}`);
  console.log(`    workspaceStorage: ${exists(wsStorage) ? 'FOUND' : 'NOT FOUND'}`);
  if (broken && broken.length) console.log(yellow(`    (${broken.length} unparseable project file[s] skipped)`));

  // --- id format ---
  const sampleId = probeIds[0] || '';
  const idIsUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sampleId);
  console.log(bold('\n  Project id format'));
  console.log(`    ${idIsUuid ? '36-char text UUID' : 'non-standard: ' + JSON.stringify(sampleId.slice(0, 12) + '…')}`);

  // --- build needles ---
  const textNeedles = probeIds.map((id) => Buffer.from(id, 'ascii'));
  const binNeedles = probeIds.map(uuidToBytes).filter(Boolean);

  // folder-path needle (the linkage-by-folder theory). Read RAW folderUris from
  // the project JSONs and generate several encodings, so the bytes match
  // whatever Antigravity actually stored regardless of slash/encoding style.
  const rawUris = new Set();
  for (const e of entries) {
    try {
      const j = JSON.parse(fs.readFileSync(e.full, 'utf8'));
      for (const u of collectFolderUris(j)) rawUris.add(u);
    } catch (_) { /* skip */ }
  }
  const folderVariants = new Set();
  for (const u of rawUris) {
    folderVariants.add(u); // raw, e.g. file:///c%3A/Users/...
    let dec; try { dec = decodeURIComponent(u); } catch (_) { dec = u; }
    folderVariants.add(dec);
    const noScheme = dec.replace(/^file:\/\/\/?/i, '');
    folderVariants.add(noScheme);                   // c:/Users/...
    folderVariants.add(noScheme.replace(/\//g, '\\')); // c:\Users\...
  }
  const folderNeedles = [...folderVariants].filter((s) => s && s.length > 3).map((p) => Buffer.from(p, 'utf8'));

  // --- scan each store ---
  console.log(bold(`\n  Searching ${usingDups ? 'DUPLICATE' : 'all'} project ids across data stores`) + dim(` (probing ${probeIds.length})`));
  const row = (label, files, needles) => {
    const r = scanFilesFor(files, needles);
    return `${r.filesWith} file(s), ${r.occ} hit(s)`;
  };
  const dbFiles = exists(convDir) ? walkFiles(convDir, ['.db'], CAP) : [];
  const walFiles = exists(convDir) ? walkFiles(convDir, ['.db-wal'], CAP) : [];
  const convPbFiles = exists(convDir) ? walkFiles(convDir, ['.pb'], CAP) : [];
  const agyhubFiles = exists(agyhubFile) ? [agyhubFile] : [];
  const brainFiles = exists(brainDir) ? walkFiles(brainDir, null, CAP) : [];
  const brainDirNames = exists(brainDir) ? (() => { try { return fs.readdirSync(brainDir); } catch (_) { return []; } })() : [];
  const stateFiles = exists(stateDb) ? [stateDb] : [];
  const wsFiles = exists(wsStorage) ? walkFiles(wsStorage, null, CAP) : [];

  const dupIdSet = new Set(probeIds);
  const brainDirMatches = brainDirNames.filter((n) => dupIdSet.has(n)).length;

  console.log(dim('  store                         text-UUID            binary-UUID(16B)'));
  const line = (label, files) => {
    const t = scanFilesFor(files, textNeedles);
    const b = scanFilesFor(files, binNeedles);
    console.log(
      '    ' + label.padEnd(28) +
      `${t.filesWith}f/${t.occ}h`.padEnd(20) +
      `${b.filesWith}f/${b.occ}h`
    );
  };
  line('conversations/*.db', dbFiles);
  line('conversations/*.db-wal', walFiles);
  line('conversations/*.pb', convPbFiles);
  line('agyhub_summaries_proto.pb', agyhubFiles);
  line('brain/** (file contents)', brainFiles);
  line('state.vscdb', stateFiles);
  line('workspaceStorage/**', wsFiles);
  console.log('    ' + 'brain/<id> dir names'.padEnd(28) + `${brainDirMatches} match(es)`);
  if (agyhubFiles.length) {
    let structure = null;
    try { structure = protobufStructureFingerprint(fs.readFileSync(agyhubFile)); } catch (_) { /* ignore */ }
    console.log('    ' + 'agyhub protobuf'.padEnd(28) + describeProtoStructure(structure));
  }

  // --- folder-path linkage (alternative theory) ---
  const fp = scanFilesFor(dbFiles, folderNeedles);
  const fpConvPb = scanFilesFor(convPbFiles, folderNeedles);
  const fpAgyhub = scanFilesFor(agyhubFiles, folderNeedles);
  console.log(bold('\n  Folder-path linkage (alternative)'));
  console.log(`    conversations/*.db containing the project folder path: ${fp.filesWith} file(s)`);
  console.log(`    conversations/*.pb containing the project folder path: ${fpConvPb.filesWith} file(s)`);
  console.log(`    agyhub_summaries_proto.pb containing the project folder path: ${fpAgyhub.filesWith} file(s)`);

  // --- structured hints ---
  console.log(bold('\n  Structured link hints'));
  const sqliteLocations = dbFiles.length && probeIds.length ? sqliteProjectUuidLocations(dbFiles, probeIds) : new Map();
  if (sqliteLocations === null) {
    console.log(dim('    conversations SQLite: skipped (node:sqlite unavailable in this Node runtime)'));
  } else if (sqliteLocations.size) {
    for (const [key, value] of [...sqliteLocations.entries()].sort()) {
      console.log(`    conversations SQLite ${key}: ${value.dbs} db(s), ${value.rows} row-hit(s)`);
    }
  } else {
    console.log(dim('    conversations SQLite: no structured table/column hit'));
  }
  if (agyhubFiles.length) {
    let paths = null;
    try { paths = summarizeProtoUuidPaths(fs.readFileSync(agyhubFile), probeIds); } catch (_) { /* ignore */ }
    if (paths && paths.projectPaths.size) {
      for (const [key, count] of [...paths.projectPaths.entries()].sort()) {
        console.log(`    agyhub project UUID path ${key}: ${count} hit(s)`);
      }
    } else if (paths && paths.uuidPaths.size) {
      console.log(dim('    agyhub protobuf: UUIDs found, but none matched the probed project ids'));
    } else {
      console.log(dim('    agyhub protobuf: no structured UUID path hit'));
    }
  } else {
    console.log(dim('    agyhub protobuf: file not found'));
  }

  // --- verdict ---
  console.log(bold('\n  Where the chat→project link most likely lives:'));
  const hits = [];
  const note = (label, files) => {
    const t = scanFilesFor(files, textNeedles).occ;
    const b = scanFilesFor(files, binNeedles).occ;
    if (t || b) hits.push(`${label} (${t ? 'text' : ''}${t && b ? '+' : ''}${b ? 'binary' : ''})`);
  };
  note('conversations', [...dbFiles, ...walFiles, ...convPbFiles]);
  note('agyhub_summaries_proto.pb', agyhubFiles);
  note('brain', brainFiles);
  note('state.vscdb', stateFiles);
  note('workspaceStorage', wsFiles);
  if (brainDirMatches) hits.push('brain dir names');
  if (hits.length) {
    console.log(green('    → ' + hits.join(', ')));
  } else if (fp.filesWith || fpConvPb.filesWith || fpAgyhub.filesWith) {
    console.log(yellow('    → not by project id; chats reference the FOLDER PATH instead.'));
  } else {
    console.log(red('    → no link found by id or folder path. Please mention your Antigravity version.'));
  }
  console.log(dim('\n  Thanks! This tells us exactly how to make `merge` work on your setup.\n'));
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
                       ${dim('(no chat deleted; SQLite needed only for pending')}
                       ${dim(' WAL checkpointing - experimental)')}
  purge                Remove every project entry (clean slate)
  restore <dir>        Copy project files back from a backup folder
  diagnose, doctor     Read-only: show where chats link to projects on your
                       machine ${dim('(safe to paste into a bug report)')}

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
  --agyhub-summaries <path>
                       Override agyhub_summaries_proto.pb for ${cyan('merge')} / ${cyan('diagnose')}
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
    case 'diagnose':
    case 'doctor':
      cmdDiagnose(dir, flags);
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
