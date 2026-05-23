# Antigravity Session Manager Plan

## 目标

做一个本地会话管理工具，同时支持 `Antigravity` 和 `Antigravity IDE`：

- 排查 `Antigravity IDE` 历史记录残缺：统计 conversation 文件、`agyhub_summaries_proto.pb`、`state.vscdb` 三处索引差异。
- 自动修复丢失会话：把缺失的 summary 写回可见历史索引，写入前备份，写入后验证。
- 清理 `Antigravity` 重复项目：识别同一 folderUri 对应多个 project UUID 的情况。
- 归拢会话：把已删除或重复项目下的会话指向保留项目。
- 双向同步：在 `Antigravity` 与 `Antigravity IDE` 之间同步会话文件、summary 索引、项目关联。

## 非目标

- 不修改用户源码目录。
- 不解密或猜测无法确认结构的 opaque `.pb` 会话正文。
- 不在 Antigravity 正在运行时写入数据库或 protobuf 文件，除非用户显式加 `--force`。
- 不删除会话内容。删除只允许作用于重复项目配置，且默认只预览。

## 支持的数据位置

### Antigravity

- Gemini 数据目录：`~/.gemini/antigravity/`
- 会话目录：`~/.gemini/antigravity/conversations/`
- summary 索引：`~/.gemini/antigravity/agyhub_summaries_proto.pb`
- 项目配置：`~/.gemini/config/projects/*.json`
- VS Code state 目录：`~/Library/Application Support/Antigravity/User/`

### Antigravity IDE

- Gemini 数据目录：`~/.gemini/antigravity-ide/`
- 会话目录：`~/.gemini/antigravity-ide/conversations/`
- summary 索引：`~/.gemini/antigravity-ide/agyhub_summaries_proto.pb`
- VS Code state 目录：`~/Library/Application Support/Antigravity IDE/User/`
- state summary key：`antigravityUnifiedStateSync.trajectorySummaries`
- agent state key：`jetskiStateSync.agentManagerInitState`

## 核心概念

### Area

`Area` 表示一个产品实例：

- `ag`：Antigravity
- `ide`：Antigravity IDE

每个 Area 都有：

- `geminiDir`
- `conversationDir`
- `agyhubSummaryPath`
- `userDataDir`
- `stateDbPath`

### Conversation

统一会话记录：

- `cid`：会话文件名 stem，也是可见历史 id。
- `kind`：`db` 或 `pb`。
- `area`：来源 Area。
- `path`：会话文件路径。
- `mtime`、`size`
- `trajectoryId`
- `stepCount`
- `title`
- `workspaceUris`
- `projectId`
- `hasAgyhubSummary`
- `hasStateSummary`

### Project

项目配置记录：

- `projectId`
- `name`
- `folderUris`
- `sourcePath`
- `isDuplicate`
- `canonicalProjectId`

### Summary

统一 summary 记录：

- `cid`
- `title`
- `payload`
- `payloadEncoding`：`raw` 或 `base64-in-entry`
- `projectId`
- `workspaceUris`
- `updatedAt`
- `source`：`agyhub` 或 `state`

## 命令设计

### 只读命令

```bash
agyfix doctor
agyfix doctor --area ide
agyfix doctor --area ag
agyfix doctor --all
```

输出：

- conversation 文件数。
- agyhub summary 数。
- state summary 数。
- conversation 缺 agyhub 的数量。
- agyhub 缺 state 的数量。
- state 多出的旧 id 数量。
- orphan project link 数量。
- 重复项目组数量。
- 可自动修复项数量。
- 需要人工判断项数量。

```bash
agyfix list sessions --area ide
agyfix list missing --area ide
agyfix list duplicates
agyfix list sync-diff
```

### 修复命令

```bash
agyfix repair sessions --area ide
agyfix repair sessions --area ag
agyfix repair state --area ide
agyfix repair state --area ag
```

默认 dry-run。真正写入：

```bash
agyfix repair sessions --area ide --apply
agyfix repair state --area ide --apply
```

写入规则：

- 先检查进程是否运行。
- 先备份被写文件。
- 写临时文件或事务。
- 写后重新解析。
- 数量和 id 集合必须符合预期。

### 项目清理命令

```bash
agyfix projects scan
agyfix projects merge
agyfix projects merge --apply
agyfix projects purge
agyfix projects purge --apply --yes
```

处理逻辑：

- 按 normalized `folderUri` 分组。
- 每组选择 canonical project：
  - 优先非 deleted。
  - 优先当前存在于 summary link 的 project。
  - 优先最近使用。
  - 最后按名称和 mtime 稳定排序。
- 对重复 project 下的会话执行 rehome：
  - 更新 `agyhub_summaries_proto.pb` 的 link field 18。
  - 更新 `state.vscdb` 里的 summary payload。
  - 更新可确认结构的 conversation `.pb` 引用。
  - SQLite `.db` 会话只在已确认字段时更新；否则只更新索引，不改正文。

### 同步命令

```bash
agyfix sync plan
agyfix sync plan --from ag --to ide
agyfix sync plan --from ide --to ag
agyfix sync apply --from ag --to ide
agyfix sync apply --from ide --to ag
agyfix sync apply --bidirectional
```

同步策略：

- 以 `cid` 为主键。
- 两边都有同一 `cid`：
  - 文件 hash 一致：跳过。
  - 文件 hash 不一致：比较 mtime，默认保留两份，生成 conflict copy。
