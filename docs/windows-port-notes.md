# Windows 11 移植日志（windows-port 分支）

基于上游 Phz-06/agent-frontdesk @ 2f923a0（2026-11-18 移植）。事实均来自本机实测，
推测处已标注。随移植推进持续更新。

## 已验证事实

### 环境基线
- Windows 11（10.0.26300）+ Node 24.19 + npm 11.17 + Git 2.55 + .NET SDK 8.0.428 + PowerShell 7.6。
- `npm run check`（3 份 tsconfig + vite build）与 `npm test` 在 Windows 原生通过（Swift 文件不参与编译）。

### Git 换行符（已修复）
- Git for Windows 默认 `core.autocrlf=true` 会把源文件 checkout 成 CRLF，破坏上游
  静态正则测试（直接匹配 Swift 源码文本）。本仓库已设 `core.autocrlf=false`。
  克隆本 fork 时同样需要；已列入部署指南。

### Antigravity（真机验证 ✅，读通道全通；发送链路通到配额墙）
- LS 发现机制平台无关：`~/.gemini/antigravity/daemon/hub_<port>.json`（pid/httpPort/csrfToken）
  在 Windows 上原样工作，正常启动会写新 hub 文件。
- **已修复：陈旧 hub PID 复用误判**。旧版仅凭 `process.kill(pid, 0)` 探活，对陈旧 hub 记录可能因 pid 复用
  （如 `svchost` 占用该 pid）误判存活。现 `lsEnv()` 校验 `Number.isInteger(pid) && pid > 0` 与合法端口范围
  （`1..65535`），带 2 秒 `lsCache` 与 30 秒 `pidCache`，并在 Windows 下对非本进程的 `pid` 用 `tasklist`
  校验进程名匹配 `language_server|antigravity|codeium|node`；`listConversations()` 也只在必要时触发校验。
- **坑：僵尸进程**。异常退出的 Antigravity.exe 可能残留 4~12MB 的半死实例，不写 hub、
  UIA 树不完整。重启应用后恢复正常。
- **坑：StartCascade 必须显式带模型**。language server 2.32.1 对客户端启动的 cascade
  报 "plan model not specified"。已在 `newConversation` 里带
  `config.plannerConfig.requestedModel`（人选的模型，否则 getModels() 第一个）。
- **坑：EPHEMERAL_MESSAGE 步骤**。MCP（如 OpenViking 记忆注入）会向轨迹注入系统通知步骤，
  且桌面端可能先翻转 DB 的 idle 标志、后写终态步骤。`turnOutcome` 已改为：
  跳过 EPHEMERAL；completed 必须有 PLANNER_RESPONSE/NOTIFY_USER 证据；仅 USER_INPUT
  后跟时保持等待（不再凭"没有错误"就猜完成）。
- **已修复：`agentapi.bat` 与 Windows 路径归一化**。`agentapi` 在 Windows 是 `bin/agentapi.bat`，现统一通过
  `config.ts` 的 `winSpawnArgs()` 走 `cmd.exe /d /s /c` + `windowsVerbatimArguments: true` 转义调用，移除
  `shell: true` 以消除 Node 24 `DEP0190` 警告与换行截断；`editedFile()` 改为 `/[\\/]\.system_generated[\\/]/`
  同时拦截正反斜杠内部路径，`parseRecords()` 对比 `uploadOf()` 与 `media[].uri` 时统一做 `file://` 解码和正反斜杠/盘符大小写归一化。
- 会话列表（conversation_summaries.db，bridge 查询 LIMIT 200 封顶；当前库顶层会话 241 条）、cwd（Windows 路径）、模型清单（18 个模型）与配额（81.8% ~ 100%）均真机读通，历史对话（turns/steps/artifacts）和中文/空格路径的 `file:///d:/...` 文件预览实机返回 200。`openFile` 已适配在 Windows 调用 `Antigravity.exe`。旧会话无转录且未加载时 LS 返回 404 "trajectory not found"——与上游 macOS 行为一致（上游 Limits 也承认旧会话读取靠替身覆盖），非移植回归。

