# Antigravity Session 技术说明

本文记录本工具当前已经验证过的 Antigravity 与 Antigravity IDE 会话管理方式、常见故障、修复方法，以及双向同步时除了复制 Session 之外还需要做的适配工作。

## 数据模型

本文把两个产品实例称为 area：

- `ag`：Antigravity
- `ide`：Antigravity IDE

两边的数据目录不同，但结构基本一致：

| 数据 | Antigravity | Antigravity IDE |
| --- | --- | --- |
| conversation 文件 | `~/.gemini/antigravity/conversations/` | `~/.gemini/antigravity-ide/conversations/` |
| agyhub summary | `~/.gemini/antigravity/agyhub_summaries_proto.pb` | `~/.gemini/antigravity-ide/agyhub_summaries_proto.pb` |
| VS Code state | `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` | `~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb` |
| workspaceStorage | `~/Library/Application Support/Antigravity/User/workspaceStorage/` | `~/Library/Application Support/Antigravity IDE/User/workspaceStorage/` |
| project 配置 | `~/.gemini/config/projects/*.json` | 同一目录 |

### Session

一个 Session 至少由三部分组成：

1. `conversations/<cid>.pb` 或 `conversations/<cid>.db`
2. `agyhub_summaries_proto.pb` 中同一个 `cid` 的 summary
3. `state.vscdb` 中 `antigravityUnifiedStateSync.trajectorySummaries` 里的同一个 `cid`

其中 `cid` 是会话 id，也是 conversation 文件名的主体部分。历史列表能不能看到一条会话，取决于 conversation 文件、agyhub summary、state summary 这三处是否一致。

summary payload 里已经确认的关键字段：

- field `1`：标题
- field `2`：step count
- field `3` / `10`：时间信息
- field `17`：workspace/project link
- field `17 -> 7`：workspace URI，例如 `file:///Users/.../repo`
- field `17 -> 18`：project id
- field `15`：本地元信息。AG 和 IDE 之间会出现稳定差异，不能直接当成内容冲突。

`agyhub_summaries_proto.pb` 使用 raw payload。`state.vscdb` 的 `trajectorySummaries` 存 base64 payload，并且 AG 与 IDE 的包装格式不同：AG 是 direct base64 payload，IDE 是 wrapped base64 payload。

### Project

Project 配置保存在 `~/.gemini/config/projects/*.json`。文件名通常是 project id，内容里也有 `id`。一个典型 Git 项目结构如下：

```json
{
  "id": "project-uuid",
  "name": "repo-name",
  "projectResources": {
    "resources": [
      {
        "gitFolder": {
          "folderUri": "file:///Users/name/GitHub/repo",
          "defaultBranch": "main",
          "allowWrite": true
        }
      }
    ]
  }
}
```

已验证的行为：

- summary payload 的 `field 17 -> field 18` 决定会话在历史列表里属于哪个 Project。
- 如果 project id 不存在，或者 workspace URI 找不到可用 project，历史里会出现 orphan project link 或被归入 conversations。
- 对 Git 项目，`gitFolder.allowWrite: true` 是更接近 Antigravity 自己生成 project 的结构。本工具会补这个字段。

### Sidebar Workspaces

`state.vscdb` 里还有 `antigravityUnifiedStateSync.sidebarWorkspaces`。它记录侧边栏工作区列表。它不是 summary 本身，但会影响目标应用是否认识某个 workspace。

双向同步会合并 AG 和 IDE 的 sidebarWorkspaces。

### Workspace Storage

`workspaceStorage/<hash>/workspace.json` 记录具体 workspace，例如：

```json
{
  "folder": "file:///Users/maemolee/GitHub/code-switch-R"
}
```

每个 workspaceStorage 目录还可能包含该 workspace 的 `state.vscdb` 和扩展状态。

已验证的行为：

- 只修 project JSON 和 summary project id 不一定足够。
- 如果目标应用缺少对应 workspaceStorage，Antigravity 打开某条已归类到 Project 的会话后，可能重新写 `agyhub_summaries_proto.pb`，删除 `field 17 -> field 18`，导致这条会话被移回 conversations。
- 因此，从 IDE 迁到 AG，或者从 AG 迁到 IDE 时，目标应用需要有对应 workspaceStorage。

