# Session 归属修复 UI 调整需求

## 背景

当前 macOS App 已有两类操作：

- `修复 Session`：修历史索引、summary、state，同时目前也顺带执行 project 修复。
- `双向同步`：同步 AGY 和 IDE 两边的 Session，并执行 project 适配。

现在需要把 `Session 归属修复` 作为独立入口露出。原因是：Session 从 Project 里掉回 `conversations` 并不等于会话内容坏了，它是 Project 归属异常。用户不应该为了修这个问题去点语义更重的 `双向同步`，也不应该依赖 hover 才知道该做什么。

## 目标

1. 主界面直接展示 Session 归属相关统计，不依赖 hover。
2. 增加独立按钮：`修复归属`。
3. `修复 Session` 和 `修复归属` 都不需要二次确认。
4. `修复归属` 只做 Project/归属相关修复，不做完整双向同步。
5. 保持现有 `双向同步` 的二次确认。
6. 排版需要平铺信息，但不能让窗口显得拥挤或高度失控。

## 术语

界面文案统一用：

- `归属异常`：summary/project/workspaceStorage/sidebarWorkspaces 任一归属适配项需要处理。
- `修复归属`：按钮名。
- `Session 归属`：统计面板标题。

不要把这类问题直接叫 `Session 损坏`。

## 主界面信息架构

建议主窗口从上到下：

1. Header
2. Overview tiles
3. AG / IDE 两个产品状态面板
4. `Session 归属` 面板
5. `同步计划` 面板
6. 最近结果 / 错误
7. 底部 action bar

### Overview tiles

当前 4 个 tile 可以保留，但第 4 个 `待处理` 建议改为包含归属异常：

- `Antigravity`
- `Antigravity IDE`
- `索引健康`
- `待处理`

`待处理` 的值应为：

```text
覆盖 + 分叉 + 归属异常
```

detail：

```text
同步 X / 归属 Y
```

这里的 `同步 X` 可用 `pendingOverwriteCount + pendingForkCount`。

### Session 归属面板

新增一个独立面板，放在产品状态面板下面、同步计划上面。

标题：

```text
Session 归属
```

副标题：

```text
修复掉出 Project、无效 Project、缺工作区状态的问题
```

右侧状态 pill：

- `健康`：归属异常总数为 0，绿色
- `需修复`：归属异常总数大于 0，橙色
- `读取中`：还没有数据，蓝色或灰色

面板内容平铺展示，不依赖 hover。建议两列或三列紧凑排版：

| 指标 | 含义 |
| --- | --- |
| `缺 Project` | summary 里 project id 为空或 `outside-of-project` |
| `无效 Project` | summary 指向的 project id 不存在 |
| `项目文件待修` | project JSON 结构需要补，例如 `gitFolder.allowWrite` |
| `工作区状态待补` | 目标应用缺 workspaceStorage |
| `侧边栏待补` | sidebarWorkspaces 缺 workspace |

如果数据结构暂时无法区分 `缺 Project` 与 `无效 Project`，可以先合并为 `Project 待修`，但面板文案要保留未来拆分空间。

统计建议 AG / IDE 都显示，避免用户只看到总数不知道哪边有问题：

```text
AG 缺 Project 0
IDE 缺 Project 0
AG 项目文件待修 0
IDE 项目文件待修 0
AG 工作区状态待补 0
IDE 工作区状态待补 0
侧边栏待补 0
```

如果 SwiftUI 空间太紧，可以做成：

左侧 `AG` 一组，右侧 `IDE` 一组，底部单独一行 `侧边栏待补`。

### 同步计划面板

保留现有信息，但避免和归属面板重复：

- `项目列表待同步` 可以保留，指 sidebarWorkspaces。
- 如果新增 `Session 归属` 面板已经展示 `侧边栏待补`，这里可以保留但不需要突出。

## 按钮设计

底部 action bar 建议：

左侧：

- `刷新`
- `查看日志`
- `备份`
- `分叉副本`

中间修复类：

- `修复 Session`
- `修复归属`

右侧：

- `双向同步`（蓝色主按钮，保留确认弹窗）
- `退出`

### 修复 Session

点击后直接执行，不弹确认。

语义：

- 修 state summary
- 修 missing summary
- 不需要承担 Project 归属修复的主要入口

