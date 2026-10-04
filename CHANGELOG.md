# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- worker 控制台**输入模式整体清零**（实测 `0x01F7 → 0x0000`）：不只是关掉 QuickEdit，鼠标点击/拖选、键盘、
  `Ctrl+C`（`ENABLE_PROCESSED_INPUT`）全部不再交给进程，误点误按都不会打断改写；
  只影响输入缓冲，控制台输出与状态写入不受影响。

## [0.3.0] - 2026-10-05

首个正式版本：把"换图标"这条路从"看起来在跑"变成"每一条路径都验证过"。

### Added

- `GET /api/icon-changer/log?lines=N`：`helper.log` 尾部（宿主 / 启动器 / worker 统一日志）。
  独立页的"后台日志"面板此前请求了一个不存在的路由，永远是空的。
- `/status` 新增 `appliedId`：把 `state.applied.icon` 反查成图标 id。
  设置页卡片因此**默认停在应用当前穿着的图标上**，并给该图标挂「当前使用」角标。
- **任务自愈**：宿主记录 `workerPid`；若某次启动发现"队列还在、而那个 worker 已经没了"，
  自动用 `-WindowStyle Hidden` 在后台重跑（`reconcileStalledPending()`）。
- **防竞态**：任务携带 `jobId`（= 入队时间），worker 拿到 exe 锁后先核对队列是否仍是自己那一版，
  否则打印 `SUPERSEDED` 并**什么都不改**退出。多个 waiter 不会抢同一个 exe。
- `bin/refresh-shell.ps1`：完整的 shell 图标缓存刷新 ——
  `ie4uinit -show` → 停 Explorer → **抢删 `iconcache_16/32/48/256/wide/idx.db`** → 起 Explorer → 广播 `SHCNE_ASSOCCHANGED`。
- worker 窗口显示本地化进度文案（`正在更换图标，请勿关闭此窗口` → … → `已完成，本窗口即将自动关闭`），
  完成后随进程退出自动关闭；长时间等待型任务用 `-WindowStyle Hidden` 静默运行。
- `LICENSE`（MIT）、`THIRD_PARTY_NOTICES.md`（随包分发的 rcedit）、`.gitignore`、`.gitattributes`、GitHub Actions `check` 工作流。

### Fixed

- **exe 改写校验永远判定"没变化"**：`Get-IconHash` 计算哈希前没有把 `MemoryStream` 回绕到起点，
  `Get-FileHash -InputStream` 读到 0 字节，于是所有文件都哈希成空串的 SHA256，改前/改后恒等 →
  每次 apply 都被判定失败并从备份回滚。**在此之前核心功能从未真正生效**。
- **worker 被应用的 job object 一起带走**：直接 `spawn` 的子进程活不过应用退出，队列永远挂着、
  `helper.log` 空无一物。改为把任务写成文件、用 **WMI `Win32_Process.Create`** 创建（挂在 `wmiprvse.exe` 名下），
  从而在应用退出后继续完成改写并（可选）拉回应用。
- **`state.json` / `spawn-result.json` 带 UTF-8 BOM**：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM，
  宿主 `JSON.parse` 抛错后被 `readState()` 静默吞掉 → 界面永远显示"没有上次结果"、队列不可见。
  改为 .NET 无 BOM 写入，并在宿主侧剥 BOM 兜底。
- **重启应用时继承了 worker 的控制台**：窗口会一直开着（应用的 stdout 还往里面灌），
  关掉它等于给刚启动的应用发 `CTRL_CLOSE`。改为 WMI 无控制台启动。
- **点击 worker 窗口会让任务冻结**：Windows 控制台默认开启 QuickEdit，鼠标一拖选文字就暂停进程
  （标题会多出 `选择 ` 前缀）。`run-worker.ps1` 启动即清掉 QuickEdit 位（实测 `0x01F7 → 0x01B7`）。
- **删除规则**：正在使用中的图标返回 `in-use`、内置/原版返回 `builtin-readonly`；
  界面只在"未使用的上传图标"上显示 `×`。
- 上传的图标不显示类型词条时布局会矮一截 → 类型行与角标行在所有卡片上等高占位。
- `apply-icon.ps1` 硬编码 `C:\Windows\System32\ie4uinit.exe` → 改用 `$env:SystemRoot`。
- 日志尾部首字符带 BOM → 读取时剥掉。

### Changed

- 刷新 shell 不再阻塞插件启动（原先 `spawnSync` 最长卡 45 秒）：改为 WMI 一次性派发，脚本自写日志。
- `pendingExplorer` 改由 **worker 在真正改写成功后**置位，不再由宿主"刚拉起 worker"时就提前置位
  （那会导致刷了缓存而图标还没换）。
- WMI 启动流程抽成 `spawnDetachedViaWmi()`，worker 与 shell 刷新复用。
- 移除未使用的 import（`copyFileSync`、`execFile`）。
- 独立管理页与设置页卡片对齐：预选 `appliedId`、标「当前使用」、`已应用` 不再把内置原版说成"自定义图标"。
- 文档：安装/HTTP API/数据与回滚/结构/安全与信任模型/已知限制 全面重写。

## [0.2.0] - 2026-10-04

插件骨架：宿主半区挂 `ctx.webServer` 路由（`/status` `/icons` `/preview` `/upload` `/apply` `/restore` `/clear`）、
客户端半区往设置页注册卡片、独立页 `lib/ui.html`、rcedit 改写 + 备份回退、Explorer 重启式兜底刷新。

该版本的 exe 校验、worker 存活、状态文件读写三处关键路径存在缺陷（详见 0.3.0 的 Fixed），
因此**核心功能实际不可用**，仅作为历史记录保留。

[0.3.0]: https://github.com/flycucu/dsh-icon-changer/releases/tag/v0.3.0