## 常见问题

### 历史列表数量少于 conversation 文件数量

表现：

- `conversations` 有 N 条，但历史列表只能看到更少的 Session。
- `doctor` 里出现 `conversationMissingFromAgyhub`、`agyhubMissingFromState` 或 `stateMissingFromAgyhub`。

原因：

- conversation 文件存在，但没有进入 `agyhub_summaries_proto.pb`。
- agyhub summary 存在，但没有进入 `state.vscdb` 的 `trajectorySummaries`。
- state 中残留旧 id，和 agyhub 不一致。
- IDE 的 state summary 使用 wrapped 格式，按 AG 格式写入会导致 IDE 历史弹窗异常。

工具覆盖：

- `repair summary --area <ag|ide> --apply`：为缺 agyhub summary 的 conversation 合成 summary。
- `repair state --area <ag|ide> --mirror-agyhub --apply`：把 state summary 镜像为 agyhub summary。
- `修复 Session` 按钮会同时执行 AG/IDE 的 state 修复和 summary 修复。

### IDE 有新增 Session，但暂时未入历史索引

表现：

- IDE conversation 数量多于 agyhub/state 数量。
- 新会话仍在使用中，历史健康检查显示异常。

原因：

- 正在进行中的会话可能还没有写完整 summary。
- 过早修复可能根据不完整信息合成 summary。

工具覆盖：

- 工具可以发现异常。
- 修复前应确认这条会话已经结束或至少不再被 IDE 持续写入。

### 同 ID 文件在两边几乎都不同

表现：

- `sync plan` 显示大量 raw file differences。
- 但 `contentConflicts` 为 0，很多项目显示为 `skippedSameSummary` 或 `skippedStableMetadata`。

原因：

- AG 和 IDE 对同一个 Session 的 conversation 文件或 summary 会加入本地元信息。
- field `15` 已确认是稳定本地元信息差异之一。
- 如果 canonical payload 一致，或者 summary payload 一致，不能把它当成内容冲突。

工具覆盖：

- `sync conflicts` 会区分 raw 文件差异、summary 相同、稳定元信息差异和真正内容冲突。
- 双向同步只在能判断一边更完整时覆盖。
- 无法判断的同 ID 内容冲突会复制到 conflicts 目录，不覆盖原文件。

### Session 被归入 conversations，而不是对应 Project

表现：

- summary 里有 workspace URI，但 project id 为空、`outside-of-project`，或指向不存在的 project。
- 通过工具修复后，历史列表短暂进入 Project。
- 打开 Session 后，又被应用移回 conversations。

原因：

- 缺 project JSON。
- project JSON 有对应 workspace，但结构不够接近应用自己的项目配置，例如缺 `gitFolder.allowWrite: true`。
- 目标应用缺 sidebarWorkspaces。
- 目标应用缺 workspaceStorage。这个问题已经用 `Unifying Navigation Page Layouts` 验证过：AG 的 summary project 被修好后，打开会话时 AG 又删除 project id，因为 AG 缺对应 workspaceStorage。

工具覆盖：

- `repair projects --area <ag|ide> --apply`：
  - 为缺 project id 的 summary 写入目标 project id。
  - 没有 project JSON 时创建 project JSON。
  - 修复 project JSON 的 `gitFolder.allowWrite`。
  - 从另一方复制缺失的 workspaceStorage。
  - 写入 agyhub summary 后同步 state summary。
- `修复 Session` 按钮会对 AG 和 IDE 都执行 project 修复。
- 新版双向同步也会执行同样的 project 修复。

### Project 重复或 orphan project link

表现：

- `doctor` 显示 duplicate project groups。
- `doctor` 显示 orphan summary project links。
- 同一 folderUri 下有多个 project id。

原因：

- 多次迁移、手动复制或旧项目清理后，summary 引用的 project id 已经不存在。
- 同一 folderUri 被生成过多个 project JSON。

工具覆盖：

