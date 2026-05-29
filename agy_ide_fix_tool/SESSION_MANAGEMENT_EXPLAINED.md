# Antigravity Session 管理科普

这篇文章解释 Antigravity 和 Antigravity IDE 是怎么管理 Session 的。

它不假设你熟悉 protobuf、SQLite 或 VS Code state。你只需要知道：Antigravity 不是把一条聊天记录存在一个地方就完事。它会把同一条 Session 的信息分别写到几个文件里。只要这些文件之间没有对上，界面里就可能出现“历史不见了”“Session 掉到 conversations 里”“Project 归属错了”“两边数量不一致”等问题。

## 先把几个词说清楚

### Antigravity 和 Antigravity IDE

现在本工具把它们当成两个产品实例：

- `Antigravity`：工具里简称 `ag`
- `Antigravity IDE`：工具里简称 `ide`

它们很像，但数据目录不一样。你可以把它们理解成两套独立的本地资料柜。两边可能各有一批 Session，也可能同一个 Session 同时存在于两边。

### Session

Session 就是一段聊天工作记录。

从用户视角看，它是历史列表里的一条记录。点进去能看到对话、工具调用、文件操作等内容。

从磁盘视角看，一条 Session 通常不是一个文件，而是至少由三部分组成：

1. conversation 文件：真正的会话内容。
2. agyhub summary：给历史列表看的摘要。
3. state summary：给应用界面状态用的摘要副本。

这三部分的编号必须一致。这个编号叫 `cid`，也就是 conversation id。

### Project

Project 是 Antigravity 里的项目条目。它通常对应一个代码目录，比如：

```text
/Users/you/GitHub/my-app
```

Antigravity 不只按目录路径识别 Project。它会给每个 Project 生成一个 id。很多历史归属问题都和这个 id 有关。

### Workspace

Workspace 更接近“打开过的工作目录”。它通常用 URI 表示，例如：

```text
file:///Users/you/GitHub/my-app
```

Project 和 Workspace 很接近，但不是同一个概念：

- Workspace 说的是“这个 Session 和哪个目录有关”。
- Project 说的是“这个目录在 Antigravity 的项目列表里是哪一个项目条目”。

如果 Session 知道 workspace，但不知道对应的 Project，它可能会显示在普通 conversations 下，而不是显示在具体 Project 下。

## 一条 Session 需要同时记在三本账上

可以把 Antigravity 的 Session 管理想成三本账。

第一本账：conversation 文件。

它放在：

```text
~/.gemini/antigravity/conversations/
~/.gemini/antigravity-ide/conversations/
```

文件名通常长这样：

```text
<cid>.pb
<cid>.db
```

这是真正的聊天内容。只要这个文件还在，聊天内容通常没有丢。

第二本账：`agyhub_summaries_proto.pb`。

它放在：

```text
~/.gemini/antigravity/agyhub_summaries_proto.pb
~/.gemini/antigravity-ide/agyhub_summaries_proto.pb
```

它像一本历史目录。里面记录每条 Session 的标题、时间、步数、workspace、project id 等摘要信息。

第三本账：`state.vscdb` 里的 `trajectorySummaries`。

它放在：

```text
~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb
~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb
```

这是 VS Code 系应用常见的状态数据库。Antigravity 会把历史摘要也存一份在这里，供界面读取。

所以，一条健康的 Session 应该满足：

```text
conversation 文件里有这个 cid
agyhub summary 里有这个 cid
state summary 里也有这个 cid
```

如果三本账数量不一样，界面就可能异常。

## 常见字段是什么意思

下面这些字段不需要死记。理解它们分别负责什么就够了。

### `cid`

`cid` 是 Session 的身份编号。

conversation 文件名会用它：

```text
abc123.pb
abc123.db
```

agyhub summary 和 state summary 里也会用它。

如果 conversation 文件存在，但 summary 里没有同一个 `cid`，用户会感觉“聊天记录文件还在，但历史列表看不到”。

