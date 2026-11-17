// The interface in two languages. Chinese is the source: every label is written in Chinese
// where it is drawn and passed through t(); English is looked up here by that Chinese text.
// A text with no entry stays Chinese, so a missing translation never breaks the page.
// Only the workbench's own words are translated: chats, titles, and what an engine or the
// server reports are shown as they are.
//   t('新建聊天')                              → 'New chat'
//   t('{label} 剩 {percent}%', { label, percent })   placeholders are filled in after lookup
// The language is read once when the page loads (settings change it and reload the page).
// Until the person picks one in settings it follows the browser: Chinese for a Chinese browser,
// English for any other. Outside a page (tests, the server) it is Chinese, the language texts are written in.
export const language: 'zh' | 'en' = (() => {
  try {
    if (typeof window === 'undefined') return 'zh';
    const picked = window.localStorage?.getItem('desktop-bridge:lang');
    if (picked === 'en' || picked === 'zh') return picked;
    return /^zh\b/i.test(window.navigator?.language || 'zh') ? 'zh' : 'en';
  } catch { return 'zh'; }
})();
export const locale = language === 'en' ? 'en-US' : 'zh-CN';

// English is written for the place each text appears in (a button, a status line, an error),
// not word for word from the Chinese.
const EN: Record<string, string> = {
  '正在从桌面版读这张卡片的按钮…': "Reading this card's buttons from the desktop app…",
  // time and usage
  '今天': 'Today', '昨天': 'Yesterday', '{days}天': '{days}d', '每周': 'Weekly', '小时': 'hr', '5 小时': '5 hr',
  '{label} 剩 {percent}%': '{label}: {percent}% left', '正在读取额度': 'Checking usage', '正在读取额度…': 'Checking usage…',
  '额度未公开': 'Usage not available', '额度暂不可用': 'Usage unavailable right now', '即将重置': 'Resets soon', '{n} 分钟后重置': 'Resets in {n} min',
  '{n} 小时后重置': 'Resets in {n} hr', '{time} 重置': 'Resets {time}', '额度': 'Usage',
  '显示引擎实际返回的剩余额度与重置时间，自动更新；未提供数据的引擎以原客户端为准': 'Limits are reported by each app and refresh automatically. If one is missing, check that app directly.',
  // engine dock
  '正在思考…': 'Thinking…', '在这儿，随时可以开始': 'Ready when you are', '正在工作': 'working', '{n} 条新消息': '{n} unread', '就绪': 'idle', '切换到': 'Switch to',
  '引擎快捷切换': 'Your AIs', '快速切换引擎': 'Switch AI', '正在连接引擎…': 'Connecting…', '接入新的桌面 AI': 'Add a desktop AI',
  // agents on and off (the rail's "+", settings, and the page shown while none is on)
  '添加 Agent': 'Add an agent', '管理 Agent…': 'Manage agents…', '从 Agent 栏移除': 'Remove from the rail', '启用 {name}': 'Turn on {name}',
  '打开开关，这个 Agent 就接上它的桌面版，出现在 Agent 栏里。关掉只是把它从工作台拿走，桌面版和里面的聊天不受影响。': 'Turn an agent on to connect it to its desktop app and add it to the rail. Turning it off only takes it out of Frontdesk; the desktop app and its chats are untouched.',
  '已启用': 'On', '已启用 · 桌面版已连接': 'On · desktop app connected', '已启用 · 桌面版没连上': "On · desktop app isn't reachable", '已启用 · 桌面版没连上：{reason}': "On · desktop app isn't reachable: {reason}",
  '未启用': 'Off', '未启用 · 这台电脑上有它的桌面版': 'Off · its desktop app is on this computer', '未启用 · 这台电脑上没找到它的桌面版': "Off · its desktop app wasn't found on this computer",
  '正在接上它的桌面版…': 'Connecting to its desktop app…', '正在移除…': 'Removing…', '没能启用：{reason}': "Couldn't turn it on: {reason}", '这个工作台还没有集成任何 Agent': 'No agents are built into this Frontdesk yet',
  '工作台正跟着 {name} 的 {n} 轮任务，移除后它会在桌面版里继续跑，只是这里不再显示。': "Frontdesk is following {n} running turn(s) of {name}. They keep running in the desktop app; they just won't show here.",
  '还有 {n} 条消息排着队等发给 {name}，移除后它们不会发出。': "{n} queued message(s) for {name} won't be sent.",
  '先留着': 'Keep it', '仍然移除': 'Remove anyway',
  // an agent's name, faces and place in the rail (settings)
  '正在保存…': 'Saving…', '自己的图片': 'Your picture', '默认形象': 'Default', '更换': 'Replace', '上传': 'Upload', '恢复默认': 'Reset',
  '上传 {name} {state}时的头像': 'Upload the {state} picture for {name}', '名称': 'Name', '头像图片': 'Avatar', '空闲': 'Idle', '工作中': 'Working', '顺序': 'Order',
  'PNG、JPEG、GIF、WebP，最大 2 MB。静态图会居中裁成正方形；想让工作中的头像动起来，可以传 GIF。只传空闲图时，工作中也用它，外圈照常转。': 'PNG, JPEG, GIF or WebP, up to 2 MB. Still pictures are cropped to a centred square; for a working face that moves, use a GIF. With only an idle picture, it is used while working too, with the usual ring.',
  '上移': 'Move up', '下移': 'Move down', '也可以拖动左边的把手。Agent 栏和 ⌥ 数字键按这个顺序。': 'Or drag the handle on the left. The rail and the ⌥ number keys follow this order.',
  '拖动调整顺序': 'Drag to reorder', '编辑 {name} 的名称和头像': 'Edit the name and avatar of {name}', '编辑名称、头像和顺序': 'Edit name, avatar and order',
  '这张图片读不出来': "This picture can't be read", '只支持 PNG、JPEG、GIF、WebP 图片': 'Only PNG, JPEG, GIF and WebP pictures are supported', '图片不能超过 2 MB': 'Pictures can be up to 2 MB',
  '先接上一个 Agent': 'Connect your first agent',
  'Agent Frontdesk 是桌面版 AI 的远程窗口。打开一个 Agent 的开关，就能在这里看它的聊天、给它发消息，任务仍由它的桌面版执行。': 'Agent Frontdesk is a remote window onto your desktop AI apps. Turn an agent on to read its chats and message it from here. The work still runs in its desktop app.',
  '接入其他桌面 AI': 'Connect another desktop AI', '接入其他桌面 AI…': 'Connect another desktop AI…', '列表里没有的，把一段提示词发给它，它会照着手册自己接进来': "Not listed? Send it a prompt and it connects itself, following the guide",
  // sidebar
  // new chat cards (what the desktop's New session page asks for)
  '在「{name}」里开始新聊天': 'Start a new chat in {name}', '发出第一条消息，聊天就在桌面版的「{mode}」模式里建好，用桌面版那里的模型和设置。': "Send the first message and the chat is made in the desktop app's {mode} mode, with the model and settings it has there.",
  '正在读取 {name} 的新建页…': "Reading {name}'s new session page…", '在「{name}」里新建聊天': 'New chat in {name}', '新聊天会放在项目「{name}」': 'This chat will go in {name}', '正在桌面版里选好这个项目…': 'Setting this project in the desktop app…', '正在读取桌面版的选项…': 'Reading the options from the desktop app…',
  '改这一项': 'Change this', '从桌面版重新读取': 'Read again from the desktop app',
  '都选好了，在下面输入第一条消息。': 'All set. Type your first message below.', '开': 'On', '关': 'Off', '桌面版没有列出可选项': 'The desktop app lists no options here',
  '第 {n} 步': 'Step {n}', '现在是 {value}': 'Now: {value}', '正在桌面版里选…': 'Picking it in the desktop app…',
  '先一项项选好桌面版新建页要的设置，再发出第一条消息，聊天就在桌面版里建好了。': 'Pick what the desktop app asks for, one at a time, then send your first message. The chat is created in the desktop app.',
  '新建聊天': 'New chat', '搜索聊天': 'Search chats', '聊天': 'Chats', '最近': 'Recents', '项目': 'Projects', '会话': 'Chats', '会话导航': 'Chats', '聊天列表': 'Chat list',
  '刷新会话': 'Refresh chats', '正在读取会话…': 'Loading chats…', '没有匹配的聊天': 'No chats found', '还没有聊天，从新建聊天开始': 'No chats yet. Start a new one.',
  '长对话只从桌面版读到了 {read} / {total} 条消息': 'Only {read} of {total} messages could be read from the desktop app for this long chat', '模式': 'Mode', '{name} 的模式': '{name} mode', '{name} 模式还没有接入': "{name} mode isn't connected yet", '还没有聊天': 'No chats yet', '未命名聊天': 'Untitled', '草稿': 'Draft', '收起': 'Show less', '显示更多': 'Show more', '正在运行': 'Running', '需要查看': 'Needs attention',
  '关闭会话列表': 'Close sidebar', '关闭侧栏': 'Close sidebar', '切换会话列表': 'Toggle sidebar', '拖动调整会话列表宽度，双击恢复默认': 'Drag to resize. Double-click to reset.',
  '引擎已就绪': 'Connected', '桌面版界面有改动': 'Desktop app changed', '{n} 个控件的认法要更新：{keys}': '{n} controls need a new locator: {keys}', '仅可查看历史': 'Read-only', '引擎未连接': 'Not connected', '正在连接': 'Connecting…', '同步中': 'Syncing',
  '我的': 'Profile', '我的头像': 'Your avatar', '设置': 'Settings',
  // settings
  '语言': 'Language', '主题': 'Theme', '跟随系统': 'System', '浅色': 'Light', '深色': 'Dark', 'AI 对话框位置': 'Speech bubbles', '头像下方': 'Below', '头像右侧': 'Beside',
  'Agent 栏': 'Agent rail', '紧凑': 'Compact', '展开': 'Wide', '展开 Agent 栏': 'Widen the agent rail', '收起 Agent 栏': 'Narrow the agent rail', '在 {name} 打开': 'Open in {name}', '聊天数': 'Chats', '窗口宽度超过 1100 像素时才会展开': 'The rail widens once the window is wider than 1100 px.',
  '回复旁的头像': 'Avatars in chat', '显示': 'On', '不显示': 'Off', '头像': 'Your avatar', '换一个': 'Shuffle',
  // header and chat details
  '打开侧边栏': 'Open preview panel', '关闭侧边栏': 'Close preview panel', '侧边栏（⌘ \\\\）': 'Preview panel (⌘ \\)', '查看会话信息': 'Chat details', '在桌面端打开这个会话': 'Open this chat in the desktop app', '会话信息': 'Chat details', '关闭提示': 'Dismiss', '关闭': 'Close',
  '引擎': 'AI', '会话 ID': 'Session ID', '工作目录': 'Working directory', '由桌面端管理': 'Set by the desktop app', '模型': 'Model', 'Web 端沿用的桌面设置': 'Desktop settings in use',
  '推理': 'effort', '权限': 'permissions', '（取自最近使用的桌面会话）': ' (from your latest desktop session)', '桌面端': 'Desktop app', '活跃': 'Active', '历史会话': 'Idle',
  '选择会话后查看工作目录与模型信息': 'Open a chat to see its folder and model',
  // conversation
  '聊天内容': 'Conversation', '回到最新消息': 'Jump to latest', '正在读取聊天记录…': 'Loading conversation…', '本地引擎': 'Local AI', '工作台': 'workspace',
  '和 {name} 开始新聊天': 'New chat with {name}', '在输入框下面选好项目，发出第一条消息，聊天就建好了。': 'Choose a project below, then send your first message.',
  '发出第一条消息，聊天就建好了。': 'Send a message to get started.', '从一条消息开始': 'Start with a message',
  '说说你想完成的事。回复、执行进度和产物都会留在这里。': 'Describe what you need. Replies, progress, and files will show up here.', '文件编辑留在原工作区，聊天负责调度与交付': 'Edits happen in the project folder. This chat runs the work.',
  '连接暂时中断，正在重连…': 'Connection lost. Reconnecting…', '读取失败：': "Couldn't load this chat: ", '读取会话失败：': "Couldn't load chats: ", '无法连接工作台：': "Can't reach Frontdesk: ",
  '服务暂时不可用，恢复后刷新页面继续': 'Frontdesk is unavailable. Refresh once it is back up.',
  '工作台没有在跟踪这一轮了（例如服务重启过），结果以桌面版的记录为准': 'Frontdesk lost track of this turn (it may have restarted). Check the desktop app for the result.',
  '在 Finder 中显示': 'Show in Finder', '在资源管理器中显示': 'Show in File Explorer', '在文件管理器中显示': 'Show in file manager', '在 {name} 中打开': 'Open in {name}', '文件操作': 'File actions',
  '已在 {name} 里按下「{label}」': 'Pressed “{label}” in {name}',
  '已在 {name} 里打开这个聊天，但没找到这个文件的链接': "Opened this chat in {name}, but couldn't find the link to this file there",
  '你': 'You', '正在输入': 'typing…', '展开消息': 'Show more', '复制回答': 'Copy response', '复制 {name} 的路径': 'Copy path to {name}', '已复制': 'Copied', '下载': 'Download', '预览': 'Preview',
  '已省略 {n} 字节': '{n} bytes not shown', '图片': 'Image', '截图': 'Screenshot', '生成产物': 'Generated file',
  '执行中': 'Running', '完成': 'Done', '失败': 'Failed', '已停止': 'Stopped', '命令退出异常': 'Exited with an error', '此步骤仅显示执行摘要': 'Summary only',
  '执行步骤': 'Plan', '已完成': 'Done', '进行中': 'In progress', '待办': 'To do', '允许': 'Allow', '拒绝': 'Deny', '取消': 'Cancel', '回到桌面端': 'Open in desktop app',
  '正在使用 {n} 项工具': 'Using {n} tools', '使用了 {n} 项工具': 'Used {n} tools', '工具执行中': 'Running a tool', '任务未完成': "Didn't finish", '任务已停止': 'Stopped', '任务已完成': 'Done',
  '正在重新确认任务状态': 'Checking on this turn…', '正在处理': 'Working…', '这个操作只能在桌面版里点': 'Only available in the desktop app',
  '无法写入剪贴板，请在会话信息中手动复制': "Couldn't copy. You can copy it from Chat details.",
  // composer
  '跳到输入框': 'Skip to composer', '发送消息': 'Send message', '此会话当前只读': 'This chat is read-only', '发消息给': 'Message', '给当前引擎发送任务或后续指令…': 'Send a message…',
  '添加附件': 'Attach files', '添加文件或图片': 'Add files or photos', '待发送附件': 'Attachments', '松开以添加附件': 'Drop files to attach', '移除': 'Remove', '{n} 个附件': '{n} attached',
  '每条消息最多添加 10 个附件': 'You can attach up to 10 files per message', '上传失败': 'Upload failed', '正在上传附件…': 'Uploading…',
  '桌面端默认模型': 'Desktop default', '选择下一次任务的模型': 'Model for your next message', '使用引擎自身的默认模型': "Uses this AI's default model", '桌面端设置': 'Same as desktop',
  '推理强度': 'Reasoning effort', '权限模式': 'Permission mode', '停止任务': 'Stop', '任务在对应桌面引擎中执行': 'Runs in the desktop app', 'Enter 发送 · Shift Enter 换行': 'Enter to send · Shift+Enter for a new line',
  '插入正在执行的这一轮（Enter）': 'Send into the current turn (Enter)', '排队，这一轮结束后发送（Enter）': 'Queue for after this turn (Enter)', '排队，这一轮结束后发送': 'Queue for after this turn',
  '排队：这一轮结束后发送（Tab）': 'Queue for after this turn (Tab)', '排队中的消息': 'Queued messages', '排队中': 'Queued', '桌面版': 'Desktop', '立即发送这条消息': 'Send this message now', '立即发送': 'Send now',
  '插入正在执行的这一轮': 'Send into the current turn', '插入': 'Send now', '编辑这条排队消息': 'Edit queued message', '编辑：放回输入框': 'Edit in the composer', '取消这条排队消息': 'Remove from queue',
  '这一轮没法插进去，消息已排队': "Couldn't reach the current turn, so your message is queued", '，可以在队列里再点“插入”': '. Use Send now in the queue to try again.',
  '正在新建聊天…': 'Creating chat…', '正在发送…': 'Sending…', '等待操作批准': 'Waiting for your approval', '正在确认引擎状态': 'Reconnecting…', '正在执行': 'Running',
  ' · 请在桌面端停止任务': ' · stop it from the desktop app', '工作目录 ·': 'Working in', '任务由 {name} 执行': 'Runs in {name}', '桌面引擎': 'the desktop app',
  '正在停止…': 'Stopping…',
  '发送失败：': "Couldn't send: ", '请先输入第一条消息': 'Type a message first', '聊天已建好，但第一条消息没发出去：': "Chat created, but your message didn't go through: ", '新建聊天失败：': "Couldn't create the chat: ",
  // new chat: project picker
  '不指定项目': 'No project', '在默认文件夹里开始：': 'Starts in your default folder: ', '其他': 'Other', '其他文件夹…': 'Choose a folder…', '新聊天所在的项目': 'Project for this chat',
  '文件夹的完整路径，回车确认': 'Full path to a folder, then press Enter', '新聊天的工作文件夹路径': 'Folder for this chat',
  // dictation
  '语音输入': 'Dictate', '{name} 语音识别': '{name} speech-to-text', '浏览器语音识别': 'Browser speech-to-text', '结束语音输入': 'Stop dictation', '语音输入 ·': 'Dictate ·', '正在整理识别结果…': 'Finishing up…',
  '正在听写 ·': 'Listening ·', '· 再点话筒结束，Esc 取消': '· click the mic to finish, Esc to cancel', '语音输入：': 'Dictation: ', '语音输入：没有麦克风权限，请在浏览器地址栏允许使用麦克风': 'Microphone access is blocked. Allow it from the address bar.',
  '语音输入需要安全连接。请改用': 'Dictation needs a secure connection. Open', '打开（首次需在浏览器里信任本机证书），或在这台 Mac 上用 http://localhost:': 'instead (you will need to trust the local certificate once), or on this Mac use http://localhost:',
  '打开。': '.', '浏览器只允许 https 或 localhost 页面使用麦克风。请在这台 Mac 上用 http://localhost:': 'Browsers only allow the microphone on https or localhost. On this Mac, open http://localhost:',
  '打开，或用 HOST=0.0.0.0 启动服务以启用 HTTPS。': ', or start Frontdesk with HOST=0.0.0.0 to enable HTTPS.',
  '语音输入不可用：': 'Dictation is unavailable: ', '{name}不可用（{reason}）': '{name} is unavailable ({reason})', '{name}不可用': '{name} is unavailable', '；': '; ', '，已改用': ', using ', '自动': 'Automatic', '（现在不可用）': ' (unavailable now)',
  '现在会用：': 'Uses now: ', '（各 Agent 的语音识别都不可用）': " (no agent's speech-to-text is available)",
  '无法开始听写': "Couldn't start dictation", '听写连接中断': 'Dictation disconnected', '当前浏览器不支持语音识别': "This browser doesn't support speech-to-text", '没有麦克风权限': 'Microphone access is blocked', '语音识别失败：': 'Speech-to-text failed: ',
  // file preview panel
  '文件预览': 'File preview', '拖动调整侧边栏宽度': 'Drag to resize', '打开的文件': 'Open files', '查看源码': 'View source', '查看排版': 'View formatted', '复制路径': 'Copy path',
  '点击回复里的文件链接，在这里预览': 'Click a file link in a reply to preview it here', '只读预览，文件在原工作区里不会被改动': "Read-only. The file itself isn't changed.", '正在读取…': 'Loading…',
  ' · 只显示开头部分': ' · truncated', '复制代码': 'Copy code', '复制': 'Copy', '{n} 项': '{n} items', '空文件夹': 'Empty folder', '· 第 {line} 行': '· line {line}', '读取文件失败': "Couldn't open this file", '查看图片': 'Image viewer', '在新标签页打开原图': 'Open original in new tab',
  // adding an AI (the prompt itself has its own English edition, onboardingPromptEn in app.ts)
  '把下面这段话发给你的桌面版 AI（Claude、Codex、Antigravity 或其他）。它会复用工作台现成的页面和能力，只接自己的数据、选好把消息送进它桌面版的通道。': 'Paste this prompt into your desktop AI (Claude, Codex, Antigravity, or another). It reuses the pages and features Frontdesk already has, connects only its own data, and picks how messages reach its desktop app.',
  '读工作台的接入手册': 'Read the Frontdesk guide', '选好进桌面版的通道': 'Pick how messages reach its desktop app', '分阶段接数据、补能力': 'Connect its data, one capability at a time', '真实走一遍后交付': 'Try it for real, then ship',
  '提示词': 'Prompt', '复制手册路径': 'Copy guide path', '复制提示词': 'Copy prompt', '已选中，按 ⌘C 复制': 'Selected. Press ⌘C to copy.', '已复制路径': 'Path copied', '手册位置：': 'Guide: ', '工作台项目目录': 'Frontdesk project folder',
};

