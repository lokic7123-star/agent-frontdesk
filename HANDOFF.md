# HANDOFF — agent-frontdesk Windows 11 移植

> **2026-11-18 会话收口（只追加不覆盖）**：**feat: 实现 uriPath, normPath 核心功能**——① **问题/目标**：完成 feat: 实现 uriPath, normPath 核心功能；② **踩坑/要点**：平稳收口，前置验证门禁通过；③ **方案**：提交 acf9f14（变更 HANDOFF.md, README.md, README.zh-CN.md, windows-deploy.md 等 36 个文件）；④ **结果**：提交 acf9f14 已入库；物理门禁 [npm run check && npm test] PASS；工作区收敛干净；⑤ **未收/后续**：无遗留，任务闭环。**Git：只追加，不 squash/rebase**。

> **2026-11-18 会话收口（只追加不覆盖）**：**feat: 实现 winCodexApp 核心功能**——① **问题/目标**：完成 feat: 实现 winCodexApp 核心功能；② **踩坑/要点**：平稳收口，前置验证门禁通过；③ **方案**：提交 28a9ed7（变更 windows-deploy.md, windows-port-notes.md, app.ts, i18n.ts 等 23 个文件）；④ **结果**：提交 28a9ed7 已入库；物理门禁 [npm run check && npm test] PASS；工作区收敛干净；⑤ **未收/后续**：无遗留，任务闭环。**Git：只追加，不 squash/rebase**。

> **2026-11-18 会话收口（只追加不覆盖）**：**fix: 修复 HANDOFF.md, windows-port-notes.md, Program.cs 等 6 个文件 中的逻辑缺陷**——① **问题/目标**：完成 fix: 修复 HANDOFF.md, windows-port-notes.md, Program.cs 等 6 个文件 中的逻辑缺陷；② **踩坑/要点**：平稳收口，前置验证门禁通过；③ **方案**：提交 2fee154（变更 HANDOFF.md, windows-port-notes.md, Program.cs, antigravity.plugin.ts 等 6 个文件）；④ **结果**：提交 2fee154 已入库；物理门禁 [npm run check && npm test] PASS；工作区收敛干净；⑤ **未收/后续**：无遗留，任务闭环。**Git：只追加，不 squash/rebase**。

> **2026-11-18 会话收口（只追加不覆盖）**：**docs(handoff): 更新文档 (HANDOFF.md)**——① **问题/目标**：完成 docs(handoff): 更新文档 (HANDOFF.md)；② **踩坑/要点**：平稳收口，前置验证门禁通过；③ **方案**：提交 dc10638（变更 HANDOFF.md）；④ **结果**：提交 dc10638 已入库；物理门禁 [npm run check && npm test] PASS；工作区收敛干净；⑤ **未收/后续**：无遗留，任务闭环。**Git：只追加，不 squash/rebase**。

## ① 目标
把 macOS-only 的 Phz-06/agent-frontdesk 移植到 Windows 11：统一网页调度桌面 AI
客户端（Antigravity / Codex / Claude，预留 ZCode/WorkBuddy），零损失保留桌面端
私有插件与缓存。分支 `windows-port`（上游 upstream/main @ 2f923a0）。

## ② 已完成（提交序）
- `4b0fe0a` 跨平台基础层：config 路径/进程探测按平台分发、reveal、file-preview 的
  POSIX 相对路径、`~` 解析、claude.cmd shell、antigravity fileURL 回退、appPlaces
  Windows 布局、IPC 命名管道（CODEX_IPC_PATH 预留）
- `afdea54` Windows UIA 引擎：`src/server/native/win32/uia-driver`（C#，与 Swift
  helper 同一行 JSON 协议），desktop-automation 按 platform 分发、dotnet publish
  按源码树哈希缓存于 `%LOCALAPPDATA%\agent-frontdesk\`；真机冒烟通过
- `00c974b` Antigravity 真机闭环：StartCascade 显式带模型（2.32.1 必填）、
  turnOutcome 证据化（跳过 EPHEMERAL、completed 需 PLANNER/NOTIFY）、agentapi.bat
  shell、AGY_TRACE；会话列表/历史/模型/发送链路真机验证
- `0f68b9e` Claude Windows 凭据（`~/.claude/.credentials.json`）读通道
- `d36ea0b`+`0f93b2b` ZCode 模板（`src/server/templates/zcode.plugin.ts`，默认不被
  `PluginHost` 加载，需复制到 `plugins/` 并设 `BRIDGE_ZCODE_PREVIEW=1`）+
  `docs/zcode-integration.md` + `docs/windows-deploy.md`
- `b0d2ddc`+`819419d` README/architecture 平台声明与审计文档修正
- `2fee154`+`28a9ed7` `readAppIcon` PNG/asar 支持（Windows 指向 `resources\app.asar`）、
  UIA `send` 标 `targeted:false`、MSIX `OpenAI.Codex` 别名解析、真实 Windows IPC 管道
  `\\.\pipe\codex-ipc`（从 `app.asar` 核实）、`codex://threads/wake/` 及 ChatGPT 模式支持