### `title`

标题。也就是历史列表里显示的名称。

标题可能来自几个地方：

- Antigravity 已经保存过的标题。
- brain 目录里的 markdown 标题。
- 根据时间和 cid 生成的临时标题。

标题错了通常不代表聊天内容丢了，只是摘要信息不完整。

### `step count`

步数。可以粗略理解为这条 Session 里有多少轮记录。

它有两个用途：

- 帮助判断一条 Session 是否完整。
- 当 AG 和 IDE 两边都有同一个 `cid`，但文件不同，可以用步数判断哪边更像新版本。

如果一边 20 步，另一边 35 步，35 步那边通常更完整。

但这不是绝对规则。工具只在差异足够明确时才会覆盖另一边。

### `updatedAt`

更新时间。

历史列表排序通常和时间有关。如果时间字段缺了，Session 可能排到奇怪的位置。

修复时可以从 conversation 文件的修改时间推断一个时间，但这属于从现有证据恢复，不等同于官方原始时间。

### `workspace URI`

它表示这条 Session 和哪个工作目录有关。

例子：

```text
file:///Users/you/GitHub/my-app
```

也可能是远程 workspace：

```text
vscode-remote://ssh-remote+server/path/to/project
vscode-remote://wsl+Ubuntu/home/user/project
```

如果 workspace URI 缺失，Antigravity 就不知道这条 Session 属于哪个目录。

### `project id`

这是 Project 的身份编号。

它不是目录路径，而是 Antigravity 给 Project 条目分配的 id。

summary 里通常有一个 project link。里面至少会关心两个值：

```text
workspace URI
project id
```

workspace URI 说明“这个 Session 和哪个目录有关”。

project id 说明“这个目录在 Project 列表里对应哪个项目条目”。

如果 project id 不存在，或者指向一个已经没有 JSON 文件的 Project，这条 Session 就可能变成 orphan project link。界面表现通常是：它不在正确 Project 下，或者被放回普通 conversations。

### `outside-of-project`

这是一个特殊值，意思是“不属于任何 Project”。

它不一定是错误。比如你开了一个临时会话，没有绑定项目，那就可能是正常的。

但如果一条 Session 明明有 workspace URI，却被写成 `outside-of-project`，那就很可能是 Project 归属丢了。

### `projectResources.resources[].gitFolder.folderUri`

这个字段在 Project JSON 里。

它表示这个 Project 对应哪个 Git 目录：

```json
{
  "gitFolder": {
    "folderUri": "file:///Users/you/GitHub/my-app"
  }
}
```

工具会用它把 workspace URI 对应到 Project。

### `gitFolder.allowWrite`

这个字段也在 Project JSON 里。

更接近 Antigravity 自己生成的 Git Project 结构通常带：

```json
{
  "allowWrite": true
}
```

如果缺这个字段，有些场景下 Project 看起来存在，但应用不完全认可它。工具会把它修成 `true`。

### `sidebarWorkspaces`

它在 `state.vscdb` 里。

它不是 Session 摘要本身，而是侧边栏认识的 workspace 列表。

如果 summary 已经写了 workspace 和 project id，但目标应用的 `sidebarWorkspaces` 里没有这个 workspace，界面仍然可能表现异常。

### `workspaceStorage`

它是 VS Code 系应用的工作区状态目录，通常在：

```text
~/Library/Application Support/Antigravity/User/workspaceStorage/
~/Library/Application Support/Antigravity IDE/User/workspaceStorage/
```

每个 workspaceStorage 目录里常见一个：

```text
workspace.json
```

里面会写：

```json
{
  "folder": "file:///Users/you/GitHub/my-app"
}
```

这个文件告诉目标应用：“我认识这个 workspace。”

如果缺它，修好的 Project 归属可能只是暂时有效。打开 Session 后，Antigravity 可能重新写 summary，把 project id 去掉，Session 又回到 conversations。

## 常见问题是怎么发生的

