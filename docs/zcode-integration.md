# ZCode / WorkBuddy 接入分析（二期准备）

一期交付：`src/server/templates/zcode.plugin.ts`（接入模板，`BRIDGE_ZCODE_PREVIEW=1` 时
才在侧栏出现）+ 本文。目标：二期照本文把真 bridge 填进模板，走 `src/shared/contract.ts`
单文件契约，页面共用侧栏、对话、输入框与文件预览。

## 一、本机已核实的事实（2026-11-18）

| 项 | 事实 |
| --- | --- |
| 应用本体 | `D:\Zcode\ZCode.exe`（Electron；`resources\app.asar` 在旁） |
| 数据目录 | `C:\Users\LoKi\.zcode` |
| 会话（CLI 子代理） | `~/.zcode/cli/agents/sess_<uuid>/agent_<uuid>/{metadata.json, output.txt, task.output}`；metadata 含 agentId、childSessionId、createdAt、cwd（Windows 路径）、description、metadataFile |
| 应用状态 | `~/.zcode/v2/`：bot-config.v3.json、bot-state.v2/v3.json、credentials.json、config.json、logs/<日期>.log、tasks-index.sqlite(+wal/shm) |
| 工作区 | `~/.zcode/workspace/<ts-uuid>/`（每会话工作目录） |
| 记忆 | `~/.zcode/cli/memories/projects/<project-hash>/memory/`（每项目一文件一事实，含 MEMORY.md 索引） |
| UIA 树 | Electron 窗口可读（Chrome_WidgetWin_1 → RootView…）；完整 DOM 级树需 accessibility 激活，Phase 2 冒烟已确认进程发现 + 树读取可用 |
| CDP | 取决于启动参数；本机未见开启。可用快捷方式追加 `--remote-debugging-port` 打开 |

### 还需要二期现场确认的
- **主会话正文落盘**：子代理转录在 `cli/agents/**`（output.txt/task.output），主会话
  消息流的持久化位置与格式尚未核实（候选：v2/ 状态文件、tasks-index.sqlite、应用内
  IndexedDB）。接入读通道前先在此三处取证。
- **发送通道**：计划书列了两条候选，二期按此顺序裁决：
  1. `app-server --stdio`（若 ZCode CLI 暴露，与 Codex 同构，协议直连最稳）；
  2. Windows UIA（`native/win32/uia-driver` 已就绪，profiles/<engine>.json 写一份
     zcode.json 定位 composer/send，模板照 claude.json：class/快捷键为主、文本兜底）；
  3. CDP 注入（可选增强，免疫最小化与语言差异，需用户改启动参数）。
- **额度/用量**：v2/coding-plan-cache.json 疑似相关，二期核实映射到 `usage()`。

## 二、通道裁决（沿用上游原则）

桌面应用是唯一写者：能协议直连绝不 UIA；UIA 定位严禁依赖按钮显示文本（中英文界面
都要能用）；状态以应用自己的记录为准，页面不猜。`docs/architecture.md` 的三条规则
原样适用于 ZCode。

## 三、二期步骤（照做即可）

1. 取证主会话落盘（上文"还需要现场确认的"），决定读通道：转录 tail（照
   `services/jsonl-tail.ts`）或 sqlite/IndexedDB 读取（照 app-assets 的只读解析）。
2. 写 `src/server/zcode-bridge.ts`：`status/models/list/read/create/send` 必选，
   `interrupt/steer/observe/usage` 按能力开关；全部窄化自 `unknown`（`shared/guards.ts`）。
3. 写 `src/server/native/profiles/zcode.json`（若走 UIA）：先用驱动 `inspect` 导出真
   实控件树再写定位器，`probe` 验证每个 key 唯一命中。
4. 把 `templates/zcode.plugin.ts` 的 setup 换成真 bridge（照 antigravity.plugin.ts 的
   registerEngine 形状），去掉 `BRIDGE_ZCODE_PREVIEW` 门控。
5. 验收：真机闭环（网页发消息 → 桌面端静默响应 → 网页回显）+ `npm test` 用替身覆盖
   新增解析逻辑 + 中文界面可用。

WorkBuddy 同法：先取证 `%LOCALAPPDATA%\Programs\WorkBuddyAI` 与其数据目录，再走同一
模板流程。
