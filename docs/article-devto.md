---
title: "Fix Google Antigravity 2.0's duplicate-projects bug (and keep all your chats)"
published: false
description: "After the Antigravity 2.0 update your Projects sidebar fills with MyApp, MyApp 2, … MyApp 41. Here's why it happens and a one-command, zero-dependency tool to clean it up — without losing a single chat."
tags: googleantigravity, gemini, cli, productivity
cover_image: https://raw.githubusercontent.com/ryukenshin546-a11y/antigravity-projects-fix/main/assets/social-preview.png
canonical_url: https://github.com/ryukenshin546-a11y/antigravity-projects-fix
---

> **TL;DR** — If Google Antigravity 2.0 turned one project into `MyApp`, `MyApp 2`, … `MyApp 41` in your Projects sidebar, run this and you're done:
> ```bash
> npx antigravity-projects-fix scan        # see the damage (read-only)
> npx antigravity-projects-fix merge --apply  # collapse to one, keep every chat
> ```
> Zero dependencies, dry-run by default, automatic backup, never deletes a chat.
> Repo: https://github.com/ryukenshin546-a11y/antigravity-projects-fix

## The problem

I updated [Google Antigravity](https://antigravity.google) — Google's agentic, AI‑first IDE — to **2.0**, and my **Projects** sidebar had quietly multiplied. A single repository I'd opened a few times now appeared **dozens of times**, each with a number tacked on the end:

```text
Projects
 📁 my-app
 📁 my-app 2
 📁 my-app 3
 ...
 📁 my-app 41      ← 41 copies of ONE folder
```

Every numbered entry opened the **exact same directory**. There's no "remove all" button, and deleting them one at a time — when there are 40+ — is hopeless. Clearing the local SQLite/state files didn't help either, because that's not where the list lives.

## Why it happens

Antigravity identifies each workspace by a generated **UUID**, *not* by its folder path. During the 2.0 migration / cloud re‑sync it keeps minting a **brand‑new UUID for the same folder** instead of reusing the existing one. Each new UUID becomes another sidebar entry, and the UI appends `2`, `3`, … to tell the identical names apart.

The panel is rendered from **one JSON file per entry**, here:

```text
~/.gemini/config/projects/<uuid>.json
```

If you open a few of them, you'll see dozens carrying the *same* `folderUri`:

```json
{
  "id": "0381f70c-d691-4bd0-bd02-0ec63f39d168",
  "name": "my-app 19",
  "projectResources": {
    "resources": [
      { "gitFolder": { "folderUri": "file:///home/user/code/my-app" } }
    ]
  }
}
```

## The fix: a tiny zero-dependency CLI

I built [**antigravity-projects-fix**](https://github.com/ryukenshin546-a11y/antigravity-projects-fix) — one file, no npm dependencies, runs anywhere Node ≥ 16.7 runs. It reads that registry, groups entries by their *real* folder, and lets you clean up safely.

### 1. Scan first (read-only)

```bash
npx antigravity-projects-fix scan
```

![scan output grouping 58 project files into 5 real folders with 53 duplicates](https://raw.githubusercontent.com/ryukenshin546-a11y/antigravity-projects-fix/main/assets/scan-terminal.svg)

It groups every entry by folder and shows you exactly how bad the duplication is — changing nothing.

### 2. Consolidate — keep one entry per folder

```bash
npx antigravity-projects-fix consolidate --apply
```

This keeps a single keeper per folder and removes the redundant entries. It's **dry‑run by default** (drop `--apply` to preview), makes an **automatic backup** first, and refuses to run while Antigravity is open.

### 3. Merge — keep one entry *and re-home your chats*

Here's the subtle part: each chat secretly remembers *which* duplicate it was created under. So plain consolidation can leave a chat that belonged to "my-app 19" **orphaned** — its project is gone, so it may not show under the surviving "my-app".

`merge` solves that. Before removing the duplicates, it **re‑points every affected chat to the single keeper**, so they all line up under one entry:

```bash
npx antigravity-projects-fix merge --apply
```

![Before: chats scattered across my-app, my-app 2 … my-app 41. After: all chats grouped under one my-app, zero chats deleted](https://raw.githubusercontent.com/ryukenshin546-a11y/antigravity-projects-fix/main/assets/merge-before-after.svg)

How it works, and why it's safe:

- Each chat is a separate database in `~/.gemini/antigravity/conversations`, with the project it belongs to stored **inside** as a 36‑character UUID.
- `merge` rewrites that UUID **in place** to the keeper's. Both are exactly 36 chars, so the file's byte length never changes — the database stays structurally intact (verified with a size assertion after every write).
- **No chat is ever deleted.** Only its "belongs to project" pointer changes.
- It backs up the registry **and** every chat file it touches, and aborts before editing if a backup fails.

## Built to be hard to misuse

- **Dry‑run by default** — destructive commands only preview until you add `--apply`.
- **Automatic backups** — and it won't start deleting if the backup can't be written.
- **Won't fight the app** — refuses to run while Antigravity is detected as running.
- **Auto-detects** the registry across OSes, and lists where it looked if it can't find one.
- **Fully reversible** — `restore <backup-dir>` puts everything back.
- **Offline** — only touches local files, never makes a network request.

There's also an `interactive` checkbox mode if you want to tick exactly which entries to delete, and a `purge` if you'd rather start from a clean slate.

## Try it

```bash
npx antigravity-projects-fix scan
```

⭐ Repo (issues & feedback welcome): **https://github.com/ryukenshin546-a11y/antigravity-projects-fix**

> ⚠️ It's currently **tested on Windows only** — macOS and Linux use the same code paths but are unverified on real hardware. On those, run `scan` first and keep the automatic backup. Reports are very welcome.

If this saved you from clicking "delete" 40 times, a star on the repo helps other people find it. And if you're on a Mac or Linux, I'd love to hear whether it worked for you.
