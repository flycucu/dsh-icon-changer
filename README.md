**【本插件代码由 DeepSeek Harness 生成】**

# dsh-icon-changer

[![check](https://github.com/flycucu/dsh-icon-changer/actions/workflows/check.yml/badge.svg)](https://github.com/flycucu/dsh-icon-changer/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[更新日志](CHANGELOG.md)

DeepSeek Harness 桌面端的**应用图标更换器**插件：把官方 exe 内嵌的图标换成你自己的 `.ico`，也能一键回退成官方默认。

> 宿主半区（`lib/index.js`，跑在 DSH 主进程里）通过 `ctx.webServer` 挂一组 API；
> 客户端半区（`lib/client.js`）往设置页注册一张卡片，所以不需要手输 URL。
> 两侧都不引入任何 npm 依赖。

## 为什么需要"退出后才换"

Windows 会锁住正在运行的可执行文件，而这个插件**就跑在它要改的那个 exe 里**。
所以 API 不会当场动手，而是：

1. 校验请求，把任务写进 `state.json` 与 `pending-job.json`
2. 用 **WMI**（`Win32_Process.Create`）拉起 worker —— 关键点：直接 `spawn` 的子进程会随应用被 job object 一起干掉，而 WMI 创建出来的进程挂在 `wmiprvse.exe` 名下，**不受应用 job object 约束**，能在应用退出后继续活着
3. worker（`bin/apply-icon.ps1`）轮询等待 exe 被释放
4. 备份 → 用 rcedit 改写图标 → **比对改前/改后/目标三者的图标指纹**
5. 指纹没变**且**不等于目标图标才自动还原并报失败；成功则（可选）重新拉起应用（应用已在跑就不重复拉）
6. **刷新 shell 图标缓存**：worker 立刻跑一次 `ie4uinit.exe -show`，并把 `pendingExplorer` 写进 `state.json`；
   应用重启后宿主侧 `reconcilePendingExplorer()` 会调 `bin/refresh-shell.ps1` 做完整刷新：
   `ie4uinit -show` → 停 Explorer → **抢删 `iconcache_16/32/48/256/wide/idx.db`** → 起 Explorer → 广播 `SHCNE_ASSOCCHANGED`

也就是说：**改图标必然伴随一次应用重启**，这是平台限制，不是偷懒。

### 任务卡住时怎么自愈（都是踩过的坑）

- **那个窗口是"只读"的**：Windows 控制台默认开着 QuickEdit，**鼠标一拖选文字就会把里面的进程暂停**（标题会多出 `选择 ` 前缀）。
  本机真踩过：worker 冻在第一步、exe 没改写、队列永远挂着。
  `run-worker.ps1` 现在启动就把控制台**输入模式整个清零**（实测 `0x01F7 → 0x0000`）：
  鼠标点击/拖选无效、键盘无效、`Ctrl+C` 也不再变成信号（`ENABLE_PROCESSED_INPUT` 关掉），
  所以点它、敲它都不会打断任务；只动输入缓冲，输出与任务本身完全不受影响。
  右上角的 `×` 仍能关闭（**关掉 = 杀掉任务**）；等应用退出的长等待型任务本来就用 `-WindowStyle Hidden` 无窗口运行。
- **下次启动自动接续**：宿主会记下 worker 的 pid（`workerPid`）。若某次启动发现"队列还在、而那个 worker 已经没了"，
  `reconcileStalledPending()` 就把任务交给重试路径，用 `-WindowStyle Hidden` 在后台重跑（实测：任务被成功补完）。
- **两个 waiter 不会打架**：任务里带 `jobId`（= 入队时间）。worker 拿到 exe 锁后先核对队列是否仍是自己那一版，
  否则打印 `SUPERSEDED` 并**什么都不改**就退出；`pendingExplorer` 也由 **worker 在真正改写成功后**设置，
  不再由宿主在"刚拉起 worker"时就提前置位（那会导致刷了缓存但图标还没换）。
- 队列里的 `pending` 显示为"上次任务没有跑完"时，可以点「取消排队」，或直接再点一次应用（新请求会覆盖它）。

> 只改 exe 而不刷缓存，图标文件是新的、shell 还在供旧位图（本机实测：exe 指纹、
> 三个快捷方式全对，桌面仍显示旧图标）。**只重启 Explorer 也不够** —— 缓存库会活下来，
> 必须删库；而 `AutoRestartShell=1` 会在杀掉 Explorer 后约 1 秒把它拉回、重新锁住文件，
> 所以删库必须"杀+抢删"带重试（`refresh-shell.ps1` 已按此实现，实测 6/6 删除成功）。

> 排查入口只有一个：`$DSH_HOME/icon-changer/helper.log`。宿主侧以 `[host]` 前缀、
> 启动器以 `[wmi-spawn]` 前缀、worker 以自己的时间戳写入，任何一环失败都能在这里看到。

## 安装

装法就是"放到磁盘上 + 挂进 profile"，仓库里没有安装脚本。先把代码取到本地：

```powershell
git clone https://github.com/flycucu/dsh-icon-changer.git "$env:USERPROFILE\.dsh\plugin-src\dsh-icon-changer"
```

然后两处链接：

1. 把插件目录挂进 profile：`mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-icon-changer" "<插件目录>"`
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里加依赖 `"dsh-icon-changer": "link:<插件目录>"`，
   并把 `dsh-icon-changer` 加进 `dsh.profile.bundles`（宿主半边靠这一条进 Loader，客户端半边靠它被 roster 扫到）

改完 `package.json` 要**重启 DeepSeek Harness**；客户端半边只在启动扫描时进入启动图，
不重启不会出现设置卡片。改动前先备份 `package.json`（它属于启动关键配置）。

卸载：从 `dsh.profile.bundles` 与依赖里删掉，再删 junction。

## 用法（设置页，推荐）

打开 **设置 → 应用图标**：

- **选图标**：内置图标（`assets/whalemaid.ico` → 显示为「鲸鱼娘（预置）」，`assets/original.ico` → 显示为「原版」）
  与已上传的图标并排显示，点一下选中；文案见宿主 `BUNDLED_LABELS`，改文案要重启应用才生效
- **上传 .ico**：宿主要求合法的 ICONDIR 头，不是 ico 会被拒（`not-an-ico`）；
  上传的图标可以配一个 `<名字>-tray.ico` 伴生文件（放 `$DSH_HOME/icon-changer/icons/`），托盘会优先用它
- **应用选中图标并重启**：排队后应用自动退出、worker 改写、再自动拉起
- **回退官方图标**：从首次更换时留下的备份还原
- **删除**：只有**未使用的外部上传图标**右上角才有 `×`（悬停显示）。内置/原版没有 `×`，
  正在使用中的那个也没有；宿主侧同样拒绝（`in-use` / `builtin-readonly`），旧页面绕不过去

每张卡片固定留出"类型词条"与"当前使用"两行的高度：上传的图标没有词条，但用等高空位占住，
免得它那张卡片比别的矮、整行看着变形。

卡片顶部常驻 **「当前图标」**，并且**默认停在应用当前真正穿着的那个图标上**
（宿主把 `state.applied.icon` 反查成图标 id 作为 `appliedId` 返回；用户手动点过别的图标后不再覆盖他的选择），
对应那张卡片还会挂一个绿色 `当前使用` 角标。卡片同时显示目标 exe 路径、排队中的任务、上次执行结果。

**更换时弹出的那个 PowerShell 窗口**：会依次显示
`正在更换图标，请勿关闭此窗口` → `正在等待应用退出…` → `正在写入新图标…` → `图标已写入，正在重新启动应用…` →
`已完成，本窗口即将自动关闭`，然后**进程退出、窗口自己关掉**（关掉窗口 = 杀掉任务，所以别手动关）。
等待用户自己退出应用的那类任务（`restart:false` / 启动补做）可能等很久，会用 `-WindowStyle Hidden` 静默运行，不弹窗。

## 用法（独立页面，备用）

`http://127.0.0.1:<端口>/icon-changer`（端口就是 Web GUI 那个，把路径换掉）。
页面上的按钮和设置卡片一一对应，UI 出问题时可以走这条。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/icon-changer/status` | exe / 备份 / 当前图标（`applied` + `appliedId`）/ 待处理任务 / 上次结果 |
| GET | `/api/icon-changer/icons` | 内置 + 已上传图标列表 |
| GET | `/api/icon-changer/log?lines=200` | `helper.log` 尾部（宿主 / 启动器 / worker 统一日志） |
| GET | `/api/icon-changer/preview/<id>` | 图标原始字节，供 `<img>` 预览 |
| POST | `/api/icon-changer/upload` | `{name, b64}`，最大 4 MiB |
| POST | `/api/icon-changer/apply` | `{icon, restart, targets}` |
| POST | `/api/icon-changer/restore` | `{restart, targets}` |
| DELETE | `/api/icon-changer/icon/<id>` | 删除上传的图标；内置/原版（`builtin-readonly`）与**正在使用中的**（`in-use`）会被拒 |
| POST | `/api/icon-changer/clear` | 清掉卡住的排队任务 |

图标 id 形如 `builtin:whalemaid.ico` 或 `user:my_icon.ico`。
所有写操作都过同源校验（`Origin` 与 `Host` 不一致直接 403）。

## 数据与回滚

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/icon-changer/state.json` | 任务与结果状态 |
| `$DSH_HOME/icon-changer/icons/` | 你上传的图标 |
| `$DSH_HOME/icon-changer/backup/DeepSeek Harness.exe.orig` | **原始 exe 备份**（首次更换时创建，只创建一次） |
| `$DSH_HOME/icon-changer/helper.log` | 宿主 / 启动器 / worker 的统一日志 |
| `$DSH_HOME/icon-changer/pending-job.json` | 交给 worker 的任务描述（宿主写、worker 读） |
| `$DSH_HOME/icon-changer/pending-job.cmdline` | 交给 WMI 创建的命令行（避免多层引号地狱） |
| `$DSH_HOME/icon-changer/spawn-result.json` | WMI 创建结果（无 BOM，供宿主判成败） |

手工回滚（插件用不了时的兜底）：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\icon-changer\backup\DeepSeek Harness.exe.orig" `
          "<你的安装目录>\DeepSeek Harness.exe" -Force
```

> 备份是在**首次更换之前**做的，所以它始终是官方原版，多次换图标也不会被覆盖成中间态。

## 结构

```
icon-changer/
  package.json          # dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 声明浏览器半边
  cordis.patch.yml      # 往 profile 插一行宿主插件
  lib/index.js          # 宿主半区：路由、状态、任务落盘、用 WMI 拉起 worker
  lib/client.js         # 客户端半区：设置页卡片（__ModuleLoader__ + React，无构建步骤）
  lib/ui.html           # 独立管理页面（备用，原生 JS）
  bin/wmi-spawn.ps1     # 启动器：读命令行文件 → Win32_Process.Create（逃出应用 job object）
  bin/run-worker.ps1    # bootstrap：读 pending-job.json → 调 apply-icon.ps1
  bin/apply-icon.ps1    # worker：等待解锁 → rcedit → 校验 → 记状态 → 可选重启
  bin/refresh-shell.ps1 # 刷 shell 图标缓存：ie4uinit → 杀 Explorer → 抢删 iconcache → 起 Explorer → 广播
  bin/console-messages.ps1 # 给 worker 窗口取中文提示（dot-source 共用）
  bin/messages.txt      # 中文提示文案（UTF-8 数据文件；脚本本体保持 ASCII-only，避免 PS 5.1 无 BOM 乱码）
  tools/rcedit-x64.exe  # rcedit 2.0.0（Electron 官方维护的 PE 资源编辑工具）
  assets/whalemaid.ico  # 内置图标
  _test_plugin.mjs      # 自测：mock cordis 上下文，真跑 /apply 全链路
```

自测（用一份**改名的 node.exe 副本**当"应用 exe"，`DSH_HOME` 指向临时目录，
所以只会改那份副本；**别传 restart:true**，那条路会 taskkill 真的应用）：

```powershell
$t = "$env:TEMP\ic-test"; New-Item -ItemType Directory -Force $t | Out-Null
Copy-Item (Get-Command node).Source "$t\DeepSeek Harness.exe"
$env:DSH_HOME = "$t\home"
& "$t\DeepSeek Harness.exe" .\_test_plugin.mjs
Get-Content "$t\home\icon-changer\helper.log"   # 等几秒，看 RESULT ok=True

# 第二阶段：证明宿主能把 worker 写的 state 读回来（BOM 回归守卫）
& "$t\DeepSeek Harness.exe" .\_test_plugin.mjs --status-only
```

只做语法检查：`npm run check`。

## 安全与信任模型

- 所有路由挂在 `ctx.webServer` 上、只监听 `127.0.0.1`，**不带 Web GUI 的 token**：本机任何进程都能调 `/apply`。
  跨源浏览器页面会被 `sameOrigin()` 挡掉（`Origin` 与 `Host` 不一致 → 403），所以拦住的是网页，不是本机程序。
  换句话说：**同用户、同机器即受信**，与"能改本机 exe 的桌面插件"这一前提一致。若你的机器上有不受信的本机程序，请自行取舍。
- 上传走 ICONDIR 头校验 + 4 MiB 上限 + 文件名净化（`basename` + 非 `\w` 压成 `_`），预览/删除都只认数据目录里的图标 id，
  不接受任意路径。
- 删内置/原版或**正在使用中**的图标会被宿主拒绝（`builtin-readonly` / `in-use`），即使绕过界面直接调接口也一样。
- 改写 exe 会**破坏该文件的代码签名**（若有），Windows SmartScreen 可能提示；官方 exe 备份在首次更换前就留下了，
  可随时整字节还原。

## 许可

本插件为 **MIT**（见 [LICENSE](LICENSE)）。随仓库分发的第三方组件与内置图标说明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：`tools/rcedit-x64.exe` 来自
[electron/rcedit](https://github.com/electron/rcedit)（MIT, Copyright (c) 2013 GitHub, Inc.）；
`assets/whalemaid*.ico` 为作者自有美术资源，`assets/original*.ico` 是官方原版应用图标（仅为方便回退而收录）。

## 已知限制

- 只在 **Windows** 上工作（依赖 WMI、PowerShell 5.1、PE 资源改写与 shell 缓存机制）。
- 只在**桌面端**工作：若 DSH 是以 `npx dsh web` 跑的（`process.execPath` 是 node.exe），`/apply` 返回 `not-desktop-app`。
- **改图标必然伴随一次应用重启**：运行中的 exe 被系统锁住，这是平台限制（流程见上文）。
- 应用升级（重装/覆盖安装）会换回官方 exe，重新应用一次即可。
- 独立页 `lib/ui.html` 只做"看状态 + 换图标/回退 + 看日志"，删除图标请走设置页卡片。