### Codex（MSIX 桌面版读通道 + 模型 + 额度真机验证 ✅；IPC 管道已核实，发消息待交互窗口实测）
- 本机通过 Microsoft Store / MSIX 安装了官方 `OpenAI.Codex`（`C:\Program Files\WindowsApps\OpenAI.Codex_...\app\`，Alias `%LOCALAPPDATA%\Microsoft\WindowsApps\chatgpt-desktop.exe`）。`config.ts` 通过 `fs.readlinkSync` 解析该别名，自动发现 `resources\codex.exe`、`resources\app.asar` 与 `assets\icon.png`，且 `.exe`/`.cmd`/`.bat` 优先于无扩展名 npm shim；`app-server` 经 `winSpawnArgs()` 启动。
- 真机实测全通：App Server (`codex app-server --stdio`) 启动成功，读取 10 个模型、Plus 额度（2 个窗口：5h 与 weekly）、3 个项目、9 条会话（含 Codex 本地线程与 ChatGPT 模式会话/项目）与完整历史回合、887B PNG 图标和 1.3MB WebP 精灵图；页面模式切换（Codex ↔ ChatGPT）实机渲染正常。`codex-projects.ts` 与 `codex-bridge.ts` 已补齐反斜杠与盘符大小写归一化。
- 通过读取本机 `app.asar`（`early-bootstrap-824` 模块 `92272`）核实 Windows 真实 IPC 管道名为 `\\.\pipe\codex-ipc`（已替换原占位名）；`wake()` 已适配 Windows `cmd.exe /d /s /c` + `windowsVerbatimArguments: true` 调用 `start "" "codex://threads/wake/..."`。实际纯文本发送、唤醒与桌面端回流待交互桌面窗口实测；UIA 侧建聊/改模型仍返回 `unsupported`。

### Claude
- 本机未安装 Claude Desktop（`%APPDATA%\Claude`、`~/.claude` 均无），真机验证待装机。适配代码已就绪：`claude.plugin.ts` 已把 `config.claudeBin` 传入 `ClaudeBridge`；`findClaudeBin()` 与 `config.ts` 均优先探测 `.exe`/`.cmd`/`.bat`（避免命中 npm POSIX shim）、`~/.local/bin/claude.exe` 及 `%APPDATA%\Claude\claude-code`，同时保留显式 `bin: null`；`authStatus` 与 `spawnCli` 改用 `winSpawnArgs()` 消除 `DEP0190`，`loginCommand` 正确拆分 Windows `PATH` 盘符冒号；凭据在 Windows 下优先读取 `~/.claude/.credentials.json`。

### UIA 驱动与构建/前端实机修复
- C# 驱动（`src/server/native/win32/uia-driver/Program.cs`，net8.0-windows + WPF/WinForms）：
  - 已在入口设置 `Console.InputEncoding = Console.OutputEncoding = new UTF8Encoding(false)`，修复中文 Windows（ACP/OEMCP 936）下输出与标准输入中文乱码，单测与 `.exe` 实机启动返回 JSON 正常（非交互沙箱终端下因窗口站隔离 `MainWindowHandle` 为 0 会报 `not_running`，需在普通交互桌面终端下驱动桌面窗口）。
  - 当前实现 **6 个命令**：`check`、`warm`、`inspect`、`probe`、纯文本 `send`、`stop`。其余命令（`new`、`settings`、`new-shown`、`new-controls`、`new-pick`、`new-leave`、`open-file`、`show-session`、`send-now`、`answer`、`card`、`action` 及全部 `chat-*`）以及携带 `--model`/`--effort`/`--mode`/`steer` 的 `send` 均明确返回 `unsupported`（不再静默忽略设置参数）。
  - `FindByWay` 已拒绝 macOS 专属定位键（`keys`/`url`/`subrole`/`popup`/`has`/`named`/`roles`）、`inside` 容器为空时立即返回空集（不再回退到全窗搜索），并支持 `class` 字符串数组与后缀通配符（如 `ViewToggle-*`）；`BorrowFocusAndPaste` / `BorrowFocusAndKey` 补齐剪贴板重试、发送后等待再还原前台并返回真实发送状态；`FindAppRoot` 统一释放所有 `Process` 句柄并在 `FromHandle` 前先唤醒最小化窗口。
  - `DesktopAutomation`（`desktop-automation.ts`）按 `process.arch` 选择 `win-arm64` / `win-x64`，为并发 `dotnet publish` 隔离 `BaseIntermediateOutputPath` 并清理临时目录，`prune()` 补齐递归清理。
- 前端与构建修复：`vite.config.ts` 在 `build` 时清理 `dist/server` 与 `dist/shared`；`renderers.ts` 的 `filePathOf` 先 `decodeSafe` 再剥离 `file://localhost/` 与前导 `/`，支持含中文/空格的 Windows 盘符路径内联代码；`sidebar.ts` 导出 `repoKey()` 将 `\` 转为 `/`、小写盘符并保留 `c:/` 盘根；`app.ts`/`kit.ts`/`new-options.ts` 统一按 `/[\\/]/` 切分 basename、`diffCard` 归一化 `cwd` 剥离与 `repoKey` 对比；`i18n.ts` 补齐 Win32 UIA 驱动全部报错翻译，`kit.css`/`style.css` 修复窄屏输入框重叠与长路径溢出。

## 已知限制（诚实清单）
1. Codex 桌面版纯文本发消息唤醒（`codex://threads/wake/`）与命名管道（`\\.\pipe\codex-ipc`）插话、Antigravity 网页发消息实机端到端发送，待交互桌面下唤醒桌面窗口实测。
2. Claude Desktop 未装机，其 UIA 发送未真机验证（代码与 `CLAUDE_BIN` 传递就绪 + 单测通过）。
3. ZCode/WorkBuddy 仅模板与分析文档（模板位于 `src/server/templates/zcode.plugin.ts`，默认不被 `PluginHost` 加载，需复制到 `src/server/plugins/` 后才可预览）。
4. UIA 驱动（`Program.cs`）目前仅实现 `check`、`warm`、`inspect`、`probe`、纯文本 `send`、`stop`；`new`、模型/推理/权限/模式切换、`steer`、卡片操作、`open-file`、`show-session` 与 `chat-*` 均返回 `unsupported`。
5. CDP（DevToolsActivePort）在本机为陈旧文件，实际未开——Electron CDP 增强通道仍是可选项，未启用。
6. UIA 驱动的 `warm check` 暂无 profile 漂移巡检（Windows 侧忽略 `check` 参数，行为安全但无 `staleControls` 告警）；`send` 尚不导航会话（`title`/`localId` 未用，文本进入应用当前显示的会话，结果带 `targeted:false` 标记）——都随后续 UIA 补全一并实现。
