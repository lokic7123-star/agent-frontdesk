# Windows 11 部署指南

## 要求

- Windows 10/11 x64，Node.js ≥ 22.16（本机验证 24.x）
- 静默发送引擎（Claude/Codex 桌面通道）需要 .NET SDK 8（本机验证 8.0.428）；
  只用 Antigravity 通道时不需要（协议直连）
- Git 克隆本仓库时先执行 `git config core.autocrlf false`（源码测试按 LF 匹配）

## 启动

```sh
git clone <本仓库>
cd agent-frontdesk
git config core.autocrlf false
npm ci
npm start
```

打开 <http://127.0.0.1:4100>。装了哪个桌面应用，哪个 AI 出现在左侧一栏
（Codex/Claude 需各自桌面版；本机未装则如实显示未安装）。

首次对 Claude/Codex 桌面发消息时，服务会用 `dotnet publish` 编译 UIA 驱动
（几秒），产物按源码哈希缓存在 `%LOCALAPPDATA%\agent-frontdesk\`，之后直接复用。

## 环境变量（全部可选）

| 变量 | 用途 | Windows 默认（本仓库新增行为） |
| --- | --- | --- |
| `HOST` / `PORT` | 监听地址/端口 | `127.0.0.1` / `4100` |
| `CODEX_BIN` | Codex 可执行文件 | 解析 MSIX 别名 `%LOCALAPPDATA%\Microsoft\WindowsApps\chatgpt-desktop.exe` 定位 `resources\codex.exe`，否则依次试 PATH 中的 `codex`、`codex.cmd`、`codex.exe` 及 `%LOCALAPPDATA%\Programs\ChatGPT\resources\codex-cli\bin\codex.exe` |
| `CODEX_HOME` | Codex 数据目录 | `~/.codex` |
| `CODEX_IPC_PATH` | Codex 桌面版 IPC 端点（Windows） | `\\.\pipe\codex-ipc`（已从 `OpenAI.Codex` 应用核实） |
| `CLAUDE_BIN` | Claude Code 可执行文件 | PATH 里的 `claude`/`claude.cmd`/`claude.exe`、`~/.local/bin/claude.exe`、`%APPDATA%\Claude\claude-code\` 下 |
| `CLAUDE_HOME` | Claude Code 会话目录 | `~/.claude` |
| `CLAUDE_DESKTOP_HOME` | Claude 桌面应用数据目录 | `%APPDATA%\Claude` |
| `CLAUDE_APP_ASAR` | Claude 桌面应用 asar | `%LOCALAPPDATA%\Programs\Claude\resources\app.asar` |
| `CHATGPT_APP_ASAR` | ChatGPT / Codex 桌面应用 asar | `%LOCALAPPDATA%\Programs\ChatGPT\resources\app.asar` 或 MSIX `OpenAI.Codex` 包内 `app\resources\app.asar` |
| `ANTIGRAVITY_HOME` | Antigravity 数据目录 | `~/.gemini/antigravity` |
| `ANTIGRAVITY_APP_ICON` | Antigravity 图标来源 | `%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe` |
| `AGENTAPI_BIN` | Antigravity 命令行工具 | `~/.gemini/antigravity/bin/agentapi.bat`（本机核实存在的就是 .bat） |
| `ZCODE_APP_ASAR` / `ZCODE_HOME` | ZCode 模板探测用 | `%LOCALAPPDATA%\Programs\Zcode\resources\app.asar`（或 `D:\Zcode\resources\app.asar`） / `~/.zcode` |
| `BRIDGE_ZCODE_PREVIEW` | `1` 时侧栏出现 ZCode 模板项（未实现引擎，启用会给出二期提示） | 不显示 |
| `BRIDGE_DEFAULT_CWD` / `BRIDGE_UPLOADS_DIR` / `BRIDGE_SETTINGS_FILE` / `BRIDGE_PLUGIN_DIR` / `BRIDGE_MODEL_CATALOG` / `BRIDGE_DICTATION_ENGINE` / `HTTPS_PORT` | 同上游 README | 同上游 |

## 各桌面应用在 Windows 上的现状（诚实清单）

| 应用 | 读历史 | 发消息 | 状态 |
| --- | --- | --- | --- |
| Antigravity | 本机数据库 + 语言服务器（`hub_<port>.json` 发现，Windows 原样可用） | 语言服务器直连（协议，已真机验证模型/配额/历史/预览） | ✅ 读通道、配额、历史、文件预览、前端展示全通；实机网页发消息待交互窗口确认 |
| Codex | 桌面版的 app-server（支持 MSIX `OpenAI.Codex`） | 消息队列 + 窗口间 IPC（`\\.\pipe\codex-ipc`）+ `codex://threads/wake/` + UIA | ✅ 读历史、模型、Plus 额度、图标/精灵图、ChatGPT 模式实机验证通过；发消息唤醒待交互桌面实测 |
| Claude | Claude Code 会话转录 + 桌面索引 | UIA 引擎（win32 上 dotnet 编译的 uia-driver） | 桌面版装机后启用；凭据读 `~/.claude/.credentials.json`（Windows 无 keychain） |
| ZCode / WorkBuddy | 二期（见 docs/zcode-integration.md） | 二期 | 模板就绪，`BRIDGE_ZCODE_PREVIEW=1` 可见 |

## 常见问题

- **侧栏里某个 AI 不出现**：detect 只看安装位置与数据目录；环境变量可显式指路。
- **UIA 发送失败 `no_composer`**：Electron 的 accessibility 树未激活——把目标应用
  窗口正常打开一次，或用驱动 `inspect <深度>` 看真实控件树，再补
  `src/server/native/profiles/<engine>.json` 的定位器。
- **窗口最小化时发送不稳**：驱动会 `SW_SHOWNOACTIVATE` 唤醒；若仍失败，托盘驻留类
  应用（窗口销毁型最小化）需要真窗口。CDP 增强通道是后续选项。
- **首次 dotnet 编译慢**：正常，只发生一次（缓存按源码哈希失效）。
