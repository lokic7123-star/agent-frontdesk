# HANDOFF — agent-frontdesk Windows 11 移植

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
- `d36ea0b`+`0f93b2b` ZCode 模板（templates/，BRIDGE_ZCODE_PREVIEW=1 门控）+
  docs/zcode-integration.md + docs/windows-deploy.md
- `b0d2ddc` README/architecture 平台声明更新
- 测试：147/147（基线 135/145，CRLF 修复 +10）；`npm run check` 全绿

## ③ 验证方式
`npm run check && npm test`（relay wrapup 门禁 exit 0）；真机验证记录在
docs/windows-port-notes.md（hub 发现、LS RPC 200、发送到配额墙、回合证据链）。

## ④ 未决断点（按优先级）
1. Antigravity 回复文本的网页回显：账号配额 429（约 2026-11-23 重置）后，重跑 closure 类探测脚本
   （POST /api/sessions/antigravity 新建会话后轮询回合终态）补验「网页发消息→桌面回复→网页回显」全文闭环。
2. Claude Desktop / Codex 桌面版未装机：UIA 发送与 IPC 通道代码就绪，装机后真机验证
   （Codex IPC 的 Windows 管道名是占位，`CODEX_IPC_PATH` 可覆盖）。
3. ZCode 二期接入：按 docs/zcode-integration.md 取证主会话落盘 → bridge → profiles。
4. `process.kill(pid,0)` 的 pid 复用误判：改进为校验进程名或 TCP 探活。

## ⑤ 环境 注意事项
- 本仓库已设 `core.autocrlf=false`（源码测试按 LF 匹配，勿改回）。
- 终端（Git Bash）显示中文为 GBK 乱码是显示问题；用 node 脚本 + 文件中转（Read 工具
  读 UTF-8）核验中文内容。
- relay wrapup 在干净工作区会跳过台账写入；如需补台账，先落 HANDOFF.md 再收口。

## ⑥ 交叉审计补遗（2026-11-18 第二轮，提交 819419d 之后）
三个独立子代理交叉审核（提交完整性 / 门禁重跑 / 文档事实核查），全部通过，产出
以下已修复项：
- readAppIcon 支持 PNG 与 app.asar 内 /icon.png（Windows 图标原给 .exe 永远解析失败，
  现指向 resources\app.asar，真机验证 48633B PNG 读出）
- UIA send 结果带 targeted:false 并注明 title/localId 未导航的限制；粘贴超时不再误报
  成功（BorrowFocusAndPaste 返回实绩）
- contract.ts 过时注释、port-notes 补 warm-check/send 导航两条限制、README 徽章
  URL、Roadmap 标注、HANDOFF 文件名指正
- 隐私清理：Temp 下 npm test 遗留的 106 个 frontdesk-spaces-*（含桌面应用数据拷贝）
  与本次会话全部探测脚本/dump 已删除；未发现任何敏感值入库
审计确认：darwin 分支逐行等价、测试只加宽不削弱（含反例验证）、敏感信息零泄露。