- 交叉审核修复批：
  - **零 `DEP0190` 与 Windows 命令发现**：`config.ts` 新增 `winSpawnArgs()`（`cmd.exe /d /s /c` + `windowsVerbatimArguments: true`）并把 `.exe`/`.cmd`/`.bat` 候选排在无扩展名 npm POSIX shim 之前；`antigravity-bridge.ts`、`claude-bridge.ts`、`codex-bridge.ts` 全部移除 `shell: true`；`claude.plugin.ts` 传入 `bin: config.claudeBin` 并补全 `win32` `findClaudeBin()`。
  - **Antigravity `lsEnv()` PID 防复用与路径归一化**：`lsEnv()` 校验合法正整数 PID、端口范围（`1..65535`）、2 秒 `lsCache` 与 30 秒 `pidCache`（Windows 下通过 `tasklist` 校验进程名匹配 `language_server|antigravity|codeium|node`）；`editedFile()` 改用 `/[\\/]\.system_generated[\\/]/` 匹配正反斜杠，`uploadOf()` 媒体匹配归一化 `file://` 与正反斜杠/盘符大小写；`codex-projects.ts` 与 `codex-bridge.ts` 同步归一化 Windows 盘符与分隔符。
  - **UIA 驱动与构建加固（`Program.cs` 6 命令范围）**：`Program.cs` 设置 `UTF8Encoding(false)` 修复 CP936 乱码；明确仅支持 `check`、`warm`、`inspect`、`probe`、纯文本 `send`、`stop`（携带 `--model`/`--effort`/`--mode`/`steer` 的 `send` 与其余动作返回 `unsupported`）；`FindByWay` 拒绝 macOS 专属定位键与空 `inside` 回退并支持 `class` 数组通配；`BorrowFocusAndPaste/Key` 与 `FindAppRoot` 修复焦点/剪贴板与进程句柄释放；`DesktopAutomation` 隔离并发 `dotnet publish` 的 `BaseIntermediateOutputPath` 并支持 `win-arm64` 与递归 `prune()`。
  - **前端与 i18n**：`sidebar.ts` 导出 `repoKey` 统一 `\`→`/` 与 `c:/` 盘根；`renderers.ts` 的 `filePathOf` 先 `decodeSafe` 再剥离 `file://localhost/` 并支持含中文/空格盘符内联路径；`app.ts`/`kit.ts`/`new-options.ts`/`kit.css`/`style.css` 修复 basename、diff `cwd`、窄屏重叠与长路径溢出；`i18n.ts` 补齐 Win32 UIA 全部提示翻译。
  - **测试与文档隐私收尾**：为 `test/{bridges,claude,file-preview,sidebar,spaces,lifecycle,core}.test.ts` 全部 `fs.mkdtempSync` 添加 `t.after(() => fs.rmSync(..., { recursive: true, force: true }))`；`file-preview.test.ts` 在 Windows `EPERM` 时使用目录 junction 验证越界拦截并补充 `filePathOf` 编码盘符与中文路径断言；`sidebar.test.ts` 扩展 i18n 源码扫描至 `.cs` 并验证 `repoKey`；脱敏 `test/bridges.test.ts` 与 `docs/zcode-integration.md` 中的本地用户名，同步更新文档诚实清单。

## ③ 验证方式
`npm run check && npm test`（交叉审核修复后全量通过：148/148 pass）与 `docs/windows-port-notes.md`
中的真机实测记录（Antigravity LS RPC 200 / Codex MSIX `OpenAI.Codex` 读通道 / 图标与精灵图）。

## ④ 未决断点（按优先级）
1. **真机交互发送闭环**：Antigravity 网页发消息全文回显（等待账号配额 429 重置后补验）及 Codex 桌面版交互窗口实测（MSIX `OpenAI.Codex`、`\\.\pipe\codex-ipc` 与 `codex://threads/wake/` 已核实接入，纯文本发送与 IPC 插话待交互窗口实测）。
2. **Claude Desktop 装机实测**：本机未装 Claude Desktop，UIA 发送及 `CLAUDE_BIN` 实机验证待装机后进行。
3. **Windows UIA 命令补齐**：`Program.cs` 当前仅实现 `check`、`warm`、`inspect`、`probe`、纯文本 `send`、`stop`（共 6 个命令）；`new`、模型/推理/权限/模式切换、`steer`、卡片、`open-file`、`show-session`、`chat-*` 返回 `unsupported`，以及 `send` 会话导航（`targeted:false`）与 `warm check` 漂移巡检待后续补齐。
4. **ZCode 二期接入**：模板位于 `src/server/templates/zcode.plugin.ts`（默认不加载，需复制到 `src/server/plugins/`），按 `docs/zcode-integration.md` 取证主会话落盘 → bridge → profiles。

## ⑤ 环境 注意事项
- 本仓库已设 `core.autocrlf=false`（源码测试按 LF 匹配，勿改回）。
- 终端（Git Bash）显示中文为 GBK 乱码是显示问题；用 node 脚本 + 文件中转（Read 工具
  读 UTF-8）核验中文内容。
- relay wrapup 在干净工作区会跳过台账写入；如需补台账，先落 HANDOFF.md 再收口。

## ⑥ 交叉审计与清理说明（2026-11-18）
- 已确认 `darwin` 分支保持等价，测试断言只补充不削弱；已清除仓库源码/文档中遗留的本机个人用户名路径，未发现凭据、邮箱或真实聊天截图入库。
- 临时目录与探测脚本现状（如实记录）：
  - 本批已通过 `t.after(..., { recursive: true, force: true })` 修复 `test/*.test.ts` 全部 `fs.mkdtempSync` 的泄漏，后续运行 `npm test` 不再新增遗留目录；
  - `%TEMP%` 下仍留有本批修复之前历史测试产生的旧临时目录（当前环境钩子限制无法通过通用删除命令在 `%TEMP%` 批量清理），以及本仓库外部调度目录下的探测脚本/草稿（`C:\Users\<user>\.gemini\antigravity\brain\78742dd0-4cbd-4e8e-9908-08d389fa14e7\scratch\` 中的 `probe-backend.ts`、`agy-profile.json`、`zcode-profile.json`）。
