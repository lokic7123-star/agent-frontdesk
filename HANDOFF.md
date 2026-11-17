# HANDOFF — agent-frontdesk Windows 11 移植

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
- `d36ea0b`+`0f93b2b` ZCode 模板（templates/，BRIDGE_ZCODE_PREVIEW=1 门控）+
  docs/zcode-integration.md + docs/windows-deploy.md
- `b0d2ddc` README/architecture 平台声明更新
- 测试：147/147（基线 135/145，CRLF 修复 +10）；`npm run check` 全绿

## ③ 验证方式
`npm run check && npm test`（relay wrapup 门禁 exit 0）；真机验证记录在
docs/windows-port-notes.md（hub 发现、LS RPC 200、发送到配额墙、回合证据链）。

## ④ 未决断点（按优先级）
1. Antigravity 回复文本的网页回显：账号配额 429（约 2026-11-23 重置）后，重跑
   `/tmp/final-closure.mjs` 类流程补验「网页发消息→桌面回复→网页回显」全文闭环。
2. Claude Desktop / Codex 桌面版未装机：UIA 发送与 IPC 通道代码就绪，装机后真机验证
   （Codex IPC 的 Windows 管道名是占位，`CODEX_IPC_PATH` 可覆盖）。
3. ZCode 二期接入：按 docs/zcode-integration.md 取证主会话落盘 → bridge → profiles。
4. `process.kill(pid,0)` 的 pid 复用误判：改进为校验进程名或 TCP 探活。

## ⑤ 环境 注意事项
- 本仓库已设 `core.autocrlf=false`（源码测试按 LF 匹配，勿改回）。
- 终端（Git Bash）显示中文为 GBK 乱码是显示问题；用 node 脚本 + 文件中转（Read 工具
  读 UTF-8）核验中文内容。
- relay wrapup 在干净工作区会跳过台账写入；如需补台账，先落 HANDOFF.md 再收口。
