#!/usr/bin/env python3
"""
Check Antigravity / Antigravity IDE local session index health.

Default mode is read-only. It reports:
  - summaries pointing at project IDs no longer present in ~/.gemini/config/projects
  - conversation DB/PB files missing from agyhub_summaries_proto.pb
  - recent conversation DBs with local evidence but no visible summary index

With --repair-missing-summary --apply it appends conservative agyhub summary
records for conversation DBs that have no visible summary index. It backs up the
summary protobuf first and validates that the result can be parsed.
"""

from __future__ import annotations

import argparse
import base64
import shutil
import json
import re
import sqlite3
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote


UUID_RE = re.compile(rb"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TEXT_RE = re.compile(rb"[\x20-\x7e]{4,}")
UUID_TEXT_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    val = 0
    shift = 0
    while pos < len(buf):
        c = buf[pos]
        pos += 1
        val |= (c & 0x7F) << shift
        if c < 0x80:
            return val, pos
        shift += 7
        if shift > 70:
            raise ValueError("varint too long")
    raise ValueError("unexpected eof")


def enc_varint(val: int) -> bytes:
    if val < 0:
        raise ValueError("negative varint")
    out = bytearray()
    while True:
        byte = val & 0x7F
        val >>= 7
        if val:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def enc_key(field: int, wire: int) -> bytes:
    return enc_varint((field << 3) | wire)


def enc_uint(field: int, val: int) -> bytes:
    return enc_key(field, 0) + enc_varint(val)


def enc_bytes(field: int, val: bytes) -> bytes:
    return enc_key(field, 2) + enc_varint(len(val)) + val


def enc_string(field: int, val: str) -> bytes:
    return enc_bytes(field, val.encode("utf-8"))


def parse_fields(buf: bytes) -> list[tuple[int, int, int, int]]:
    out: list[tuple[int, int, int, int]] = []
    pos = 0
    while pos < len(buf):
        key, key_end = read_varint(buf, pos)
        field = key >> 3
        wire = key & 7
        data_start = key_end
        if wire == 0:
            _, pos = read_varint(buf, key_end)
            data_end = pos
        elif wire == 1:
            pos = key_end + 8
            data_end = pos
        elif wire == 2:
            length, payload_start = read_varint(buf, key_end)
            data_start = payload_start
            data_end = payload_start + length
            pos = data_end
        elif wire == 5:
            pos = key_end + 4
            data_end = pos
        else:
            raise ValueError(f"unsupported wire type {wire}")
        if data_end > len(buf):
            raise ValueError("field exceeds buffer")
        out.append((field, wire, data_start, data_end))
    return out


def first_string_msg(buf: bytes, field_no: int) -> str | None:
    try:
        fields = parse_fields(buf)
    except ValueError:
        return None
    for field, wire, start, end in fields:
        if field == field_no and wire == 2:
            return buf[start:end].decode("utf-8", "replace")
    return None


def repeated_string_msg(buf: bytes, field_no: int) -> list[str]:
    try:
        fields = parse_fields(buf)
    except ValueError:
        return []
    values = []
    for field, wire, start, end in fields:
        if field == field_no and wire == 2:
            values.append(buf[start:end].decode("utf-8", "replace"))
    return values


def norm_uri(uri: str) -> str:
    try:
        uri = unquote(uri)
    except Exception:
        pass
    return uri.rstrip("/")


def collect_folder_uris(obj, out: list[str]) -> None:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "folderUri" and isinstance(value, str):
                out.append(norm_uri(value))
            else:
                collect_folder_uris(value, out)
    elif isinstance(obj, list):
        for value in obj:
            collect_folder_uris(value, out)


@dataclass
class Project:
    pid: str
    name: str
    uris: tuple[str, ...]


@dataclass
class Summary:
    idx: int
    cid: str
    title: str
    project: str | None
    uris: tuple[str, ...]


@dataclass
class Conversation:
    cid: str
    kind: str
    path: Path
    mtime: float
    size: int
    trajectory_id: str | None = None
    step_count: int | None = None
    workspace_uris: tuple[str, ...] = ()
    evidence: tuple[str, ...] = ()
    title: str | None = None
    created_at: float | None = None
    updated_at: float | None = None


def load_projects(project_dir: Path) -> dict[str, Project]:
    projects: dict[str, Project] = {}
    for path in sorted(project_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except Exception as exc:
            print(f"WARN: cannot parse project JSON {path}: {exc}", file=sys.stderr)
            continue
        pid = data.get("id") or path.stem
        uris: list[str] = []
        collect_folder_uris(data, uris)
        projects[pid] = Project(pid=pid, name=data.get("name") or "", uris=tuple(sorted(set(uris))))
    return projects


def field_bytes(buf: bytes, target_field: int) -> bytes | None:
    try:
        fields = parse_fields(buf)
    except ValueError:
        return None
    for field, wire, start, end in fields:
        if field == target_field and wire == 2:
            return buf[start:end]
    return None


def message_time(seconds: int, nanos: int = 0) -> bytes:
    msg = enc_uint(1, max(0, int(seconds)))
    if nanos:
        msg += enc_uint(2, max(0, int(nanos)))
    return msg


def split_timestamp(ts: float) -> tuple[int, int]:
    seconds = int(ts)
    nanos = int((ts - seconds) * 1_000_000_000)
    return seconds, nanos


def parse_summaries(pb_path: Path) -> list[Summary]:
    buf = pb_path.read_bytes()
    summaries: list[Summary] = []
    for idx, (field, wire, start, end) in enumerate(parse_fields(buf)):
        if field != 1 or wire != 2:
            continue
        entry = buf[start:end]
        entry_fields = parse_fields(entry)
        if len(entry_fields) < 2:
            continue
        cid = entry[entry_fields[0][2] : entry_fields[0][3]].decode("utf-8", "replace")
        msg = entry[entry_fields[1][2] : entry_fields[1][3]]
        title = first_string_msg(msg, 1) or ""
        project = None
        uris: list[str] = []
        for sub_field, sub_wire, sub_start, sub_end in parse_fields(msg):
            if sub_field == 17 and sub_wire == 2:
                link = msg[sub_start:sub_end]
                project = first_string_msg(link, 18)
                uris = [norm_uri(u) for u in repeated_string_msg(link, 7)]
        summaries.append(Summary(idx=idx, cid=cid, title=title, project=project, uris=tuple(sorted(set(uris)))))
    return summaries


def sqlite_count_rows(db_path: Path, table: str) -> int | None:
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            return int(con.execute(f"select count(*) from {table}").fetchone()[0])
        finally:
            con.close()
    except Exception:
        return None


def strings_from_bytes(data: bytes, limit: int = 80) -> list[str]:
    values = []
    for match in TEXT_RE.finditer(data):
        text = match.group().decode("utf-8", "replace")
        if len(text) >= 8:
            values.append(text)
        if len(values) >= limit:
            break
    return values


def unicode_strings_from_bytes(data: bytes, limit: int = 120) -> list[str]:
    text = data.decode("utf-8", "ignore")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]+", "\n", text)
    values = []
    for item in re.split(r"[\n\r\t]+", text):
        item = item.strip(" \r\n\t\"'`:;,.H")
        item = re.sub(r"^[^\w\u4e00-\u9fff]+", "", item)
        item = re.sub(r"[^\w\u4e00-\u9fff.!?)）]+$", "", item)
        item = re.sub(r"^[a-z0-9](?=[A-Z\u4e00-\u9fff])", "", item)
        if len(item) < 4:
            continue
        if UUID_TEXT_RE.fullmatch(item):
            continue
        values.append(item)
        if len(values) >= limit:
            break
    return values


def title_score(text: str) -> int:
    bad_parts = [
        "sessionID",
        "Conversation History",
        "toolAction",
        "toolSummary",
        "file://",
        "/Users/",
        "github.com",
        "bot-",
        "list_dir",
        "run_command",
        "view_file",
        "grep_search",
        "已经成功",
        "目前的 Git",
        "请稍等",
        "无需构建",
    ]
    if any(part in text for part in bad_parts):
        return -100
    if UUID_TEXT_RE.search(text):
        return -100
    if re.search(r"\$[0-9a-f]{8}-", text):
        return -100
    if re.fullmatch(r"[-_A-Za-z0-9]{14,}", text):
        return -100
    if len(re.findall(r"[^\w\s\u4e00-\u9fff]", text)) > max(4, len(text) // 6):
        return -40
    if len(text) > 90:
        return -10
    score = 0
    if 8 <= len(text) <= 70:
        score += 10
    if re.search(r"[A-Z][a-z]", text):
        score += 4
    if re.search(r"[\u4e00-\u9fff]", text):
        score += 4
    if re.search(r"\b(Fix|Add|Update|Implement|Resolve|Analyze|Create|Build|Review|修复|新增|分析|迁移|检查)\b", text):
        score += 4
    if re.fullmatch(r"(?:[A-Z][A-Za-z0-9]+|[A-Z][a-z]+ing)(?: [A-Z0-9][A-Za-z0-9]+| [a-z]{2,}){1,8}", text):
        score += 8
    return score


def structured_titles_from_step23(values: list[str]) -> list[str]:
    titles: list[str] = []
    for idx, value in enumerate(values):
        if value != "sessionID":
            continue
        pos = idx + 3
        if pos < len(values):
            titles.append(values[pos])
    return titles


def extract_title_from_db(con: sqlite3.Connection, fallback: str) -> str:
    candidates: list[str] = []
    try:
        rows = con.execute(
            "select step_payload, task_details, metadata from steps where step_type=23 order by idx limit 20"
        ).fetchall()
    except Exception:
        rows = []
    for row in rows:
        for value in row:
            if isinstance(value, bytes) and value:
                values = unicode_strings_from_bytes(value, 80)
                candidates.extend(structured_titles_from_step23(values))
                candidates.extend(values)
    if not candidates:
        try:
            rows = con.execute(
                "select step_payload, task_details, metadata from steps where step_type in (14,15) order by idx limit 20"
            ).fetchall()
        except Exception:
            rows = []
        for row in rows:
            for value in row:
                if isinstance(value, bytes) and value:
                    candidates.extend(unicode_strings_from_bytes(value, 80))
    scored = sorted(((title_score(c), idx, c) for idx, c in enumerate(candidates)), key=lambda item: (-item[0], item[1]))
    for score, _, candidate in scored:
        if score > 0:
            return candidate[:100]
    return fallback


def extract_workspace_uris_from_blob(data: bytes) -> tuple[str, ...]:
    uris: set[str] = set()
    text = data.decode("utf-8", "ignore")
    for match in re.finditer(r"file:///[^\x00-\x20\"'<>]+", text):
        uri = match.group()
        uri = re.sub(r"[zH]+$", "", uri)
        uris.add(norm_uri(uri))
    return tuple(sorted(uris))


def inspect_conversation_db(
    db_path: Path,
) -> tuple[str | None, int | None, tuple[str, ...], tuple[str, ...], str | None, float | None, float | None]:
    trajectory_id = None
    step_count = None
    workspace_uris: set[str] = set()
    evidence: list[str] = []
    title = None
    created_at = None
    updated_at = None

    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            row = con.execute("select trajectory_id from trajectory_meta limit 1").fetchone()
            if row:
                trajectory_id = row[0]
            row = con.execute("select count(*) from steps").fetchone()
            if row:
                step_count = int(row[0])
            title = extract_title_from_db(con, db_path.stem)
            row = con.execute("select data from trajectory_metadata_blob where id='main'").fetchone()
            if row and isinstance(row[0], bytes):
                workspace_uris.update(extract_workspace_uris_from_blob(row[0]))
            row = con.execute("select min(idx), max(idx) from steps").fetchone()
            if row:
                # The steps table does not expose a timestamp column. Use the DB
                # file times for created/updated order in synthesized summaries.
                created_at = db_path.stat().st_ctime
                updated_at = db_path.stat().st_mtime
        finally:
            con.close()
    except Exception:
        pass

    sample = b""
    for suffix in ("", "-wal"):
        path = Path(str(db_path) + suffix)
        if path.exists():
            sample += path.read_bytes()[:2_000_000]
    for text in strings_from_bytes(sample, 200):
        if "toolAction" in text or "toolSummary" in text or "/Users/maemolee/GitHub/" in text:
            evidence.append(text[:180])
            if len(evidence) >= 5:
                break
    return trajectory_id, step_count, tuple(sorted(workspace_uris)), tuple(evidence), title, created_at, updated_at


def list_conversations(conv_dir: Path) -> dict[str, Conversation]:
    conversations: dict[str, Conversation] = {}
    for path in sorted(conv_dir.glob("*")):
        if path.suffix not in {".db", ".pb"}:
            continue
        cid = path.stem
        if cid.endswith(".db"):
            cid = cid[:-3]
        stat = path.stat()
        if path.suffix == ".db":
            trajectory_id, step_count, workspace_uris, evidence, title, created_at, updated_at = inspect_conversation_db(path)
            conversations[cid] = Conversation(
                cid=cid,
                kind="db",
                path=path,
                mtime=stat.st_mtime,
                size=stat.st_size,
                trajectory_id=trajectory_id,
                step_count=step_count,
                workspace_uris=workspace_uris,
                evidence=evidence,
                title=title,
                created_at=created_at,
                updated_at=updated_at,
            )
        elif cid not in conversations:
            conversations[cid] = Conversation(cid=cid, kind="pb", path=path, mtime=stat.st_mtime, size=stat.st_size)
    return conversations


def decode_state_value(value: str | bytes) -> bytes:
    raw = value.encode() if isinstance(value, str) else value
    try:
        return base64.b64decode(raw, validate=True)
    except Exception:
        return raw


def read_state_ids(user_dir: Path) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    db_path = user_dir / "globalStorage" / "state.vscdb"
    if not db_path.exists():
        return out
    keys = [
        "antigravityUnifiedStateSync.trajectorySummaries",
        "jetskiStateSync.agentManagerInitState",
    ]
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            for key in keys:
                row = con.execute("select value from ItemTable where key=?", (key,)).fetchone()
                if not row:
                    continue
                decoded = decode_state_value(row[0])
                out[key] = {m.group().decode("ascii") for m in UUID_RE.finditer(decoded)}
        finally:
            con.close()
    except Exception as exc:
        print(f"WARN: cannot read {db_path}: {exc}", file=sys.stderr)
    return out


def guess_project_for_uris(projects: dict[str, Project], uris: Iterable[str]) -> list[Project]:
    uri_set = set(uris)
    if not uri_set:
        return []
    exact = [p for p in projects.values() if set(p.uris) == uri_set]
    if exact:
        return exact
    scored = []
    for project in projects.values():
        overlap = len(set(project.uris) & uri_set)
        if overlap:
            scored.append((overlap, project))
    scored.sort(key=lambda item: (-item[0], item[1].name))
    return [p for _, p in scored[:3]]


def best_project_for_conversation(projects: dict[str, Project], conv: Conversation) -> Project | None:
    guesses = guess_project_for_uris(projects, conv.workspace_uris)
    return guesses[0] if guesses else None


def build_workspace_resource(uri: str) -> bytes:
    uri = norm_uri(uri)
    msg = enc_string(1, uri)
    msg += enc_string(2, uri)
    msg += enc_string(4, "main")
    return msg


def build_summary_payload(conv: Conversation, project: Project | None) -> bytes:
    title = conv.title or conv.cid
    trajectory_id = conv.trajectory_id or conv.cid
    created = conv.created_at or conv.mtime
    updated = conv.updated_at or conv.mtime
    created_s, created_ns = split_timestamp(created)
    updated_s, updated_ns = split_timestamp(updated)
    workspace_uris = conv.workspace_uris
    workspace_uri = workspace_uris[0] if workspace_uris else ""

    payload = bytearray()
    payload += enc_string(1, title)
    payload += enc_uint(2, int(conv.step_count or 0))
    payload += enc_bytes(3, message_time(updated_s, updated_ns))
    payload += enc_string(4, trajectory_id)
    payload += enc_uint(5, 1)
    payload += enc_bytes(7, message_time(created_s, created_ns))

    resource = b""
    if workspace_uri:
        resource = build_workspace_resource(workspace_uri)
        payload += enc_bytes(9, resource)
    payload += enc_bytes(10, message_time(updated_s, updated_ns))
    payload += enc_bytes(15, b"")
    payload += enc_uint(16, max(0, int((conv.step_count or 0) - 1)))

    link = bytearray()
    if resource:
        link += enc_bytes(1, resource)
    link += enc_bytes(2, message_time(created_s, created_ns))
    link += enc_string(3, trajectory_id)
    for uri in workspace_uris:
        link += enc_string(7, uri)
    link += enc_string(18, project.pid if project else "outside-of-project")
    payload += enc_bytes(17, bytes(link))
    payload += enc_uint(22, 4)
    return bytes(payload)


def build_summary_entry(conv: Conversation, project: Project | None) -> bytes:
    entry = enc_string(1, conv.cid)
    entry += enc_bytes(2, build_summary_payload(conv, project))
    return enc_bytes(1, entry)


def backup_file(path: Path) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.backup-{stamp}")
    backup.write_bytes(path.read_bytes())
    return backup


def repair_missing_summaries(
    summary_path: Path,
    summaries: list[Summary],
    missing: list[Conversation],
    projects: dict[str, Project],
    apply: bool,
) -> int:
    candidates = [c for c in missing if c.kind == "db"]
    print(f"Repair candidates: {len(candidates)}")
    for conv in sorted(candidates, key=lambda c: c.mtime, reverse=True):
        project = best_project_for_conversation(projects, conv)
        pname = project.name if project else "outside-of-project"
        print(f"  + {conv.cid} | {conv.title or conv.cid} | {pname}")
    if not candidates:
        return 0
    if not apply:
        print("Dry-run only. Add --apply to append these summary records.")
        return 0

    original = summary_path.read_bytes() if summary_path.exists() else b""
    if original:
        parse_fields(original)
    additions = b"".join(build_summary_entry(c, best_project_for_conversation(projects, c)) for c in candidates)
    updated = original + additions
    parsed = parse_summaries_from_bytes(updated)
    old_ids = {s.cid for s in summaries}
    new_ids = {s.cid for s in parsed}
    expected = {c.cid for c in candidates}
    missing_after_build = expected - new_ids
    duplicate_ids = [cid for cid, count in Counter(s.cid for s in parsed).items() if count > 1 and cid in expected]
    if missing_after_build or duplicate_ids:
        raise RuntimeError(f"generated summary failed validation: missing={missing_after_build}, duplicates={duplicate_ids}")
    if old_ids & expected:
        raise RuntimeError("some repair candidates already exist in summary")

    backup = backup_file(summary_path)
    tmp = summary_path.with_name(f"{summary_path.name}.tmp-{int(time.time())}")
    tmp.write_bytes(updated)
    tmp.replace(summary_path)
    reparsed = parse_summaries(summary_path)
    final_ids = {s.cid for s in reparsed}
    if expected - final_ids:
        shutil.copy2(backup, summary_path)
        raise RuntimeError("summary validation failed after write; restored backup")
    print(f"Applied: appended {len(candidates)} summary record(s)")
    print(f"Backup: {backup}")
    return len(candidates)


def parse_summaries_from_bytes(buf: bytes) -> list[Summary]:
    summaries: list[Summary] = []
    for idx, (field, wire, start, end) in enumerate(parse_fields(buf)):
        if field != 1 or wire != 2:
            continue
        entry = buf[start:end]
        entry_fields = parse_fields(entry)
        if len(entry_fields) < 2:
            continue
        cid = entry[entry_fields[0][2] : entry_fields[0][3]].decode("utf-8", "replace")
        msg = entry[entry_fields[1][2] : entry_fields[1][3]]
        title = first_string_msg(msg, 1) or ""
        project = None
        uris: list[str] = []
        for sub_field, sub_wire, sub_start, sub_end in parse_fields(msg):
            if sub_field == 17 and sub_wire == 2:
                link = msg[sub_start:sub_end]
                project = first_string_msg(link, 18)
                uris = [norm_uri(u) for u in repeated_string_msg(link, 7)]
        summaries.append(Summary(idx=idx, cid=cid, title=title, project=project, uris=tuple(sorted(set(uris)))))
    return summaries


def fmt_time(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def run(args: argparse.Namespace) -> int:
    home = Path(args.home).expanduser()
    gemini_dir = Path(args.gemini_dir).expanduser() if args.gemini_dir else home / ".gemini" / args.area
    project_dir = Path(args.project_dir).expanduser() if args.project_dir else home / ".gemini" / "config" / "projects"
    user_dir = Path(args.user_dir).expanduser() if args.user_dir else home / "Library" / "Application Support" / "Antigravity IDE" / "User"
    summary_path = gemini_dir / "agyhub_summaries_proto.pb"
    conv_dir = gemini_dir / "conversations"

    projects = load_projects(project_dir)
    summaries = parse_summaries(summary_path) if summary_path.exists() else []
    conversations = list_conversations(conv_dir) if conv_dir.exists() else {}
    state_ids = read_state_ids(user_dir)

    summary_ids = {s.cid for s in summaries}
    current_project_ids = set(projects)
    orphan_summaries = [s for s in summaries if s.project and s.project not in current_project_ids and s.project != "outside-of-project"]
    missing_from_summary = [c for c in conversations.values() if c.cid not in summary_ids]
    recent_cutoff = time.time() - args.recent_hours * 3600
    recent_missing = [c for c in missing_from_summary if c.mtime >= recent_cutoff]

    print(f"Area: {args.area}")
    print(f"Projects: {len(projects)} from {project_dir}")
    print(f"Summaries: {len(summaries)} from {summary_path}")
    print(f"Conversations: {len(conversations)} from {conv_dir}")
    print()

    print("Summary project links:")
    by_project = Counter(s.project or "(none)" for s in summaries)
    for pid, count in by_project.most_common(20):
        name = projects.get(pid).name if pid in projects else pid
        print(f"  {count:3}  {name}")
    print()

    print(f"Orphan summary project IDs: {len(orphan_summaries)}")
    for summary in orphan_summaries[: args.limit]:
        guesses = guess_project_for_uris(projects, summary.uris)
        guess_text = ", ".join(f"{p.name}({p.pid})" for p in guesses) or "no local project match"
        print(f"  [{summary.idx}] {summary.cid} | {summary.title} | {summary.project} -> {guess_text}")
    if len(orphan_summaries) > args.limit:
        print(f"  ... {len(orphan_summaries) - args.limit} more")
    print()

    print(f"Conversations missing from summary: {len(missing_from_summary)}")
    shown = recent_missing if args.recent_only else missing_from_summary
    if args.recent_only:
        print(f"Recent missing conversations ({args.recent_hours:g}h): {len(recent_missing)}")
    for conv in sorted(shown, key=lambda c: c.mtime, reverse=True)[: args.limit]:
        guesses = guess_project_for_uris(projects, conv.workspace_uris)
        guess_text = ", ".join(f"{p.name}({p.pid})" for p in guesses) or "no local project match"
        print(
            f"  {conv.cid} | {conv.kind} | {fmt_time(conv.mtime)} | "
            f"steps={conv.step_count if conv.step_count is not None else '-'} | {guess_text}"
        )
        if conv.workspace_uris:
            print("    workspace:", ", ".join(conv.workspace_uris))
        for item in conv.evidence[:2]:
            print("    evidence:", item)
    if len(shown) > args.limit:
        print(f"  ... {len(shown) - args.limit} more")
    print()

    print("Global state UUID references:")
    for key, ids in state_ids.items():
        missing = ids - summary_ids
        print(f"  {key}: {len(ids)} ids, {len(missing)} not in summary")
        for cid in sorted(missing & set(conversations))[: args.limit]:
            print(f"    state-only conversation: {cid}")
    print()

    if args.apply:
        if not args.repair_missing_summary:
            print("No changes made.")
            print("Use --repair-missing-summary --apply to append missing agyhub summary records.")
            return 2
        repaired = repair_missing_summaries(summary_path, summaries, missing_from_summary, projects, apply=True)
        refreshed = parse_summaries(summary_path)
        refreshed_ids = {s.cid for s in refreshed}
        still_missing = [c for c in conversations.values() if c.cid not in refreshed_ids]
        print(f"Conversations missing from summary after repair: {len(still_missing)}")
        return 0 if repaired else 1
    if args.repair_missing_summary:
        repair_missing_summaries(summary_path, summaries, missing_from_summary, projects, apply=False)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Antigravity session index health")
    parser.add_argument("--home", default=str(Path.home()))
    parser.add_argument("--area", default="antigravity-ide", choices=["antigravity-ide", "antigravity"])
    parser.add_argument("--gemini-dir")
    parser.add_argument("--project-dir")
    parser.add_argument("--user-dir")
    parser.add_argument("--recent-hours", type=float, default=48)
    parser.add_argument("--recent-only", action="store_true")
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--repair-missing-summary", action="store_true", help="append agyhub summaries for missing conversation DBs")
    parser.add_argument("--apply", action="store_true", help="write repairs; otherwise reports only")
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
