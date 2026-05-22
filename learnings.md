# Learnings

## Antigravity IDE session index repair

Observed on macOS with Antigravity IDE data under:

- `~/.gemini/antigravity-ide/conversations/`
- `~/.gemini/antigravity-ide/agyhub_summaries_proto.pb`
- `~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb`

The IDE can keep real conversation content in `conversations/*.db`. These files
are SQLite databases with tables including `trajectory_meta`, `steps`, and
`trajectory_metadata_blob`. The visible history list is a separate protobuf
index at `agyhub_summaries_proto.pb`. If a DB exists but the summary index lacks
its conversation id, the UI may not show the session even though the content is
still present locally.

The summary protobuf is a top-level protobuf message with repeated field `1`.
Each field `1` item is an entry shaped like:

- entry field `1`: visible conversation/cascade id, matching the `.db` filename
- entry field `2`: summary payload

The summary payload uses stable fields that are enough for conservative repair:

- field `1`: title
- field `2`: step count or a progress-like count
- field `3`: updated timestamp message
- field `4`: trajectory id from `trajectory_meta.trajectory_id`
- field `5`: observed as `1`
- field `7`: created timestamp message
- repeated field `9`: workspace resource message
- field `10`: updated timestamp message
- field `15`: can be empty
- field `16`: last step index or nearby count
- field `17`: link block
- field `22`: observed as `4`

The link block is important for project association:

- field `1`: workspace resource message
- field `2`: created timestamp message
- field `3`: trajectory id
- repeated field `7`: workspace URI
- field `18`: project UUID, or `outside-of-project`

The DB filename and `trajectory_meta.trajectory_id` are different ids. For
repair, keep the filename stem as the summary entry id and use
`trajectory_meta.trajectory_id` inside payload/link field `4`/`3`.

Workspace URIs can be extracted from `trajectory_metadata_blob` row `id='main'`.
Titles are often present in early `steps` rows with `step_type=23`. The payload
commonly contains `sessionID`, an account/session number, an internal token,
then the user-visible title and description. Token-like strings and UUID-bearing
strings should be filtered before selecting a title.

`conversations/*.pb` files are a separate case. They are conversation files, not
the global summary index, but the script should not synthesize summaries from
them until their internal fields are mapped. They do not expose the SQLite
metadata used for the DB repair path.

Follow-up investigation on two missing `.pb` conversations found:

- `0e95d5ec-57a7-47ef-8c6b-e3a1d873c88d.pb`: about 211 KiB
- `04090889-6731-4a49-a1fe-cb0139e5b3a8.pb`: about 752 KiB

Both files are high-entropy raw data. They do not parse as a single protobuf
message, a length-delimited protobuf stream, or common compression formats such
as gzip, zlib, bz2, or lzma. They also do not contain plain UUIDs, workspace
URIs, or readable conversation text. `file(1)` reports them only as `data`.

That means the `.pb` file body is not currently a safe source for summary field
extraction. However, the IDE global state row
`antigravityUnifiedStateSync.trajectorySummaries` contains both missing
conversation ids followed by base64-encoded summary payloads. Those decoded
payloads match the same summary payload shape used by `agyhub_summaries_proto.pb`
entry field `2`.

The two decoded state summary payloads contained:

- `04090889-6731-4a49-a1fe-cb0139e5b3a8`
  - title: `VS Code Marketplace Custom Installer`
  - trajectory id: `3d6191a0-f786-4a21-a157-f2739be81999`
  - workspace: `file:///Users/maemolee/GitHub/enhanced-vscode-marketplace`
  - project field: absent in the state payload
- `0e95d5ec-57a7-47ef-8c6b-e3a1d873c88d`
  - title: `你知道这个项目应该怎么跑起来吗？`
  - trajectory id: `194e31bc-9068-4a61-9ef9-96fe49d2fecf`
  - workspace: `file:///Users/maemolee/GitHub/code-switch-R`
  - project field: absent in the state payload

For `.pb` conversations, the safer repair path is therefore:

- find the missing conversation id in `antigravityUnifiedStateSync.trajectorySummaries`
- decode the following base64 summary payload
- validate that it parses and has a title plus link block
- create an agyhub summary entry using the `.pb` filename stem as entry field `1`
  and the decoded state payload as entry field `2`

This avoids guessing from the opaque `.pb` body. If a `.pb` conversation has no
matching state summary payload, the script should continue reporting it instead
of fabricating a summary from incomplete evidence.

Safety notes:

- Read-only reporting should remain the default.
- `--repair-missing-summary --apply` should back up
  `agyhub_summaries_proto.pb` before writing.
- After writing, re-parse the whole summary file and verify every appended id is
  present exactly once.
- Do not treat `globalStorage/state.vscdb` ids as proof that a full summary can
  be synthesized; state rows may reference ids that are absent from the visible
  agyhub index.