### 1. conversation 文件还在，但历史列表看不到

表现：

- `conversations` 目录里有 `.pb` 或 `.db` 文件。
- Antigravity 历史列表里没有这些 Session。
- 工具检查时看到 `conversationMissingFromAgyhub`。

发生方式：

conversation 文件已经存在，但 `agyhub_summaries_proto.pb` 里没有同一个 `cid`。

可以理解为：正文还在，但目录里没有登记。

修复方式：

- 从 conversation 文件、brain 文件、transcript 里找标题、时间、workspace。
- 合成一条 agyhub summary。
- 再把 state summary 调整到和 agyhub summary 一致。

对应命令：

```bash
node agy_ide_fix_tool/src/cli.js repair summary --area ide --apply
node agy_ide_fix_tool/src/cli.js repair state --area ide --mirror-agyhub --apply
```

### 2. agyhub 有记录，但 state 里没有

表现：

- `agyhub_summaries_proto.pb` 里有这条 Session。
- `state.vscdb` 的 `trajectorySummaries` 里没有。
- 历史列表数量可能少于 agyhub 数量。

发生方式：

agyhub 这本账已经登记了，但界面读的 state 那本账没跟上。

修复方式：

把 state summary 按 agyhub summary 重建。

对应命令：

```bash
node agy_ide_fix_tool/src/cli.js repair state --area ide --mirror-agyhub --apply
```

注意：AG 和 IDE 的 state summary 包装格式不同。不能把 AG 的格式直接写给 IDE。工具里已经区分了两种格式。

### 3. state 里有旧记录，但 agyhub 里没有

表现：

- `stateMissingFromAgyhub` 不为 0。
- 历史状态里可能残留已经失效的 Session。

发生方式：

state 这本账里留着旧条目，agyhub 那本账已经没有了。

修复方式：

让 state 和 agyhub 保持一致。工具会把 state summary 镜像成 agyhub summary。

### 4. Session 掉到 conversations，而不是 Project

表现：

- Session 还在历史里。
- 但它不在正确 Project 下。
- 它可能出现在普通 conversations 区域。

发生方式通常有几种：

- summary 里没有 project id。
- project id 是 `outside-of-project`。
- project id 指向的 Project JSON 已经不存在。
- Project JSON 存在，但和 workspace URI 对不上。
- 目标应用缺少 `sidebarWorkspaces` 或 `workspaceStorage`。

修复方式：

工具会按 workspace URI 找 Project。

如果找得到：

- 把 summary 里的 project id 改成正确的 Project id。
- 检查 Project JSON 是否需要调整，比如 `allowWrite`。
- 同步 state summary。

如果找不到：

- 创建一个新的 Project JSON。
- 把 summary 指向新 Project。
- 同步 state summary。

如果另一边有对应 workspaceStorage：

- 复制到当前 area。

对应命令：

```bash
node agy_ide_fix_tool/src/cli.js repair projects --area ag --apply
node agy_ide_fix_tool/src/cli.js repair projects --area ide --apply
```

### 5. Project 重复

表现：

Project 侧边栏里出现很多同名项目，例如：

```text
my-app
my-app 2
my-app 3
my-app 4
```

发生方式：

Antigravity 给同一个目录生成了多个 Project id。它们的 `folderUri` 一样或等价，但 id 不同。

修复方式要谨慎。

只删除重复 Project JSON 可能会让原本挂在那些 project id 下的 Session 找不到归属。更合适的顺序是：

1. 先找出哪些 Session 指向重复 Project id。
2. 把这些 Session 的 project id 改到保留的 Project id。
3. 确认 agyhub、state、可能的 conversation 引用都改好了。
4. 再删除重复 Project JSON。

当前 `agy_ide_fix_tool` 不默认删除重复 Project JSON。原因是这个操作对历史归属影响很大，需要单独判断。

