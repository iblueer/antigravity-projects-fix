# agy_ide_fix_tool

本目录是新的 Antigravity 会话管理工具原型。

当前能力：

- `doctor`：只读检查 `Antigravity` / `Antigravity IDE` 的会话、agyhub summary、state summary 和项目重复情况。
- `sync plan`：只读比较两边会话和 summary 的差异，为双向同步做计划。
- `repair state --mirror-agyhub`：把指定 area 的 `state.vscdb` summary 计划为镜像同 area 的 `agyhub_summaries_proto.pb`。默认只预览，`--apply` 才写入。

已验证场景：

- `Antigravity IDE -> Antigravity` 单向同步缺失会话。
- 同步后两边 `conversations`、`agyhub summaries`、`state summaries` 都为 109。
- `sync plan` 中两边缺失项为 0。

## 使用

```bash
node agy_ide_fix_tool/src/cli.js doctor --all
node agy_ide_fix_tool/src/cli.js sync plan
node agy_ide_fix_tool/src/cli.js sync plan --from ide --to ag
node agy_ide_fix_tool/src/cli.js sync apply --from ide --to ag
node agy_ide_fix_tool/src/cli.js repair state --area ide --mirror-agyhub
node agy_ide_fix_tool/src/cli.js repair state --area ag --mirror-agyhub
```

真正写入：

```bash
node agy_ide_fix_tool/src/cli.js repair state --area ide --mirror-agyhub --apply
node agy_ide_fix_tool/src/cli.js sync apply --from ide --to ag --apply
```

写入会先备份 `state.vscdb`，写后重新解析验证。验证失败会恢复备份。

## 当前限制

- `sync apply` 目前只支持单向复制缺失会话，并更新目标 agyhub/state。默认只预览。
- `repair state` 目前只修 state summary，不改 conversation 文件和项目配置。
- 同 id 的 conversation 文件在 `Antigravity` 与 `Antigravity IDE` 中大小不同，后续同步实现不能直接覆盖。
- 写入前应关闭 Antigravity / Antigravity IDE。写入命令已接入主进程保护，可用 `--force` 绕过。