// What the server and the engines' adapters report (errors, status notes, approval prompts).
// They are written in Chinese where they arise; say() puts them into the interface language
// where they are shown. Exact texts first, then the ones that carry a name or a reason.
const REPORTS: Record<string, string> = {
  // an agent's name and faces (settings)
  '设置文件没有位置，图片存不下': "There's no settings file to keep pictures beside", '图片是空的': 'The picture is empty',
  '名称不能超过 40 个字': 'Names can be up to 40 characters',
  // switching an agent off while the console still holds work for it (PUT /api/agents/:id)
  '工作台还在跟着它的任务': 'Frontdesk is still following its work',
  // a desktop mode the console cannot read yet (plugin `spaces`)
  'Claude 模式的新聊天要在 Claude 桌面版里开始，工作台目前只列出这个模式的聊天和项目': "Start new Claude-mode chats in Claude's desktop app. For now the console only lists this mode's chats and projects.",
  'ChatGPT 模式的新对话要在 Codex 桌面版里开始，工作台目前只列出这个模式的对话和项目': "Start new ChatGPT-mode chats in Codex's desktop app. For now the console only lists this mode's chats and projects.",
  'Claude 模式聊天的正文不在本机，要从 Claude 桌面版的界面读': "This Claude-mode chat's messages aren't on this computer; they're read from Claude's desktop app",
  'ChatGPT 对话的正文不在本机，要从 Codex 桌面版的界面读': "This ChatGPT chat's messages aren't on this computer; they're read from Codex's desktop app",
  'Claude 模式的聊天还不能从工作台发消息，请在 Claude 桌面版里回复': "Claude-mode chats can't be answered from the console yet. Reply in Claude's desktop app.",
  'ChatGPT 对话还不能从工作台发消息，请在 Codex 桌面版里回复': "ChatGPT chats can't be answered from the console yet. Reply in Codex's desktop app.",
  '桌面版没有读出这个聊天': "The desktop app didn't show this chat's messages",
  // a new chat in the Claude desktop app
  'Claude 桌面版的侧栏里没有找到新建按钮': "Couldn't find the New button in Claude's desktop sidebar",
  '没能读取 Claude 桌面版的新建会话页': "Couldn't read Claude's New session page", '没能在 Claude 桌面版的新建会话页上选这一项': "Couldn't pick that on Claude's New session page",
  '开关只能选 on 或 off': 'A toggle is either on or off', '缺少要选的项和选项': 'Say which control and which option', '这个引擎没有新建选项': 'This AI has no new chat options',
  '这个会话不在 Claude 桌面版里，只能发给桌面版已有的会话': "This chat isn't in Claude's desktop app. Messages go only to chats the desktop app has.",
  // sending and turns
  '当前会话已有任务正在执行': 'This chat already has a turn running', '正在重新确认引擎状态，任务没有被判定失败': 'Reconnecting. The turn has not failed.',
  '这个引擎不支持在运行中插话，可以排队到这一轮结束后发送': "This AI can't take messages mid-turn. Queue it for after this turn instead.", '这条排队消息已经发出或不存在': 'That queued message was already sent or removed',
  '排队的消息太多了': 'Too many messages in the queue', '没有正在执行的任务': 'Nothing is running', '请在原桌面端停止此任务': 'Stop this one from the desktop app', '审批不存在或已失效': 'That approval request has expired', '找不到这个会话': 'Chat not found', '这一轮已经结束，消息已排队': 'That turn has ended, so your message is queued',
  '审批已失效': 'That approval request has expired', '请选择文件': 'Choose a file', '附件不存在，请重新上传': 'That attachment is gone. Upload it again.', '请输入首条消息': 'Type a message first',
  '引擎未返回会话 ID': "The AI didn't return a session", '请输入消息或添加附件': 'Type a message or attach a file', '这个引擎没有立即发送': "This AI doesn't support Send now", '读取文件失败': "Couldn't open this file", '服务异常': 'Something went wrong',
  '正在处理任务': 'Working…', '需要批准操作': 'Needs your approval', '已完成。': 'Done.', '执行失败': 'Failed', '引擎正在重试': 'Retrying…', '批准操作': 'Approve this action', '本轮总结': 'Wrap-up', '更新任务清单': 'Updated the plan',
  '引擎报告了错误，正在确认任务状态': 'The AI reported an error. Checking on the turn…', '引擎尚未确认回合，请稍后重试或在桌面端停止': "The turn hasn't started yet. Try again in a moment, or stop it from the desktop app.",
  // Claude
  '没有找到 Claude Code 命令行。请先打开一次 Claude 桌面版的 Code 标签页，或设置 CLAUDE_BIN。': "Claude Code CLI not found. Open the Code tab in Claude's desktop app once, or set CLAUDE_BIN.",
  '改文件、跑命令前先问你': 'Asks before editing files or running commands', '直接改文件，跑命令前先问你': 'Edits files freely, asks before running commands', '只读，先给出计划，不改动任何东西': 'Read-only. Plans first and changes nothing.',
  '由 Claude 判断哪些操作需要你确认': 'Claude decides what needs your approval', '不再询问，直接执行所有操作': 'Runs everything without asking',
  '未公开': 'Unavailable', 'Claude Code 没有返回额度窗口': "Claude Code didn't report any limits", '找不到这个 Claude 会话的记录': "Couldn't find this Claude session", 'Claude Code 没有及时响应': 'Claude Code timed out',
  '未登录': 'Signed out', '未安装': 'Not installed', '未运行': 'Not running',
  'Claude 语音识别失败': 'Claude speech-to-text failed', '无法连接 Claude 语音识别': "Couldn't reach Claude speech-to-text",
  '这个会话还不在 Claude 桌面版里，桌面代发只能发给桌面版已有的会话': "This chat isn't in Claude's desktop app yet, so the desktop app can't send for it",
  '桌面代发失败': "Claude's desktop app couldn't send this", 'Claude 桌面版里这一轮还没结束，消息已交给桌面版，它会插进正在执行的这一轮': 'Claude is still mid-turn on desktop. Your message was handed over and will join that turn.',
  '没能确定这个模型在 Claude 桌面版里叫什么，没有发送': "Couldn't tell what this model is called in Claude's desktop app, so nothing was sent",
  '没能打开 Claude 桌面版的模型菜单': "Couldn't open the model menu in Claude's desktop app", 'Claude 桌面版的模型菜单里没有这个模型': "Claude's desktop app doesn't list this model",
  '在 Claude 桌面版里选了这个模型，但它没有切换过去': "Picked this model in Claude's desktop app, but it didn't switch", '切换模型时 Claude 桌面版弹出了确认，请到桌面版里操作': "Claude's desktop app asked for confirmation while switching models. Switch it there.",
  '这个模型在 Claude 桌面版里不能调推理强度': "This model has no effort setting in Claude's desktop app", '没能打开 Claude 桌面版的推理强度菜单': "Couldn't open the effort menu in Claude's desktop app",
  'Claude 桌面版的推理强度菜单里没有这一档': "Claude's desktop app doesn't offer this effort level", '在 Claude 桌面版里选了这档推理强度，但它没有切换过去': "Picked this effort level in Claude's desktop app, but it didn't switch",
  '没能打开 Claude 桌面版的权限菜单': "Couldn't open the permission menu in Claude's desktop app", 'Claude 桌面版的权限菜单里没有这个模式': "Claude's desktop app doesn't offer this permission mode",
  'Claude 桌面版里还没有启用这个权限模式，请先在桌面版里启用它': "This permission mode isn't enabled in Claude's desktop app yet. Enable it there first.",
  '切换到这个权限模式需要在 Claude 桌面版里确认，请到桌面版里操作': "Claude's desktop app asks you to confirm this permission mode. Switch it there.",
  '在 Claude 桌面版里选了这个权限模式，但它没有切换过去': "Picked this permission mode in Claude's desktop app, but it didn't switch",
  'Claude 桌面版的窗口不在屏幕上，这次没能把消息交给它：把窗口放到看得见的地方再发': "Claude's desktop window isn't on screen and the message couldn't be handed to it this time. Bring it into view and send again.",
  'Claude 桌面版的窗口不在屏幕上，这次没能改它的模型和权限：把窗口放到看得见的地方再发': "Claude's desktop window isn't on screen and its model and permissions couldn't be changed this time. Bring it into view and send again.",
  'Claude 桌面版没有收到这条消息': "Claude's desktop app didn't pick up this message", '这个会话不能由 Claude 桌面版插话': "Claude's desktop app can't add to this chat mid-turn", '没能由 Claude 桌面版插话': "Couldn't add your message to the running turn",
  'Claude 桌面版没有收到这条插话': "Claude's desktop app didn't pick up your message", '这个会话不在 Claude 桌面版里': "This chat isn't in Claude's desktop app", '没能让 Claude 桌面版立即发送': "Couldn't get Claude's desktop app to send it now",
  '没能在 Claude 桌面版里新建会话': "Couldn't start a new session in Claude's desktop app", '没能在 Claude 桌面版里打开新建会话页': "Couldn't open the New session page in Claude's desktop app",
  'Claude 桌面版要先确认信任这个文件夹：请在桌面版里用它新建一次会话': "Claude's desktop app needs you to trust this folder first. Start one session in it from the desktop app.",
  'Claude 桌面版的新建会话页没有文件夹选项': "The New session page in Claude's desktop app has no folder picker",
  '这个文件夹不在 Claude 桌面版的常用文件夹里：请先在桌面版里用它新建一次会话': "Claude's desktop app doesn't know this folder yet. Start one session in it from the desktop app first.",
  '消息已在 Claude 桌面版里发出，但还没在它的会话列表里看到这个新会话，请到桌面版里查看': "Your message was sent in Claude's desktop app, but the new session hasn't shown up yet. Check the desktop app.",
  '没能在 Claude 桌面版里停止': "Couldn't stop it in Claude's desktop app", 'Claude Code 报告执行失败': 'Claude Code reported a failure',
  'Claude 桌面版有同名会话，无法确认要停止的是哪一个': 'More than one chat has this title in Claude. Open the chat in Claude to stop it.',
  '缺少有效的会话 ID': 'Missing a valid chat ID', '缺少有效的会话 ID 或标题': 'Missing a valid chat ID or title',
  '没能按下 Claude 桌面版的停止按钮': "Couldn't press Stop in Claude's desktop app",
  '桌面代发需要辅助功能权限：在「系统设置 → 隐私与安全性 → 辅助功能」里允许运行工作台服务的程序（例如终端），然后重启工作台': "Sending through the desktop app needs Accessibility access. In System Settings → Privacy & Security → Accessibility, allow the app that runs Frontdesk (for example Terminal), then restart Frontdesk.",
  'Claude 桌面版没有及时响应': "Claude's desktop app didn't respond in time", '桌面代发程序没有正常返回': 'The desktop helper stopped unexpectedly', '桌面代发只支持 macOS': 'Sending through the desktop app only works on macOS', '桌面代发只支持 macOS 和 Windows': 'Sending through the desktop app works on macOS and Windows',
  '桌面代发程序编译失败（需要 Xcode 命令行工具：xcode-select --install）': "Couldn't build the desktop helper. Install the Xcode command line tools: xcode-select --install", 'Claude 桌面版没有在运行': "Claude's desktop app isn't running",
  '桌面代发程序不可用': 'The desktop helper is unavailable', '工作台没有辅助功能权限': "Frontdesk doesn't have Accessibility access", '缺少会话标题': 'Missing chat title', '消息是空的': 'The message is empty',
  '这个 AI 的桌面版不支持打开会话': "This AI's desktop app can't open chats from here", '没能在桌面版里打开这个会话': "Couldn't open this chat in the desktop app",
  '这个 AI 的桌面版不支持打开文件': "This AI's desktop app can't open files from here", '没能打开这个文件': "Couldn't open this file", '没能在文件管理器里显示这个文件': "Couldn't show this file in the file manager",
  'Claude 桌面版里没有这个会话': "Claude's desktop app doesn't have this chat", '缺少要按的按钮': 'No button was named', '缺少卡片的内容': "The card's contents are missing", '没能从桌面版读出这张卡片': "Couldn't read this card from the desktop app", '没能从 Claude 桌面版读出这张卡片': "Couldn't read this card from Claude's desktop app", 'Claude 桌面版的这张卡片上已经没有这个按钮了': "This button is no longer on the card in Claude's desktop app", 'Claude 桌面版里没有找到这一轮的卡片': "Couldn't find this turn's card in Claude's desktop app", '没能在桌面版里按下这个按钮': "Couldn't press this button in the desktop app", '没能在 Claude 桌面版里按下这个按钮': "Couldn't press this button in Claude's desktop app", '这一轮还在 Claude 桌面版里运行，卡片上的按钮要等它结束才能按': "This turn is still running in Claude's desktop app; the card's buttons work once it ends", '没能在 Claude 桌面版里打开这个文件': "Couldn't open this file in Claude's desktop app", '没能在 Codex 桌面版里打开这个文件': "Couldn't open this file in Codex's desktop app",
  '没能在 Antigravity 里打开这个文件': "Couldn't open this file in Antigravity", '缺少会话标题或文件': 'Missing chat title or file',
  '没能在 Claude 桌面版里打开这个会话': "Couldn't open this chat in Claude's desktop app", '这个会话正在 Claude 桌面版里运行，等这一轮结束再发': 'Claude is still mid-turn on desktop. Try again when it finishes.',
  '没能把消息填进 Claude 桌面版的输入框': "Couldn't type into Claude's desktop composer", 'Claude 桌面版没有出现发送按钮': "Claude's desktop app didn't show a Send button", 'Claude 桌面版里没有排队中的消息': "Nothing is queued in Claude's desktop app",
  '这个会话在 Claude 桌面版里没有在运行': "This chat isn't running in Claude's desktop app", '按了停止，但 Claude 桌面版还在运行': 'Pressed Stop, but Claude is still running on desktop', '未知命令': 'Unknown command',
  'Claude Code 登录信息无法读取': "Couldn't read your Claude Code sign-in",
  '语音识别出错': 'Speech-to-text error', '听写已结束': 'Dictation ended', '没有可用的语音识别': 'No speech-to-text is available', '语音识别失败': 'Speech-to-text failed',
  // Codex
  '未发现 Codex，请设置 CODEX_BIN': 'Codex not found. Set CODEX_BIN.', '引擎没有返回额度窗口': "The AI didn't report any limits",
  'Codex 桌面版没有确认收到这条消息，请在桌面端看一下是否已插入': "Codex didn't confirm your message. Check the desktop app to see whether it went in.",
  'Codex 桌面版没有响应': "Codex's desktop app isn't responding", '连不上 Codex 桌面版': "Can't reach Codex's desktop app", 'Codex 桌面版断开了连接': "Codex's desktop app disconnected", 'Codex 桌面版拒绝了连接': "Codex's desktop app refused the connection",
  // Antigravity
  '未发现 agentapi，请确认已安装 Antigravity 或设置 AGENTAPI_BIN': 'agentapi not found. Install Antigravity or set AGENTAPI_BIN.', '未找到正在运行的 Antigravity。请打开 Antigravity 桌面端后重试。': "Antigravity isn't running. Open the desktop app and try again.",
  'Antigravity 没有返回模型额度': "Antigravity didn't report any limits", 'Antigravity 语音识别失败': 'Antigravity speech-to-text failed', 'Antigravity 未返回会话 ID': "Antigravity didn't return a session",
  '这个文件夹不存在，聊天没有新建': "That folder doesn't exist, so no chat was started.", '这个确认已经处理过了': 'This has already been answered', '跳过': 'Skip', '这个问题已经回答过了': 'This question has already been answered', '没能在 Claude 桌面版里回答这个问题': "Couldn't answer this in the Claude desktop app", 'Claude 桌面版没有记下这个回答，请在桌面端看一下': "Claude didn't record this answer. Check the desktop app.", '缺少要回答的问题': 'No question to answer',
  '允许 Antigravity 运行这条命令？': 'Allow Antigravity to run this command?', '允许 Antigravity 执行这个操作？': 'Allow Antigravity to do this?',
  'Antigravity 桌面端现在没有提供这个模型，消息没有发出': "Antigravity doesn't offer this model right now, so nothing was sent.", 'Antigravity 没有开始这一轮：它的记录里没有这条消息的回应': "Antigravity didn't start this turn: its record shows no response to the message.", 'Antigravity 的记录里没有这个聊天，这一轮没有开始': "Antigravity has no record of this chat, so the turn didn't start.",
  // file preview
  '这个会话没有记录工作目录，无法预览文件': "This chat has no working directory, so files can't be previewed", '文件路径无效': "That file path isn't valid", '会话的工作目录已经不存在': "This chat's working directory no longer exists",
  '找不到这个文件': 'File not found', '只能预览这个会话工作目录里的文件': "Only files inside this chat's working directory can be previewed", '这个文件可能包含密钥或仓库内部数据，不提供预览': 'This file may contain secrets or repository internals, so it is not shown',
  '这不是一个文件': "That isn't a file", '图片太大，不提供预览': 'This image is too large to preview', '这是二进制文件，不提供预览': "Binary files can't be previewed",
  // usage
  '原生引擎未公开额度': "This AI doesn't report usage",
  // Codex desktop (src/server/codex-bridge.ts, src/server/native/codex-desktop.swift) and the shared desktop helper.
  'Claude 桌面版': "Claude's desktop app", 'Codex 桌面版': "Codex's desktop app", 'Codex 桌面版没有在运行': "Codex's desktop app isn't running", '桌面版没有在运行': "The desktop app isn't running",
  '桌面版没有及时响应': "The desktop app didn't respond in time", '缺少桌面版的配置（AX_PROFILE）': 'The desktop helper is missing its profile (AX_PROFILE)',
  'Codex 要运行这条命令': 'Codex wants to run this command', 'Codex 要修改文件': 'Codex wants to change files',
  '没能读到 Codex 桌面版新建页的模型': "Couldn't read the model on Codex's New chat page", 'Codex 桌面版的新建页上没有模型菜单': "Codex's New chat page has no model menu",
  '没能确定这个模型在 Codex 桌面版里叫什么，没有发送': "Couldn't tell what this model is called in Codex's desktop app, so nothing was sent",
  '这个文件夹不是 Codex 桌面版里的项目，请在桌面版里先把它加为项目': "This folder isn't a project in Codex's desktop app. Add it as a project there first.",
  '没能在 Codex 桌面版里新建聊天': "Couldn't start a new chat in Codex's desktop app", '没能在 Codex 桌面版里换模型': "Couldn't change the model in Codex's desktop app",
  '消息已在 Codex 桌面版里发出，但还没在它的聊天列表里看到这个新聊天，请到桌面版里查看': "Your message was sent in Codex's desktop app, but the new chat hasn't shown up yet. Check the desktop app.",
  '没能唤起 Codex 桌面版来处理这条消息': "Couldn't get Codex's desktop app to pick up this message", '消息已排进 Codex 桌面版的队列，正在等桌面版接手': "Your message is in Codex's desktop queue, waiting for the desktop app to pick it up",
  'Codex 桌面版没有确认收到这条消息，请在桌面版看一下是否已插入': "Codex's desktop app didn't confirm it got this message. Check the desktop app to see whether it was added.",
  '桌面版还没开始这一轮，请稍后重试或在桌面端停止': "The desktop app hasn't started this turn yet. Try again shortly or stop it on desktop.",
  'Codex 桌面版的输入框下面没有模型菜单': "Codex's desktop composer has no model menu", '没能打开 Codex 桌面版的模型菜单': "Couldn't open the model menu in Codex's desktop app",
  'Codex 桌面版的模型菜单里找不到选模型的入口': "Couldn't find the model list in Codex's desktop model menu", '没能打开 Codex 桌面版的推理强度滑块': "Couldn't open the effort slider in Codex's desktop app",
  '读不到 Codex 桌面版推理强度滑块的位置': "Couldn't read the effort slider in Codex's desktop app", 'Codex 桌面版的新建页上没有「不在项目里」这一项': "Codex's New chat page has no \"no project\" option",
  '没能打开 Codex 桌面版的项目菜单': "Couldn't open the project menu in Codex's desktop app", '没能在 Codex 桌面版里打开新建聊天页': "Couldn't open the New chat page in Codex's desktop app",
  '没能把消息填进 Codex 桌面版的输入框': "Couldn't type into Codex's desktop composer", 'Codex 桌面版没有出现发送按钮': "Codex's desktop app didn't show a Send button",
  'Claude 模式的聊天在回复时不能插话，消息已排队，等这条回复结束再发': "A Claude-mode chat can't take a message while it's replying. Your message is queued for when the reply ends.",
  'Claude 模式的回复请在 Claude 桌面版里停止': "Stop a Claude-mode reply in Claude's desktop app",
  'ChatGPT 对话的回复请在 Codex 桌面版里停止': "Stop a ChatGPT reply in Codex's desktop app",
  'ChatGPT 对话在回复时不能插话，消息已排队，等这条回复结束再发': "A ChatGPT conversation can't take a message while it's replying. Your message is queued for when the reply ends.",
  '缺少会话标题或消息': 'The chat title or the message is missing',
  '没能在 Codex 桌面版的侧栏里找到这个聊天': "Couldn't find this chat in Codex's desktop sidebar", '在 Codex 桌面版里选了不在项目里，但项目没有切换过去': "Picked no project in Codex's desktop app, but it didn't switch",
};
const REPORT_PATTERNS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  // The sign-in command is the one that works on that machine (claude-bridge.ts, loginCommand).
  [/^Claude Code 命令行还没有登录。请在终端运行一次 (.+)，然后刷新工作台。$/, match => `Claude Code is signed out. Run ${match[1]} in a terminal, then refresh.`],
  [/^读取不到 Claude Code 的登录信息，请先运行 (.+)$/, match => `Claude Code is signed out. Run ${match[1]} first.`],
  [/^没能在 Codex 桌面版里回答（(.*)），请到桌面版里操作$/, match => `Couldn't answer in Codex's desktop app (${match[1]}). Answer it there.`],
  [/^(.+?)（这次也没能从桌面版界面读出来：(.*)）$/, match => `${english(match[1])} (reading it from the desktop app didn't work this time: ${english(match[2])})`],
  [/^(.+?)的配置里没有 chatRead$/, match => `${owner(match[1])} profile has no chatRead`],
  [/^没能在(.+?)的侧栏里找到这个聊天$/, match => `Couldn't find this chat in ${owner(match[1])} desktop sidebar`],
  [/^没能在(.+?)里确认打开的是要停止的聊天$/, match => `Couldn't verify the chat to stop in ${owner(match[1])} desktop app`],
  [/^这个会话在(.+?)里已经没有在回复$/, match => `This chat is no longer replying in ${owner(match[1])} desktop app`],
  [/^没能在(.+?)里确认哪个按钮会停止这条回复$/, match => `Couldn't identify the stop button in ${owner(match[1])} desktop app`],
  [/^没能按下(.+?)的停止按钮$/, match => `Couldn't press Stop in ${owner(match[1])} desktop app`],
  [/^没能在(.+?)里确认这条回复已停止$/, match => `Couldn't confirm the reply stopped in ${owner(match[1])} desktop app`],
  [/^没能确认(.+?)已停止回复$/, match => `Couldn't confirm the reply stopped in ${owner(match[1])} desktop app`],
  [/^按了停止，但(.+?)还在回复$/, match => `Pressed Stop, but ${owner(match[1])} desktop app is still replying`],
  // A chat mode's chats, started and answered in the desktop's window (the driver's chat-new / chat-send, ChatMode).
  [/^(.+?)的配置里没有 chatSend$/, match => `${owner(match[1])} profile has no chatSend`],
  [/^没能把消息填进(.+?)的输入框$/, match => `Couldn't type into ${owner(match[1])} desktop composer`],
  [/^(.+?)的窗口不在屏幕上，这次没能把消息交给它：把窗口放到看得见的地方再发$/, match => `${owner(match[1])} window isn't on screen, so the message didn't reach it. Put the window where it can be seen and send again.`],
  [/^(.+?)没有出现发送按钮$/, match => `${owner(match[1])} desktop app didn't show a Send button`],
  // Held back by the driver rather than guessed at (ax-driver.swift: "one control, or none", "a control found by its place").
  [/^(.+?)的页面上有 (.+?) 个控件都对得上「(.+?)」，分不清该动哪一个，所以没有动手（桌面版可能改过界面，这个控件的认法要更新）$/, match => `${owner(match[1])} desktop app shows ${match[2]} controls that all match "${match[3]}", so nothing was touched (the app may have changed: this control's locator needs updating)`],
  [/^(.+?)里按位置找到的「(.+?)」打开的不是预期的菜单，所以什么都没有选（桌面版可能改过界面，这个控件的认法要更新）$/, match => `The "${match[2]}" control found by its place in ${owner(match[1])} desktop app opened another menu than expected, so nothing was picked (the app may have changed: this control's locator needs updating)`],
  [/^按了(.+?)的发送，但消息还留在输入框里$/, match => `Pressed Send in ${owner(match[1])} desktop app, but the message is still in its composer`],
  [/^(.+?)离开了这个模式，没有新建聊天$/, match => `${owner(match[1])} desktop app left this mode, so no chat was started`],
  [/^(.+?)的侧栏里没有找到新建聊天的按钮$/, match => `Couldn't find the new chat button in ${owner(match[1])} desktop sidebar`],
  [/^没能在(.+?)里打开新聊天的页面$/, match => `Couldn't open a new chat page in ${owner(match[1])} desktop app`],
  [/^(.+?)的侧栏里没有「(.*)」这个项目，没能在里面新建聊天$/, match => `${owner(match[1])} desktop sidebar doesn't show the project "${match[2]}", so no chat was started in it`],
  [/^没能在(.+?)里打开「(.*)」的新聊天页面$/, match => `Couldn't open a new chat page for "${match[2]}" in ${owner(match[1])} desktop app`],
  [/^这个聊天正在(.+?)里回复，等它回复完再发$/, match => `This chat is replying in ${owner(match[1])} desktop app. Send once the reply is done.`],
  [/^(.+?)这个模式的聊天还不能从工作台带附件，请在桌面版里添加$/, match => `Chats in this mode of ${owner(match[1])} desktop app can't take attachments from here yet. Add them in the desktop app.`],
  [/^(.+?)这个模式的模型和设置要在桌面版里选，工作台发的消息用桌面版当前的设置$/, match => `In this mode of ${owner(match[1])} desktop app, pick the model and settings there. Messages from here use what it has now.`],
  [/^没能在(.+?)里新建聊天$/, match => `Couldn't start a chat in ${owner(match[1])} desktop app`],
  [/^消息已在(.+?)里发出，但还没在它的列表里看到这个新聊天，请到桌面版里查看$/, match => `The message went out in ${owner(match[1])} desktop app, but the new chat isn't in its list yet. Check the desktop app.`],
  [/^这个聊天不在(.+?)的列表里$/, match => `This chat isn't in ${owner(match[1])} desktop list`],
  [/^没能把消息交给(.+)$/, match => `Couldn't hand the message to ${owner(match[1])} desktop app`],
  [/^(.+?)里这条回复还没结束，工作台不再跟进，请到桌面版里查看$/, match => `This reply in ${owner(match[1])} desktop app still isn't done. The console stopped following it; check the desktop app.`],
  [/^你正在用(.+?)，工作台先不把它切到这个聊天；等你离开它，或在桌面版里打开这个聊天，再接着看回复$/, match => `You're using ${owner(match[1])} desktop app, so the console won't switch it to this chat. It will pick the reply up once you leave the app or open this chat there.`],
  [/^(.+?)还在回复，工作台会隔一会儿去桌面版里看一眼$/, match => `${owner(match[1])} desktop app is still replying. The console will check on it there every so often.`],
  [/^(.+?)里这个聊天没有显示出消息$/, match => `${owner(match[1])} desktop app didn't show this chat's messages`],
  // The shared driver's modes (profile "spaces") name the app by its profile too.
  [/^(.+?)没有这个模式$/, match => `${owner(match[1])} desktop app has no such mode`],
  [/^没能在(.+?)上找到切换模式的地方$/, match => `Couldn't find the mode switch in ${owner(match[1])} desktop app`],
  [/^没能打开(.+?)切换模式的菜单$/, match => `Couldn't open the mode menu in ${owner(match[1])} desktop app`],
  [/^(.+?)切换模式的菜单里没有「(.*)」$/, match => `${owner(match[1])} mode menu has no "${match[2]}"`],
  [/^(.+?)的模式切换里没有「(.*)」$/, match => `${owner(match[1])} mode switch has no "${match[2]}"`],
  [/^在(.+?)里切到「(.*)」模式，但没有切过去$/, match => `Switched ${owner(match[1])} desktop app to ${match[2]} mode, but it didn't change`],
  [/^每周 · 模型$/, () => 'Weekly · model'], [/^每周 · 其他$/, () => 'Weekly · other'],
  [/^每周 · (.+)$/, match => `Weekly · ${match[1]}`],
  [/^无法确认 Claude Code 登录状态：(.*)$/, match => `Couldn't check your Claude Code sign-in: ${match[1]}`],
  [/^切换模型时 Claude 桌面版弹出了确认，没能在里面确认，请到桌面版里操作。桌面版的提示：(.+)$/, match => `Claude's desktop app asked for confirmation while switching models and it couldn't be confirmed from here. Switch it there. The desktop app says: ${match[1]}`],
  [/^已在 Claude 桌面版里把这个会话切换为 (.+?)（桌面版提示：(.*)）$/, match => `Switched this chat in Claude's desktop app to ${match[1]} (the desktop app says: ${match[2]})`],
  [/^已在 Claude 桌面版里把这个会话切换为 (.+)$/, match => `Switched this chat in Claude's desktop app to ${match[1]}`],
  [/^Claude Code 意外退出（(.*)）$/, match => `Claude Code quit unexpectedly (${match[1]})`],
  [/^允许 Claude 使用 (.+)？$/, match => `Allow Claude to use ${match[1]}?`],
  [/^这一轮没法插进去（(.*)），消息已排队$/, match => `Couldn't reach the current turn (${english(match[1])}), so your message is queued`],
  [/^(.*)，消息还在队列里$/, match => `${english(match[1])}. Your message is still in the queue.`],
  [/^(.+) 没有可用的原生语音识别$/, match => `${match[1]} has no built-in speech-to-text`],
  [/^暂时无法读取额度：(.*)$/, match => `Couldn't check usage right now: ${english(match[1])}`],
  [/^Antigravity 语音识别不可用 \((.*)\)$/, match => `Antigravity speech-to-text is unavailable (${match[1]})`],
  [/^(.+) 语音识别暂时不可用$/, match => `${match[1]} speech-to-text is unavailable right now`],
  [/^语音连接已断开 \((.*)\)$/, match => `Dictation disconnected (${match[1]})`],
  // The shared driver's new-chat page reports name the app by its profile ("Claude 桌面版").
  [/^(.+?)的新建会话页上现在没有「(.*)」这一项$/, match => `${owner(match[1])} New session page doesn't show "${match[2]}" right now`],
  [/^没能打开 (.+?)新建会话页上的「(.*)」菜单$/, match => `Couldn't open the "${match[2]}" menu on ${owner(match[1])} New session page`],
  [/^(.+?)的窗口不在屏幕上，页面没有接进辅助功能：把它的窗口切到前台看一眼再试，还不行的话可能是桌面版更新后换了打开辅助功能的方式$/, match => `${owner(match[1])} window isn't on screen and its page isn't reachable through Accessibility. Bring its window to the front once and try again. If that doesn't help, an update may have changed how the desktop app turns Accessibility on.`],
  [/^(.+?)的页面没有接进辅助功能，工作台读不到它的界面（桌面版刚更新过的话，可能换了打开辅助功能的方式）$/, match => `${owner(match[1])} page isn't reachable through Accessibility, so the console can't read it. If the desktop app was just updated, it may have changed how it turns Accessibility on.`],
  [/^(.+?)的窗口不在屏幕上，没能打开新建会话页上的菜单：把窗口放到看得见的地方再试$/, match => `${owner(match[1])} window isn't on screen, so the New session page's menu didn't open. Put the window where it can be seen and try again.`],
  [/^(.+?)的「(.*)」菜单里没有「(.*)」$/, match => `${owner(match[1])} "${match[2]}" menu has no "${match[3]}"`],
  [/^在 (.+?)里按了「(.*)」，但它没有变$/, match => `Pressed "${match[2]}" in ${owner(match[1])} desktop app, but it didn't change`],
  [/^在 (.+?)里选了「(.*)」，但「(.*)」没有变$/, match => `Picked "${match[2]}" in ${owner(match[1])} desktop app, but "${match[3]}" didn't change`],
  [/^Antigravity 没有接收这条消息（(.*)）$/, match => `Antigravity didn't take this message (${match[1]})`],
  [/^Antigravity 没有在这个文件夹里新建聊天（(.*)）$/, match => `Antigravity didn't start a chat in this folder (${match[1]})`],
  [/^(.+) 桌面版在等你批准$/, match => `${match[1]} desktop app is waiting for your approval`],
  [/^(.+) 桌面版在等你操作$/, match => `${match[1]} desktop app is waiting for you`],
  [/^Claude 想用电脑操作(?: (.+?))?(?:：(.*))?。请在 Claude 桌面版里允许或拒绝，这一轮才会继续。$/s, match => `Claude wants to use the computer${match[1] ? ` to control ${match[1].replace(/、/g, ', ')}` : ''}${match[2] ? `: ${match[2]}` : ''}. Allow or deny it in the Claude desktop app for this turn to go on.`],
  [/^这一步（(.*)）停在桌面版里，可能需要你在那里确认后才会继续。$/s, match => `This step (${match[1]}) is paused in the desktop app and may need you to confirm it there.`],
  [/^这组问题要在 (.+) 桌面端回答$/, match => `Answer these in the ${match[1]} desktop app`],
  [/^(.+) 有问题要问你$/, match => `${match[1]} has a question for you`],
  [/^没能在(.+)里打开这个会话$/, match => `Couldn't open this chat in ${owner(match[1])} desktop app`],
  [/^(.+)里没有在等回答的这个问题$/, match => `${owner(match[1])} desktop app isn't waiting on this question`],
  [/^(.+)的这个问题里没有「(.*)」这个选项$/, match => `That question in ${owner(match[1])} desktop app has no option "${match[2]}"`],
  [/^(.+)的问题卡片上没有找到提交按钮$/, match => `No submit button on the question card in ${owner(match[1])} desktop app`],
  [/^没能在(.+)的问题卡片上选中「(.*)」，没有提交$/, match => `Couldn't pick "${match[2]}" on the question card in ${owner(match[1])} desktop app, so nothing was submitted`],
  [/^(.+)没有收下这个回答$/, match => `${owner(match[1])} desktop app didn't take this answer`],
  [/^Antigravity 没有收到这个回答（(.*)）$/, match => `Antigravity didn't get this answer (${match[1]})`],
  [/^Antigravity 没有停下这一轮（(.*)）$/, match => `Antigravity didn't stop this turn (${match[1]})`],
  [/^这一轮没法插进去（(.*)$/, match => `Couldn't reach the current turn (${english((match[1] ?? '').replace(/）$/, ''))})`],
  [/^Codex 桌面版的模型菜单里没有 (.+)$/, match => `Codex's desktop model menu has no ${match[1]}`],
  [/^在 Codex 桌面版里选了 (.+)，但它没有切换过去$/, match => `Picked ${match[1]} in Codex's desktop app, but it didn't switch`],
  [/^Codex 桌面版没有「(.*)」这一档推理强度$/, match => `Codex's desktop app has no "${match[1]}" effort level`],
  [/^Codex 桌面版里这个模型没有「(.*)」这一档推理强度$/, match => `This model has no "${match[1]}" effort level in Codex's desktop app`],
  [/^Codex 桌面版的项目菜单里没有「(.*)」$/, match => `Codex's desktop project menu has no "${match[1]}"`],
  [/^在 Codex 桌面版里选了「(.*)」，但项目没有切换过去$/, match => `Picked "${match[1]}" in Codex's desktop app, but the project didn't switch`],
  [/^要换模型或推理强度得在 Codex 桌面版里换，但(.*)，没有发送$/, match => `The model or effort has to be changed in Codex's desktop app, but ${english(match[1])}. Nothing was sent.`],
  [/^没能让 Codex 桌面版停下（(.*)），请在桌面端停止$/, match => `Couldn't stop Codex's desktop app (${english(match[1])}). Stop it on desktop.`],
  [/^(.+)，没有发送$/, match => `${english(match[1])}. Nothing was sent.`],
];
// A text from the server, in the interface language. Unknown texts are shown as they came.
// "Claude 桌面版" → "Claude's"; the bare "桌面版" → "the desktop app's".
function owner(app: unknown): string { const name = String(app).replace(/\s*桌面版$/, '').trim(); return name ? `${name}'s` : "the desktop app's"; }
// Anything that is not a non-empty string comes back as it was.
export function say(text: string): string;
export function say<T>(text: T): T;
export function say(text: unknown): unknown { return language === 'en' ? english(text) : text; }
export function english(text: string): string;
export function english<T>(text: T): T;
export function english(text: unknown): unknown {
  if (typeof text !== 'string' || !text) return text;
  if (Object.hasOwn(REPORTS, text)) return REPORTS[text];
  if (Object.hasOwn(EN, text)) return EN[text];
  for (const [pattern, write] of REPORT_PATTERNS) { const match = pattern.exec(text); if (match) return write(match); }
  return text;
}
export const reportTexts = () => Object.keys(REPORTS);

export function t(text: string, vars?: Record<string, unknown>): string {
  let out = language === 'en' && Object.hasOwn(EN, text) ? EN[text] ?? text : text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
  return out;
}
// The page's own markup (index.html) is written in Chinese; put it into the chosen language
// once, before anything is drawn into it. Only exact, known texts change.
export function translateDocument(root: Document = document): void {
  if (language !== 'en') return;
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue || '', text = value.trim(), english = EN[text];
    if (text && Object.hasOwn(EN, text) && english !== undefined) node.nodeValue = value.replace(text, english);
  }
  for (const element of root.querySelectorAll('[title], [aria-label], [placeholder]')) for (const name of ['title', 'aria-label', 'placeholder']) {
    const value = element.getAttribute(name);
    const english = value ? EN[value] : undefined;
    if (value && Object.hasOwn(EN, value) && english !== undefined) element.setAttribute(name, english);
  }
  root.documentElement.lang = 'en';
}
export const untranslated = (texts: string[]): string[] => texts.filter(text => !Object.hasOwn(EN, text));