根目录的 `index.js merge` 对重复 Project 做得更激进：它会扫描 conversation、agyhub、state 等位置，把重复 project id 改到保留项，再删除能安全删除的重复项。

### 6. AG 和 IDE 两边 Session 数量不同

表现：

- Antigravity 有 100 条。
- Antigravity IDE 有 120 条。
- 两边历史不一致。

发生方式：

两个产品实例的数据目录不同。你可能在 IDE 里产生了新 Session，但 AG 里没有。也可能反过来。

修复方式：

双向同步不是只复制 conversation 文件。完整同步需要：

1. 复制缺失 conversation 文件。
2. 合并缺失 agyhub summary。
3. 重建目标 state summary。
4. 合并 sidebarWorkspaces。
5. 修复 Project 归属。
6. 处理同 ID 内容冲突。

对应命令：

```bash
node agy_ide_fix_tool/src/cli.js sync plan
node agy_ide_fix_tool/src/cli.js sync apply --bidirectional --apply
```

### 7. 同一个 cid，两边文件都在，但内容不同

表现：

- AG 和 IDE 都有同一个 `cid`。
- 文件 hash 不一样。
- 但这不一定代表内容冲突。

发生方式：

AG 和 IDE 可能会在本地文件里写入各自的本地元信息。也就是说，两个文件二进制不同，但聊天内容可能等价。

工具会分几种情况：

- 文件 hash 一样：跳过。
- step count 不同：步数更多的一方通常更完整。
- summary payload 一样：认为内容层面一致。
- 只差稳定本地元信息：跳过。
- updatedAt 明确一边更新：较新的一边更可信。
- 无法判断：不覆盖，把冲突副本复制出来。

对应命令：

```bash
node agy_ide_fix_tool/src/cli.js sync conflicts
```

## 工具里的检查项怎么读

运行：

```bash
node agy_ide_fix_tool/src/cli.js doctor --all
```

你会看到一些计数。

### `conversations`

conversation 文件数量。

它代表磁盘上真正有多少个 Session 文件。

### `agyhub summaries`

agyhub summary 数量。

它代表历史摘要目录里登记了多少个 Session。

### `state summaries`

state.vscdb 里的 summary 数量。

它代表界面状态里记录了多少个 Session。

健康情况下，这三个数字通常应该一致。

### `conversation missing from agyhub`

conversation 文件存在，但 agyhub summary 缺失。

用户感知通常是：聊天内容还在，但历史列表不显示。

### `agyhub missing conversation file`

agyhub summary 有记录，但 conversation 文件不存在。

用户感知可能是：历史里有条目，但打开不了，或数据不完整。

### `agyhub missing from state`

agyhub 里有，state 里没有。

修复方式通常是重建 state summary。

### `state missing from agyhub`

state 里有，agyhub 里没有。

修复方式通常也是让 state 重新跟随 agyhub。

### `orphan summary project links`

summary 里写了 project id，但 Project JSON 里找不到这个 id。

用户感知通常是：Session 不在正确 Project 下，或者显示位置异常。

### `duplicate project groups`

多个 Project JSON 指向同一个目录。

这就是 Project 重复问题。

## 修复动作分别在改什么

### `repair state --mirror-agyhub`

改的是：

```text
state.vscdb / trajectorySummaries
```

它做的事：

- 读取 agyhub summaries。
- 按当前 area 的格式生成 state summaries。
- 写入 state.vscdb。
- 写完重新读取校验。

适用问题：

- agyhub 和 state 数量不一致。
- state 里有旧摘要。
- state 缺摘要。

### `repair summary`

改的是：

```text
agyhub_summaries_proto.pb
state.vscdb / trajectorySummaries
```

它做的事：

- 找出 conversation 文件里有、agyhub 里没有的 `cid`。
- 尝试从 brain markdown、transcript、conversation 文件时间推断摘要。
- 能推断的就生成 summary。
- 再同步 state。

适用问题：

- conversation 文件还在，但历史不显示。

不适合的情况：