- 只有一边存在：
  - 复制 conversation 文件。
  - 复制或生成目标 Area 的 agyhub summary。
  - 写入目标 Area 的 state summary。
- project link：
  - 如果目标 Area 有相同 folderUri 的 project，映射到目标 projectId。
  - 没有项目时写 `outside-of-project`，并在报告里列出。
- state summary 格式：
  - `agyhub_summaries_proto.pb` 使用 raw payload。
  - `state.vscdb` 的 `trajectorySummaries` 使用 base64 payload。

## 修复流程

### IDE 历史记录残缺

1. 读取 `conversations/*.db` 和 `conversations/*.pb`。
2. 解析 `agyhub_summaries_proto.pb`。
3. 解析 `state.vscdb` 的 `antigravityUnifiedStateSync.trajectorySummaries`。
4. 统计：
   - conversation 不在 agyhub。
   - agyhub 不在 state。
   - state 不在 agyhub。
5. 修复：
   - conversation 不在 agyhub：
     - SQLite `.db`：从 DB metadata 合成 summary。
     - `.pb`：优先从 state summary 取 payload；没有 payload 时报告，不猜。
   - agyhub 不在 state：
     - 用 agyhub raw payload 生成 state base64 entry。
   - state 不在 agyhub：
     - 默认不自动删除。
     - 如果执行 `repair state --mirror-agyhub --apply`，用 agyhub 的 id 集合替换 state。

### 重复项目清理

1. 读取 `~/.gemini/config/projects/*.json`。
2. 提取并 normalize 所有 `folderUri`。
3. 找到同一 folderUri 的多个 project。
4. 选择 canonical project。
5. 找到所有 summary 中引用重复 project 的会话。
6. 写入 remap：
   - agyhub summary project field。
   - state summary project field。
   - 可确认结构的 conversation `.pb` project field。
7. 删除或标记重复 project JSON。

### 已删除重复项目的会话归拢

1. 找到 summary 中 projectId 不存在于 `projects/*.json` 的记录。
2. 用 summary 的 workspaceUris 匹配现有 project。
3. 有唯一匹配时自动计划 rehome。
4. 多个匹配时列入人工确认报告。
5. 没有匹配时转为 `outside-of-project` 或保留原 id，由参数决定。

## 双向同步细节

### 同步前检查

- 两个应用都不能运行。
- 两边所有待写文件都能备份。
- 源端 summary 必须可解析。
- 目标端 state row 存在；不存在时可创建，但默认只报告。

### 冲突处理

冲突类型：

- 同 cid，不同 conversation 文件。
- 同 cid，不同 title。
- 同 cid，不同 workspaceUris。
- 同 workspaceUri，不同 projectId。

默认策略：

- 不覆盖 conversation 文件。
- 为冲突文件生成 `cid.conflict-<area>-<timestamp>.<ext>`。
- summary 以较新的 conversation mtime 为准。
- 报告冲突，要求用户之后手动处理。

### 同步后的验证

每个目标 Area 必须满足：

- conversation 文件数符合计划。
- agyhub summary 可解析。
- state summary 可解析。
- 目标 summary id 集合包含所有同步进来的 cid。
- orphan project link 数量没有增加，除非同步计划已说明。

## 文件备份

每次写入都创建 manifest：

```text
~/.gemini/agyfix-backups/<timestamp>/manifest.json
```

manifest 内容：

- 命令参数。
- 修改文件列表。
- 原始 sha256。
- 新 sha256。
- 备份路径。
- 验证结果。

备份文件包括：

- `agyhub_summaries_proto.pb`
- `state.vscdb`
- `projects/*.json`
- 被修改的 conversation `.pb`

## 建议实现结构

```text
agy_ide_fix_tool/
  PLAN.md
  src/
    cli.ts
    areas.ts
    protobuf.ts
    state-db.ts
    conversations.ts
    projects.ts
    summaries.ts
    repair.ts
    sync.ts
    backup.ts
    report.ts
  test/
    fixtures/
    protobuf.test.ts
    state-db.test.ts
    sync.test.ts
```

推荐 TypeScript/Node.js：

- 和当前 CLI 项目风格一致。
- 方便发布 npm 包。
- SQLite 读写需要选择稳定依赖；不确定具体包前要查官方文档和当前 Node 版本支持。

也可以先用 Python 实现内部工具：

- 当前已有 Python 原型。
- SQLite 和 protobuf varint 处理更直接。
- 后续再迁移到 Node CLI。

## 开发顺序

1. 抽出 Area 配置和路径探测。
2. 抽出 protobuf parser/builder，支持 raw payload 与 state base64 payload。
3. 实现 `doctor --all`。
4. 实现 `repair state --area ide --apply`。
5. 实现 `repair sessions --area ide --apply`。
6. 实现 project duplicate scan。
7. 实现 project rehome。
8. 实现单向 sync plan。
9. 实现单向 sync apply。
10. 实现 bidirectional sync 和 conflict copy。

## 验收标准

- `doctor --all` 能清楚列出 Antigravity 与 Antigravity IDE 的会话、summary、state 差异。
- 对当前机器的 IDE 数据，`repair state --area ide --apply` 后 state summary 从 96 回到 109。
- 任何写入失败都会保留原文件或从备份恢复。
- Antigravity 重复项目清理后，同 folderUri 只剩一个 canonical project。
- 被删除重复项目引用的会话能归到现存 project。
- 双向同步后，两边都能看到同步进来的会话。
- 所有未验证结构的 `.pb` 正文不会被写。