- `doctor --all` 会统计 duplicate project groups 和 orphan summary project links。
- 当前 `repair projects` 能处理 summary project 缺失、`outside-of-project`、project id 不存在，以及缺 project JSON 的情况。
- 对重复 project 的选择和清理仍应谨慎。删除 project JSON 不属于当前自动同步的默认动作。

## 修复方法和 App 覆盖情况

| 问题 | CLI | App 覆盖 |
| --- | --- | --- |
| state 缺 summary 或 state 残留旧 summary | `repair state --area <ag|ide> --mirror-agyhub --apply` | `修复 Session` |
| conversation 缺 agyhub summary | `repair summary --area <ag|ide> --apply` | `修复 Session` |
| summary 缺 project id | `repair projects --area <ag|ide> --apply` | `修复 Session`、`双向同步` |
| project JSON 不存在 | `repair projects --area <ag|ide> --apply` | `修复 Session`、`双向同步` |
| project JSON 缺 `gitFolder.allowWrite` | `repair projects --area <ag|ide> --apply` | `修复 Session`、`双向同步` |
| 缺 workspaceStorage | `repair projects --area <ag|ide> --apply` | `修复 Session`、`双向同步` |
| 缺 sidebarWorkspaces | `sync apply --bidirectional --apply` | `双向同步` |
| 同 ID 内容冲突 | `sync conflicts`、`sync apply --bidirectional --apply` | `双向同步` |
| 大量稳定本地元信息差异 | `sync conflicts` | 只展示统计，不视作需要修复 |
| 重复 project JSON 删除 | 暂未默认自动删除 | 暂未覆盖 |

所有写入类操作都应在 Antigravity 和 Antigravity IDE 关闭后执行。App 的同步流程会在写入前关闭两个应用。CLI 默认有进程保护，`--force` 会绕过保护。

## 双向同步做了什么

`sync apply --bidirectional --apply` 的目标不是只复制 conversation 文件。为了让 Session 在目标应用可见、可打开、能留在正确 Project 下，会做以下工作：

1. AG -> IDE 单向同步缺失项：
   - 复制缺失 conversation 文件。
   - 合并缺失 agyhub summary。
   - 根据 agyhub summary 重建目标 state summary。

2. IDE -> AG 单向同步缺失项：
   - 同上。

3. 合并 sidebarWorkspaces：
   - 读取两边 `antigravityUnifiedStateSync.sidebarWorkspaces`。
   - 按 workspace URI 合并。
   - 写回缺失的一方。

4. 修复 Project 适配：
   - 对 AG 执行 `repair projects --area ag --apply`。
   - 对 IDE 执行 `repair projects --area ide --apply`。
   - 补 summary project id。
   - 创建缺失 project JSON。
   - 修 project JSON 结构。
   - 复制缺失 workspaceStorage。
   - 将 agyhub summary 镜像到 state summary。

5. 处理同 ID 内容冲突：
   - conversation 文件 hash 一致：跳过。
   - step count 不同：步数更多的一方胜出。
   - summary payload 一致：跳过。
   - 只差稳定本地元信息：跳过。
   - updatedAt 明确不同：较新一方胜出。
   - 无法判断：复制冲突副本，不覆盖原文件。

6. 写日志和备份：
   - 同步日志：`~/Library/Application Support/AgySessionTray/sync.log`
   - 覆盖备份：`~/Library/Application Support/AgySessionTray/backups/`
   - 无法判断的冲突副本：`~/Library/Application Support/AgySessionTray/conflicts/`
   - agyhub/state/project JSON 写入前会在原目录旁边生成备份。

## 当前限制

- `sync plan` 目前不会展示 project 修复预估，只展示 conversation、summary、sidebarWorkspaces 和内容冲突。实际 `sync apply --bidirectional --apply` 会执行 project 修复。
- 工具不会删除重复 project JSON。删除会影响历史归属，需要单独确认。
- 对 conversation `.pb` 正文只做复制，不做未验证字段改写。项目归属主要通过 summary、state、project JSON、sidebarWorkspaces 和 workspaceStorage 适配。
- 正在写入中的 Session 不适合立即修复。应等 AG/IDE 停止更新后再执行修复或同步。