实现上如果暂时仍会调用 project repair，不算阻塞，但 UI 上要把 `修复归属` 作为更清晰的入口。

### 修复归属

点击后直接执行，不弹确认。

语义：

- 不复制 conversation。
- 不做同 ID 内容冲突处理。
- 不执行完整双向同步。
- 执行 AG / IDE 的 project repair。
- 如需要，为了归属稳定同步 sidebarWorkspaces。

建议 ViewModel 增加：

```swift
func repairAttribution() async
```

内部调用：

```swift
runner.repairProjects(area: "ag")
runner.repairProjects(area: "ide")
```

如果已有 CLI 能力同步 sidebarWorkspaces 只能通过完整 sync，先不要偷偷调用完整 sync。可以先只修 project repair，并在统计中继续显示 sidebarWorkspaces 待同步。后续如需要，再补窄范围 CLI。

执行成功后的最近结果文案：

```text
归属修复完成：项目归属 2 条，项目文件 1 个，工作区状态 1 个
```

没有问题时：

```text
归属检查完成，未发现需要修复的项目
```

失败时：

```text
归属修复失败：<错误信息>
```

## 数据来源

当前已有：

- `doctor --all --json`
- `sync plan --json`
- `repair projects --area ag --json`
- `repair projects --area ide --json`

要展示归属统计，需要新增只读读取方式。优先方案：

1. 在 `ToolRunner` 增加 dry-run 方法：

```swift
func projectRepairPlan(area: String) async throws -> ProjectRepairResult
```

调用：

```bash
repair projects --area ag --json
repair projects --area ide --json
```

不带 `--apply`。

2. `StatusViewModel.refresh()` 同时读取 AG / IDE 的 project repair plan。

3. Models 需要能 decode `ProjectRepairResult.items`。至少要读：

```swift
struct ProjectRepairItem: Decodable {
    let cid: String
    let title: String?
    let workspaceUri: String?
    let projectMissing: Bool?
    let projectJsonNeedsRepair: Bool?
    let workspaceStorageNeedsCopy: Bool?
}
```

4. ViewModel 根据 items 计算：

- `agProjectMissingCount`
- `ideProjectMissingCount`
- `agProjectFileRepairCount`
- `ideProjectFileRepairCount`
- `agWorkspaceStorageRepairCount`
- `ideWorkspaceStorageRepairCount`
- `attributionIssueCount`

sidebarWorkspaces 继续来自 `syncPlan.counts.sidebarWorkspacesMissingInAg / sidebarWorkspacesMissingInIde`。

## 布局要求

- 不依赖 hover。
- 不新增说明型大段文字。
- 面板文案短，统计直接可见。
- 保持窗口默认高度内能看到主要内容和底部按钮。
- 不要嵌套卡片。
- 卡片圆角保持 8px 或更小。
- 按钮文字不要挤压或截断。
- `修复归属` 不用蓝色主按钮，使用普通 bordered button。
- `双向同步` 继续是主按钮。

## 验收标准

1. `swift build --scratch-path /tmp/agy-session-tray-build` 通过。
2. `./build.sh` 通过。
3. 主界面有 `Session 归属` 面板。
4. `修复归属` 按钮可见，点击不弹二次确认。
5. `修复 Session` 点击不弹二次确认。
6. `双向同步` 仍会弹二次确认。
7. 健康状态下归属统计显示为 0。
8. `修复归属` 在健康状态下执行后，最近结果显示无需修复，不产生错误。
9. `git diff` 不包含无关格式化或 unrelated 改动。

## 给 Claude Code 的执行指令

你在 `/Users/maemolee/GitHub/antigravity-projects-fix` 工作。请按 `agy_ide_fix_tool/SESSION_ATTRIBUTION_UI_REQUIREMENTS.md` 调整 macOS App UI。

重点：

- 新增独立 `Session 归属` 面板，平铺展示 AG/IDE 的归属修复统计。
- 新增底部按钮 `修复归属`，不弹确认，只执行 project repair。
- `修复 Session` 也不弹确认。
- `双向同步` 保留确认。
- 不要改无关文件。
- 完成后运行 `swift build --scratch-path /tmp/agy-session-tray-build`。
- 不要提交，由 Codex 验收后提交。