- 正在写入中的新 Session。因为信息可能还没完整写完。

### `repair projects`

改的可能包括：

```text
agyhub_summaries_proto.pb
state.vscdb / trajectorySummaries
~/.gemini/config/projects/*.json
workspaceStorage/
```

它做的事：

- 找出 project id 缺失或失效的 summary。
- 根据 workspace URI 找 Project。
- 找不到就创建 Project JSON。
- Project JSON 缺 `allowWrite` 时修正。
- 目标 area 缺 workspaceStorage 时，从另一边复制。
- 写完 agyhub 后同步 state。

适用问题：

- Session 掉到 conversations。
- Project 归属丢失。
- Project id 指向不存在的 Project。
- 打开 Session 后又被应用移回 conversations。

### `sync apply --bidirectional`

改的范围最大。

它会处理：

- AG 缺 IDE 的 Session。
- IDE 缺 AG 的 Session。
- 两边 summary 数量不同。
- 两边 state summary 不一致。
- 两边 sidebarWorkspaces 不一致。
- Project 归属适配。
- 同 ID 内容冲突。

适用问题：

- 同时使用 Antigravity 和 Antigravity IDE 后，两边历史不一致。

使用前建议先看：

```bash
node agy_ide_fix_tool/src/cli.js sync plan
node agy_ide_fix_tool/src/cli.js sync conflicts
```

## 为什么修复前要关闭应用

Antigravity 运行时可能正在写这些文件：

- conversation `.db`
- `.db-wal`
- `agyhub_summaries_proto.pb`
- `state.vscdb`
- workspaceStorage 里的状态

如果工具写入时应用也在写，结果可能互相覆盖。

所以写入前应该关闭 Antigravity 和 Antigravity IDE。

App 版会尝试先关闭两个应用。CLI 有进程保护。`--force` 可以绕过，但只适合你明确知道应用没有在写数据的时候使用。

## 为什么有些问题不能直接自动删

最典型的是重复 Project。

重复 Project 看起来只是侧边栏多了几个条目，但每个条目背后都有不同 project id。某些 Session 可能正指向这些 id。

如果直接删除重复 Project JSON，Session 本身不会被删除，但它的 Project 归属可能失效。

所以更安全的判断方式是：

- 能证明 Session 已经改到保留 Project，再删除旧 Project。
- 不能证明，就保留旧 Project，让历史还能被找到。

这也是 `agy_ide_fix_tool` 不默认删除重复 Project JSON 的原因。

## 一个简单判断表

| 你看到的现象 | 大概是哪本账出问题 | 优先检查 |
| --- | --- | --- |
| 聊天文件在，但历史看不到 | agyhub summary 缺记录 | `doctor --all` |
| 历史数量和文件数量不同 | agyhub/state 不一致 | `repair state` 或 `repair summary` |
| Session 不在 Project 下 | project id、Project JSON、workspaceStorage | `repair projects` |
| 打开后又回到 conversations | workspaceStorage 或 sidebarWorkspaces 缺失 | `repair projects`、双向同步 |
| AG 和 IDE 历史不同 | 两边数据目录不同步 | `sync plan` |
| 同 ID 文件不同 | 可能是本地元信息，也可能是真冲突 | `sync conflicts` |
| Project 出现一堆重复项 | 同目录多个 Project id | 先分析引用，再清理 |

## 最后怎么记

可以这样理解：

一条 Session 想在正确 Project 下稳定出现，必须同时满足三件事：

1. 内容还在：conversation 文件存在。
2. 历史认识它：agyhub summary 和 state summary 都有同一个 `cid`。
3. Project 认识它：summary 里的 workspace 和 project id 能对应到真实 Project、sidebarWorkspaces、workspaceStorage。

如果只满足第一点，聊天内容可能还在，但历史看不到。

如果满足第一点和第二点，历史可能看得到，但 Project 归属可能不对。

三点都满足，Session 才更可能在正确 Project 下稳定显示。
