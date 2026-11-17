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
- 会话列表（conversation_summaries.db，bridge 查询 LIMIT 200 封顶；当前库顶层会话 241 条）、cwd（Windows 路径）、模型清单
  均真机读通。旧会话无转录且未加载时 LS 返回 404 "trajectory not found"——与上游
  macOS 行为一致（上游 Limits 也承认旧会话读取靠替身覆盖），非移植回归。
- 发送链路实测到账号配额墙（RESOURCE_EXHAUSTED 429，约 131h 后重置）：桌面记录的
  回合生命周期（completed 空回复/failed 错误）如实回传网页。回复文本待配额重置后补验。

### Codex
- `~/.codex` 数据目录在本机完整在用（config.toml、sessions、sqlite 等约 80 项），
  读通道可真机验证；桌面版（ChatGPT app）未安装，IPC 通道（`ipc.sock`/命名管道）
  待桌面版装机后验证。`CODEX_IPC_PATH` 环境变量已预留。

### Claude
- 本机未安装 Claude Desktop（`%APPDATA%\Claude`、`~/.claude` 均无）。适配代码就绪
  （authStatus 的 .cmd shell、`claude.exe` 候选、路径映射），真机验证待装机。

### UIA 驱动（Phase 2）
- C# 驱动（native/win32/uia-driver，net8.0-windows + WPF/WinForms）与 Swift helper
  同协议（一行 JSON）。真机冒烟：进程发现 + UIA 树读取对运行中的 Electron 应用全通。
- Electron 的完整 DOM 级 UIA 树需要 accessibility 激活；`inspect` 深度不够时只见原生
  壳层（Chrome_WidgetWin_1 → RootView）。composer 定位需更深层级或先触发 accessibility。
- dotnet publish 首次数秒，产物按源码树哈希缓存在 `%LOCALAPPDATA%\agent-frontdesk\`。

## 已知限制（诚实清单）
1. Antigravity 回复文本的网页回显待配额重置（约 2026-11-23）后补验。
2. Claude Desktop / Codex 桌面版未装机，其 UIA 发送与 IPC 通道未真机验证（代码就绪 + 单测）。
3. ZCode/WorkBuddy 仅模板与分析文档（一期范围）。
4. `process.kill(pid,0)` 的 pid 复用误判未做进程名校验（后续改进项）。
5. CDP（DevToolsActivePort）在本机为陈旧文件，实际未开——Electron CDP 增强通道
   仍是可选项，未启用。
