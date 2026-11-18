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
- **坑：pid 复用误判**。`process.kill(pid, 0)` 探活对陈旧 hub 记录可能因 pid 复用
  （如 svchost 占用该 pid）误判为存活。缓解：正常重启应用后 hub 是新的；彻底修复
  需校验 pid 进程名或 TCP 探活，列为后续改进。
- **坑：僵尸进程**。异常退出的 Antigravity.exe 可能残留 4~12MB 的半死实例，不写 hub、
  UIA 树不完整。重启应用后恢复正常。
- **坑：StartCascade 必须显式带模型**。language server 2.32.1 对客户端启动的 cascade
  报 "plan model not specified"。已在 `newConversation` 里带
  `config.plannerConfig.requestedModel`（人选的模型，否则 getModels() 第一个）。
- **坑：EPHEMERAL_MESSAGE 步骤**。MCP（如 OpenViking 记忆注入）会向轨迹注入系统通知步骤，
  且桌面端可能先翻转 DB 的 idle 标志、后写终态步骤。`turnOutcome` 已改为：
  跳过 EPHEMERAL；completed 必须有 PLANNER_RESPONSE/NOTIFY_USER 证据；仅 USER_INPUT
  后跟时保持等待（不再凭"没有错误"就猜完成）。
- agentapi 在 Windows 是 `bin/agentapi.bat`（execFile 需 shell:true，已处理）。
- 会话列表（conversation_summaries.db，bridge 查询 LIMIT 200 封顶；当前库顶层会话 241 条）、cwd（Windows 路径）、模型清单（18 个模型）与配额（81.8% ~ 100%）均真机读通，历史对话（turns/steps/artifacts）和中文/空格路径的 `file:///d:/...` 文件预览实机返回 200。`openFile` 已适配在 Windows 调用 `Antigravity.exe`。旧会话无转录且未加载时 LS 返回 404 "trajectory not found"——与上游 macOS 行为一致（上游 Limits 也承认旧会话读取靠替身覆盖），非移植回归。

### Codex（MSIX 桌面版读通道 + 模型 + 额度真机验证 ✅；IPC 管道已核实，发消息待交互窗口实测）
- 本机通过 Microsoft Store / MSIX 安装了官方 `OpenAI.Codex`（`C:\Program Files\WindowsApps\OpenAI.Codex_...\app\`，Alias `%LOCALAPPDATA%\Microsoft\WindowsApps\chatgpt-desktop.exe`）。`config.ts` 通过 `fs.readlinkSync` 解析该别名，自动发现 `resources\codex.exe`、`resources\app.asar` 与 `assets\icon.png`。
- 真机实测全通：App Server (`codex app-server --stdio`) 启动成功，读取 10 个模型、Plus 额度（2 个窗口：5h 与 weekly）、3 个项目、9 条会话（含 Codex 本地线程与 ChatGPT 模式会话/项目）与完整历史回合、887B PNG 图标和 1.3MB WebP 精灵图；页面模式切换（Codex ↔ ChatGPT）实机渲染正常。
- 通过读取本机 `app.asar`（`early-bootstrap-824` 模块 `92272`）核实 Windows 真实 IPC 管道名为 `\\.\pipe\codex-ipc`（已替换原占位名）；`wake()` 已适配 Windows `cmd.exe /c start "" "codex://threads/wake/..."`。实际发消息唤醒与在交互桌面中走完桌面端回流待桌面窗口启动后实测。

### Claude
- 本机未安装 Claude Desktop（`%APPDATA%\Claude`、`~/.claude` 均无）。适配代码就绪（authStatus 与 spawnCli 的 `.cmd` shell、`claude.exe` 候选、路径映射、Windows 下优先读取 `~/.claude/.credentials.json`），真机验证待装机。

### UIA 驱动与构建/前端实机修复
- C# 驱动（`native/win32/uia-driver`，net8.0-windows + WPF/WinForms）已修复编译产物缺少 `.exe` 后缀的问题、`hashTree` 排除 `bin`/`obj` 避免重复编译，以及在 `profiles/claude.json` / `profiles/codex.json` 补全 `win32.process`（`Program.cs` 对 `ChatGPT` 兼容探测 `Codex` 进程名）。单测与真机实测 `.exe` 均可正常启动并返回 JSON；注意在非交互沙箱终端下因窗口站隔离 `MainWindowHandle` 为 0（会报 `not_running`），需在普通交互桌面终端下驱动桌面窗口。
- 前端与构建实机修复（由真实运行浏览器检查发现）：`vite.config.ts` 在 `build` 时预先清理 `dist/server` 以消除旧 `zcode.plugin.js` 残留；`filePathOf` 与 `resolveFile` 支持 Windows 盘符路径及含中文/空格的 `file:///C:/...` 链接；`pickSpace` 切回模式时重绘新聊天欢迎页；`.kit-tool > summary` 长路径单行截断不遮挡下一行；`sidebar.ts` 按 `/` 和 `\` 分割项目名并归一化盘符大小写（`d:\` 与 `D:\` 合并）。

## 已知限制（诚实清单）
1. Codex 桌面版发消息唤醒（`codex://threads/wake/`）与命名管道（`\\.\pipe\codex-ipc`）插话、Antigravity 网页发消息实机端到端发送，待交互桌面下唤醒桌面窗口实测。
2. Claude Desktop 未装机，其 UIA 发送未真机验证（代码就绪 + 单测）。
3. ZCode/WorkBuddy 仅模板与分析文档（一期范围）。
4. `process.kill(pid,0)` 的 pid 复用误判未做进程名校验（后续改进项）。
5. CDP（DevToolsActivePort）在本机为陈旧文件，实际未开——Electron CDP 增强通道仍是可选项，未启用。
6. UIA 驱动的 `warm check` 暂无 profile 漂移巡检（Windows 侧忽略 check 参数，行为安全但无 staleControls 告警）；`send` 尚不导航会话（title/localId 未用，文本进入应用当前显示的会话，结果带 `targeted:false` 标记）——都随 Claude/Codex 桌面版真机接入补齐。
