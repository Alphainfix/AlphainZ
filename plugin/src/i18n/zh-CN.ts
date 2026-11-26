/**
 * Simplified Chinese for the interface text.
 *
 * Each key is the English exactly as it is passed to `t`, `tn`, `tr` or `msg`,
 * placeholders included; a source string without an entry shows in English.
 * A key may end in "@@context" when the same English means different things
 * in different places; only the part before "@@" is ever shown in English.
 * The unit test `tests/unit/utils/i18nTable.test.ts` fails when a source
 * string in the code has no entry here, or when an entry's placeholders
 * differ from its key's. `node scripts/i18n-keys.mjs` lists the ones missing.
 *
 * Entries are grouped by the file that first uses them.
 *
 * Writing:
 *   - Full-width punctuation (，。：；？！（）“”), and a space between Chinese
 *     and Latin letters or digits ("3 篇论文", "PDF 附件"). A placeholder needs
 *     no space around it: the space is added when the value starts or ends
 *     with a Latin letter or digit (see `translate` in src/utils/i18n.ts).
 *   - Menu paths keep their arrows: 设置 → 模型 → 服务商.
 *   - Brand and model names, file formats and "API key" stay as they are.
 *
 * Terms, kept the same everywhere (Zotero's own Chinese where it has one):
 *   library → 文献库 ("My Library" → 我的文库)      collection → 分类
 *   item → 条目      tag → 标签      note → 笔记      annotation → 注释
 *   comment (on an annotation) → 评论      highlight → 高亮
 *   attachment → 附件      trash → 回收站      group library → 群组文献库
 *   conversation, chat, thread → 对话      question and answer (exchange) → 问答
 *   action (a saved prompt) → 快捷操作      prompt → 提示词
 *   model → 模型      provider → 服务商      thinking → 思考
 *   embedding → 嵌入      index → 索引      topic search → 主题搜索
 *   full text → 全文      citation → 引用      reader → 阅读器
 *   run (one answer) → 本轮回答      apply / reject / undo → 应用 / 拒绝 / 撤销
 *   the agent → AI      Settings → 设置      sync → 同步      token → token
 */
export const ZH_CN: Readonly<Record<string, string>> = {

  // packages/agent-core/src/run-state/runErrorCopy.ts
  "Account Error":
    "账户错误",
  "Subscription Required":
    "需要订阅",
  "Model Not Set Up":
    "模型尚未设置",
  "Model Not Available":
    "模型不可用",
  "Model Not Supported":
    "不支持该模型",
  "API Key Required":
    "需要 API key",
  "Limit Reached":
    "已达上限",
  "Rate Limit Exceeded":
    "请求过于频繁",
  "API Key Issue":
    "API key 有问题",
  "AI Service Problem":
    "AI 服务出错",
  "Context Limit Reached":
    "超出上下文长度",
  "Content Blocked":
    "内容被拦截",
  "Request Problem":
    "请求有误",
  "Connection Failed":
    "连接失败",
  "Can't Reach the Model":
    "无法连接模型",
  "Run Stopped":
    "回答已停止",
  "Run Failed":
    "回答失败",
  "Update Required":
    "需要更新",
  "System Error":
    "系统错误",
  "Server Error":
    "服务器错误",
  "Client Error":
    "客户端错误",
  "An error occurred":
    "出错了",

  // packages/agent-core/src/run-state/runStatusCopy.ts
  "Reconnecting… ({attempt}/{maxAttempts})":
    "正在重新连接…（{attempt}/{maxAttempts}）",
  "Reconnecting…":
    "正在重新连接…",
  "Retrying…":
    "正在重试…",
  "{label} · {seconds}s":
    "{label} · {seconds} 秒",

  // packages/agent-core/src/run-state/toolCallRequest.ts
  "Item search":
    "条目搜索",
  "Fulltext search":
    "全文搜索",
  "Keyword search":
    "关键词搜索",
  "List items":
    "列出条目",
  "List collections":
    "列出分类",
  "List tags":
    "列出标签",
  "List libraries":
    "列出文献库",
  "Zotero search":
    "Zotero 搜索",
  "Get metadata":
    "读取元数据",
  "Edit metadata":
    "编辑元数据",
  "Get annotations":
    "读取注释",
  "Find annotations":
    "查找注释",
  "Edit annotations":
    "编辑注释",
  "Delete annotations":
    "删除注释",
  "Reading note":
    "阅读笔记",
  "Edit note":
    "编辑笔记",
  "Create note":
    "新建笔记",
  "Filing items":
    "整理条目",
  "Proposing a collection":
    "建议新建分类",
  "Manage tags":
    "管理标签",
  "Manage collections":
    "管理分类",
  "Reading":
    "阅读",
  "Search in documents":
    "在文档中搜索",
  "Search in attachment":
    "在附件中搜索",
  "Search in attachments":
    "在附件中搜索",
  "Find in attachments":
    "在附件中查找",
  "Retrieving data":
    "获取数据",
  "Reading documentation":
    "阅读说明文档",
  "Loading tool results":
    "载入工具结果",
  "Viewing pages":
    "查看页面",
  "Viewing":
    "查看",
  "Reading document":
    "阅读文档",
  "Extracting":
    "提取文本",
  "Highlight annotations":
    "高亮注释",
  "Note annotations":
    "笔记注释",
  "Creating highlight annotations":
    "正在添加高亮注释",
  "Creating sticky notes":
    "正在添加便笺",
  "Suggestions":
    "建议",
  "Asking a question":
    "提问",
  "Web search":
    "网络搜索",
  "Add item":
    "添加条目",
  "Lookup work":
    "查找文献",
  "Batch operations":
    "批量操作",
  "Skipping items":
    "跳过条目",
  "Recording findings":
    "记录发现",
  "Loading tools":
    "载入工具",
  "Finding tools":
    "查找工具",
  "Searching in document":
    "正在文档中搜索",
  "Searching your library":
    "正在搜索你的文献库",
  "Searching the literature":
    "正在检索文献",
  "Proposing a highlight":
    "建议高亮",
  "Adding papers to your library":
    "正在把论文加入你的文献库",

  // packages/agent-core/src/run-state/toolLabels.ts
  "Library Management":
    "文献库管理",
  "Metadata Editing":
    "元数据编辑",
  "Note Editing":
    "笔记编辑",
  "External Literature":
    "外部文献",
  "AlphainZ Help":
    "AlphainZ 帮助",
  "capability":
    "功能",
  "Calling function":
    "调用函数",
  "{label}: {detail}":
    "{label}：{detail}",
  "{label}: \"{text}\"":
    "{label}：“{text}”",
  "{label}: {name}, {locator}":
    "{label}：{name}，{locator}",
  "highlights":
    "高亮",
  "notes":
    "笔记",
  "underlines":
    "下划线",
  "images":
    "图片",
  "inks":
    "笔迹",
  "{count} result":
    "{count} 条结果",
  "{count} results":
    "{count} 条结果",
  "{count} collection":
    "{count} 个分类",
  "{count} collections":
    "{count} 个分类",
  "{count} tag":
    "{count} 个标签",
  "{count} tags":
    "{count} 个标签",
  "{count} found":
    "找到 {count} 条",
  "skipped":
    "已跳过",
  "no response":
    "未回答",
  "answered":
    "已回答",
  "Library management":
    "文献库管理",
  "skill":
    "技能",
  "{label} ({detail})":
    "{label}（{detail}）",
  "in {publication}":
    "刊物：{publication}",
  "tag \"{tag}\"":
    "标签“{tag}”",
  "Retrieving previous results":
    "获取之前的结果",
  "Loading skill: {skill}":
    "载入技能：{skill}",
  "p. {page}+":
    "第 {page} 页起",
  "{label}: \"{query}\" in {name}":
    "{label}：“{query}”（{name}）",
  "Proposing a {color} highlight":
    "建议{color}高亮",
  "{label} in {name}, {locator}":
    "{label}：{name}，{locator}",
  "{label} in {name}":
    "{label}：{name}",
  "{label}, {locator}":
    "{label}，{locator}",
  "{title} and {count} more":
    "{title} 及另外 {count} 篇",
  "into {count} collection":
    "移入 {count} 个分类",
  "into {count} collections":
    "移入 {count} 个分类",
  "out of {count} collection":
    "移出 {count} 个分类",
  "out of {count} collections":
    "移出 {count} 个分类",
  "{label}: {items} {changes}":
    "{label}：{items}，{changes}",
  "{label} \"{name}\" with {count} item":
    "{label}“{name}”，含 {count} 个条目",
  "{label} \"{name}\" with {count} items":
    "{label}“{name}”，含 {count} 个条目",
  "{label} \"{name}\"":
    "{label}“{name}”",
  "lines {lines}":
    "第 {lines} 行",
  "line {line}":
    "第 {line} 行",
  "annotations":
    "注释",
  "{color} {annotations}":
    "{color}{annotations}",
  "tagged \"{tag}\"":
    "标签为“{tag}”",
  "Invalid query":
    "查询无效",
  "{count} queries":
    "{count} 个查询",
  "contains":
    "包含",
  "does not contain":
    "不包含",
  "begins with":
    "开头是",
  "before":
    "早于",
  "after":
    "晚于",
  "in the last":
    "在最近",
  "{field} is empty":
    "{field}为空",
  "\"{field}\" {operator} \"{value}\"":
    "“{field}”{operator}“{value}”",
  "{label} in \"{name}\"":
    "{label}：“{name}”中",
  "subcollections":
    "子分类",
  "{label} in collection":
    "{label}（分类中）",
  "Loading tools: {capability}":
    "载入工具：{capability}",

  // packages/agent-core/src/types/actions.ts
  "Items":
    "条目",
  "Works anywhere, no context needed":
    "任何地方都能用，无需上下文",
  "Works with library items":
    "适用于文献库条目",
  "Works with PDF, EPUB, and snapshot attachments":
    "适用于 PDF、EPUB 和网页快照附件",
  "Works with Zotero notes":
    "适用于 Zotero 笔记",
  "Works with collections":
    "适用于分类",
  "Item or attachment":
    "条目或附件",
  "Works with library items and file attachments":
    "适用于文献库条目和文件附件",
  " or ":
    "或",

  // packages/agent-ui/src/auth/OTPVerification.tsx
  "We sent a 6-digit code to {email}":
    "我们已向 {email} 发送 6 位验证码",
  "Check your email":
    "请查收邮件",
  "Verification code":
    "验证码",
  "Verifying...":
    "正在验证…",
  "Verify Email":
    "验证邮箱",
  "Resend code in {seconds}s":
    "{seconds} 秒后可重新发送",
  "Resend code":
    "重新发送验证码",
  "Wrong email? Change it":
    "邮箱填错了？点此修改",

  // packages/agent-ui/src/chat/actionPopup.ts
  "Click to edit in preferences":
    "点击在设置中编辑",

  // packages/agent-ui/src/chat/AskUserQuestionCard.tsx
  "Question {number} of {total}":
    "第 {number} 个问题，共 {total} 个",
  "Question":
    "问题",
  "Previous question":
    "上一个问题",
  "{number} of {total}":
    "{number} / {total}",
  "Next question":
    "下一个问题",
  "(Multiple choice)":
    "（可多选）",
  "Other (custom answer)":
    "其他（自己填写）",
  "Other...":
    "其他…",
  "Custom answer for: {question}":
    "自定义回答：{question}",
  "Stop the agent run":
    "停止 AI 的这次回答",
  "Skip this question and submit":
    "跳过此问题并提交",
  "Skip this question":
    "跳过此问题",
  "Submit answers":
    "提交回答",
  "Submit":
    "提交",

  // packages/agent-ui/src/chat/BatchApprovalCard.tsx
  "Apply library changes without asking again":
    "修改文献库时不再询问",
  "Ask permission":
    "每次询问",
  "Add instructions":
    "补充说明",
  "Batch operation approval":
    "批量操作审批",
  "What to change, or what you want done instead":
    "要改什么，或者你想换成怎样做",
  "Instructions for this batch (optional)":
    "对这批操作的说明（可选）",
  "Add instructions for this batch":
    "为这批操作补充说明",
  "How this batch's changes are approved":
    "这批修改的批准方式",
  "Cancel batch operation":
    "取消批量操作",
  "Approve batch operation":
    "批准批量操作",

  // packages/agent-ui/src/chat/Citation.tsx
  "p.{pages}":
    "第 {pages} 页",
  "Ibid":
    "同上",
  "{citation}, p.{pages}":
    "{citation}，第 {pages} 页",
  "Lines {first}–{last}":
    "第 {first}–{last} 行",
  "Line {line}":
    "第 {line} 行",
  "View details":
    "查看详情",
  "Opens external file":
    "打开外部文件",
  "Opens note":
    "打开笔记",
  "Opens annotation in PDF":
    "在 PDF 中打开注释",
  "Opens EPUB at page {page}":
    "在 EPUB 第 {page} 页打开",
  "Opens EPUB at location":
    "在 EPUB 中定位打开",
  "Highlights passage on page {page}":
    "高亮第 {page} 页的段落",
  "Highlights passage in PDF":
    "在 PDF 中高亮段落",
  "Opens PDF on page {page}":
    "在 PDF 第 {page} 页打开",
  "Opens PDF at location":
    "在 PDF 中定位打开",
  "Opens text file (external application)":
    "打开文本文件（外部程序）",
  "Opens Snapshot at location":
    "在网页快照中定位打开",
  "Opens Snapshot":
    "打开网页快照",
  "Opens PDF":
    "打开 PDF",
  "Reveals item in library":
    "在文献库中显示条目",
  "Invalid citation":
    "无效引用",

  // packages/agent-ui/src/chat/CitedSourcesList.tsx
  "p. {pages}":
    "第 {pages} 页",
  "Open file":
    "打开文件",
  "Reveal source":
    "显示来源",

  // packages/agent-ui/src/chat/CreditConfirmationCard.tsx
  "Credit confirmation":
    "额度确认",

  // packages/agent-ui/src/composer/LexicalEditorInput.tsx
  "Message":
    "消息",

  // packages/agent-ui/src/composer/MentionPill.tsx
  "Mention: {label}, {sublabel}":
    "提及：{label}，{sublabel}",
  "Mention: {label}":
    "提及：{label}",
  "Remove mention":
    "移除提及",

  // packages/agent-ui/src/composer/SlashCommandNode.tsx
  "{command}, command, unavailable":
    "{command}，命令，不可用",
  "{command}, command":
    "{command}，命令",

  // packages/agent-ui/src/primitives/SearchMenu.tsx
  "Start typing to search":
    "输入以搜索",

  // packages/agent-ui/src/primitives/Tag.tsx
  "Close tag":
    "关闭标签",

  // react/atoms/actions.ts
  "Libraries still loading":
    "文献库仍在载入",
  "AlphainZ is still reading your Zotero libraries. Try again in a moment.":
    "AlphainZ 仍在读取你的 Zotero 文献库，请稍后再试。",
  "Action skipped":
    "已跳过快捷操作",
  "This action targets an item in a library you excluded from AlphainZ. You can change excluded libraries in AlphainZ Settings.":
    "这个快捷操作针对的条目位于你已从 AlphainZ 排除的文献库中。可以在 AlphainZ 设置里修改排除的文献库。",
  "This action targets a collection in a library you excluded from AlphainZ. You can change excluded libraries in AlphainZ Settings.":
    "这个快捷操作针对的分类位于你已从 AlphainZ 排除的文献库中。可以在 AlphainZ 设置里修改排除的文献库。",
  "One or more items failed validation.":
    "有条目未通过检查。",
  "This action references an item in a library you excluded from AlphainZ. You can change excluded libraries in AlphainZ Settings.":
    "这个快捷操作引用的条目位于你已从 AlphainZ 排除的文献库中。可以在 AlphainZ 设置里修改排除的文献库。",

  // react/atoms/agentRunAtoms.ts
  "Chat changed elsewhere":
    "对话已在别处更改",
  "This chat was changed somewhere else, so the failed run was not retried automatically. Reloading the chat.":
    "这个对话已在别处被修改，因此没有自动重试失败的回答。正在重新载入对话。",
  "Failed to automatically retry run":
    "自动重试失败",
  "• {count} PDF annotation":
    "• {count} 条 PDF 注释",
  "• {count} PDF annotations":
    "• {count} 条 PDF 注释",
  "• {count} PDF annotation change":
    "• {count} 处 PDF 注释修改",
  "• {count} PDF annotation changes":
    "• {count} 处 PDF 注释修改",
  "• {count} Zotero note":
    "• {count} 篇 Zotero 笔记",
  "• {count} Zotero notes":
    "• {count} 篇 Zotero 笔记",
  "• {count} metadata edit":
    "• {count} 处元数据修改",
  "• {count} metadata edits":
    "• {count} 处元数据修改",
  "• {count} note edit":
    "• {count} 处笔记修改",
  "• {count} note edits":
    "• {count} 处笔记修改",
  "• {count} created item":
    "• 新建了 {count} 个条目",
  "• {count} created items":
    "• 新建了 {count} 个条目",
  "• {count} created collection":
    "• 新建了 {count} 个分类",
  "• {count} created collections":
    "• 新建了 {count} 个分类",
  "• {count} organize action":
    "• {count} 项整理操作",
  "• {count} organize actions":
    "• {count} 项整理操作",
  "• {count} tag change":
    "• {count} 处标签修改",
  "• {count} tag changes":
    "• {count} 处标签修改",
  "• {count} collection change":
    "• {count} 处分类修改",
  "• {count} collection changes":
    "• {count} 处分类修改",
  "• {count} created note":
    "• 新建了 {count} 篇笔记",
  "• {count} created notes":
    "• 新建了 {count} 篇笔记",
  "Retry?":
    "重试？",
  "The following changes were applied and can be undone:":
    "以下修改已经应用，可以撤销：",
  "Undo them and retry, or retry without undoing?":
    "撤销后再重试，还是不撤销直接重试？",
  "Undo && Retry":
    "撤销并重试",
  "Retry":
    "重试",
  "Item not found in your Zotero library":
    "在你的 Zotero 文献库中找不到该条目",
  "Library is not available on this computer. It may be a group library you haven't joined on this device":
    "这台电脑上没有这个文献库，可能是你在这台设备上尚未加入的群组文献库",
  "Item is in trash":
    "条目在回收站中",
  "Library is not configured to sync with AlphainZ":
    "这个文献库未设置与 AlphainZ 同步",
  "Item type not supported":
    "不支持该条目类型",
  "Item was added after the last sync. Please wait for sync to complete or sync manually in settings":
    "条目是在上次同步之后添加的。请等待同步完成，或在设置中手动同步",
  "File is unavailable":
    "文件不可用",
  "Unexpected error. Try again; if it keeps happening, Zotero's debug output (Help → Debug Output Logging) will show why.":
    "意外错误。请重试；如果一直出现，Zotero 的调试输出（帮助 → 调试输出日志）会显示原因。",
  "Unable to process {count} attachment: {reason}":
    "无法处理 {count} 个附件：{reason}",
  "Unable to process {count} attachments: {reason}":
    "无法处理 {count} 个附件：{reason}",
  "{count} other attachment has a different reason.":
    "另有 {count} 个附件的原因不同。",
  "{count} other attachments have different reasons.":
    "另有 {count} 个附件的原因不同。",
  "Could not save the answer to the highlight":
    "无法把回答保存到高亮",
  "Save to the highlight?":
    "保存到高亮？",
  "Could not save":
    "无法保存",
  "Indexing your library":
    "正在为你的文献库建立索引",
  "We are processing your library to enable Beta features. You can use standard features in the meantime.":
    "我们正在处理你的文献库以启用 Beta 功能。在此期间可以照常使用标准功能。",
  "AlphainZ is still reading your Zotero libraries. Try sending again in a moment.":
    "AlphainZ 仍在读取你的 Zotero 文献库，请稍后再发送。",
  "Item Removed":
    "已移除条目",
  "Items Removed":
    "已移除条目",
  "An item that AlphainZ cannot use was removed from this message.":
    "一个 AlphainZ 无法使用的条目已从这条消息中移除。",
  "{count} items that AlphainZ cannot use were removed from this message.":
    "{count} 个 AlphainZ 无法使用的条目已从这条消息中移除。",
  "File unavailable":
    "文件不可用",
  "\"{filename}\" is no longer available and was removed from the message.":
    "“{filename}”已不可用，已从消息中移除。",
  "Failed to prepare message":
    "消息准备失败",
  "Retry from here?":
    "从这里重试？",
  "They cannot be brought back.":
    "删除后无法恢复。",
  "Retrying this message also removes the question and answer after it in this chat, including the answer still being written.":
    "重试这条消息还会删除对话中它之后的那一轮问答，包括正在写的回答。",
  "Retrying this message also removes the {count} questions and answers after it in this chat, including the answer still being written.":
    "重试这条消息还会删除对话中它之后的 {count} 轮问答，包括正在写的回答。",
  "Retrying this message also removes the question and answer after it in this chat.":
    "重试这条消息还会删除对话中它之后的那一轮问答。",
  "Retrying this message also removes the {count} questions and answers after it in this chat.":
    "重试这条消息还会删除对话中它之后的 {count} 轮问答。",
  "Retry failed":
    "重试失败",
  "AlphainZ could not be reached to start the retry. Nothing was changed — please try again.":
    "无法连接 AlphainZ 来开始重试。没有做任何更改，请再试一次。",
  "This chat was changed somewhere else (for example on another device), so the retry was not applied. Reloading the chat.":
    "这个对话已在别处被修改（例如另一台设备），因此没有执行重试。正在重新载入对话。",
  "Failed to regenerate response":
    "重新生成回答失败",
  "Failed to regenerate with edited prompt":
    "用修改后的提问重新生成失败",
  "Failed to automatically resume run":
    "自动继续回答失败",
  "Failed to resume run":
    "继续回答失败",

  // react/atoms/citationTip.ts
  "Understanding Citations":
    "了解引用",

  // react/atoms/deferredToolPreferences.ts
  "Always ask":
    "总是询问",
  "Always apply":
    "总是应用",
  "Always review later":
    "总是稍后审阅",
  "Show each change and wait for your approval":
    "逐条显示修改，等你批准",
  "Make the change without asking (the riskiest ones still ask)":
    "不询问直接修改（风险最高的仍会询问）",
  "Don't ask now; list the changes after the answer for you to apply or reject":
    "现在不问；回答结束后列出修改，由你应用或拒绝",

  // react/atoms/errors.ts
  "Unexpected error":
    "意外错误",
  "Unable to read file":
    "无法读取文件",
  "File Type not supported":
    "不支持该文件类型",
  "Too many pages":
    "页数过多",
  "Too many pages for OCR":
    "页数过多，无法 OCR",
  "Insufficient balance":
    "余额不足",
  "File too large":
    "文件过大",
  "File is encrypted":
    "文件已加密",
  "File requires OCR":
    "文件需要 OCR",
  "Insufficient text":
    "文本过少",
  "File missing":
    "文件缺失",
  "OCR failed":
    "OCR 失败",
  "Attachment deleted":
    "附件已删除",
  "File not available":
    "文件不可用",
  "Zotero login required":
    "需要登录 Zotero",
  "Zotero server download failed":
    "从 Zotero 服务器下载失败",
  "Upload failed":
    "上传失败",
  "Unable to read":
    "无法读取",

  // react/atoms/excludedLibraries.ts
  "Unable to update library access":
    "无法更新文献库访问权限",
  "That change could not be saved. Check the Zotero error console.":
    "无法保存这项更改。请查看 Zotero 的错误控制台。",

  // react/atoms/firstRun.ts
  "What's new in my research areas?":
    "我的研究领域有什么新进展？",
  "Find recent papers in the topics you are working on.":
    "查找你正在研究的主题里的最新论文。",
  "Organize my recent additions":
    "整理我最近添加的条目",
  "Tag and file the items you added in the last 7 days.":
    "为最近 7 天添加的条目打标签并归入分类。",
  "Tag all untagged items":
    "给所有没有标签的条目打标签",
  "Assign consistent subject tags to items that have none.":
    "为没有标签的条目添加统一的主题标签。",

  // react/atoms/fulltextIndex.ts
  "No embedding provider is chosen.":
    "尚未选择嵌入服务。",
  "Embeddings are set to {provider}, but this computer has no {provider} API key.":
    "嵌入服务设为 {provider}，但这台电脑上没有 {provider} 的 API key。",
  "Embeddings are set to Ollama, but {reason}.":
    "嵌入服务设为 Ollama，但{reason}。",
  "The full text of your PDFs is indexed once that is fixed.":
    "修好之后，会为你的 PDF 全文建立索引。",
  "The index database is not open yet; try again in a moment.":
    "索引数据库还没有打开，请稍后再试。",

  // react/atoms/messageComposition.ts
  "{count} Items Removed":
    "已移除 {count} 个条目",
  "File Removed":
    "已移除文件",
  "Annotation":
    "注释",
  "Note":
    "笔记",
  "Unknown error":
    "未知错误",
  "Item Not Added":
    "条目未添加",
  "{count} Items Not Added":
    "{count} 个条目未添加",
  "File Not Added":
    "文件未添加",

  // react/atoms/pageImageIndex.ts
  "Waiting for the text index":
    "等待文本索引",
  "The linked PDF is not at its path on this computer. Relink it in Zotero, then retry.":
    "链接的 PDF 不在这台电脑上原来的位置。请在 Zotero 中重新链接，然后重试。",
  "The PDF file is not on this computer, and Zotero never uploaded it, so it cannot be downloaded either. Attach the PDF to the item again (for example, move the empty attachment to the trash, then use Find Available PDF on the item), then retry.":
    "这台电脑上没有这个 PDF 文件，Zotero 也从未上传过它，所以无法下载。请重新给条目附加 PDF（例如把空附件移到回收站，再对条目使用“查找可用 PDF”），然后重试。",
  "The PDF is not downloaded to this computer yet. Open it once in Zotero to download it, then retry.":
    "这个 PDF 还没有下载到这台电脑。请在 Zotero 中打开一次以下载，然后重试。",
  "The PDF file is not on this computer, and file syncing is off for this library in Zotero's Sync settings. Turn it on or attach the PDF again, then retry.":
    "这台电脑上没有这个 PDF 文件，而且 Zotero 同步设置中此文献库的文件同步已关闭。请打开文件同步或重新附加 PDF，然后重试。",

  // react/atoms/runApprovalPolicy.ts
  "metadata edits":
    "元数据修改",
  "note edits":
    "笔记修改",
  "note creation":
    "新建笔记",
  "item organization and collection creation":
    "整理条目和新建分类",
  "library-wide tag and collection changes":
    "整个文献库的标签和分类更改",
  "annotation creation and editing":
    "添加和编辑注释",
  "annotation deletion":
    "删除注释",
  "item creation":
    "新建条目",
  "Allow all {scope} for this run":
    "本轮回答中全部允许：{scope}",

  // react/atoms/streamDisplay.ts
  "Show all steps":
    "显示全部步骤",
  "Collapse steps":
    "折叠步骤",
  "Answer only":
    "只看回答",
  "Thinking and tool calls inline":
    "思考和工具调用直接显示",
  "One line you can open":
    "收成一行，可点开",
  "Everything while it works, then just the answer":
    "进行中全部显示，完成后只留回答",

  // react/atoms/threadCompaction.ts
  "Compacted {count} earlier exchange":
    "已压缩之前的 {count} 轮问答",
  "Compacted {count} earlier exchanges":
    "已压缩之前的 {count} 轮问答",
  "The model now reads a summary of them instead. Click the marker in the chat to read or discard it.":
    "模型现在改读它们的摘要。点对话中的标记可以查看或丢弃摘要。",

  // react/atoms/threads.ts
  "Open chat from another Zotero?":
    "打开来自另一个 Zotero 的对话？",
  "This chat was created with a different Zotero account or database. Cited items and links may not work here. Any library changes like editing metadata, adding PDF annotations, or organizing items may not apply or even change the incorrect Zotero items.":
    "这个对话是用另一个 Zotero 账户或数据库创建的。引用的条目和链接在这里可能无法使用。编辑元数据、添加 PDF 注释、整理条目等文献库修改可能无法生效，甚至会改错 Zotero 条目。",
  "Open Chat":
    "打开对话",
  "Start new chat?":
    "开始新对话？",
  "AlphainZ is still generating a response in this chat. Starting a new chat will stop it.":
    "AlphainZ 还在这个对话里生成回答。开始新对话会中止它。",
  "Start New Chat":
    "开始新对话",
  "Switch chat?":
    "切换对话？",
  "AlphainZ is still generating a response in this chat. Switching chats will stop it.":
    "AlphainZ 还在这个对话里生成回答。切换对话会中止它。",
  "Switch Chat":
    "切换对话",

  // react/atoms/welcomeWizard.ts
  "Its model needs a {provider} key, and API keys stay on each computer: paste one in Settings → Model, or pick another model.":
    "它的模型需要 {provider} 的 key，而 API key 只保存在各自的电脑上：请在 设置 → 模型 中粘贴一个，或者换一个模型。",
  "Its model's provider is not set up on this computer: add it in Settings → Model, or pick another model.":
    "它的模型所用的服务商在这台电脑上还没有设置：请在 设置 → 模型 中添加，或者换一个模型。",
  "Kept from this computer, and sent to the other one: {settings}.":
    "保留了这台电脑上的设置，并同步给另一台：{settings}。",
  "Using your other computer's settings":
    "已使用你另一台电脑的设置",
  "Taken from the computer that already syncs here: {settings}.":
    "采用了已在这里同步的那台电脑的设置：{settings}。",
  "API keys stay on each computer.":
    "API key 只保存在各自的电脑上。",

  // react/components/ActionSuggestions.tsx
  "This library is not synced":
    "这个文献库没有同步",
  "No actions available for the current selection.":
    "当前选中的内容没有可用的快捷操作。",
  "Edit actions":
    "编辑快捷操作",
  "Actions for":
    "快捷操作：",
  "Actions":
    "快捷操作",

  // react/components/agentRuns/AgentRunFooter.tsx
  "Copy":
    "复制",
  "Copy link to message":
    "复制消息链接",
  "Copy message ID":
    "复制消息 ID",
  "Save as note":
    "保存为笔记",
  "Save as child note":
    "保存为子笔记",
  "Copy chat ID":
    "复制对话 ID",
  "Copy citation metadata":
    "复制引用元数据",
  "User":
    "用户",
  "Could not save note":
    "无法保存笔记",
  "Failed to save note.":
    "保存笔记失败。",
  "Retry from here — removes the later message":
    "从这里重试——会删除后面的 1 条消息",
  "Retry from here — removes the {count} later messages":
    "从这里重试——会删除后面的 {count} 条消息",
  "Linking sources...":
    "正在关联来源…",
  "{count} Source":
    "{count} 个来源",
  "{count} Sources":
    "{count} 个来源",
  "Share":
    "分享",
  "More options":
    "更多选项",

  // react/components/agentRuns/AnnotationTooltip.tsx
  "Page {page}":
    "第 {page} 页",
  "Highlight Annotation":
    "高亮注释",
  "Underline Annotation":
    "下划线注释",
  "Sticky Note":
    "便笺",
  "Area Annotation":
    "区域注释",
  "Text Annotation":
    "文本注释",

  // react/components/agentRuns/ContextCompressionIndicator.tsx
  "Summary of {count} earlier exchange":
    "之前 {count} 轮问答的摘要",
  "Summary of {count} earlier exchanges":
    "之前 {count} 轮问答的摘要",
  "Earlier exchanges summarized here":
    "之前的问答已在此总结",
  "{count} earlier exchange compacted — the model reads a summary of it instead":
    "已压缩之前的 {count} 轮问答——模型改读它的摘要",
  "{count} earlier exchanges compacted — the model reads a summary of them instead":
    "已压缩之前的 {count} 轮问答——模型改读它们的摘要",
  "{count} earlier exchange compacted — the summary is not used while automatic compaction is off":
    "已压缩之前的 {count} 轮问答——自动压缩已关闭，暂不使用摘要",
  "{count} earlier exchanges compacted — the summary is not used while automatic compaction is off":
    "已压缩之前的 {count} 轮问答——自动压缩已关闭，暂不使用摘要",
  "The model reads this summary instead of that earlier exchange. It stays here in full, and nothing on this computer changes.":
    "模型会读这份摘要，而不是之前那一轮问答。原文仍完整保留在这里，这台电脑上的内容不会有任何改变。",
  "The model reads this summary instead of those {count} earlier exchanges. They stay here in full, and nothing on this computer changes.":
    "模型会读这份摘要，而不是之前那 {count} 轮问答。原文仍完整保留在这里，这台电脑上的内容不会有任何改变。",
  "If the summary gets something wrong, discard it. From your next message the model is sent your last 10 exchanges instead of the summary (older ones are left out), which costs more. A new summary is written from the originals later.":
    "如果摘要有误，可以丢弃。从你的下一条消息起，模型会改收你最近的 10 轮问答而不是摘要（更早的不再发送），花费会更多。之后会根据原文重新写一份摘要。",
  "Automatic compaction is off in Settings → Advanced, so the model is not sent this summary: it is sent your last 10 exchanges, and older ones are left out. If you turn compaction back on, the summary is used again unless you discard it.":
    "设置 → 高级 中的自动压缩已关闭，所以不会把这份摘要发给模型：模型会收到你最近的 10 轮问答，更早的不再发送。如果重新打开压缩，除非你丢弃它，否则会再次使用这份摘要。",
  "Keep":
    "保留",
  "Discard summary":
    "丢弃摘要",

  // react/components/agentRuns/ConversationOutline.tsx
  "Conversation outline":
    "对话大纲",
  "Questions":
    "问题",
  "Search questions and answers":
    "搜索问题和回答",
  "Search questions...":
    "搜索问题…",
  "Question {number}: {question}, current question":
    "问题 {number}：{question}，当前问题",
  "Question {number}: {question}":
    "问题 {number}：{question}",
  "(current)":
    "（当前）",
  "No matching questions":
    "没有匹配的问题",

  // react/components/agentRuns/ConversationRail.tsx
  "Questions in this conversation":
    "本对话中的问题",
  "Question {number}":
    "问题 {number}",
  "Press Enter to jump":
    "按回车跳转",
  "Click to jump":
    "点击跳转",

  // react/components/agentRuns/EditNotePreview.tsx
  "Replaces the entire note":
    "替换整篇笔记",
  "Replaces the entire note: {oldLines} → {newLines} lines":
    "替换整篇笔记：{oldLines} 行 → {newLines} 行",
  "Replaces the entire note: {oldLines} → {newLines} lines, about {percent}% of the text is deleted":
    "替换整篇笔记：{oldLines} 行 → {newLines} 行，约 {percent}% 的文字被删除",
  "Replaces the entire note: {oldLines} → {newLines} lines, about {percent}% of the text is replaced":
    "替换整篇笔记：{oldLines} 行 → {newLines} 行，约 {percent}% 的文字被替换",
  "Delete (all occurrences) — {count} occurrence":
    "删除（所有出现处）——{count} 处",
  "Delete (all occurrences) — {count} occurrences":
    "删除（所有出现处）——{count} 处",
  "Replace (all occurrences) — {count} occurrence":
    "替换（所有出现处）——{count} 处",
  "Replace (all occurrences) — {count} occurrences":
    "替换（所有出现处）——{count} 处",
  "Delete (all occurrences)":
    "删除（所有出现处）",
  "Replace (all occurrences)":
    "替换（所有出现处）",

  // react/components/agentRuns/GenericAgentActionView.tsx
  "Action":
    "操作",
  "{count} annotation":
    "{count} 条注释",
  "{count} annotations":
    "{count} 条注释",
  "{count} item":
    "{count} 个条目",
  "{count} items":
    "{count} 个条目",
  "{count} edit":
    "{count} 处修改",
  "{count} edits":
    "{count} 处修改",

  // react/components/agentRuns/requestChips/RequestChipPrimitives.tsx
  "Attachment":
    "附件",
  "Item":
    "条目",
  "Reveal in library":
    "在文献库中显示",
  "Open annotation in PDF":
    "在 PDF 中打开注释",
  "(no text)":
    "（无文字）",
  "p.{page}":
    "第 {page} 页",
  "{count} more":
    "还有 {count} 个",
  "{count} Highlight":
    "{count} 处高亮",
  "{count} Highlights":
    "{count} 处高亮",
  "Untitled Note":
    "未命名笔记",
  "Open note":
    "打开笔记",
  "Search filter":
    "搜索筛选",
  "Collection":
    "分类",
  "External file":
    "外部文件",
  "Open external file":
    "打开外部文件",

  // react/components/agentRuns/requestChips/RequestChips.tsx
  "Standalone attachment":
    "独立附件",
  "Attached note":
    "附属笔记",
  "Standalone note":
    "独立笔记",

  // react/components/agentRuns/RunErrorDisplay.tsx
  "Connection details: {details}":
    "连接详情：{details}",
  "Reason: {details}":
    "原因：{details}",
  "Resume":
    "继续",
  "Open Settings → Model":
    "打开 设置 → 模型",

  // react/components/agentRuns/RunInterruptedDisplay.tsx
  "Response interrupted":
    "回答被中断",
  "Continue response":
    "继续回答",
  "The connection dropped before this response finished. Continuing picks up where it left off.":
    "回答完成前连接断开了。继续会从中断处接着写。",
  "The server restarted before this response finished. Continuing picks up where it left off.":
    "回答完成前服务器重启了。继续会从中断处接着写。",
  "AlphainZ closed before this response finished. Continuing picks up where it left off.":
    "回答完成前 AlphainZ 被关闭了。继续会从中断处接着写。",

  // react/components/agentRuns/RunResumeDisplay.tsx
  "Resuming interrupted request...":
    "正在继续被中断的请求…",

  // react/components/agentRuns/RunStatusIndicator.tsx
  "Generating":
    "正在生成",

  // react/components/agentRuns/RunWarningDisplay.tsx
  "Open Settings → Advanced":
    "打开 设置 → 高级",
  "Hide this notice for the rest of the session":
    "本次运行期间不再显示此提示",
  "Hide for the rest of the session":
    "本次运行期间不再显示",
  "Dismiss this warning":
    "关闭此警告",

  // react/components/agentRuns/ScreenReaderRunAnnouncer.tsx
  "Message sent. AlphainZ is generating a response.":
    "消息已发送。AlphainZ 正在生成回答。",
  "AlphainZ response: {response} End of response. Press Enter to message AlphainZ.":
    "AlphainZ 的回答：{response} 回答结束。按回车给 AlphainZ 发消息。",

  // react/components/agentRuns/SuggestionsView.tsx
  "Next steps":
    "下一步",
  "Dismiss suggestions":
    "关闭建议",

  // react/components/agentRuns/ThinkingPartView.tsx
  "Thinking":
    "思考",
  "Thoughts":
    "思考过程",

  // react/components/agentRuns/ThreadView.tsx
  "No messages yet":
    "还没有消息",

  // react/components/agentRuns/TokenUsageDisplay.tsx
  "{tokens} tokens • {cost}":
    "{tokens} token • {cost}",
  "{tokens} tokens":
    "{tokens} token",
  "Input tokens":
    "输入 token",
  "Output tokens":
    "输出 token",
  "Cache read":
    "缓存读取",
  "Cache write":
    "缓存写入",
  "Total cost":
    "总费用",
  "Usage details":
    "用量详情",

  // react/components/agentRuns/ToolResultView.tsx
  "No result":
    "没有结果",
  "Tool results not available":
    "工具结果不可用",

  // react/components/agentRuns/toolResultViews/AnnotationListResultView.tsx
  "No annotations found":
    "没有找到注释",

  // react/components/agentRuns/toolResultViews/AnnotationResultRow.tsx
  "Highlight annotation":
    "高亮注释",
  "Underline annotation":
    "下划线注释",
  "Note annotation":
    "笔记注释",
  "Image annotation":
    "图片注释",
  "Ink annotation":
    "笔迹注释",
  "Text annotation":
    "文本注释",
  "Click to view in Zotero Reader":
    "点击在 Zotero 阅读器中查看",

  // react/components/agentRuns/toolResultViews/AttachmentSearchResultView.tsx
  "{count} match":
    "{count} 处匹配",
  "{count} matches":
    "{count} 处匹配",
  "{count} document":
    "{count} 篇文档",
  "{count} documents":
    "{count} 篇文档",
  "search error":
    "搜索出错",
  "no matches":
    "无匹配",
  "No matches found":
    "没有找到匹配",
  "Click to open the file":
    "点击打开文件",
  "Click to reveal in Zotero":
    "点击在 Zotero 中显示",
  "Hide {count} document without matches":
    "隐藏 {count} 篇没有匹配的文档",
  "Hide {count} documents without matches":
    "隐藏 {count} 篇没有匹配的文档",
  "Show {count} document without matches":
    "显示 {count} 篇没有匹配的文档",
  "Show {count} documents without matches":
    "显示 {count} 篇没有匹配的文档",
  "{label} ({count} could not be searched)":
    "{label}（{count} 篇无法搜索）",
  "{matches} found across {documents}":
    "在{documents}中找到{matches}",
  "Showing {shown} of {total} matches across {documents}":
    "显示 {total} 处匹配中的 {shown} 处，分布在{documents}中",

  // react/components/agentRuns/toolResultViews/BatchOperationResultView.tsx
  "Requested action":
    "请求的操作",
  "Your instructions":
    "你的说明",
  "What this batch removes or overwrites":
    "这批操作会删除或覆盖的内容",

  // react/components/agentRuns/toolResultViews/CollectionListResultView.tsx
  "No collections found":
    "没有找到分类",
  "Showing {shown} of {total} collections":
    "显示 {total} 个分类中的 {shown} 个",

  // react/components/agentRuns/toolResultViews/ExternalReferenceListResultView.tsx
  "No works found":
    "没有找到文献",
  "No external references found":
    "没有找到外部文献",
  "{query} — not found":
    "{query}——未找到",
  "{query} — lookup unavailable":
    "{query}——暂时无法查询",

  // react/components/agentRuns/toolResultViews/ItemListResultView.tsx
  "Attached to {parent}":
    "附属于 {parent}",
  "No items found":
    "没有找到条目",

  // react/components/agentRuns/toolResultViews/TagListResultView.tsx
  "{count} attachment":
    "{count} 个附件",
  "{count} attachments":
    "{count} 个附件",
  "{count} note":
    "{count} 篇笔记",
  "{count} notes":
    "{count} 篇笔记",
  "No tags found":
    "没有找到标签",
  "Showing {shown} of {total} tags":
    "显示 {total} 个标签中的 {shown} 个",

  // react/components/agentRuns/toolResultViews/UserQuestionResultView.tsx
  "Question skipped":
    "已跳过问题",
  "No response":
    "未回答",
  "Not answered":
    "未回答",

  // react/components/agentRuns/UserRequestView.tsx
  "No actions found":
    "没有找到快捷操作",
  "Search actions...":
    "搜索快捷操作…",
  "Edit your message...":
    "编辑你的消息…",
  "Edit message":
    "编辑消息",
  "Cancel":
    "取消",
  "Send":
    "发送",

  // react/components/agentRuns/workStream.ts
  "{steps} · +{count} more":
    "{steps} · 另外 {count} 项",

  // react/components/CategoryPanel.tsx
  "Click to run action":
    "点击运行快捷操作",
  "Create repeatable workflows for common research tasks":
    "为常用研究任务创建可重复的工作流程",
  "Add custom action":
    "添加自定义快捷操作",
  "Add Custom Action":
    "添加自定义快捷操作",

  // react/components/dialog/ErrorReportDialog.tsx
  "Report Error":
    "报告错误",
  "Close dialog":
    "关闭对话框",
  "Describe the issue you encountered...":
    "描述你遇到的问题…",
  "The current state of your application will be shared with the developers.":
    "应用程序的当前状态会发送给开发者。",
  "Sending...":
    "正在发送…",

  // react/components/dialog/ExternalReferenceDetailsDialog.tsx
  "Close":
    "关闭",

  // react/components/dialog/SkippedFilesDialog.tsx
  "{skippedFilesCount} Skipped Files":
    "{skippedFilesCount} 个跳过的文件",
  "Skipped Files":
    "跳过的文件",
  "Skipped files":
    "跳过的文件",
  "Reasons for skipping files":
    "跳过文件的原因",

  // react/components/externalReferences/ExternalReferenceDetails.tsx
  "Untitled Item":
    "未命名条目",
  "Abstract":
    "摘要",

  // react/components/Header.tsx
  "Close chat":
    "关闭对话",
  "Close AlphainZ panel":
    "关闭 AlphainZ 面板",
  "Chat history":
    "对话历史",
  "Show chat history":
    "显示对话历史",
  "New chat":
    "新对话",
  "Development tools":
    "开发工具",
  "Chat actions":
    "对话操作",
  "Open in separate window":
    "在独立窗口中打开",
  "AlphainZ settings":
    "AlphainZ 设置",

  // react/components/HomeLauncher.tsx
  "Research":
    "研究",
  "Ask and explore your library":
    "提问并探索你的文献库",
  "Grounded answers from full text, plus related work and gaps":
    "基于全文的有据回答，以及相关研究和空白",
  "Write":
    "写作",
  "Write & synthesize":
    "写作与综述",
  "Summaries, reviews, and notes drawn from your sources — every claim cited":
    "从你的文献里提炼摘要、综述和笔记——每个论点都有引用",
  "Organize":
    "整理",
  "Organize & edit your library":
    "整理和编辑你的文献库",
  "Tag, sort, and fix metadata. You approve every change":
    "打标签、归类、修正元数据。每处修改都由你批准",
  "Annotate":
    "标注",
  "AI-powered PDF annotations":
    "AI 生成的 PDF 注释",
  "Highlights and notes added right in your PDF, ready to review":
    "高亮和笔记直接添加到 PDF 中，等你审阅",

  // react/components/input/CreditInfoBar.tsx
  "Dismiss credit info":
    "关闭额度信息",

  // react/components/input/DragDropWrapper.tsx
  "Collection is deleted":
    "分类已被删除",
  "Collection is not in a synced library":
    "分类不在同步的文献库中",
  "You can add up to {count} items at a time.":
    "一次最多可以添加 {count} 个条目。",
  "Annotation type not supported":
    "不支持该注释类型",
  "Collection not supported":
    "不支持该分类",
  "Collection not found":
    "找不到分类",
  "Import failed":
    "导入失败",
  "The /{existing} command was taken, so it was added as /{command}.":
    "命令 /{existing} 已被占用，所以添加为 /{command}。",
  "Action added":
    "已添加快捷操作",
  "\"{title}\" was added to your message. Type /{command} to use it again.":
    "“{title}”已加入你的消息。输入 /{command} 可以再次使用。",
  "Open in settings":
    "在设置中打开",
  "No valid collections to add":
    "没有可添加的有效分类",
  "No files found in drop":
    "拖入的内容中没有文件",
  "Drop here to add {count} annotation":
    "拖到这里添加 {count} 条注释",
  "Drop here to add {count} annotations":
    "拖到这里添加 {count} 条注释",
  "Drop here to filter by {count} collection":
    "拖到这里按 {count} 个分类筛选",
  "Drop here to filter by {count} collections":
    "拖到这里按 {count} 个分类筛选",
  "Drop here to add {count} file":
    "拖到这里添加 {count} 个文件",
  "Drop here to add {count} files":
    "拖到这里添加 {count} 个文件",
  "Drop here to add {count} item":
    "拖到这里添加 {count} 个条目",
  "Drop here to add {count} items":
    "拖到这里添加 {count} 个条目",

  // react/components/input/ExternalFileButton.tsx
  "Open File":
    "打开文件",
  "Show File":
    "显示文件",

  // react/components/input/HighTokenUsageWarningBar.tsx
  "This chat is long — each message sends about {tokens} tokens to the model, though older exchanges are summarized automatically.":
    "这个对话很长——每条消息大约要向模型发送 {tokens} token，不过较早的问答会自动总结。",
  "This chat is long — each message sends about {tokens} tokens to the model.":
    "这个对话很长——每条消息大约要向模型发送 {tokens} token。",
  "This chat is long — each message resends much of it to the model, though older exchanges are summarized automatically.":
    "这个对话很长——每条消息都会把大部分内容重新发给模型，不过较早的问答会自动总结。",
  "This chat is long — each message resends much of it to the model.":
    "这个对话很长——每条消息都会把大部分内容重新发给模型。",
  "{link} for a new topic: replies get faster and cheaper.":
    "换新话题时请{link}：回复会更快、更省钱。",
  "Start a new chat":
    "开始新对话",
  "Dismiss long chat warning":
    "关闭长对话提醒",

  // react/components/input/InputArea.tsx
  "@ to add a source, / for actions":
    "输入 @ 添加来源，/ 使用快捷操作",
  "@ to add a source, / for actions, drag to add annotations":
    "输入 @ 添加来源，/ 使用快捷操作，也可拖入注释",
  "Type to search":
    "输入以搜索",
  "Message AlphainZ":
    "给 AlphainZ 发消息",
  "Stop generating":
    "停止生成",
  "Send message":
    "发送消息",
  "Stop":
    "停止",

  // react/components/input/MessageCollectionButton.tsx
  "Reveal Collection":
    "显示分类",

  // react/components/input/MessageItemButton.tsx
  "Area annotation":
    "区域注释",
  "Image preview unavailable":
    "无法预览图片",
  "Loading image...":
    "正在载入图片…",
  "Reveal in PDF":
    "在 PDF 中显示",
  "Reveal in Library":
    "在文献库中显示",
  "Open Note":
    "打开笔记",
  "Open Attachment":
    "打开附件",
  "Invalid File":
    "无效文件",
  "Unreadable File":
    "无法读取的文件",
  "Current File":
    "当前文件",
  "Current Note":
    "当前笔记",

  // react/components/input/MessageItemChipPopup.tsx
  "{count} more attachment":
    "还有 {count} 个附件",
  "{count} more attachments":
    "还有 {count} 个附件",

  // react/components/input/PendingActionsBar.tsx
  "Deleting annotations and rewriting a note each need their own Apply on the card.":
    "删除注释和重写笔记都需要在各自的卡片上单独点“应用”。",
  "The note rewrite needs its own Apply on its card.":
    "重写笔记需要在它的卡片上单独点“应用”。",
  "The {count} note rewrites need their own Apply on their cards.":
    "这 {count} 处笔记重写需要在各自的卡片上单独点“应用”。",
  "The annotation deletion needs its own Apply on its card.":
    "删除注释需要在它的卡片上单独点“应用”。",
  "The {count} annotation deletions need their own Apply on their cards.":
    "这 {count} 处注释删除需要在各自的卡片上单独点“应用”。",
  "another chat":
    "另一个对话",
  "{count} proposed change":
    "{count} 处待定修改",
  "{count} proposed changes":
    "{count} 处待定修改",
  "Approve All":
    "全部批准",
  "Proposed changes":
    "待定修改",
  "Show the proposed change":
    "显示待定修改",
  "Show the proposed changes":
    "显示待定修改",
  "Show":
    "显示",
  "Reject All":
    "全部拒绝",
  "This one needs its own Apply on its card.":
    "这一项需要在它的卡片上单独点“应用”。",
  "These need their own Apply on their cards.":
    "这些需要在各自的卡片上单独点“应用”。",
  "{count} proposed change in ‘{name}’":
    "“{name}”中有 {count} 处待定修改",
  "{count} proposed changes in ‘{name}’":
    "“{name}”中有 {count} 处待定修改",
  "Open ‘{name}’ to decide its proposed changes":
    "打开“{name}”来处理它的待定修改",
  "Open":
    "打开",
  "{changes} in {chats}":
    "{chats}中还有{changes}",
  "{count} more chat":
    "另外 {count} 个对话",
  "{count} more chats":
    "另外 {count} 个对话",

  // react/components/input/ReaderAnnotationsButton.tsx
  "{count} more attached":
    "另有 {count} 条已附上",
  "{count} not attached — the agent can fetch them":
    "{count} 条未附上——AI 可以自己去取",

  // react/components/input/RunUsageChip.tsx
  "{input} in · {output} out":
    "输入 {input} · 输出 {output}",
  "{cached} of the input came from cache":
    "其中 {cached} 来自缓存",
  "across {count} message in this chat":
    "本对话 {count} 条消息合计",
  "across {count} messages in this chat":
    "本对话 {count} 条消息合计",
  "Counted by the provider, billed to your own key.":
    "由服务商统计，计入你自己的 key。",
  "{total} tokens used in this chat — click for the breakdown":
    "本对话已用 {total} token——点击查看明细",

  // react/components/input/TextSelectionButton.tsx
  "Reveal page {page} in PDF":
    "在 PDF 中显示第 {page} 页",
  "Snapshot":
    "网页快照",
  "Document":
    "文档",
  "Reveal in {type}":
    "在{type}中显示",
  "Text Selection":
    "选中的文字",

  // react/components/library/LibraryButton.tsx
  "Reveal Library":
    "显示文献库",

  // react/components/library/TagButton.tsx
  "Filter Library by Tag":
    "按标签筛选文献库",
  "Filter library by tag":
    "按标签筛选文献库",

  // react/components/messages/NoteDisplay.tsx
  "Reveal in Zotero":
    "在 Zotero 中显示",
  "Library is read-only":
    "文献库为只读",
  "Create Zotero Note":
    "创建 Zotero 笔记",
  "Toggle content":
    "展开/收起内容",
  "_No content yet._":
    "_还没有内容。_",
  "New note":
    "新笔记",
  "Failed to save note":
    "保存笔记失败",

  // react/components/pages/firstRun/BackToSuggestions.tsx
  "Back to starting points":
    "返回起点建议",
  "Back to suggestions":
    "返回建议",
  "Start a new chat anytime with {plus} (top left) or with {shortcut}":
    "随时可以点 {plus}（左上角）或按 {shortcut} 开始新对话",

  // react/components/pages/firstRun/EmptyLibraryDiscovery.tsx
  "Social media and teen mental health":
    "社交媒体与青少年心理健康",
  "mRNA cancer vaccines":
    "mRNA 癌症疫苗",
  "Coral reef restoration":
    "珊瑚礁修复",
  "How LLMs hallucinate":
    "大语言模型为何产生幻觉",
  "Psychedelics for depression":
    "迷幻药治疗抑郁症",
  "Describe what you're researching…":
    "描述你正在研究的内容…",
  "Discover papers":
    "发现论文",
  "Finding recent work on {topic}…":
    "正在查找关于{topic}的最新研究…",

  // react/components/pages/firstRun/NextStepsPanel.tsx
  "Guided next steps":
    "下一步建议",
  "Dismiss next steps":
    "关闭下一步建议",

  // react/components/pages/FirstRunPage.tsx
  "Failed to connect to AlphainZ. Please try again.":
    "无法连接 AlphainZ，请重试。",
  "Ideas for your library":
    "为你的文献库准备的想法",
  "Tell us what you're researching and we'll find recent, highly-cited papers to start your library.":
    "告诉我们你在研究什么，我们会找出近期的高被引论文，帮你建立文献库。",
  "Your AI research assistant in Zotero":
    "你在 Zotero 里的 AI 研究助手",
  "Search across your library, read papers faster, compare findings, and discover relevant new research.":
    "在整个文献库中搜索，更快地读论文、比较研究发现，并发现相关的新研究。",
  "Skip for now":
    "暂时跳过",
  "Skip":
    "跳过",
  "A few ideas based on your library":
    "根据你的文献库给出的几个想法",
  "Refresh suggestions (dev)":
    "刷新建议（开发）",

  // react/components/pages/HomePage.tsx
  "AlphainZ can't access any libraries. You've excluded all of them.":
    "AlphainZ 无法访问任何文献库：你把它们全部排除了。",
  "Open Settings":
    "打开设置",
  "No model is configured yet. Choose a provider and paste your API key to start.":
    "还没有设置模型。选择一个服务商并粘贴 API key 即可开始。",
  "How can I help you?":
    "有什么可以帮你？",

  // react/components/pages/onboarding/EmbeddingIndexProgress.tsx
  "Error: {message}":
    "错误：{message}",
  "Indexing {done} of {total} items...":
    "正在索引 {done} / {total} 个条目…",
  "Indexing your library...":
    "正在为你的文献库建立索引…",
  "Indexing complete":
    "索引完成",
  "Ready to index":
    "可以开始索引",
  "Library Indexed":
    "文献库已索引",
  "Indexing Library":
    "正在索引文献库",
  "{totalItems} Items":
    "{totalItems} 个条目",
  "Indexing takes less than a minute":
    "索引用时不到一分钟",

  // react/components/pages/onboarding/OnboardingFooter.tsx
  "Back":
    "上一步",

  // react/components/pages/onboarding/OnboardingHeader.tsx
  "Welcome to AlphainZ":
    "欢迎使用 AlphainZ",
  "AlphainZ logo":
    "AlphainZ 标志",

  // react/components/pages/WhereToStartPage.tsx
  "Failed to start. Please try again.":
    "启动失败，请重试。",
  "Let's dig into your library":
    "一起深入看看你的文献库",
  "Here are a few good places to start.":
    "可以从这几处开始。",
  "Loading starting points":
    "正在载入起点建议",
  "No starting points available.":
    "暂无起点建议。",
  "First task options":
    "第一个任务的选项",
  "Start":
    "开始",

  // react/components/pages/wizard/steps/ApiKeysStep.tsx
  "Key works — saved.":
    "key 可用，已保存。",
  "Already set ✓":
    "已设置 ✓",
  "Change":
    "更改",
  "Test":
    "测试",
  "{label} API key":
    "{label} API key",
  "One key is enough to start — DeepSeek is the recommended first pick. Keys are stored locally in Zotero's preferences and are never synced anywhere.":
    "有一个 key 就能开始——首选推荐 DeepSeek。key 只保存在本机 Zotero 的设置里，不会同步到任何地方。",
  "No key at all?":
    "一个 key 都没有？",
  "Hide the local option":
    "隐藏本地选项",
  "Run a model on this computer with Ollama":
    "用 Ollama 在这台电脑上运行模型",

  // react/components/pages/wizard/steps/FeatureTourStep.tsx
  "Your highlights ride along":
    "你的高亮会一起带上",
  "Open a PDF and the paper plus every highlight on it attaches to the chat automatically — ask \"what did I mark?\" with no setup. Leave the paper and they leave too.":
    "打开一篇 PDF，论文和上面的所有高亮会自动附到对话里——直接问“我标了什么？”即可，无需设置。离开这篇论文，它们也会随之移除。",
  "Highlights, notes and filing, once you allow them":
    "高亮、笔记和归类，在你允许之后",
  "The agent can propose highlights, notes, edits to papers and notes, and how items are filed. This is off until you turn it on under Settings → Permissions, where you also choose which kinds of change wait for your approval.":
    "AI 可以提议添加高亮和笔记、修改论文和笔记，以及如何归类条目。这项功能默认关闭，需要在 设置 → 权限 中打开，在那里还可以选择哪些修改要等你批准。",
  "Answers cite sentences, not pages":
    "回答引用到句子，而不只是页码",
  "Citation markers hover to show the exact sentence and click to jump to it in the PDF, highlighted. Verified across 840 sentences at 100%.":
    "鼠标停在引用标记上会显示原句，点击会跳到 PDF 中并高亮该句。在 840 个句子上验证，准确率 100%。",
  "Watch the work, or just the answer":
    "看整个过程，或只看回答",
  "The eye icon at the top of the panel picks how much of the run you see: every step, one collapsible line (tool calls show their arguments, thoughts show a preview), or the answer alone.":
    "面板顶部的眼睛图标决定显示多少过程：每一步、可展开的一行（工具调用显示参数，思考显示预览），或只显示回答。",
  "Delete is an archive":
    "删除即归档",
  "Deleted chats move to the Archive at the top of the history and restore in one click. Titles are AI-written after the first answer; rename them freely.":
    "删除的对话会移到历史记录顶部的“归档”中，一键即可恢复。标题在第一次回答后由 AI 拟定，可以随意重命名。",
  "Your library, from other apps":
    "在其他应用里使用你的文献库",
  "An MCP server (Settings → Advanced) lets Claude Desktop or Claude Code search and read this Zotero library directly.":
    "MCP 服务器（设置 → 高级）让 Claude Desktop 或 Claude Code 可以直接搜索和阅读这个 Zotero 文献库。",

  // react/components/pages/wizard/steps/IndexStep.tsx
  "The search index is what lets the agent find papers by meaning, not just by keyword. It reads titles, abstracts and PDF text through an embedding model — that costs a small amount of that provider's quota (Ollama runs locally and is free). Skip it and keyword search still works.":
    "有了搜索索引，AI 才能按意思而不只是按关键词找论文。它通过嵌入模型读取标题、摘要和 PDF 文本——会消耗该服务商少量额度（Ollama 在本地运行，免费）。跳过的话，关键词搜索照样可用。",
  "Free, and nothing leaves this computer — needs the Ollama app (0.40 or later) and the EmbeddingGemma 2 model, 671 MB (set up below)":
    "免费，数据不离开这台电脑——需要 Ollama 应用（0.40 或更高版本）和 EmbeddingGemma 2 模型，671 MB（在下方设置）",
  "Needs that vendor’s API key (step 1)":
    "需要该服务商的 API key（第 1 步）",
  "Gemini Embedding 2, with the Google key from the Gemini card in step 1":
    "Gemini Embedding 2，使用第 1 步 Gemini 卡片里的 Google key",

  // react/components/pages/wizard/steps/SyncChoiceStep.tsx
  "Choose the sync folder":
    "选择同步文件夹",
  "Conversations (and these settings) can follow you between machines.":
    "对话（以及这些设置）可以在你的多台电脑间同步。",
  "Already set ✓ — your current choice is selected below.":
    "已设置 ✓——下方已选中你当前的选择。",
  "Not now":
    "暂不",
  "Everything stays on this computer. You can turn sync on later in Settings → Advanced.":
    "所有内容都只留在这台电脑上。之后可以在 设置 → 高级 中打开同步。",
  "No sync":
    "不同步",
  "Through Zotero sync":
    "通过 Zotero 同步",
  "Stored as attachments in your Zotero library; your existing Zotero account carries them.":
    "以附件形式存放在你的 Zotero 文献库中，由你现有的 Zotero 账户同步。",
  "Zotero sync":
    "Zotero 同步",
  "Synced folder":
    "同步文件夹",
  "Plain JSON files in a folder you choose. Put it inside iCloud Drive, OneDrive or any synced folder — the plugin only reads and writes files there, like Obsidian.":
    "存为你选定文件夹中的普通 JSON 文件。把它放进 iCloud 云盘、OneDrive 或任何同步文件夹即可——插件只在那里读写文件，就像 Obsidian 一样。",
  "Change…":
    "更改…",
  "Choose…":
    "选择…",

  // react/components/pages/wizard/WelcomeWizardPage.tsx
  "Connect a model":
    "连接模型",
  "AlphainZ talks straight to the model vendor with your own key — no account, no middleman.":
    "AlphainZ 用你自己的 key 直接连接模型服务商——无需账户，没有中间商。",
  "Sync (optional)":
    "同步（可选）",
  "Carry conversations and settings to your other machines.":
    "把对话和设置带到你的其他电脑。",
  "Search index (optional)":
    "搜索索引（可选）",
  "Let the agent search your library by meaning.":
    "让 AI 按意思搜索你的文献库。",
  "Make it yours":
    "个性化",
  "Theme, font and spacing — every change lands instantly.":
    "主题、字体和行距——每处修改立即生效。",
  "What it can do":
    "它能做什么",
  "Two minutes on the features you would otherwise find by accident.":
    "花两分钟了解那些你可能要偶然才会发现的功能。",
  "Setup steps":
    "设置步骤",
  "Get Started":
    "开始使用",
  "Next":
    "下一步",
  "Skip setup":
    "跳过设置",

  // react/components/preferences/ActionCard.tsx
  "Required":
    "必填",
  "Action exported":
    "已导出快捷操作",
  "Saved \"{title}\" to a file. Share it and others can import it into AlphainZ.":
    "已将“{title}”保存为文件。分享给别人后，他们可以导入到 AlphainZ。",
  "Export failed":
    "导出失败",
  "Could not save the action to a file.":
    "无法把快捷操作保存为文件。",
  "Untitled action":
    "未命名快捷操作",
  "This prompt contains [[ ]] placeholders, which are sent as written.":
    "这段提示词含有 [[ ]] 占位符，会按原样发送。",
  "Placeholders":
    "占位符",
  "New action":
    "新建快捷操作",
  "This action is built in and can't be edited. Duplicate it to make an editable copy.":
    "这是内置快捷操作，不能编辑。复制一份即可修改。",
  "Locked":
    "已锁定",
  "Add a title and a prompt to save":
    "填写标题和提示词后才能保存",
  "Save":
    "保存",
  "Title":
    "标题",
  "Action title...":
    "快捷操作标题…",
  "Action title":
    "快捷操作标题",
  "Description":
    "描述",
  "Short summary shown when you hover the /command in the chat. Optional.":
    "在对话中把鼠标停在 /命令 上时显示的简短说明。可选。",
  "e.g. Summarize the key findings of the selected paper":
    "例如：总结所选论文的主要发现",
  "Action description":
    "快捷操作描述",
  "Slash command":
    "斜杠命令",
  "Typing /command in the chat input inserts this action. Derived from the title unless you set it yourself; spaces are not allowed.":
    "在输入框中输入 /命令 即可插入这个快捷操作。默认根据标题生成，也可以自己设置；不能包含空格。",
  "action-name":
    "命令名",
  "Slash command name":
    "斜杠命令名",
  "Already used. A number will be added.":
    "已被占用，将自动加上数字。",
  "Derived from the title. Edit to set your own.":
    "根据标题生成。可以改成你自己的。",
  "Clear the field to derive it from the title again.":
    "清空此栏即可重新根据标题生成。",
  "Argument hint":
    "参数提示",
  "Hint shown during autocomplete to indicate expected arguments.":
    "自动补全时显示，提示需要填写的参数。",
  "e.g. topic or question":
    "例如：主题或问题",
  "Shown greyed out after the inserted command.":
    "以灰色显示在插入的命令之后。",
  "Prompt":
    "提示词",
  "Enter prompt text...":
    "输入提示词…",
  "Action prompt text":
    "快捷操作提示词",
  "{count} / {max} characters":
    "{count} / {max} 字符",
  "This prompt contains [[ ]] placeholders. They are currently sent to the assistant as written; a new way to fill them in is coming in a future update.":
    "这段提示词含有 [[ ]] 占位符。目前会按原样发送给助手；之后的更新会提供新的填写方式。",
  "Category":
    "类别",
  "Groups this action on the home page launcher.":
    "决定这个快捷操作在主页启动器中的分组。",
  "Select category":
    "选择类别",
  "Applies to":
    "适用于",
  "Controls when this action shows up, based on your current Zotero selection.":
    "根据你在 Zotero 中当前选中的内容，决定这个快捷操作何时出现。",
  "Select what this action applies to":
    "选择这个快捷操作适用的对象",
  "Add a title and a prompt to export":
    "填写标题和提示词后才能导出",
  "Save this action to a file you can share":
    "把这个快捷操作保存为可分享的文件",
  "Export":
    "导出",
  "Create an editable copy of this action":
    "创建这个快捷操作的可编辑副本",
  "Duplicate":
    "复制",
  "Reset to default":
    "恢复默认",
  "Delete":
    "删除",

  // react/components/preferences/ActionsPreferenceSection.tsx
  "Action imported":
    "已导入快捷操作",
  "A /{existing} command already existed, so this one was added as /{command}.":
    "已存在 /{existing} 命令，所以这个添加为 /{command}。",
  "Could not import the action.":
    "无法导入这个快捷操作。",
  "{title} (copy)":
    "{title}（副本）",
  "All targets":
    "所有对象",
  "All categories":
    "所有类别",
  "Uncategorized":
    "未分类",
  "Import an action from a .beaveraction file":
    "从 .beaveraction 文件导入快捷操作",
  "Import":
    "导入",
  "Add Action":
    "添加快捷操作",
  "Actions are reusable prompts for common research tasks. They appear based on what you're doing in Zotero: on the home page, in the slash menu, and Zotero's right-click menu. Each action targets items, collections, or your whole library, and AlphainZ shows the relevant ones automatically.":
    "快捷操作是用于常见研究任务的可复用提示词。它们会根据你在 Zotero 中正在做的事，出现在主页、斜杠菜单和 Zotero 的右键菜单里。每个快捷操作针对条目、分类或整个文献库，AlphainZ 会自动显示相关的那些。",
  "{link}.":
    "{link}。",
  "Learn more":
    "了解更多",
  "Show:":
    "显示：",
  "Filter by target":
    "按对象筛选",
  "Filter by category":
    "按类别筛选",
  "Clear":
    "清除",
  "{shown} of {total}":
    "{shown} / {total}",
  "No actions match the selected filters.":
    "没有符合筛选条件的快捷操作。",
  "Deleted actions ({count})":
    "已删除的快捷操作（{count}）",
  "Restore":
    "恢复",

  // react/components/preferences/AddSelectedItemsOnNewThreadToggle.tsx
  "Add Selected Items to New Threads":
    "新对话自动加入选中的条目",
  "Automatically include items selected in Zotero when creating a new chat thread.":
    "新建对话时，自动加入在 Zotero 中选中的条目。",
  "When enabled, any items you have selected in Zotero will be automatically added as sources when you start a new conversation thread.":
    "开启后，开始新对话时会把你在 Zotero 中选中的条目自动添加为来源。",

  // react/components/preferences/AddSelectedItemsOnOpenToggle.tsx
  "Add Selected Items When Opening AlphainZ":
    "打开 AlphainZ 时加入选中的条目",
  "Automatically include items selected in Zotero when opening the AlphainZ sidebar.":
    "打开 AlphainZ 侧栏时，自动加入在 Zotero 中选中的条目。",
  "When enabled, any items you have selected in Zotero will be automatically added as sources when you open AlphainZ.":
    "开启后，打开 AlphainZ 时会把你在 Zotero 中选中的条目自动添加为来源。",

  // react/components/preferences/AdvancedSection.tsx
  "Settings taken from your other computer":
    "已采用你另一台电脑的设置",
  "Exported {count} conversation":
    "已导出 {count} 个对话",
  "Exported {count} conversations":
    "已导出 {count} 个对话",
  "Nothing new to export":
    "没有新的内容可导出",
  "{count} already there":
    "{count} 个已存在",
  "{count} left alone (newer on another computer, or still downloading)":
    "{count} 个未处理（另一台电脑上的更新，或仍在下载）",
  "{count} failed — see the debug log":
    "{count} 个失败——请查看调试日志",
  "; ":
    "；",
  "{text}.":
    "{text}。",
  ". ":
    "。",
  "Sync is on.":
    "同步已开启。",
  "{count} file":
    "{count} 个文件",
  "{count} files":
    "{count} 个文件",
  "Syncing with the new location…":
    "正在与新位置同步…",
  "Delete External Files?":
    "删除外部文件？",
  "Delete {files} attached to past chats?":
    "删除附在过去对话中的{files}？",
  "AlphainZ will no longer be able to read these files in past conversations. Files can be re-attached at any time.":
    "过去的对话将无法再读取这些文件。文件可以随时重新附加。",
  "Long Conversations":
    "长对话",
  "Every message sends the chat so far to the model again, so a long chat costs more and answers more slowly. These options shorten what is sent. Your chats stay complete on screen and on this computer either way.":
    "每条消息都会把目前为止的对话重新发给模型，所以对话越长，花费越多，回答也越慢。下面这些选项可以缩短发送的内容。无论怎样，你的对话在屏幕上和这台电脑上都完整保留。",
  "Compact old exchanges automatically":
    "自动压缩较早的问答",
  "When a chat gets long, its older exchanges are summarized (one extra small request) and the model reads the summary instead of them. A marker in the chat shows where; click it to read or discard the summary":
    "对话变长后，较早的问答会被总结（多一次小请求），模型改读这份摘要。对话中会有标记显示位置；点击可以查看或丢弃摘要",
  "Compact after":
    "压缩时机",
  "Summarize once a chat has more than this many exchanges. Without a summary the model is sent only the last 10 exchanges and sees nothing older":
    "对话超过这么多轮问答后进行总结。没有摘要时，模型只会收到最近 10 轮问答，更早的内容看不到",
  "Compact after this many exchanges":
    "超过这么多轮问答后压缩",
  "6 exchanges":
    "6 轮问答",
  "8 exchanges":
    "8 轮问答",
  "10 exchanges":
    "10 轮问答",
  "12 exchanges":
    "12 轮问答",
  "15 exchanges":
    "15 轮问答",
  "Compact sooner above":
    "超过此大小时提前压缩",
  "Also summarize before that many exchanges once the earlier chat and the attached context sent with each message reach this size (at least 3 exchanges at a time)":
    "即使还没到那么多轮，只要之前的对话加上每条消息附带的上下文达到这个大小，也会提前总结（每次至少 3 轮问答）",
  "Compact sooner above this size":
    "超过此大小时提前压缩",
  "40k tokens":
    "4 万 token",
  "60k tokens":
    "6 万 token",
  "80k tokens":
    "8 万 token",
  "100k tokens":
    "10 万 token",
  "150k tokens":
    "15 万 token",
  "Trim tool detail from old turns":
    "精简旧问答中的工具细节",
  "In exchanges older than the last two, long tool inputs and results are shortened before they are sent. Your questions and the answers in those exchanges are not shortened":
    "在最近两轮之前的问答里，较长的工具输入和结果会先缩短再发送。这些问答中你的问题和回答不会被缩短",
  "Input Box":
    "输入框",
  "Editor engine":
    "编辑器引擎",
  "The native text box keeps the cursor where you put it (recommended). The older rich editor draws command chips inline, but its cursor can jump while you type. Takes effect after restarting Zotero":
    "原生文本框会让光标停在你放的位置（推荐）。旧版富文本编辑器会在行内显示命令标签，但输入时光标可能跳动。重启 Zotero 后生效",
  "Composer engine":
    "输入框引擎",
  "Native text box":
    "原生文本框",
  "Rich editor (legacy)":
    "富文本编辑器（旧版）",
  "Conversation Sync":
    "对话同步",
  "Keeps your conversations and settings on your other machines — either as JSON attachments in your Zotero library (your existing Zotero sync carries them), or as plain files in a folder you choose (put it inside iCloud Drive, OneDrive or any synced folder; the plugin never talks to the cloud itself). One at a time. When you switch, you are asked whether to keep the copies in the old place; conversations on this computer are always kept.":
    "在你的其他电脑上保留你的对话和设置——可以作为 JSON 附件存放在 Zotero 文献库中（由你现有的 Zotero 同步带过去），也可以存为你选定文件夹中的普通文件（放进 iCloud 云盘、OneDrive 或任何同步文件夹；插件本身从不连接云端）。一次只能用一种。切换时会询问是否保留旧位置的副本；这台电脑上的对话始终保留。",
  "Off":
    "关闭",
  "Conversations stay on this computer only":
    "对话只保存在这台电脑上",
  "Sync off":
    "关闭同步",
  "Stored under a \"{conversationsTitle}\" item in My Library":
    "存放在“我的文库”中名为“{conversationsTitle}”的条目下",
  "Sync through Zotero":
    "通过 Zotero 同步",
  "Plain JSON files in a folder you choose, such as one in iCloud Drive or OneDrive":
    "存为你选定文件夹中的普通 JSON 文件，例如 iCloud 云盘或 OneDrive 中的文件夹",
  "Sync to a folder":
    "同步到文件夹",
  "Folder":
    "文件夹",
  "No folder chosen yet":
    "尚未选择文件夹",
  "Show Folder":
    "显示文件夹",
  "Export all conversations now":
    "立即导出所有对话",
  "Writes each conversation on this computer that the sync location is missing or has an older copy of":
    "把这台电脑上、同步位置缺少或只有旧副本的每个对话写过去",
  "Exporting…":
    "正在导出…",
  "Storage":
    "存储",
  "Data AlphainZ stores on this computer. This data is not deleted automatically including when the plugin is removed.":
    "AlphainZ 在这台电脑上保存的数据。这些数据不会自动删除，卸载插件时也不会。",
  "External Files":
    "外部文件",
  "Copies of external files you attach to chats.":
    "你附加到对话中的外部文件的副本。",
  "Delete All…":
    "全部删除…",
  "Document Cache":
    "文档缓存",
  "Text extracted from PDFs and other documents, stored to avoid re-processing files":
    "从 PDF 和其他文档中提取的文本，保存下来以免重复处理文件",
  "Deleted":
    "已删除",
  "Delete Cache":
    "删除缓存",
  "Connected Apps":
    "已连接的应用",
  "Experimental":
    "实验性",
  "Lets AlphainZ in other apps access your Zotero library while Zotero is running.":
    "让其他应用中的 AlphainZ 在 Zotero 运行时访问你的 Zotero 文献库。",
  "Allow Library Access":
    "允许访问文献库",
  "AlphainZ chats started in connected apps can search and read this Zotero library":
    "在已连接的应用中开始的 AlphainZ 对话可以搜索和阅读这个 Zotero 文献库",
  "MCP Server":
    "MCP 服务器",
  "The MCP server lets AI coding tools like Claude Code, Cursor, and Windsurf search and access your Zotero library.":
    "MCP 服务器让 Claude Code、Cursor、Windsurf 等 AI 编程工具可以搜索和访问你的 Zotero 文献库。",
  "See our {guide} for setup instructions.":
    "设置方法见我们的{guide}。",
  "MCP server guide":
    "MCP 服务器指南",
  "Enable MCP Server":
    "启用 MCP 服务器",
  "Endpoint at localhost:{port}":
    "端点位于 localhost:{port}",
  "Expose your Zotero library to MCP-compatible AI tools":
    "把你的 Zotero 文献库开放给兼容 MCP 的 AI 工具",
  "Only available with AlphainZ Pro":
    "仅 AlphainZ Pro 可用",
  "Enable Create Note Tool":
    "启用“新建笔记”工具",
  "Allow MCP clients to create Zotero notes. Changing setting requires reloading of the MCP server.":
    "允许 MCP 客户端新建 Zotero 笔记。更改此设置需要重新载入 MCP 服务器。",
  "Advertise and allow the create_note MCP tool":
    "公开并允许 create_note 这个 MCP 工具",
  "Config for HTTP Clients":
    "HTTP 客户端的配置",
  "For clients that support HTTP directly (e.g., Claude Code, Cursor).":
    "适用于直接支持 HTTP 的客户端（例如 Claude Code、Cursor）。",
  "Copied":
    "已复制",
  "Config for HTTPS-Only Clients":
    "仅支持 HTTPS 的客户端的配置",
  "For clients that only connect to HTTPS endpoints (e.g., Claude Desktop). Requires Node.js.":
    "适用于只连接 HTTPS 端点的客户端（例如 Claude Desktop）。需要 Node.js。",

  // react/components/preferences/AppearanceSection.tsx
  "Fresh":
    "清新",
  "Celadon on rice paper — light and quiet":
    "宣纸上的青瓷色——轻盈安静",
  "Warm":
    "温暖",
  "Warm paper and terracotta":
    "暖色纸张与赤陶色",
  "Quiet":
    "静谧",
  "Warm paper and a slate blue":
    "暖色纸张与石板蓝",
  "Sky":
    "晴空",
  "Pale blue paper, white cards, a cool blue — the DeepSeek Harness look":
    "淡蓝纸面、白色卡片、冷蓝色——DeepSeek Harness 的风格",
  "Follow Zotero":
    "跟随 Zotero",
  "Light":
    "浅色",
  "Dark":
    "深色",
  "System":
    "跟随系统",
  "Zotero's own interface font":
    "Zotero 自身的界面字体",
  "Serif":
    "衬线",
  "Sans":
    "无衬线",
  "Compact":
    "紧凑",
  "Normal":
    "标准",
  "Relaxed":
    "宽松",
  "Appearance":
    "外观",
  "Affects AlphainZ's own panes only — the rest of Zotero is untouched.":
    "只影响 AlphainZ 自己的面板——Zotero 其他部分不受影响。",
  "Theme":
    "主题",
  "Light or dark":
    "浅色或深色",
  "Overrides the system setting for AlphainZ":
    "为 AlphainZ 单独覆盖系统设置",
  "Font":
    "字体",
  "Text size":
    "文字大小",
  "Line spacing":
    "行距",

  // react/components/preferences/CitationFormatToggle.tsx
  "Switch between author-year (e.g., Smith, 2023) and numeric (e.g., [1]) citation formats":
    "在作者-年份（例如 Smith, 2023）和数字（例如 [1]）两种引用格式间切换",
  "Citation Format: {format}":
    "引用格式：{format}",
  "Numeric":
    "数字",
  "Author-Year":
    "作者-年份",
  "Choose between numeric [1] or author-year (Smith, 2023) citations":
    "选择数字 [1] 或作者-年份 (Smith, 2023) 引用格式",

  // react/components/preferences/ConversationViewSection.tsx
  "Question ticks instead of a scroll bar":
    "用问题刻度代替滚动条",
  "Conversation View":
    "对话视图",
  "One tick per question at the right edge of the chat. Point at a tick to preview that question, click it to jump there; the wheel, trackpad and keys still scroll. Off brings the scroll bar back. The outline button in the chat header is there either way":
    "在对话右边缘为每个问题显示一个刻度。指向刻度可以预览那个问题，点击跳转过去；滚轮、触控板和按键照常滚动。关闭则恢复滚动条。无论开关，对话顶部的大纲按钮都在",

  // react/components/preferences/CustomInstructionsSection.tsx
  "Custom Instructions":
    "自定义指令",
  "Custom instructions are added to all chats and help steer responses. (Max ~250 words)":
    "自定义指令会加到所有对话中，用来引导回答。（最多约 250 词）",
  "Enter custom instructions here...":
    "在此输入自定义指令…",
  "Custom instructions":
    "自定义指令",
  "Reader Explain Prompt":
    "阅读器“解释”提示词",
  "The prompt sent when you click \"Explain\" on selected text or annotations in the PDF reader.":
    "在 PDF 阅读器中对选中的文字或注释点击“解释”时发送的提示词。",
  "Explain the selected passage from this paper in plain language...":
    "用浅显的语言解释这篇论文中选中的段落…",
  "Reader explain prompt":
    "阅读器解释提示词",

  // react/components/preferences/DeferredToolPreferenceSetting.tsx
  "Select preference for {label}":
    "为{label}选择处理方式",

  // react/components/preferences/ExcludedLibrariesList.tsx
  "{itemCount} items, {attachmentCount} attachments":
    "{itemCount} 个条目，{attachmentCount} 个附件",
  "AlphainZ can't access any libraries.":
    "AlphainZ 无法访问任何文献库。",
  "AlphainZ can access all your libraries: {accessibleLibraryNames}":
    "AlphainZ 可以访问你的全部文献库：{accessibleLibraryNames}",
  "AlphainZ can access the following libraries: {accessibleLibraryNames}":
    "AlphainZ 可以访问以下文献库：{accessibleLibraryNames}",
  "Excluded Libraries":
    "排除的文献库",
  "Exclude a library":
    "排除一个文献库",
  "Exclude a library...":
    "排除一个文献库…",
  "All libraries are excluded. AlphainZ can't access any libraries.":
    "所有文献库都已排除。AlphainZ 无法访问任何文献库。",
  "Your personal library is excluded on every device connected to this account.":
    "你的个人文献库在连接此账户的所有设备上都已排除。",
  "No libraries excluded.":
    "没有排除任何文献库。",
  "Restore Library":
    "恢复文献库",
  "No libraries found":
    "没有找到文献库",
  "Search libraries":
    "搜索文献库",

  // react/components/preferences/LanguageChoice.tsx
  "You can change it any time in Settings → General → Appearance.":
    "之后可以随时在 设置 → 常规 → 外观 里修改。",
  "\"Follow Zotero\" shows Chinese when Zotero itself is in Chinese, and English otherwise.":
    "“跟随 Zotero”：Zotero 是中文界面时显示中文，否则显示英文。",

  // react/components/preferences/ModelSettingsSection.tsx
  "Off — keyword search only":
    "关闭——只用关键词搜索",
  "Google Gemini · online":
    "Google Gemini · 在线",
  "Ollama · EmbeddingGemma 2, on this computer":
    "Ollama · EmbeddingGemma 2，在本机运行",
  "Works":
    "正常",
  "Failed":
    "失败",
  "Delete this index?":
    "删除这个索引？",
  "Delete the {label} index? Its vectors are removed from this computer only.":
    "删除 {label} 索引？它的向量只会从这台电脑上删除。",
  "This is the model in use, so the index will be rebuilt from scratch — that costs time (and, for a cloud model, its quota).":
    "这是正在使用的模型，所以索引会从头重建——要花时间（云端模型还要消耗额度）。",
  "Switching back to this model later will rebuild it.":
    "以后切回这个模型时会重建它。",
  "Connected in {ms} ms.":
    "已连接，用时 {ms} 毫秒。",
  "The key was rejected. Check that you copied all of it.":
    "key 被拒绝了。请检查是否完整复制。",
  "This computer has no Google key yet. Add it on the Google Gemini card above, or below.":
    "这台电脑还没有 Google key。请在上方的 Google Gemini 卡片中添加，或在下方添加。",
  "This computer has no {label} key yet. Add it under Providers, above.":
    "这台电脑还没有 {label} key。请在上方的“服务商”中添加。",
  "Counting the PDFs in your libraries…":
    "正在统计文献库中的 PDF…",
  "No PDFs found in the libraries you have enabled.":
    "在已启用的文献库中没有找到 PDF。",
  "{covered} of {library} PDFs indexed · this pass: {done}/{total}.":
    "已索引 {library} 个 PDF 中的 {covered} 个 · 本轮：{done}/{total}。",
  "{covered} of {library} PDFs indexed.":
    "已索引 {library} 个 PDF 中的 {covered} 个。",
  "{label} — no key on this computer yet":
    "{label}——这台电脑上还没有 key",
  "Literature search":
    "文献检索",
  "Get a key":
    "获取 key",
  "Paste your key":
    "粘贴你的 key",
  "Literature search (OpenAlex) — a free key, made in 30 seconds. OpenAlex requires one from February 2026; without it, searches are rate-limited whenever their servers are busy.":
    "文献检索（OpenAlex）——免费 key，30 秒就能申请。OpenAlex 从 2026 年 2 月起要求使用 key；没有 key 的话，服务器繁忙时检索会被限速。",
  "Model":
    "模型",
  "The model the sidebar uses. Every model in a provider's catalogue is listed; the picker in the composer changes the same setting.":
    "侧栏使用的模型。列出了各服务商目录中的所有模型；输入框旁的选择器改的是同一个设置。",
  "Choose a model…":
    "选择模型…",
  "{provider} · {model} (stored)":
    "{provider} · {model}（已保存）",
  "No models are listed because no provider is configured yet. Add one above and its catalogue appears here.":
    "还没有设置任何服务商，所以没有列出模型。在上方添加一个，它的模型目录就会出现在这里。",
  "Highlight questions":
    "高亮提问",
  "Questions asked from the reader's selection popup use the model the sidebar is set to, so changing the model in the sidebar changes it for them too.":
    "从阅读器选中文字弹出的框里提问时，使用侧栏设置的模型；所以在侧栏换模型，这里也会跟着换。",
  "Save answers into the highlight's comment without asking":
    "不询问，直接把回答保存到高亮的评论里",
  "Answers are appended to the highlight's own Zotero comment, so they show up when you click the highlight and travel with your library.":
    "回答会追加到这条高亮自己的 Zotero 评论中，点高亮就能看到，也会随文献库一起同步。",
  "Topic and full-text search":
    "主题和全文搜索",
  "Searching your library by meaning needs an embedding provider. Leave it off and the agent is told so, instead of reading an empty result as proof your library holds nothing on the subject. This is the deeper of the two indexes — the one that reads inside your PDFs. Titles and abstracts are handled separately, under Search.":
    "按意思搜索文献库需要嵌入服务。不开的话，AI 会被告知这一点，而不会把空结果当成你的文献库里没有这方面的内容。这是两个索引中更深的那个——会读 PDF 的内文。标题和摘要另外处理，在“搜索”中。",
  "Embedding provider":
    "嵌入服务",
  "Until then nothing is indexed and topic search is off; keyword search still works. Indexing starts by itself once that is fixed.":
    "在那之前不会建立索引，主题搜索也关闭；关键词搜索仍可使用。修好之后会自动开始索引。",
  "Add the {label} key":
    "添加 {label} key",
  "Not working since {time}: {reason}":
    "从 {time} 起无法使用：{reason}",
  "Topic search falls back to titles meanwhile. This clears by itself once a request goes through — Test checks now.":
    "在此期间，主题搜索退回到只搜标题。有一次请求成功后这个提示会自动消失——点“测试”可以马上检查。",
  "Key for embeddings (optional)":
    "嵌入专用 key（可选）",
  "Empty: the Google Gemini card’s key is used":
    "留空：使用 Google Gemini 卡片中的 key",
  "Paste a Google AI Studio key":
    "粘贴 Google AI Studio key",
  "Embeddings use this key; chat keeps the Google Gemini card’s.":
    "嵌入使用这个 key；对话仍用 Google Gemini 卡片中的 key。",
  "Embeddings use the Google Gemini card’s key. A key here is used for topic and full-text search only, and wins over the card’s.":
    "嵌入使用 Google Gemini 卡片中的 key。这里填的 key 只用于主题和全文搜索，并优先于卡片中的 key。",
  "Gemini Embedding 2. A key from a project with no billing is free but allows about 100 texts a minute and 1000 a day, and Google may use what it is sent to improve its products; when Google reports the free tier, indexing keeps a fifth of each for your searches. A paid key costs about $1 per 20,000 passages.":
    "Gemini Embedding 2。未开通计费的项目的 key 是免费的，但每分钟约 100 段、每天约 1000 段文本，而且 Google 可能会用收到的内容改进其产品；当 Google 报告这是免费档时，索引会为你的搜索保留每项额度的五分之一。付费 key 每 2 万段约 1 美元。",
  "Each model keeps its own index. Switching starts filling the new model’s index in the background and leaves the previous one in place, so switching back is instant.":
    "每个模型各有自己的索引。切换模型会在后台开始填充新模型的索引，并保留之前的索引，所以切回去是即时的。",
  "Stored indexes":
    "已保存的索引",
  "· in use":
    "· 使用中",
  "{count} passages":
    "{count} 个段落",
  "{count} page images":
    "{count} 张页面图像",
  "Full text of your PDFs":
    "PDF 全文",
  "Not indexed while the embedding provider cannot be used (see above).":
    "嵌入服务无法使用时不建立索引（见上文）。",
  "Keep this up to date by itself":
    "自动保持最新",
  "Preparing…":
    "正在准备…",
  "Index {count} document":
    "为 {count} 篇文档建立索引",
  "Index {count} documents":
    "为 {count} 篇文档建立索引",
  "Everything is indexed":
    "全部已建立索引",
  "Retry the {skipped} that could not be read":
    "重试无法读取的 {skipped}",
  "{unreadable} could not be read — {reason}":
    "{unreadable} 无法读取——{reason}",
  "{unreadable} could not be read this session; they are left out until Zotero restarts or you retry them.":
    "本次运行中有 {unreadable} 无法读取；在重启 Zotero 或你重试之前会被跳过。",
  "Searching inside papers needs each one embedded page by page, which costs about as much as everything else here put together. Left on, it runs a little after launch and again a few seconds after you add papers, reading only the papers not indexed yet — so a paper you add today becomes searchable without you doing anything. It stops when you ask and picks up where it left off. Until it finishes, a full-text search says how much of your library it actually looked at.":
    "在论文内文中搜索需要把每篇论文逐页做嵌入，花费大约和这里其他所有项目加起来一样多。保持开启时，它会在启动后不久运行一次，并在你添加论文几秒后再运行，只读取尚未索引的论文——所以今天添加的论文不用你做任何事就能被搜索到。你要求时会停下，之后从中断处继续。完成之前，全文搜索会说明它实际查看了文献库的多少内容。",
  "Figures in your PDFs":
    "PDF 中的图表",
  "Finding a figure by describing it needs an embedding model that also reads pictures: Google Gemini or Ollama (EmbeddingGemma 2). OpenAI embeds text only.":
    "通过描述来找图，需要一个也能读图片的嵌入模型：Google Gemini 或 Ollama（EmbeddingGemma 2）。OpenAI 只能嵌入文本。",
  "Rendering pages · this pass: {done}/{total} PDFs":
    "正在渲染页面 · 本轮：{done}/{total} 个 PDF",
  "{indexed} of {library} PDFs indexed as pictures · {pages} pages.":
    "已把 {library} 个 PDF 中的 {indexed} 个按图片建立索引 · 共 {pages} 页。",
  "Counting…":
    "正在统计…",
  "Index every page as a picture too, after the full text":
    "在全文之后，也把每一页作为图片建立索引",
  "Every PDF is indexed":
    "所有 PDF 都已建立索引",
  "Index {count} PDF":
    "为 {count} 个 PDF 建立索引",
  "Index {count} PDFs":
    "为 {count} 个 PDF 建立索引",
  "Retry the {skipped} that could not be rendered":
    "重试无法渲染的 {skipped}",
  "{skipped} could not be rendered on this computer":
    "这台电脑上有 {skipped} 无法渲染",
  "Which PDF":
    "是哪个 PDF",
  "Which {skipped} PDFs":
    "是哪 {skipped} 个 PDF",
  "Stopped. It does not start again by itself until you press Index or restart Zotero.":
    "已停止。在你点“建立索引”或重启 Zotero 之前不会自动重新开始。",
  "Each page is rendered as a picture and turned into one vector — the picture itself is not kept — so the agent can find a figure by what it shows, then look at the page before answering. The text always goes first: search works while pages are still being added, and a paper added meanwhile is read for its words before its pages. Google charges about $0.12 per 1,000 pages; EmbeddingGemma 2 runs here, free.":
    "每一页都会渲染成图片，再转成一个向量——图片本身不保留——这样 AI 就能按图的内容找到它，并在回答前查看那一页。文字始终优先：页面还在添加时搜索就能用，期间新加的论文会先索引文字再索引页面。Google 每 1000 页约收 0.12 美元；EmbeddingGemma 2 在本机运行，免费。",

  // react/components/preferences/OllamaGuide.tsx
  "Checking Ollama…":
    "正在检查 Ollama…",
  "Ollama {version} is running · {count} model installed":
    "Ollama {version} 正在运行 · 已安装 {count} 个模型",
  "Ollama {version} is running · {count} models installed":
    "Ollama {version} 正在运行 · 已安装 {count} 个模型",
  "Ollama is not running on this computer.":
    "这台电脑上没有运行 Ollama。",
  "Check again":
    "重新检查",
  "Install Ollama":
    "安装 Ollama",
  "Install it from ollama.com, open the app once, and it keeps running in the background (menu bar / tray) — including after a restart. No account is needed; models download anonymously from Ollama’s library.":
    "从 ollama.com 安装，打开一次应用后它会在后台持续运行（菜单栏/托盘）——重启后也会。不需要账户；模型会从 Ollama 的模型库匿名下载。",
  "Installed ✓":
    "已安装 ✓",
  "Cancel downloading {name}":
    "取消下载 {name}",
  "Start Ollama first":
    "请先启动 Ollama",
  "Needs Ollama {minimum} or later":
    "需要 Ollama {minimum} 或更高版本",
  "Download {name} through Ollama":
    "通过 Ollama 下载 {name}",
  "Resume download":
    "继续下载",
  "Get it":
    "获取",
  "This model needs Ollama {minimum} or later; this one is {version}.":
    "这个模型需要 Ollama {minimum} 或更高版本；当前是 {version}。",
  "Update Ollama (its menu: Check for Updates, or download it again), then Check again.":
    "请更新 Ollama（在它的菜单中点“检查更新”，或重新下载），然后点“重新检查”。",
  "Update Ollama":
    "更新 Ollama",
  "or in a terminal:":
    "或在终端中运行：",
  "Chat models need a larger context than Ollama’s default: set “Context length” to 32k in the Ollama app’s settings, or run {command} {copy} and reopen Ollama. Installed chat models then appear in the model list as “Ollama (local) · …”. They are sent text only; one that reads images can be marked “Reads figures” on the Ollama card under Settings → Model → Providers.":
    "对话模型需要比 Ollama 默认值更大的上下文：在 Ollama 应用的设置中把“Context length”设为 32k，或运行 {command} {copy} 然后重新打开 Ollama。之后已安装的对话模型会以“Ollama（本地）· …”出现在模型列表中。默认只给它们发送文字；能读图片的模型可以在 设置 → 模型 → 服务商 的 Ollama 卡片上标记为“能看图”。",

  // react/components/preferences/PermissionsSection.tsx
  "Writing to your library":
    "修改你的文献库",
  "Off by default. Turned on, AlphainZ may change your library: add highlights and sticky notes to PDFs; write new notes and edit notes you have, including rewriting one whole; correct a paper's title, authors, year and other fields; edit annotations — their colour, comment and tags — and delete them; add papers it found in the literature; and tag items and file them into collections, creating collections as needed. Each kind follows its rule below — out of the box, every change is shown to you first and waits for your approval — and anything applied can be undone from its card in the conversation.":
    "默认关闭。打开后，AlphainZ 可以修改你的文献库：给 PDF 添加高亮和便笺；写新笔记、编辑已有笔记，包括整篇重写；修正论文的标题、作者、年份等字段；编辑注释（颜色、评论和标签）以及删除注释；添加它在文献检索中找到的论文；给条目打标签并归入分类，需要时新建分类。每类修改都按下面对应的规则处理——默认情况下，每处修改都会先展示给你，等你批准——应用后的修改都可以在对话中它的卡片上撤销。",
  "Let AlphainZ change your library":
    "允许 AlphainZ 修改你的文献库",
  "On. The rules below decide which changes ask first.":
    "已开启。下面的规则决定哪些修改要先询问。",
  "Off. AlphainZ can read your library but not change it, and says so when asked to.":
    "已关闭。AlphainZ 可以读取你的文献库但不能修改，被要求修改时会说明这一点。",
  "Library Modifications":
    "文献库修改",
  "How each kind of change is handled.":
    "各类修改的处理方式。",
  "{ask} shows the change on a card and waits for your approval.":
    "{ask}：逐条显示修改，等你批准。",
  "{apply} makes it without asking — except the riskiest ones, noted per row, which ask anyway.":
    "{apply}：不询问直接修改——除了各行注明的风险最高的那些，它们仍会询问。",
  "{later} asks nothing while the answer is written: the changes wait on their cards, each with its own Apply and Reject, and the end of the answer lists them for your review. Adding papers is the one thing that always asks. Anything applied can still be undone from the card in the conversation.":
    "{later}：回答过程中什么都不问，修改都在各自的卡片上等着，每张都有“应用”和“拒绝”，回答结束时会列出来供你审阅。添加论文是唯一总会询问的操作。应用过的修改仍可以在对话中它的卡片上撤销。",
  "Writing to your library is off, so none of these apply until you turn it on above.":
    "修改文献库的功能已关闭，所以在上面打开之前，这些规则都不生效。",
  "Note Creation":
    "新建笔记",
  "Writing new Zotero notes, filed under the paper they are about":
    "写新的 Zotero 笔记，归在相关论文下",
  "Note Edits":
    "编辑笔记",
  "Changing the text of a note that already exists, including rewriting it whole. Under Always apply, a rewrite that would drop or replace much of a longer note still asks.":
    "修改已有笔记的文字，包括整篇重写。即使设为“总是应用”，会删掉或替换较长笔记大部分内容的重写仍会询问。",
  "PDF Annotations":
    "PDF 注释",
  "Highlights and sticky notes AlphainZ adds to a PDF, and edits to annotations already there — colour, comment, tags. Under Always apply, replacing a comment an annotation already has, or removing all of its tags, still asks. Deleting annotations is the next row.":
    "AlphainZ 给 PDF 添加的高亮和便笺，以及对已有注释的编辑（颜色、评论、标签）。即使设为“总是应用”，替换注释已有的评论或删除它的全部标签仍会询问。删除注释见下一行。",
  "Annotation Deletion":
    "删除注释",
  "Removing annotations from a PDF, whatever PDF Annotations is set to. This one loses your own work — leave it on Always ask.":
    "从 PDF 中删除注释，不受“PDF 注释”设置的影响。这会丢失你自己的成果——请保持“总是询问”。",
  "Metadata Edits":
    "编辑元数据",
  "Correcting an item's title, authors, year, DOI and other fields":
    "修正条目的标题、作者、年份、DOI 等字段",
  "Item Imports":
    "导入条目",
  "Adding papers it found in the literature to your library. Every paper is shown to you first; a card can allow the rest of that run.":
    "把在文献检索中找到的论文加入你的文献库。每篇论文都会先展示给你；在卡片上可以允许本轮回答中余下的导入。",
  "Item Organization":
    "整理条目",
  "Creating collections, and adding or removing tags and collections on items":
    "新建分类，以及给条目添加或移除标签和分类",
  "System Notifications":
    "系统通知",
  "Approval Notifications":
    "审批通知",
  "Show a system notification when AlphainZ is waiting for your decision and is not visible.":
    "AlphainZ 等你决定而它不可见时，显示系统通知。",
  "Response Notifications":
    "回答通知",
  "Show a system notification when a response is ready and AlphainZ is not visible.":
    "回答已就绪而 AlphainZ 不可见时，显示系统通知。",
  "File Access":
    "文件访问",
  "Access Remote Files":
    "访问远程文件",
  "Download PDF files from the Zotero server when not available locally":
    "本地没有 PDF 文件时，从 Zotero 服务器下载",
  "When enabled, AlphainZ will attempt to download PDFs from the Zotero server or WebDAV if the file is not on your local machine. Disable this if you experience slow responses or don't want remote file downloads.":
    "开启后，如果文件不在本机，AlphainZ 会尝试从 Zotero 服务器或 WebDAV 下载 PDF。如果回答变慢或不想下载远程文件，请关闭此项。",

  // react/components/preferences/PreferencePage.tsx
  "Indexing Failed ({count})":
    "索引失败（{count}）",
  "Check & Repair":
    "检查并修复",
  "General":
    "常规",
  "Search":
    "搜索",
  "Permissions":
    "权限",
  "Advanced":
    "高级",
  "Settings":
    "设置",
  "Settings sections":
    "设置分区",
  "Topic search needs attention":
    "主题搜索需要处理",
  "Preferences":
    "偏好设置",
  "Keyboard Shortcut":
    "快捷键",
  "Sidebar:":
    "侧栏：",
  "· Window:":
    "· 窗口：",
  "· Changes require restart":
    "· 修改后需要重启",
  "Keep Cited Passages Highlighted":
    "保持被引用段落的高亮",
  "When enabled, AlphainZ marks cited passages with temporary Zotero annotations that disappear on your next click. When disabled, AlphainZ briefly flashes the passage instead.":
    "开启后，AlphainZ 用临时的 Zotero 注释标出被引用的段落，下次点击时消失。关闭后，AlphainZ 只会让段落闪一下。",
  "When disabled, citations use Zotero's transient PDF position highlight instead.":
    "关闭后，引用会改用 Zotero 自带的 PDF 临时定位高亮。",
  "Automatically attach selected items to new thread":
    "新对话自动附上选中的条目",
  "Add Selected Items When Opening":
    "打开时加入选中的条目",
  "Automatically attach selected items when opening AlphainZ":
    "打开 AlphainZ 时自动附上选中的条目",
  "Add Provenance Note to Imported Items":
    "为导入的条目添加来源笔记",
  "Add a child note that links the item back to its AlphainZ conversation":
    "添加一条子笔记，链接回导入它的 AlphainZ 对话",
  "Announce Responses for Screen Readers":
    "为读屏软件播报回答",
  "Move focus to screen-reader text when AlphainZ starts and finishes generating a response":
    "AlphainZ 开始和完成生成回答时，把焦点移到供读屏软件读取的文字上",
  "When enabled, focus moves from the chat input to screen-reader-only status text while AlphainZ generates, then to a screen-reader-only copy of the completed response.":
    "开启后，AlphainZ 生成回答时焦点会从输入框移到仅供读屏软件读取的状态文字上，完成后再移到仅供读屏软件读取的回答副本上。",
  "Preview Note Edits in Editor":
    "在编辑器中预览笔记修改",
  "Show proposed note edits inline in the Zotero note editor":
    "在 Zotero 笔记编辑器中直接显示待定的笔记修改",
  "Requires Zotero 8 — unavailable on this version":
    "需要 Zotero 8——此版本不可用",
  "When enabled, edit_note proposals appear as a colored diff directly in the note editor with Apply / Reject controls. When disabled, approvals fall back to the sidebar preview. Turn off if a Zotero update causes the in-editor preview to misbehave.":
    "开启后，edit_note 的修改建议会以彩色差异直接显示在笔记编辑器中，并附有“应用/拒绝”按钮。关闭后，审批改回在侧栏中预览。如果某次 Zotero 更新导致编辑器内预览异常，请关闭。",
  "Libraries":
    "文献库",
  "Titles and abstracts":
    "标题和摘要",
  "What lets the agent find an item by subject. It is built and kept up to date on its own, so there is normally nothing to do here — run a check if search results look out of date. Reading inside the PDFs is a separate, larger index, under Model.":
    "AI 靠它按主题找到条目。它会自动建立并保持最新，通常不需要做任何事——如果搜索结果看起来过时，可以运行一次检查。读取 PDF 内文是另一个更大的索引，在“模型”中。",
  "{count} item failed to index":
    "{count} 个条目索引失败",
  "{count} items failed to index":
    "{count} 个条目索引失败",
  "Error:":
    "错误：",
  "Off: no embedding provider is chosen, so this index is not built and the agent cannot find items by subject. Choose a provider under Model to turn it on.":
    "已关闭：没有选择嵌入服务，所以不会建立这个索引，AI 也无法按主题找到条目。在“模型”中选择一个服务即可开启。",
  "This index is built by itself once that is fixed; until then the agent cannot find items by subject.":
    "修好之后会自动建立这个索引；在那之前 AI 无法按主题找到条目。",
  "Choose a provider":
    "选择嵌入服务",
  "Fix it under Model":
    "到“模型”中修复",

  // react/components/preferences/PreferenceToggle.tsx
  "Error":
    "错误",

  // react/components/preferences/ProviderCards.tsx
  "It is the provider in use and no other provider is set up, so no model is selected until you add one.":
    "它是正在使用的服务商，而且没有设置其他服务商，所以在你添加一个之前不会选中任何模型。",
  "With settings sync on, your other computers switch to it too, so it has to be set up on each of them.":
    "开启设置同步时，你的其他电脑也会切换到它，所以每台电脑上都要设置好。",
  "It is the provider in use, so the sidebar switches to {name}.":
    "它是正在使用的服务商，所以侧栏会切换到 {name}。",
  "Test cancelled.":
    "测试已取消。",
  "{message} with {model}.":
    "{message}（{model}）。",
  "Reads figures — checked {when}.":
    "能看图——{when}检查过。",
  "Does not read figures — checked {when} ({detail}).":
    "不能看图——{when}检查过（{detail}）。",
  "Remove":
    "移除",
  "Configured":
    "已设置",
  "Not configured":
    "未设置",
  "Edit {title}":
    "编辑 {title}",
  "Edit":
    "编辑",
  "this model":
    "这个模型",
  "Thinking settings {name} takes":
    "{name} 支持的思考档位",
  "{name} takes {value}":
    "{name} 支持“{value}”",
  "None ticked: no thinking setting is sent, and the composer offers none.":
    "都不勾选：不发送任何思考设置，输入框旁也不提供选择。",
  "Context window":
    "上下文窗口",
  "Not set":
    "未设置",
  "Context window of {name}, in tokens":
    "{name} 的上下文窗口（token）",
  "Max output":
    "最大输出",
  "Most output one answer from {name} may use, in tokens":
    "{name} 单次回答最多可用的输出（token）",
  "Use the preset's values for {name}":
    "对 {name} 使用预设值",
  "Use the preset's values":
    "使用预设值",
  "A long chat is summarized before it fills 70% of the context window. Max output is this model's ceiling: Limits per Question can lower it, not raise it.":
    "长对话会在占满上下文窗口 70% 之前被总结。最大输出是这个模型的上限：“每个问题的限制”可以调低它，但不能调高。",
  "This endpoint accepts at most {tokens}, so answers stop there.":
    "这个端点最多接受 {tokens}，所以回答会在那里停止。",
  "{count} model available.":
    "有 {count} 个模型可用。",
  "{count} models available.":
    "有 {count} 个模型可用。",
  "Model catalogue":
    "模型目录",
  "Edited — the preset's list is replaced":
    "已编辑——替换了预设列表",
  "Restore default models":
    "恢复默认模型",
  "Fetch available models":
    "获取可用模型",
  "Fetching…":
    "正在获取…",
  "Available models":
    "可用模型",
  "{id} (listed)":
    "{id}（已列出）",
  "Add {pick} to the catalogue":
    "把 {pick} 添加到目录",
  "Add":
    "添加",
  "Model id, exactly as the endpoint spells it":
    "模型 ID，与端点的写法完全一致",
  "Model id":
    "模型 ID",
  "Display name":
    "显示名称",
  "Model display name":
    "模型显示名称",
  "Hide details for {name}":
    "隐藏 {name} 的详情",
  "Show details for {name}":
    "显示 {name} 的详情",
  "Remove model {name}":
    "移除模型 {name}",
  "Remove this row":
    "移除这一行",
  "Reads figures":
    "能看图",
  "Check whether {id} reads figures":
    "检查 {id} 是否能看图",
  "Check":
    "检查",
  "In use":
    "使用中",
  "Use {id}":
    "使用 {id}",
  "Use":
    "使用",
  "Add model":
    "添加模型",
  "The key is saved.":
    "key 已保存。",
  "Remove this provider?":
    "移除这个服务商？",
  "Forget the {label} key and any catalogue edits on this computer? You can add it again later.":
    "在这台电脑上删除 {label} 的 key 和对模型目录的修改？以后可以重新添加。",
  "API key":
    "API key",
  "Configured — leave empty to keep it, or paste a new key":
    "已设置——留空则保持不变，或粘贴新的 key",
  "Sends one short request to {testModel}":
    "向 {testModel} 发送一个简短请求",
  "Cancel the {label} test":
    "取消 {label} 的测试",
  "Custom settings":
    "自定义设置",
  "API address":
    "API 地址",
  "{label} API address":
    "{label} API 地址",
  "Cancel editing {label}":
    "取消编辑 {label}",
  "Save {label}":
    "保存 {label}",
  "this provider":
    "这个服务商",
  "Delete this provider?":
    "删除这个服务商？",
  "Delete {label} and the {count} model under it? Its key is forgotten with it.":
    "删除 {label} 及其下的 {count} 个模型？它的 key 也会一并删除。",
  "Delete {label} and the {count} models under it? Its key is forgotten with it.":
    "删除 {label} 及其下的 {count} 个模型？它的 key 也会一并删除。",
  "New provider":
    "新服务商",
  "Name":
    "名称",
  "e.g. My proxy":
    "例如：我的代理",
  "Provider name":
    "服务商名称",
  "Provider API address":
    "服务商 API 地址",
  "API format":
    "API 格式",
  "Chat Completions (/chat/completions)":
    "Chat Completions（/chat/completions）",
  "Responses (/responses)":
    "Responses（/responses）",
  "Most compatible servers speak Chat Completions. Responses is OpenAI's newer API: choose it when the server offers it and the model should think while it uses tools.":
    "大多数兼容服务器使用 Chat Completions。Responses 是 OpenAI 较新的 API：如果服务器支持，并且希望模型在使用工具时也能思考，就选它。",
  "Leave empty for a server that takes none":
    "服务器不需要 key 时留空",
  "Provider API key":
    "服务商 API key",
  "How the key is sent":
    "key 的发送方式",
  "Bearer token":
    "Bearer token",
  "X-Api-Key header":
    "X-Api-Key 请求头",
  "Add a model first":
    "请先添加模型",
  "Cancel the test":
    "取消测试",
  "Cancel editing provider":
    "取消编辑服务商",
  "Save provider":
    "保存服务商",
  "No answer from {address} within 4 s. Is Ollama running?":
    "{address} 在 4 秒内没有响应。Ollama 在运行吗？",
  "Could not reach Ollama at {address}. Is it running? ({error})":
    "无法连接 {address} 上的 Ollama。它在运行吗？（{error}）",
  "Found {count} chat model: {models}":
    "找到 {count} 个对话模型：{models}",
  "Found {count} chat models: {models}":
    "找到 {count} 个对话模型：{models}",
  "used for indexing: {models}":
    "用于索引：{models}",
  "Ollama has only {models}, which is used for indexing and cannot chat — download a chat model below.":
    "Ollama 里只有 {models}，它用于索引，不能对话——请在下方下载一个对话模型。",
  "Ollama is running but has no models yet — download one below.":
    "Ollama 正在运行，但还没有任何模型——请在下方下载一个。",
  "Remove Ollama?":
    "移除 Ollama？",
  "Forget the detected models on this computer? Ollama itself is not touched; you can add it again later.":
    "在这台电脑上忘记检测到的模型？Ollama 本身不受影响，以后可以重新添加。",
  "Ollama (local)":
    "Ollama（本地）",
  "Address":
    "地址",
  "Ollama address":
    "Ollama 地址",
  "Found":
    "已找到",
  "Detect models":
    "检测模型",
  "Installed models":
    "已安装的模型",
  "Ollama says it reads images":
    "Ollama 表示它能读图片",
  "{model} reads figures":
    "{model} 能看图",
  "used for indexing, not for chat":
    "用于索引，不用于对话",
  "No key, and nothing leaves your computer. Models are sent text only unless they are marked “Reads figures”; mark one only if it really reads images, since a model that does not is sent pictures it cannot see. Below: whether Ollama is running, and the models this plugin can use — each downloads with one click.":
    "不需要 key，数据也不离开你的电脑。除非标记为“能看图”，否则只给模型发送文字；只有真能读图片的模型才标记，因为不能读图的模型收到图片也看不见。下方：Ollama 是否在运行，以及本插件可用的模型——每个都能一键下载。",
  "Done editing Ollama":
    "完成 Ollama 编辑",
  "Done":
    "完成",
  "Providers":
    "服务商",
  "Where the models come from. Each provider holds a key and a catalogue of models; every model in a catalogue appears in the picker under the provider's name. Add the ones you use — a built-in vendor, or any OpenAI-compatible endpoint of your own.":
    "模型从哪里来。每个服务商有一个 key 和一份模型目录；目录中的每个模型都会以服务商的名称出现在选择器里。添加你要用的——内置服务商，或你自己的任何 OpenAI 兼容端点。",
  "No providers yet. Add one below and paste its key.":
    "还没有服务商。在下方添加一个并粘贴它的 key。",
  "An API address set in an earlier version is still stored: {address}. The next built-in provider you use sends its requests there instead of to its own address. Clear it unless that is what you want.":
    "之前版本设置的 API 地址仍然保存着：{address}。你下次使用的内置服务商会把请求发到那里，而不是它自己的地址。除非你确实想这样，否则请清除它。",
  "Clear the stored address":
    "清除保存的地址",
  "Add provider":
    "添加服务商",
  "Add custom provider":
    "添加自定义服务商",
  "Add {label}":
    "添加 {label}",
  "Add Ollama (local)":
    "添加 Ollama（本地）",
  "Keys, addresses and catalogues stay on this computer. With settings sync on, the choice of model travels to your other computers and the keys do not, so each computer needs its own. Keys are kept as plain text in Zotero's preferences: anyone who can read your Zotero profile folder can read them.":
    "key、地址和模型目录都只保存在这台电脑上。开启设置同步时，模型的选择会同步到你的其他电脑，key 不会，所以每台电脑需要各自的 key。key 以明文保存在 Zotero 的设置里：任何能读取你 Zotero 配置文件夹的人都能看到。",

  // react/components/preferences/RunLimitsSection.tsx
  "Auto (provider default)":
    "自动（服务商默认）",
  "{count}k tokens":
    "{count}k token",
  "{count} requests":
    "{count} 次请求",
  "{count} searches":
    "{count} 次搜索",
  "No limit":
    "不限",
  "{count} lookups":
    "{count} 次查询",
  "Limits per Question":
    "每个问题的限制",
  "Ceilings, not charges: you pay only for what a question actually uses. They exist so a model that keeps rephrasing or thinking cannot run on without end. Changes apply from the next message.":
    "这些是上限，不是收费：你只为一个问题实际用掉的部分付费。设置它们是为了防止模型不停改写或思考而没完没了。修改从下一条消息起生效。",
  "Output tokens per reply":
    "单次回答的输出 token 上限",
  "The most one reply may spend, and a thinking model's reasoning counts against it — too low and a turn can end mid-thought with nothing to show. Auto is 32k for DeepSeek, GLM, OpenRouter and OpenAI (16k for gpt-4o), 4k for Ollama, 8k for a provider you add, or the Max output set for the model on its card; a higher choice is held to what the provider accepts.":
    "一次回答最多能用多少 token，思考型模型的推理也算在内——设得太低，回答可能在思考中途结束，什么也没有。“自动”对 DeepSeek、GLM、OpenRouter 和 OpenAI 是 32k（gpt-4o 为 16k），对 Ollama 是 4k，对你添加的服务商是 8k，或者使用模型卡片上设置的最大输出；设得更高时，以服务商接受的为准。",
  "{count} tokens (custom)":
    "{count} token（自定义）",
  "Model requests per question":
    "每个问题的模型请求数",
  "Every step — a search, a page read, a proposed highlight — is one request. A question that reaches the limit stops and says so; ask it to continue.":
    "每一步——一次搜索、读一页、提议一处高亮——都是一次请求。问题达到上限时会停下并说明；可以让它继续。",
  "{count} requests (custom)":
    "{count} 次请求（自定义）",
  "Library searches per question":
    "每个问题的文献库搜索次数",
  "Topic, keyword and full-text searches of your library, together. With no limit, the request limit above still ends the question.":
    "对文献库的主题、关键词和全文搜索合计。即使不限，上面的请求数上限仍会结束这个问题。",
  "{count} searches (custom)":
    "{count} 次搜索（自定义）",
  "Literature lookups per question":
    "每个问题的文献查询次数",
  "OpenAlex searches, DOI lookups and citation walks, together. With no limit, the request limit above still ends the question.":
    "OpenAlex 搜索、DOI 查询和引用追溯合计。即使不限，上面的请求数上限仍会结束这个问题。",
  "{count} lookups (custom)":
    "{count} 次查询（自定义）",

  // packages/agent-llm/src/vendors.ts
  "The recommended first pick: reads figures, calls tools, low price.":
    "首选推荐：能看图、能调用工具，价格低。",
  "deepseek-flash — DeepSeek V4.1 Flash: 1M context, reads figures, calls tools. $0.15/M in · $0.60/M out, twice that at peak hours (weekdays 01:00–04:00 and 06:00–10:00 UTC). A stored choice of a retired V4 model runs as deepseek-flash.":
    "deepseek-flash——DeepSeek V4.1 Flash：100 万上下文，能看图、能调用工具。输入每百万 0.15 美元 · 输出每百万 0.60 美元，高峰时段（工作日 UTC 01:00–04:00 和 06:00–10:00）加倍。之前选择的已停用 V4 模型会按 deepseek-flash 运行。",
  "One subscription for DeepSeek V4.1 Flash, GLM 5.3, Kimi K3.1 and more.":
    "一个订阅就能用 DeepSeek V4.1 Flash、GLM 5.3、Kimi K3.1 等模型。",
  "A monthly subscription instead of a per-token bill: DeepSeek V4.1 Flash (the default), GLM 5.3 Flash, Kimi K3.1 Pro, MiniMax M3.1 Flash, DeepSeek V4 Pro and GLM 5.3 behind one key, within five-hour, weekly and monthly allowances. All call tools; all but the last two read figures. They always think before they answer: the lightest setting is Low, or High for DeepSeek V4 Pro.":
    "按月订阅，不按 token 计费：一个 key 就能用 DeepSeek V4.1 Flash（默认）、GLM 5.3 Flash、Kimi K3.1 Pro、MiniMax M3.1 Flash、DeepSeek V4 Pro 和 GLM 5.3，用量按 5 小时、每周和每月的额度计算。都能调用工具，除了最后两个都能看图。它们总会先思考再回答：最轻的档位是 Low，DeepSeek V4 Pro 是 High。",
  "GLM 5.3 Flash and DeepSeek V4.1 Flash behind one key.":
    "一个 key 就能用 GLM 5.3 Flash 和 DeepSeek V4.1 Flash。",
  "Reaches GLM 5.3 Flash (1.3M context, reads figures, ~$0.08/M in) and DeepSeek V4.1 Flash (1M context, reads figures, $0.15/M in · $0.60/M out, no peak hours). Both call tools.":
    "可用 GLM 5.3 Flash（130 万上下文，能看图，输入每百万约 0.08 美元）和 DeepSeek V4.1 Flash（100 万上下文，能看图，输入每百万 0.15 美元 · 输出每百万 0.60 美元，没有高峰时段）。两者都能调用工具。",
  "Zhipu (BigModel)":
    "智谱（BigModel）",
  "GLM 5.3 Flash from Zhipu directly.":
    "直接使用智谱的 GLM 5.3 Flash。",
  "GLM 5.3 Flash from Zhipu directly — 1M context, reads figures, calls tools.":
    "直接使用智谱的 GLM 5.3 Flash——100 万上下文，能看图、能调用工具。",
  "Gemini 3.8 Flash and 4 Argon; the same key runs Gemini Embedding for topic search.":
    "Gemini 3.8 Flash 和 4 Argon；同一个 key 还能运行用于主题搜索的 Gemini Embedding。",
  "Gemini 3.8 Flash (the default; $0.75/M in · $3.75/M out until 31 Dec 2026, then double), 3.5 Flash-Lite ($0.30/M in · $2.50/M out) and 4 Argon ($2/M in · $10/M out until 30 Nov 2026, then double). All read figures, call tools and think before they answer. The same key runs Gemini Embedding 2 for topic and full-text search. A key from a project without billing is free but tightly limited, and Google may use what it is sent to improve its products.":
    "Gemini 3.8 Flash（默认；2026 年 12 月 31 日前输入每百万 0.75 美元 · 输出每百万 3.75 美元，之后翻倍）、3.5 Flash-Lite（输入每百万 0.30 美元 · 输出每百万 2.50 美元）和 4 Argon（2026 年 11 月 30 日前输入每百万 2 美元 · 输出每百万 10 美元，之后翻倍）。都能看图、调用工具，并会先思考再回答。同一个 key 还能运行 Gemini Embedding 2，用于主题和全文搜索。未开通计费的项目的 key 免费但限额很紧，而且 Google 可能会用收到的内容改进其产品。",
  "GPT-4o and GPT-4o mini.":
    "GPT-4o 和 GPT-4o mini。",

  // react/components/PreferencesWindow.tsx
  "AlphainZ Settings":
    "AlphainZ 设置",

  // react/components/RecentChats.tsx
  "now":
    "刚刚",
  "{count}m":
    "{count} 分钟",
  "{count}h":
    "{count} 小时",
  "{count}d":
    "{count} 天",
  "{count}w":
    "{count} 周",
  "{count}mo":
    "{count} 个月",
  "Related to this file":
    "与此文件相关",
  "Related to this note":
    "与此笔记相关",
  "Recent":
    "最近",
  "View All":
    "查看全部",
  "Unnamed conversation":
    "未命名对话",

  // react/components/Sidebar.tsx
  "Upgrading your data...":
    "正在升级你的数据…",
  "Loading...":
    "正在载入…",
  "Ask a follow-up question":
    "提一个后续问题",

  // react/components/sources/CitationTipContent.tsx
  "AlphainZ cites sources from your library and beyond.":
    "AlphainZ 会引用你文献库内外的来源。",
  "points to an item in your library.":
    "指向你文献库中的一个条目。",
  "opens your PDF and highlights the exact passage it's based on.":
    "打开你的 PDF，并高亮所依据的原文段落。",
  "is an external reference you can explore or import to your library.":
    "是外部文献，可以查看或导入到你的文献库。",

  // react/components/status/DatabaseSyncStatus.tsx
  "Syncing Zotero Library":
    "正在同步 Zotero 文献库",
  "Report issue":
    "报告问题",
  "Retry syncing":
    "重试同步",

  // react/components/status/FailedProcessingTooltipContent.tsx
  "Processing Errors":
    "处理错误",
  "No specific error details available.":
    "没有具体的错误详情。",

  // react/components/status/FileStatusDisplay.tsx
  "{totalFiles} Files":
    "{totalFiles} 个文件",
  "Failed Uploads. Retry to upload again.":
    "上传失败。重试即可重新上传。",
  "Failed processing":
    "处理失败",
  "Processing errors":
    "处理错误",
  "Skipped file":
    "跳过的文件",
  "Some uploads failed because the user is not logged in to Zotero. Please log in to Zotero and try again.":
    "有些文件上传失败，因为没有登录 Zotero。请登录 Zotero 后再试。",
  "Some uploads failed because they could not be downloaded from Zotero's server. Please try again later.":
    "有些文件上传失败，因为无法从 Zotero 服务器下载。请稍后再试。",
  "File processing limit reached":
    "已达到文件处理上限",
  "The free beta has a 125,000-page processing limit. Some files weren't processed. Limits will change after the beta.":
    "免费测试版的处理上限为 125,000 页。有些文件没有被处理。测试结束后限额会调整。",

  // react/components/status/PaginatedFailedProcessingList.tsx
  "Show More":
    "显示更多",

  // react/components/status/SkippedFilesSummary.tsx
  "Show Files":
    "显示文件",
  "Updating...":
    "正在更新…",

  // react/components/ThreadListView.tsx
  "Other Zotero profile":
    "其他 Zotero 配置",
  "Created in a different Zotero account or profile":
    "在另一个 Zotero 账户或配置中创建",
  "Not written yet":
    "尚未写入",
  "This archived chat has no file in the sync location -- archived chats are not exported. Restore it, and its file is written with its next change.":
    "这个归档对话在同步位置没有文件——归档的对话不会导出。恢复它之后，下次有改动时会写入它的文件。",
  "This conversation has no file yet -- it is written when the next answer finishes, or by \"Export all conversations\" in settings.":
    "这个对话还没有文件——下一个回答完成时，或在设置中点“导出所有对话”时会写入。",
  "Could not open the conversation JSON":
    "无法打开对话的 JSON",
  "Restored":
    "已恢复",
  "The chat is back in your history.":
    "对话已回到你的历史记录中。",
  "Could not restore the chat":
    "无法恢复对话",
  "Delete forever?":
    "永久删除？",
  "This permanently deletes the chat here and on your other synced computers. It cannot be undone.":
    "这会在这里以及你其他同步的电脑上永久删除这个对话，无法撤销。",
  "Deleted forever":
    "已永久删除",
  "The chat was permanently removed.":
    "对话已被永久删除。",
  "Could not delete the chat":
    "无法删除对话",
  "Delete chat?":
    "删除对话？",
  "This chat moves to the archive. You can restore it from there.":
    "这个对话会移到归档中，可以从那里恢复。",
  "Could not rename the chat":
    "无法重命名对话",
  "Chats from other Zotero profiles are hidden":
    "来自其他 Zotero 配置的对话已隐藏",
  "{count} chat from a different Zotero profile is hidden":
    "已隐藏 {count} 个来自其他 Zotero 配置的对话",
  "{count} chats from other Zotero profiles are hidden":
    "已隐藏 {count} 个来自其他 Zotero 配置的对话",
  "Some of your chats were created in a different Zotero profile. AlphainZ keeps chat history separate for each one.":
    "你有些对话是在另一个 Zotero 配置中创建的。AlphainZ 为每个配置分别保存对话历史。",
  "You have {count} chat that was created in a different Zotero profile. AlphainZ keeps chat history separate for each one.":
    "你有 {count} 个对话是在另一个 Zotero 配置中创建的。AlphainZ 为每个配置分别保存对话历史。",
  "You have {count} chats that were created in a different Zotero profile. AlphainZ keeps chat history separate for each one.":
    "你有 {count} 个对话是在另一个 Zotero 配置中创建的。AlphainZ 为每个配置分别保存对话历史。",
  "Chats":
    "对话",
  "Search chats...":
    "搜索对话…",
  "Search chats":
    "搜索对话",
  "Back to your chats":
    "返回你的对话",
  "Archive":
    "归档",
  "Deleted chats are kept here and can be restored.":
    "删除的对话保存在这里，可以恢复。",
  "Filtered by {label}":
    "筛选：{label}",
  "Remove filter":
    "移除筛选",
  "Showing all Zotero profiles":
    "正在显示所有 Zotero 配置",
  "AlphainZ normally shows only chats created with this Zotero profile.":
    "AlphainZ 通常只显示用这个 Zotero 配置创建的对话。",
  "Showing chats from all Zotero profiles. Show only this profile's chats":
    "正在显示所有 Zotero 配置中的对话。只显示这个配置的对话",
  "All profiles":
    "所有配置",
  "Showing {count} archived chat related to {label}":
    "显示 {count} 个与 {label} 相关的归档对话",
  "Showing {count} archived chats related to {label}":
    "显示 {count} 个与 {label} 相关的归档对话",
  "Showing {count} chat related to {label}":
    "显示 {count} 个与 {label} 相关的对话",
  "Showing {count} chats related to {label}":
    "显示 {count} 个与 {label} 相关的对话",
  "current chat":
    "当前对话",
  " (current chat)":
    "（当前对话）",
  "Cancel rename":
    "取消重命名",
  "Confirm rename":
    "确认重命名",
  "Show conversation JSON in Zotero":
    "在 Zotero 中显示对话的 JSON",
  "Rename thread":
    "重命名对话",
  "Restore this chat":
    "恢复这个对话",
  "Move this chat to the archive":
    "把这个对话移到归档",
  "Delete this chat forever, on every synced computer":
    "在所有同步的电脑上永久删除这个对话",
  "You're offline":
    "你处于离线状态",
  "Couldn't load chats":
    "无法载入对话",
  "Reconnect to load your chats.":
    "重新联网后即可载入对话。",
  "Check your connection and try again.":
    "请检查网络连接后重试。",
  "Try again":
    "重试",
  "No matching chats":
    "没有匹配的对话",
  "No chats about {label}":
    "没有关于 {label} 的对话",
  "No chats on this Zotero profile":
    "这个 Zotero 配置中没有对话",
  "Show all chats":
    "显示所有对话",
  "No archived chats about {label}":
    "没有关于 {label} 的归档对话",
  "The archive is empty":
    "归档是空的",
  "No chats yet":
    "还没有对话",
  "You're offline.":
    "你处于离线状态。",
  "Couldn't reach the server.":
    "无法连接服务器。",
  "Show more":
    "显示更多",
  "Show all":
    "显示全部",
  "Sync now":
    "立即同步",
  "syncing…":
    "正在同步…",
  "last synced {time}":
    "上次同步于 {time}",
  "not synced yet":
    "尚未同步",

  // react/components/ui/buttons/AddLibraryButton.tsx
  "The library includes too many files that are stored on the Zotero server and not locally.\n\nConsider changing the \"Download files\" setting to \"at sync time\" in Zotero preferences -> Sync.\n\nA later version might support syncing files stored on the Zotero server.":
    "这个文献库有太多文件只保存在 Zotero 服务器上，不在本地。\n\n可以考虑在 Zotero 设置 → 同步 中把“下载文件”改为“同步时”。\n\n以后的版本可能会支持同步保存在 Zotero 服务器上的文件。",
  "Sync Library?":
    "同步文献库？",
  "Library not synced with Zotero":
    "文献库未与 Zotero 同步",
  "Add Library":
    "添加文献库",

  // react/components/ui/buttons/CopyButton.tsx
  "Copy to clipboard":
    "复制到剪贴板",

  // react/components/ui/buttons/DatabaseStatusButton.tsx
  "Syncing...":
    "正在同步…",
  "Sync Error":
    "同步出错",
  "Sync Database":
    "同步数据库",
  "Click to retry sync":
    "点击重试同步",

  // react/components/ui/buttons/DeferredToolPreferenceButton.tsx
  "Always asks":
    "总是询问",
  "Adding papers always asks: each paper is added only once you apply it.":
    "添加论文总是会询问：每篇论文只有在你应用后才会添加。",
  "Adding papers always asks: each paper is added only once you apply it. \"Allow for this run\" on the Apply button covers the rest of this run.":
    "添加论文总是会询问：每篇论文只有在你应用后才会添加。“应用”按钮上的“本轮允许”可以涵盖本轮回答中余下的部分。",
  "How to handle this action":
    "如何处理这类操作",
  "Adding papers always asks":
    "添加论文总是会询问",
  "Select action preference":
    "选择处理方式",

  // react/components/ui/buttons/DevToolsMenuButton.tsx
  "Development Tools":
    "开发工具",

  // react/components/ui/buttons/EmbeddingIndexStatusButton.tsx
  "Indexing":
    "正在索引",
  "Indexing titles and abstracts":
    "正在索引标题和摘要",
  "Reading your PDFs":
    "正在读取你的 PDF",
  "Indexing Error":
    "索引出错",
  "Click to retry":
    "点击重试",
  "Click to retry indexing":
    "点击重试索引",
  "Rebuild Search Index":
    "重建搜索索引",

  // react/components/ui/buttons/LibraryPermissionButton.tsx
  "How should library changes be approved?":
    "文献库的修改要怎样批准？",
  "Ask for approval":
    "逐条批准",
  "Review every change before it is applied":
    "每处修改在应用前都由你审阅",
  "Full access":
    "完全访问",
  "Edit items, collections, and annotations without asking":
    "编辑条目、分类和注释时不再询问",
  "How library changes are approved":
    "文献库修改的批准方式",

  // react/components/ui/buttons/ModelSelectionButton.tsx
  "Off — answer straight away":
    "关闭——直接回答",
  "Minimal":
    "最低",
  "Low — brief planning":
    "低——简短规划",
  "Medium":
    "中",
  "High — think it through":
    "高——充分思考",
  "Extra high":
    "超高",
  "Max — the longest thinking":
    "最高——思考最久",
  "Added by you":
    "你添加的",
  "{name} · reads figures":
    "{name} · 能看图",
  "None Selected":
    "未选择",
  "Model (recommended)":
    "模型（推荐）",
  "Model: {name}":
    "模型：{name}",
  "{count} credit":
    "{count} 点额度",
  "{count} credits":
    "{count} 点额度",
  "Recommended":
    "推荐",
  "Selected AI model: {name}":
    "已选择的 AI 模型：{name}",
  "No AI model selected":
    "未选择 AI 模型",
  "Back to {title}":
    "返回{title}",
  "None selected":
    "未选择",
  "AI model: {selectedModelAccessibleLabel}. Choose AI model":
    "AI 模型：{selectedModelAccessibleLabel}。选择 AI 模型",
  "No models available":
    "没有可用的模型",

  // react/components/ui/buttons/SplitApplyButton.tsx
  "Apply":
    "应用",
  "Allow this action group for this run":
    "本轮回答中允许这一类操作",
  "Similar actions":
    "类似操作",
  "Allow for this run":
    "本轮允许",
  "More apply options":
    "更多应用选项",

  // react/components/ui/buttons/StreamDisplayButton.tsx
  "Step display":
    "步骤显示",

  // react/components/ui/buttons/ThreadMenuButton.tsx
  "Rename chat":
    "重命名对话",
  "Enter a new name for this chat:":
    "为这个对话输入新名称：",
  "This chat moves to the archive. You can restore it from Chat history → Archive.":
    "这个对话会移到归档中，可以在 对话历史 → 归档 中恢复。",
  "‹ Save chat as note":
    "‹ 把对话保存为笔记",
  "Copy entire chat":
    "复制整个对话",
  "Save chat as note…":
    "把对话保存为笔记…",
  "Save chat as child note":
    "把对话保存为子笔记",
  "Copy link to chat":
    "复制对话链接",
  "Delete chat":
    "删除对话",

  // react/components/ui/menus/AddSourcesMenu.tsx
  "Select Files":
    "选择文件",
  "Supported files (PDF, EPUB, text, images)":
    "支持的文件（PDF、EPUB、文本、图片）",
  "No results found":
    "没有找到结果",
  "No notes found":
    "没有找到笔记",
  "Search by author, year and title":
    "按作者、年份和标题搜索",
  "Search collections":
    "搜索分类",
  "Search tags":
    "搜索标签",
  "Search notes":
    "搜索笔记",
  "Add Sources":
    "添加来源",

  // react/components/ui/menus/hooks/useCollectionsMenu.ts
  "Select Collections":
    "选择分类",
  "Collections in {library}":
    "{library} 中的分类",

  // react/components/ui/menus/hooks/useLibrariesMenu.ts
  "Select Library":
    "选择文献库",

  // react/components/ui/menus/hooks/useNotesMenu.ts
  "Search Results":
    "搜索结果",
  "Recent Notes":
    "最近的笔记",
  "Notes in {library}":
    "{library} 中的笔记",

  // react/components/ui/menus/hooks/useSourcesMenu.tsx
  "\"Filter by Library\"":
    "按文献库筛选",
  "Filter by Library":
    "按文献库筛选",
  "\"Filter by Collections\"":
    "按分类筛选",
  "Filter by Collections":
    "按分类筛选",
  "\"Filter by Tags\"":
    "按标签筛选",
  "Filter by Tags":
    "按标签筛选",
  "\"Add Note\"":
    "添加笔记",
  "Add Note":
    "添加笔记",
  "\"Add File\"":
    "添加文件",
  "Add External File…":
    "添加外部文件…",
  "Selected in Zotero":
    "在 Zotero 中选中的",

  // react/components/ui/menus/hooks/useTagsMenu.ts
  "Select Tags":
    "选择标签",
  "Tags in {library}":
    "{library} 中的标签",

  // react/components/ui/menus/ThreadFilterMenu.tsx
  "Recent Items":
    "最近的条目",
  "Filter chats by Zotero item":
    "按 Zotero 条目筛选对话",
  "Filter":
    "筛选",

  // react/components/ui/menus/ThreadsMenu.tsx
  "Delete thread":
    "删除对话",
  "No threads":
    "没有对话",

  // react/components/ui/menus/utils/menuItemFactories.tsx
  "Note on {parent}":
    "{parent} 的笔记",
  "item":
    "条目",

  // react/components/ui/popup/FeatureTourContent.tsx
  "Go to step {step}":
    "转到第 {step} 步",
  "Learn more →":
    "了解更多 →",

  // react/components/ui/popup/IndexingCompleteMessageContent.tsx
  "You can upgrade your plan to process more files.":
    "可以升级套餐来处理更多文件。",
  "Upgrade":
    "升级",
  "View Details":
    "查看详情",

  // react/components/ui/popup/NoteTipContent.tsx
  "Use AlphainZ as a writing assistant for your Zotero notes.":
    "把 AlphainZ 当作 Zotero 笔记的写作助手。",
  "Summarize papers, draft sections, and find citations while you write.":
    "边写边总结论文、起草段落、查找引用。",
  "Open AlphainZ →":
    "打开 AlphainZ →",

  // react/components/ui/popup/ReaderTipContent.tsx
  "Ask about this paper":
    "问问这篇论文",
  "Answers grounded in the open PDF, with sentence-level citations.":
    "基于当前打开的 PDF 回答，并精确引用到句子。",
  "Understand text, figures & tables":
    "读懂文字、图和表",
  "Select a passage in the PDF and choose Explain, or attach a figure with an area annotation, for an instant explanation.":
    "在 PDF 中选中一段文字并选择“解释”，或用区域注释附上一张图，立刻得到解释。",
  "Annotate the PDF":
    "给 PDF 加注释",
  "Ask AlphainZ to highlight key findings or anything relevant to your work.":
    "让 AlphainZ 高亮关键发现，或任何与你的研究相关的内容。",
  "Connect it to your library":
    "和你的文献库联系起来",
  "Ask whether the rest of your library confirms, contradicts, or extends this paper.":
    "问问你文献库里的其他文献是证实、反驳还是拓展了这篇论文。",
  "Reading assistant":
    "阅读助手",
  "Try it →":
    "试一试 →",
  "Open AlphainZ":
    "打开 AlphainZ",

  // react/components/ui/popup/SelectionCommentOfferContent.tsx
  "The answer was not saved.":
    "回答没有保存。",
  "Highlighted passage":
    "高亮的段落",
  "Page {pageLabel}":
    "第 {pageLabel} 页",

  // react/components/ui/popup/VersionUpdateMessageContent.tsx
  "Now Available":
    "现已推出",
  "Learn More":
    "了解更多",

  // react/components/ui/popup/WelcomeOnboardingContent.tsx
  "Ask questions about any PDF":
    "就任何 PDF 提问",
  "Get answers with page-level citations":
    "得到带页码引用的回答",
  "Search your library by meaning":
    "按意思搜索你的文献库",
  "Find papers by topic, not just keywords":
    "按主题而不只是关键词找论文",
  "Discover new research":
    "发现新研究",
  "Search 240M scholarly works":
    "检索 2.4 亿篇学术文献",
  "Organize automatically":
    "自动整理",
  "Auto-tag, sort, and manage collections":
    "自动打标签、归类和管理分类",
  "Your AI research assistant for Zotero":
    "你的 Zotero AI 研究助手",
  "Try it later":
    "以后再试",
  "Tip: Open AlphainZ using the button {button} or with {shortcut}":
    "提示：点按钮 {button} 或按 {shortcut} 即可打开 AlphainZ",

  // react/hooks/useAttachExternalFiles.ts
  "File not added":
    "文件未添加",
  "You can add up to {count} files at a time.":
    "一次最多可以添加 {count} 个文件。",

  // react/hooks/useComposerPasteHandlers.ts
  "The pasted content could not be read.":
    "无法读取粘贴的内容。",

  // react/hooks/useErrorCodeStats.ts
  "Could not load details.":
    "无法载入详情。",

  // react/hooks/useIndexingCompleteMessage.ts
  "Your library is ready!":
    "你的文献库已准备就绪！",

  // react/hooks/useInterruptedThreadPopup.ts
  "AlphainZ chat was interrupted":
    "AlphainZ 对话被中断",
  "AlphainZ closed before it finished working on “{name}”.":
    "AlphainZ 在完成“{name}”之前被关闭了。",
  "AlphainZ closed before it finished working on your last chat.":
    "AlphainZ 在完成你的上一个对话之前被关闭了。",
  "Open chat":
    "打开对话",

  // react/hooks/useProfileSync.ts
  "Offline":
    "离线",

  // react/hooks/useRemoveContextMenu.tsx
  "Remove all":
    "全部移除",

  // react/hooks/useSelectionChatHandler.ts
  "Not asked":
    "未提问",
  "This library is excluded from AlphainZ. You can change that in AlphainZ Settings.":
    "这个文献库已从 AlphainZ 排除。可以在 AlphainZ 设置中修改。",
  "AlphainZ did not send this question. Try again in a moment.":
    "AlphainZ 没有发出这个问题，请稍后再试。",
  "AlphainZ could not find this file in your library.":
    "AlphainZ 在你的文献库中找不到这个文件。",
  "Something went wrong. Try again.":
    "出了点问题，请重试。",

  // react/hooks/useSlashMenu.tsx
  "Create Action":
    "创建快捷操作",

  // react/hooks/useValidateSyncLibraries.ts
  "Remove Library from Syncing?":
    "不再同步这个文献库？",

  // react/host/zotero/components/ActionButtons.tsx
  "Show details":
    "显示详情",
  "Details":
    "详情",
  "Open website":
    "打开网站",
  "Web":
    "网页",
  "Open PDF":
    "打开 PDF",
  "No PDF available":
    "没有可用的 PDF",
  "Cited by {count}":
    "被引 {count} 次",
  "Reveal":
    "显示",
  "Import to Zotero":
    "导入 Zotero",

  // react/host/zotero/components/ActionPreview.tsx
  "Added to: {paper}":
    "已添加到：{paper}",
  "Adding to: {paper}":
    "正在添加到：{paper}",
  "Saved as a standalone note in {library}":
    "已作为独立笔记保存在 {library}",
  "A standalone note in {library}":
    "{library} 中的一篇独立笔记",
  "No item data available":
    "没有条目数据",
  "Edit {number}":
    "修改 {number}",
  "Action: {type}":
    "操作：{type}",

  // react/host/zotero/components/AgentActionItemButtons.tsx
  "No details available":
    "没有详情",
  "Retry creating item":
    "重试创建条目",
  "Error creating item":
    "创建条目出错",
  "Reject Item":
    "拒绝条目",
  "Add to library":
    "添加到文献库",
  "Already in library - click to reveal":
    "已在文献库中——点击显示",
  "In Library":
    "已在文献库中",

  // react/host/zotero/components/AgentActionView.tsx
  "Open annotation":
    "打开注释",
  "Waiting for your review":
    "等待你审阅",
  "Collapse":
    "收起",
  "Expand":
    "展开",
  "Collapse {target}":
    "收起{target}",
  "Expand {target}":
    "展开{target}",
  "Reject":
    "拒绝",
  "Reject {target}":
    "拒绝{target}",
  "Apply {target}":
    "应用{target}",
  "No preview available":
    "没有可用的预览",
  "Deleting annotations has its own rule, under Settings → Permissions → Annotation Deletion":
    "删除注释有单独的规则，在 设置 → 权限 → 删除注释 中",
  "Undo":
    "撤销",
  "Retry Undo":
    "重试撤销",
  "Try Again":
    "再试一次",
  "Confirm":
    "确认",

  // react/host/zotero/components/agentActionViewHelpers.ts
  "Overwrite manual changes?":
    "覆盖手动修改？",
  "The field \"{field}\" has been manually modified since the edit was applied. Do you want to overwrite your changes and revert to the original value?":
    "字段“{field}”在应用修改后被手动改过。要覆盖你的修改并恢复原值吗？",
  "The following fields have been manually modified since the edit was applied: {fields}. Do you want to overwrite your changes and revert to the original values?":
    "以下字段在应用修改后被手动改过：{fields}。要覆盖你的修改并恢复原值吗？",
  "Awaiting approval":
    "等待批准",
  "Pending":
    "待定",
  "Applied":
    "已应用",
  "Rejected":
    "已拒绝",
  "Undone":
    "已撤销",
  "Edited":
    "已修改",
  "Edited Note":
    "已修改笔记",
  "Created Note":
    "已新建笔记",
  "Create Note":
    "新建笔记",
  "{count} Sticky Notes":
    "{count} 张便笺",
  "Deleted {count} Annotations":
    "已删除 {count} 条注释",
  "Delete {count} Annotations":
    "删除 {count} 条注释",
  "Edited {count} Annotations":
    "已修改 {count} 条注释",
  "Edit {count} Annotations":
    "修改 {count} 条注释",
  "Deleted Annotation":
    "已删除注释",
  "Delete Annotation":
    "删除注释",
  "Edited Annotation":
    "已修改注释",
  "Edit Annotation":
    "修改注释",
  "Created Collection":
    "已新建分类",
  "Create Collection":
    "新建分类",
  "Organized":
    "已整理",
  "Tag":
    "标签",
  "Extract":
    "提取",
  "Delete tag \"{name}\"":
    "删除标签“{name}”",
  "Merge \"{name}\" → \"{newName}\"":
    "合并“{name}” → “{newName}”",
  "Rename \"{name}\" → \"{newName}\"":
    "重命名“{name}” → “{newName}”",
  "Tag \"{name}\"":
    "标签“{name}”",
  "Delete \"{name}\"":
    "删除“{name}”",
  "Delete collection":
    "删除分类",
  "Move \"{name}\"":
    "移动“{name}”",
  "Move collection":
    "移动分类",
  "Rename → \"{newName}\"":
    "重命名 → “{newName}”",
  "Confirm {count} Item Batch Processing":
    "确认批量处理 {count} 个条目",
  "Confirm External Search":
    "确认外部搜索",

  // react/host/zotero/components/AnnotationToolCallView.tsx
  "Delete annotation":
    "删除注释",
  "Add annotation":
    "添加注释",
  "Reject annotation":
    "拒绝注释",
  "Highlights: Error":
    "高亮：出错",
  "Highlight":
    "高亮",
  "Highlights":
    "高亮",
  "Notes: Error":
    "笔记：出错",
  "{count} Note":
    "{count} 篇笔记",
  "{count} Notes":
    "{count} 篇笔记",
  "Notes":
    "笔记",
  "Annotations: Error":
    "注释：出错",
  "Annotations":
    "注释",
  "Read-only library":
    "只读文献库",
  "Reject all":
    "全部拒绝",
  "Add annotations":
    "添加注释",

  // react/host/zotero/components/ConfirmExternalSearchPreview.tsx
  "{count} extra credit":
    "额外 {count} 点额度",
  "{count} extra credits":
    "额外 {count} 点额度",
  "Approved external literature search — {label}.":
    "已批准外部文献检索——{label}。",
  "Approved external literature search.":
    "已批准外部文献检索。",
  "Declined external literature search — {label}.":
    "已拒绝外部文献检索——{label}。",
  "Declined external literature search.":
    "已拒绝外部文献检索。",
  "Searching external sources for {label} will use {credits}.":
    "在外部来源中检索 {label} 将用掉 {credits}。",
  "This external search will use {credits}.":
    "这次外部检索将用掉 {credits}。",
  "You're only charged for successful searches.":
    "只有检索成功才会扣费。",

  // react/host/zotero/components/ConfirmExtractionPreview.tsx
  "{count} paper":
    "{count} 篇论文",
  "{count} papers":
    "{count} 篇论文",
  "Approved extraction from {count} paper — {label}.":
    "已批准从 {count} 篇论文中提取——{label}。",
  "Approved extraction from {count} papers — {label}.":
    "已批准从 {count} 篇论文中提取——{label}。",
  "Approved extraction from {count} paper.":
    "已批准从 {count} 篇论文中提取。",
  "Approved extraction from {count} papers.":
    "已批准从 {count} 篇论文中提取。",
  "Declined extraction from {count} paper — {label}.":
    "已拒绝从 {count} 篇论文中提取——{label}。",
  "Declined extraction from {count} papers — {label}.":
    "已拒绝从 {count} 篇论文中提取——{label}。",
  "Declined extraction from {count} paper.":
    "已拒绝从 {count} 篇论文中提取。",
  "Declined extraction from {count} papers.":
    "已拒绝从 {count} 篇论文中提取。",
  "Extracting {label} from {papers} will use up to {credits}.":
    "从{papers}中提取 {label} 最多将用掉 {credits}。",
  "Extracting from {papers} will use up to {credits}.":
    "从{papers}中提取最多将用掉 {credits}。",
  "You're only charged for successful extractions.":
    "只有提取成功才会扣费。",

  // react/host/zotero/components/CreateAnnotationsPreview.tsx
  "Could not create annotation because the PDF could not be processed.":
    "无法添加注释：PDF 无法处理。",
  "Could not create annotation because the target position was not found in the PDF.":
    "无法添加注释：在 PDF 中找不到目标位置。",
  "Could not create annotation because the cited section was not found in the EPUB.":
    "无法添加注释：在 EPUB 中找不到引用的章节。",
  "Could not create annotation because the cited passage was not found in the EPUB.":
    "无法添加注释：在 EPUB 中找不到引用的段落。",
  "Could not create annotation because the passage follows a math equation, which is not yet supported.":
    "无法添加注释：这段文字紧跟在数学公式之后，暂不支持。",
  "Could not create annotation because the attachment file is not available locally.":
    "无法添加注释：附件文件不在本地。",
  "Failed to create highlight.":
    "添加高亮失败。",
  "Failed to create note.":
    "添加笔记失败。",
  "Failed to create highlight":
    "添加高亮失败",
  "Failed to create note":
    "添加笔记失败",
  "Click to preview in Zotero Reader":
    "点击在 Zotero 阅读器中预览",
  "Click to view page in Zotero Reader":
    "点击在 Zotero 阅读器中查看该页",
  "highlight annotation":
    "高亮注释",
  "note annotation":
    "笔记注释",
  "{count} Tag":
    "{count} 个标签",
  "{count} Tags":
    "{count} 个标签",

  // react/host/zotero/components/CreateCollectionPreview.tsx
  "Parent Collection":
    "上级分类",
  "Added {count} item":
    "已添加 {count} 个条目",
  "Added {count} items":
    "已添加 {count} 个条目",
  "Adding {count} item":
    "正在添加 {count} 个条目",
  "Adding {count} items":
    "正在添加 {count} 个条目",

  // react/host/zotero/components/CreateItemAgentActionDisplay.tsx
  "{count} Item":
    "{count} 个条目",
  "{count} Items":
    "{count} 个条目",
  "Error importing":
    "导入出错",
  "Imported":
    "已导入",
  "Add all items":
    "添加全部条目",

  // react/host/zotero/components/CreateItemsPreview.tsx
  "this paper":
    "这篇论文",
  "Added to {location}":
    "已添加到 {location}",
  "Fetching PDF…":
    "正在获取 PDF…",
  "Reveal {paper} in Zotero":
    "在 Zotero 中显示 {paper}",
  "Don't add":
    "不添加",
  "Don't add {paper}":
    "不添加 {paper}",
  "Add {paper}":
    "添加 {paper}",
  "Add to (suggested)":
    "添加到（建议）",
  "Add to":
    "添加到",
  "Collection to add these papers to":
    "要把这些论文加入的分类",

  // react/host/zotero/components/DeleteAnnotationsPreview.tsx
  "{count} annotation skipped: {reason}":
    "已跳过 {count} 条注释：{reason}",
  "{count} annotations skipped: {reason} (+{more} more)":
    "已跳过 {count} 条注释：{reason}（另有 {more} 条）",

  // react/host/zotero/components/EditAnnotationsPreview.tsx
  "yellow":
    "黄色",
  "red":
    "红色",
  "green":
    "绿色",
  "blue":
    "蓝色",
  "purple":
    "紫色",
  "magenta":
    "品红色",
  "orange":
    "橙色",
  "gray":
    "灰色",
  "page {page}":
    "第 {page} 页",
  "a new position":
    "新位置",
  "Color →":
    "颜色 →",
  "Comment → “{comment}”":
    "评论 → “{comment}”",
  "Comment cleared":
    "已清空评论",
  "Move → {target}":
    "移动 → {target}",
  "No changes":
    "没有修改",
  "recolored":
    "已改色",
  "comment updated":
    "已更新评论",
  "tags updated":
    "已更新标签",
  "moved":
    "已移动",
  "{annotations}: {changes}":
    "{annotations}：{changes}",
  "Sticky note":
    "便笺",

  // react/host/zotero/components/EditMetadataPreview.tsx
  "(empty)":
    "（空）",
  "Creators":
    "创作者",
  "Publication":
    "出版物",
  "Date":
    "日期",
  "Access Date":
    "访问时间",
  "Volume":
    "卷次",
  "Issue":
    "期号",
  "Pages":
    "页码",
  "Series":
    "系列",
  "Series Number":
    "系列编号",
  "Series Title":
    "系列标题",
  "Journal Abbreviation":
    "刊名简称",
  "Publisher":
    "出版社",
  "Place":
    "地点",
  "Edition":
    "版次",
  "Book Title":
    "书名",
  "Proceedings Title":
    "会议论文集标题",
  "Conference Name":
    "会议名称",
  "University":
    "大学",
  "Institution":
    "机构组织",
  "Website Title":
    "网站标题",
  "Language":
    "语言",
  "Short Title":
    "短标题",
  "Archive@@zotero field":
    "档案",
  "Archive Location":
    "档案编号",
  "Library Catalog":
    "文库编目",
  "Call Number":
    "索书号",
  "Rights":
    "版权",
  "Extra":
    "其他",
  "Citation Key":
    "引用关键词",

  // react/host/zotero/components/EditNoteGroupView.tsx
  "(untitled)":
    "（无标题）",
  "Failed to undo note edit":
    "撤销笔记修改失败",
  "Rewrite Note":
    "重写笔记",
  "Note Edit":
    "笔记修改",
  "{count} Note Edits":
    "{count} 处笔记修改",
  "Reject all: {target}":
    "全部拒绝：{target}",
  "Apply all":
    "全部应用",
  "Apply all: {target}":
    "全部应用：{target}",
  "Preview":
    "预览",
  "Undo All":
    "全部撤销",
  "Retry All":
    "全部重试",
  "Apply All":
    "全部应用",

  // react/host/zotero/components/EditNoteRowView.tsx
  "Open note and jump to edit":
    "打开笔记并跳到修改处",
  "You can revert manually in the note editor.":
    "可以在笔记编辑器中手动还原。",

  // react/host/zotero/components/ManageCollectionsPreview.tsx
  "(unknown)":
    "（未知）",
  "Failed to delete collection.":
    "删除分类失败。",
  "Failed to delete collection because it contains subcollections.":
    "删除分类失败：它含有子分类。",
  "Failed to delete collection because it no longer exists.":
    "删除分类失败：它已不存在。",
  "Failed to delete collection. {reason}.":
    "删除分类失败。{reason}。",
  "Failed to move collection.":
    "移动分类失败。",
  "Failed to move collection because it contains subcollections.":
    "移动分类失败：它含有子分类。",
  "Failed to move collection because it no longer exists.":
    "移动分类失败：它已不存在。",
  "Failed to move collection. {reason}.":
    "移动分类失败。{reason}。",
  "Failed to rename collection.":
    "重命名分类失败。",
  "Failed to rename collection because it contains subcollections.":
    "重命名分类失败：它含有子分类。",
  "Failed to rename collection because it no longer exists.":
    "重命名分类失败：它已不存在。",
  "Failed to rename collection. {reason}.":
    "重命名分类失败。{reason}。",
  "Library top level":
    "文献库顶层",
  "Library:":
    "文献库：",
  "({count} item affected)":
    "（涉及 {count} 个条目）",
  "({count} items affected)":
    "（涉及 {count} 个条目）",
  "Was under:":
    "原位于：",

  // react/host/zotero/components/ManageTagsPreview.tsx
  "Failed to delete tag.":
    "删除标签失败。",
  "Failed to rename tag.":
    "重命名标签失败。",
  "Failed to delete tag because it is used on too many items.":
    "删除标签失败：使用它的条目太多。",
  "Failed to rename tag because it is used on too many items.":
    "重命名标签失败：使用它的条目太多。",
  "Failed to delete tag. {reason}.":
    "删除标签失败。{reason}。",
  "Failed to rename tag. {reason}.":
    "重命名标签失败。{reason}。",

  // react/host/zotero/components/OrganizeItemsPreview.tsx
  "{count} more item":
    "另外 {count} 个条目",
  "{count} more items":
    "另外 {count} 个条目",
  "Loading {count} item...":
    "正在载入 {count} 个条目…",
  "Loading {count} items...":
    "正在载入 {count} 个条目…",
  "Adding Tags":
    "添加标签",
  "Removing Tags":
    "移除标签",
  "Adding to Collections":
    "加入分类",
  "Removing from Collections":
    "移出分类",
  "Failed: {count} item":
    "失败：{count} 个条目",
  "Failed: {count} items":
    "失败：{count} 个条目",

  // react/host/zotero/components/reviewChangeRows.ts
  "{count} change needs your review":
    "{count} 处修改等你审阅",
  "{count} changes need your review":
    "{count} 处修改等你审阅",
  "{count} change applied":
    "已应用 {count} 处修改",
  "{count} changes applied":
    "已应用 {count} 处修改",
  "{count} change reviewed":
    "已审阅 {count} 处修改",
  "{count} changes reviewed":
    "已审阅 {count} 处修改",
  "Imported {count} item":
    "导入了 {count} 个条目",
  "Imported {count} items":
    "导入了 {count} 个条目",
  "Created {count} note":
    "新建了 {count} 篇笔记",
  "Created {count} notes":
    "新建了 {count} 篇笔记",
  "Created {count} collection":
    "新建了 {count} 个分类",
  "Created {count} collections":
    "新建了 {count} 个分类",
  "Edited {count} item":
    "修改了 {count} 个条目",
  "Edited {count} items":
    "修改了 {count} 个条目",
  "Edited {count} note":
    "修改了 {count} 篇笔记",
  "Edited {count} notes":
    "修改了 {count} 篇笔记",
  "Organized {count} item":
    "整理了 {count} 个条目",
  "Organized {count} items":
    "整理了 {count} 个条目",
  "Updated {count} tag":
    "更新了 {count} 个标签",
  "Updated {count} tags":
    "更新了 {count} 个标签",
  "Updated {count} collection":
    "更新了 {count} 个分类",
  "Updated {count} collections":
    "更新了 {count} 个分类",
  "Created {count} highlight":
    "添加了 {count} 处高亮",
  "Created {count} highlights":
    "添加了 {count} 处高亮",
  "Created {count} sticky note":
    "添加了 {count} 张便笺",
  "Created {count} sticky notes":
    "添加了 {count} 张便笺",
  "Edited {count} annotation":
    "修改了 {count} 条注释",
  "Edited {count} annotations":
    "修改了 {count} 条注释",
  "Deleted {count} annotation":
    "删除了 {count} 条注释",
  "Deleted {count} annotations":
    "删除了 {count} 条注释",
  "Reverted {count} library change":
    "还原了 {count} 处文献库修改",
  "Reverted {count} library changes":
    "还原了 {count} 处文献库修改",
  "Completed {count} library change":
    "完成了 {count} 处文献库修改",
  "Completed {count} library changes":
    "完成了 {count} 处文献库修改",

  // react/host/zotero/components/reviewChanges/ChangesCard.tsx
  "Dismiss":
    "关闭",
  "Show all ({count})":
    "显示全部（{count}）",

  // react/host/zotero/components/reviewChanges/ReviewActionRow.tsx
  "Show in library":
    "在文献库中显示",
  "Delete {target}":
    "删除{target}",
  "Undo {target}":
    "撤销{target}",

  // react/host/zotero/itemData.ts
  "Unknown":
    "未知",

  // react/host/zotero/sourceActions.ts
  "File Not Available":
    "文件不可用",
  "This file is not available on this computer. It was removed or attached on another device.":
    "这个文件不在这台电脑上。它已被移除，或是在另一台设备上附加的。",
  "Item Not Available":
    "条目不可用",
  "This item is no longer in your Zotero library. It may have been deleted.":
    "这个条目已不在你的 Zotero 文献库中，可能已被删除。",
  "Collection Not Available":
    "分类不可用",
  "This collection is no longer in your Zotero library. It may have been deleted.":
    "这个分类已不在你的 Zotero 文献库中，可能已被删除。",
  "Annotation Not Available":
    "注释不可用",
  "This annotation is no longer in your Zotero library. It may have been deleted.":
    "这条注释已不在你的 Zotero 文献库中，可能已被删除。",
  "Action Not Found":
    "找不到快捷操作",
  "This action is not available on this computer. It may have been deleted or created on another device.":
    "这个快捷操作在这台电脑上不可用，可能已被删除，或是在另一台设备上创建的。",
  "This item is in a library that isn't available on this computer. It may be a group library you haven't joined on this device.":
    "这个条目所在的文献库在这台电脑上不可用，可能是你在这台设备上尚未加入的群组文献库。",
  "This collection is in a library that isn't available on this computer. It may be a group library you haven't joined on this device.":
    "这个分类所在的文献库在这台电脑上不可用，可能是你在这台设备上尚未加入的群组文献库。",
  "This annotation is in a library that isn't available on this computer. It may be a group library you haven't joined on this device.":
    "这条注释所在的文献库在这台电脑上不可用，可能是你在这台设备上尚未加入的群组文献库。",

  // react/types/actionShare.ts
  "The action data is missing or malformed.":
    "快捷操作的数据缺失或格式有误。",
  "The action is missing a title.":
    "快捷操作缺少标题。",
  "The action is missing a prompt.":
    "快捷操作缺少提示词。",
  "The action does not target anything AlphainZ recognizes.":
    "快捷操作针对的对象 AlphainZ 无法识别。",
  "The action has a malformed category.":
    "快捷操作的类别格式有误。",
  "The action has a malformed client list.":
    "快捷操作的客户端列表格式有误。",
  "This action is not compatible with the {client} client.":
    "这个快捷操作与 {client} 客户端不兼容。",
  "The action has malformed fields.":
    "快捷操作的字段格式有误。",
  "The action's slash command cannot contain whitespace.":
    "快捷操作的斜杠命令不能包含空格。",
  "This file is not valid JSON.":
    "这个文件不是有效的 JSON。",
  "This file does not contain an action file.":
    "这个文件中没有快捷操作。",
  "This file is not an action file.":
    "这个文件不是快捷操作文件。",
  "This action file has no valid version.":
    "这个快捷操作文件没有有效的版本号。",
  "This action was exported by a newer version of AlphainZ. Update AlphainZ to import it.":
    "这个快捷操作是用较新版本的 AlphainZ 导出的。请更新 AlphainZ 后再导入。",
  "This action file version ({version}) is not supported.":
    "不支持这个快捷操作文件的版本（{version}）。",

  // react/types/archivedActions.ts
  "Highlight key findings":
    "高亮关键发现",
  "How does this fit into my library?":
    "这篇论文在我的文献库中处于什么位置？",
  "Check and strengthen citations":
    "检查并加强引用",
  "Review and give feedback on this note":
    "审阅这篇笔记并给出反馈",
  "Optional: what kind of feedback you want":
    "可选：你想要哪种反馈",
  "Edit this note for clarity and structure":
    "修改这篇笔记，让它更清晰、更有条理",
  "Optional: editing focus, e.g. tighten, restructure, or fix flow":
    "可选：修改重点，例如精简、调整结构或理顺行文",
  "Summarize this collection":
    "总结这个分类",
  "Tag all items in this collection":
    "给这个分类中的所有条目打标签",
  "Fix metadata for my recent additions":
    "修正我最近添加条目的元数据",

  // react/types/builtinActions.ts
  "Summarize":
    "总结",
  "Write a Zotero note summarizing each item so you can recall it at a glance.":
    "为每个条目写一篇 Zotero 总结笔记，方便一眼回想起来。",
  "Optional: what to focus on, e.g. methods or findings":
    "可选：侧重点，例如方法或发现",
  "Position this paper against the rest of your library. What it supports, challenges, and extends.":
    "把这篇论文放到你的文献库中对照：它支持、挑战和拓展了什么。",
  "Optional: what to compare, e.g. argument, method, or findings":
    "可选：比较什么，例如论点、方法或发现",
  "Find similar papers":
    "查找相似论文",
  "Search for research outside of your library to find closely related work.":
    "在文献库之外检索，找出密切相关的研究。",
  "Optional: similar how, e.g. method, data, or theory":
    "可选：哪方面相似，例如方法、数据或理论",
  "Auto-tag":
    "自动打标签",
  "Assign consistent Zotero tags to the selected items, reusing your existing tags.":
    "为选中的条目添加统一的 Zotero 标签，尽量沿用你已有的标签。",
  "Sort into collections":
    "归入分类",
  "File the selected items into the collections where they best belong.":
    "把选中的条目归入最合适的分类。",
  "Skim this paper":
    "速读这篇论文",
  "Add highlight annotations to key passages so you can grasp the paper in a few minutes.":
    "给关键段落加上高亮注释，让你几分钟内就能把握这篇论文。",
  "Optional: what to focus on while skimming":
    "可选：速读时的侧重点",
  "Color-code this paper":
    "给这篇论文分色标注",
  "Add color-coded highlights for question, methods, results, and limitations.":
    "用不同颜色高亮研究问题、方法、结果和局限。",
  "Optional: your own color scheme or focus":
    "可选：你自己的配色方案或侧重点",
  "Find key references from this paper":
    "找出这篇论文的关键参考文献",
  "Identify key references in this paper, and whether you already have them.":
    "找出这篇论文中的关键参考文献，并看看你是否已经收录。",
  "What am I missing in this collection?":
    "这个分类里还缺什么？",
  "Analyze this collection and suggest papers that fill its most important gaps.":
    "分析这个分类，推荐能补上最重要空缺的论文。",
  "Optional: what kind of gaps to look for":
    "可选：要找哪类空缺",
  "Literature review outline":
    "文献综述大纲",
  "Draft a thematic literature-review outline from the papers in this collection.":
    "根据这个分类中的论文，按主题起草文献综述大纲。",
  "Optional: what the review is for, e.g. a paper intro or dissertation chapter":
    "可选：综述的用途，例如论文引言或学位论文的一章",
  "Organize into thematic sub-collections":
    "按主题整理成子分类",
  "Propose and create thematic sub-collections for the items in this collection.":
    "为这个分类中的条目提出并创建按主题划分的子分类。",
  "Optional: how to organize, e.g. by theme, method, or time period":
    "可选：怎样整理，例如按主题、方法或时期",
  "Start a research project":
    "开始一个研究项目",
  "Create a new Zotero collection and populate it from your library and external search.":
    "新建一个 Zotero 分类，并从你的文献库和外部检索中填充文献。",
  "Name the project or research topic":
    "写下项目或研究主题",
  "Find notable recent or influential papers in your area that are not yet in your library.":
    "找出你所在领域中尚未收录的重要新论文或有影响力的论文。",
  "Name a topic or research question":
    "写下一个主题或研究问题",
  "Create targeted highlight annotations across a document or your whole library.":
    "在一篇文档或整个文献库中添加有针对性的高亮注释。",
  "What should I highlight? E.g. \"the methods\" or \"every mention of selection bias\"":
    "要高亮什么？例如“研究方法”或“所有提到选择偏差的地方”",
  "Create a Zotero note":
    "写一篇 Zotero 笔记",
  "Write a Zotero note on a topic, synthesized and cited from your library.":
    "就某个主题写一篇 Zotero 笔记，综合你文献库中的内容并附引用。",
  "What should the note be about?":
    "笔记要写什么？",
  "Tidy up my library":
    "整理我的文献库",
  "Find what needs organizing (unfiled items, tags, or metadata) then clean it up.":
    "找出需要整理的地方（未分类条目、标签或元数据），然后整理好。",
  "Optional: what to focus on (e.g. filing, tags, or metadata)":
    "可选：侧重点（例如归类、标签或元数据）",
  "Quick answer":
    "快速回答",
  "Answer a quick question directly, with no tools or library search.":
    "直接回答一个简单问题，不调用工具，也不搜索文献库。",
  "Quick question, no detailed research":
    "简单问题，无需深入研究",

  // react/types/firstRunFollowups.ts
  "Save the top results to a new collection":
    "把排在前面的结果存入新分类",
  "Create a summary note with key findings":
    "写一篇总结主要发现的笔记",
  "Find related papers in my library":
    "在我的文献库中查找相关论文",
  "Find related papers online":
    "在网上查找相关论文",
  "Compare these to research in my library":
    "和我文献库中的研究做比较",
  "Skim this paper with highlights":
    "用高亮速读这篇论文",
  "Save this summary as a note":
    "把这份总结保存为笔记",
  "Find new research on this topic":
    "查找这个主题的新研究",
  "Find new research on {topic}":
    "查找关于{topic}的新研究",
  "Organize items on this topic into a collection":
    "把这个主题的条目整理到一个分类中",
  "Organize papers on {topic} into a collection":
    "把关于{topic}的论文整理到一个分类中",
  "Looks good, apply the plan":
    "看起来不错，执行这个方案",
  "Write an overview note for this project":
    "为这个项目写一篇概述笔记",
  "Organize into sub-collections":
    "整理成子分类",
  "Find more recent research on this topic":
    "查找这个主题的更多新研究",
  "Find more recent research on {topic}":
    "查找关于{topic}的更多新研究",
  "Summarize this paper in a note":
    "用一篇笔记总结这篇论文",
  "Continue with the next batch":
    "继续下一批",
  "Design a consistent tag vocabulary":
    "设计一套统一的标签体系",

  // react/utils/actionShareFile.ts
  "Save Action":
    "保存快捷操作",
  "AlphainZ action":
    "AlphainZ 快捷操作",
  "Import Action":
    "导入快捷操作",
  "Could not read the action file.":
    "无法读取快捷操作文件。",

  // react/utils/actionVisibility.ts
  "{count} selected notes":
    "已选中 {count} 篇笔记",
  "Anywhere":
    "任何地方",
  "{count} attached items and attachments":
    "已附上 {count} 个条目和附件",
  "{count} selected attachments":
    "已选中 {count} 个附件",
  "{count} attached attachments":
    "已附上 {count} 个附件",
  "{count} attached notes":
    "已附上 {count} 篇笔记",
  "{count} selected items":
    "已选中 {count} 个条目",
  "{count} attached items":
    "已附上 {count} 个条目",
  "+{count} more":
    "另有 {count} 个",
  ", ":
    "、",
  "{names} (attached)":
    "{names}（已附上）",
  "{count} collections selected":
    "已选中 {count} 个分类",

  // react/utils/addItemActions.ts
  "Full Text PDF":
    "全文 PDF",
  "Finding PDF...":
    "正在查找 PDF…",
  "Re-checking PDF...":
    "正在重新检查 PDF…",

  // react/utils/annotationDisplay.ts
  "Underline":
    "下划线",
  "Area":
    "区域",
  "Highlighted Text":
    "高亮文本",
  "Underlined Text":
    "下划线文本",
  "Selected Area":
    "选中区域",

  // react/utils/attachmentReadabilityCopy.ts
  "web snapshots":
    "网页快照",
  "web links":
    "网页链接",
  "Word documents":
    "Word 文档",
  "spreadsheets":
    "电子表格",
  "presentations":
    "演示文稿",
  "audio files":
    "音频文件",
  "videos":
    "视频",
  "archives":
    "压缩包",
  "Web link":
    "网页链接",
  "Spreadsheet":
    "电子表格",
  "Presentation":
    "演示文稿",
  "Audio":
    "音频",
  "Video":
    "视频",
  "Archive@@attachment kind":
    "压缩包",
  "AlphainZ doesn't support {kinds}":
    "AlphainZ 不支持{kinds}",
  "Some attachments are not supported":
    "部分附件不受支持",
  "{kinds} attachments are not supported":
    "不支持{kinds}附件",
  "Scanned PDF — needs a vision model":
    "扫描版 PDF——需要视觉模型",
  "PDF is password-protected":
    "PDF 有密码保护",
  "PDF couldn't be read":
    "PDF 无法读取",
  "File is too large to read":
    "文件太大，无法读取",
  "File isn't downloaded":
    "文件尚未下载",
  "EPUB couldn't be read":
    "EPUB 无法读取",
  "PDF is too long ({count} pages)":
    "PDF 太长（{count} 页）",
  "Image needs a vision model":
    "图片需要视觉模型",
  "Couldn't be read":
    "无法读取",
  "text":
    "文本",
  "image":
    "图片",
  "snapshot":
    "网页快照",
  "web link":
    "网页链接",
  "spreadsheet":
    "电子表格",
  "presentation":
    "演示文稿",
  "audio":
    "音频",
  "video":
    "视频",
  "archive":
    "压缩包",
  "scanned PDF":
    "扫描版 PDF",
  "password-protected PDF":
    "有密码保护的 PDF",
  "Some {kind} attachments can't be read":
    "部分{kind}附件无法读取",
  "Some attachments can't be read":
    "部分附件无法读取",
  "AlphainZ can't read {kind} attachments":
    "AlphainZ 无法读取{kind}附件",
  "AlphainZ can't read the attachments":
    "AlphainZ 无法读取这些附件",

  // react/utils/conversationTurns.ts
  "Failed: {reason}":
    "失败：{reason}",
  "Continued answer":
    "续写的回答",
  "Untitled question":
    "无标题的问题",
  "({count} library change)":
    "（{count} 处文献库修改）",
  "({count} library changes)":
    "（{count} 处文献库修改）",
  "Answering…":
    "正在回答…",
  "Waiting for your approval…":
    "等待你批准…",
  "Cut off before it answered.":
    "回答前被中断。",
  "Stopped before it answered.":
    "回答前被停止。",
  "No written answer.":
    "没有文字回答。",

  // react/utils/createItemActions.ts
  "Saving to Zotero…":
    "正在保存到 Zotero…",

  // react/utils/dateUtils.ts
  "Today at {time}":
    "今天 {time}",
  "Yesterday at {time}":
    "昨天 {time}",
  "{weekday} at {time}":
    "{weekday} {time}",
  "Today":
    "今天",
  "Yesterday":
    "昨天",
  "This Week":
    "本周",
  "This Month":
    "本月",
  "Older":
    "更早",

  // react/utils/noteEditorDiffPreview.ts
  "Close preview":
    "关闭预览",
  "Preview: Replacing the Entire Note":
    "预览：替换整篇笔记",
  "Preview of Note Edits":
    "笔记修改预览",

  // react/utils/ollama.ts
  "EmbeddingGemma 2, Google’s open embedding model: indexes your library for topic search, in Chinese, English and a hundred other languages. Needs Ollama 0.40 or later.":
    "EmbeddingGemma 2，Google 的开源嵌入模型：为你的文献库建立主题搜索索引，支持中文、英文等上百种语言。需要 Ollama 0.40 或更高版本。",
  "A chat model that supports tool calling; good in Chinese. Needs about 8 GB of memory.":
    "支持工具调用的对话模型，中文表现好。大约需要 8 GB 内存。",
  "The download stopped before it finished.":
    "下载在完成前中断了。",
  "Starting…":
    "正在开始…",
  "Download cancelled. What was already downloaded is kept; Resume picks up from there.":
    "下载已取消。已下载的部分会保留，“继续下载”会从那里接着下。",
  "Download interrupted ({reason}). Resume picks up where it stopped.":
    "下载中断（{reason}）。“继续下载”会从中断处接着下。",

  // react/utils/planTransitionMessage.ts
  "View File Status":
    "查看文件状态",
  "Your files are already fully indexed and ready to search.":
    "你的文件已全部建立索引，可以搜索了。",
  "There are no files to process for full-text search. You can add files to your library to start indexing.":
    "没有需要处理的全文搜索文件。往文献库添加文件即可开始索引。",

  // react/utils/popupMessageUtils.ts
  "Failed to upload file(s). Please retry manually.":
    "文件上传失败，请手动重试。",
  "This library is excluded from AlphainZ. You can change excluded libraries in AlphainZ Settings.":
    "这个文献库已从 AlphainZ 排除。可以在 AlphainZ 设置中修改排除的文献库。",
  "The library {name} is excluded from AlphainZ. You can change excluded libraries in AlphainZ Settings.":
    "文献库 {name} 已从 AlphainZ 排除。可以在 AlphainZ 设置中修改排除的文献库。",
  "The libraries {names} are excluded from AlphainZ. You can change excluded libraries in AlphainZ Settings.":
    "文献库 {names} 已从 AlphainZ 排除。可以在 AlphainZ 设置中修改排除的文献库。",
  "{count} item has unsupported attachments":
    "{count} 个条目含有不支持的附件",
  "{count} items have unsupported attachments":
    "{count} 个条目含有不支持的附件",
  "{count} item has attachment issues":
    "{count} 个条目的附件有问题",
  "{count} items have attachment issues":
    "{count} 个条目的附件有问题",

  // react/utils/promptVariables.ts
  "No recently added items found in your library.":
    "你的文献库中没有最近添加的条目。",
  "No recently added item found in your library.":
    "你的文献库中没有最近添加的条目。",
  "No items are selected in the library view.":
    "文献库视图中没有选中任何条目。",
  "No attachment is open in the reader.":
    "阅读器中没有打开附件。",
  "No note is open in a tab.":
    "没有在标签页中打开笔记。",
  "No active item found. Try opening a PDF or selecting an item.":
    "找不到当前条目。试试打开一个 PDF 或选中一个条目。",

  // react/utils/screenReaderAnnouncements.ts
  "Response complete.":
    "回答完成。",
  "Response complete. AlphainZ wrote about {count} words. Navigate to the latest message to read it.":
    "回答完成。AlphainZ 写了大约 {count} 个词。请移到最新的消息阅读。",
  "AlphainZ response: {text}":
    "AlphainZ 的回答：{text}",
  "Unknown error.":
    "未知错误。",
  "AlphainZ response failed: {message} Press Tab or Enter to move to error actions, or Escape to message AlphainZ.":
    "AlphainZ 回答失败：{message} 按 Tab 或回车转到错误操作，按 Esc 给 AlphainZ 发消息。",
  "Response canceled.":
    "回答已取消。",

  // react/utils/selectionChatComment.ts
  "That highlight no longer exists.":
    "那条高亮已不存在。",
  "Zotero does not let you change that highlight, so the answer could not be added to its comment.":
    "Zotero 不允许修改那条高亮，所以无法把回答加到它的评论里。",
  "That highlight is in a library excluded from AlphainZ, so AlphainZ does not change it.":
    "那条高亮所在的文献库已从 AlphainZ 排除，所以 AlphainZ 不会修改它。",
  "Zotero could not save the comment: {detail}":
    "Zotero 无法保存评论：{detail}",
  "Zotero could not save the comment.":
    "Zotero 无法保存评论。",

  // react/utils/sourceUtils.ts
  "User ID not found. Make sure you are logged in.":
    "找不到用户 ID，请确认已登录。",
  "Library not found":
    "找不到文献库",
  "The library \"{name}\" is excluded from AlphainZ. You can update this setting in AlphainZ Settings.":
    "文献库“{name}”已从 AlphainZ 排除。可以在 AlphainZ 设置中修改。",
  "This library is excluded from AlphainZ. You can update this setting in AlphainZ Settings.":
    "这个文献库已从 AlphainZ 排除。可以在 AlphainZ 设置中修改。",
  "File not available to use in AlphainZ":
    "文件无法在 AlphainZ 中使用",
  "AlphainZ only supports PDF, EPUB, and plain-text attachments":
    "AlphainZ 只支持 PDF、EPUB 和纯文本附件",
  "File unavailable locally and on server":
    "文件在本地和服务器上都不可用",
  "Attachment not available to use in AlphainZ":
    "附件无法在 AlphainZ 中使用",
  "Invalid annotation type":
    "无效的注释类型",
  "Annotation is empty":
    "注释为空",
  "Parent item is not an attachment":
    "上级条目不是附件",
  "Parent item is not available to use in AlphainZ":
    "上级条目无法在 AlphainZ 中使用",
  "Parent file does not exist":
    "上级文件不存在",
  "Note is in trash":
    "笔记在回收站中",
  "Invalid item type":
    "无效的条目类型",

  // react/utils/syncModeSwitch.ts
  "every conversation file":
    "所有对话文件",
  "{count} conversation file":
    "{count} 个对话文件",
  "{count} conversation files":
    "{count} 个对话文件",
  "This permanently deletes {what} and the settings file from the sync folder. Your cloud service then removes them from your other computers' copies of the folder too, and a chat archived on another computer that this one never opened exists only there. Conversations on this computer are kept.":
    "这会从同步文件夹中永久删除{what}和设置文件。随后你的云服务也会从其他电脑上的该文件夹副本中删除它们，而在另一台电脑上归档、这台电脑从未打开过的对话，就只存在于那里。这台电脑上的对话会保留。",
  "This moves {what} and the settings file under \"{title}\" to Zotero's trash — on your other computers too, once Zotero syncs. Conversations on this computer are kept.":
    "这会把“{title}”下的{what}和设置文件移到 Zotero 的回收站——Zotero 同步后，你的其他电脑上也一样。这台电脑上的对话会保留。",
  "Delete the synced copies?":
    "删除同步的副本？",
  "the \"{title}\" item in My Library":
    "“我的文库”中名为“{title}”的条目",
  "the sync folder":
    "同步文件夹",
  "Switch sync mode?":
    "切换同步方式？",
  "There are conversation copies stored in {where}.":
    "{where}中存有对话副本。",
  "Keep them there, or delete them? Conversations on this computer are kept either way.":
    "保留在那里，还是删除？无论哪种，这台电脑上的对话都会保留。",
  "Conflict copies (like \"… 2.json\") are always left for you to review.":
    "冲突副本（如“… 2.json”）总会留给你查看。",
  "Keep the copies":
    "保留副本",
  "Delete them…":
    "删除它们…",

  // react/utils/workerUnavailableNotice.ts
  "AlphainZ's PDF engine didn't start":
    "AlphainZ 的 PDF 引擎没有启动",
  "An internal AlphainZ process failed. As a result, AlphainZ cannot read your PDF files. Please restart Zotero. If the problem continues after restarting, Zotero's debug output (Help → Debug Output Logging) will show why.":
    "AlphainZ 的一个内部进程出错，因此无法读取你的 PDF 文件。请重启 Zotero。如果重启后问题依旧，Zotero 的调试输出（帮助 → 调试输出日志）会显示原因。",

  // src/modules/readerIntegration.ts
  "Ask about this…":
    "问问这段…",
  "Ask AlphainZ about the selected text":
    "就选中的文字问 AlphainZ",
  "Opening AlphainZ…":
    "正在打开 AlphainZ…",
  "Sending to AlphainZ…":
    "正在发送给 AlphainZ…",
  "Ask a follow-up…":
    "继续追问…",
  "An answer is still being written; your question is waiting in the AlphainZ message box.":
    "上一个回答还在写；你的问题已放在 AlphainZ 的输入框里等待。",
  "Sent to AlphainZ →":
    "已发送给 AlphainZ →",
  "AlphainZ is not ready yet. Try again in a moment.":
    "AlphainZ 还没准备好，请稍后再试。",
  "AlphainZ did not pick this up. Try again.":
    "AlphainZ 没有接收到，请重试。",
  "Explain with AlphainZ":
    "用 AlphainZ 解释",
  "Ask AlphainZ...":
    "问 AlphainZ…",
  "Chat about this highlight":
    "就这条高亮对话",

  // src/modules/zoteroContextMenu.ts
  "AlphainZ Actions":
    "AlphainZ 快捷操作",
  "Add custom action…":
    "添加自定义快捷操作…",

  // src/services/conversationSync/settingsSync.ts
  "custom instructions":
    "自定义指令",
  "prompts":
    "提示词",
  "permissions":
    "权限",
  "the model":
    "模型",
  "the search index":
    "搜索索引",
  "the theme":
    "主题",
  "the language":
    "界面语言",
  "citations":
    "引用",
  "limits per question":
    "每个问题的限制",
  "other preferences":
    "其他偏好设置",
  "preferences":
    "偏好设置",

  // src/services/conversationSync/syncHealth.ts
  "A conversation could not be written to the sync location":
    "有一个对话没能写入同步位置",
  "The sync folder is not there: it may have been moved or renamed, or be on a drive that is not connected. Choose it again in Settings → Advanced → Conversation Sync.":
    "找不到同步文件夹：它可能被移动或重命名了，或者在没有连接的磁盘上。请在 设置 → 高级 → 对话同步 中重新选择。",
  "Zotero is not syncing attachment files, so conversations cannot reach your other computers. Turn on file syncing in Zotero's Settings → Sync.":
    "Zotero 没有同步附件文件，所以对话无法同步到你的其他电脑。请在 Zotero 的 设置 → 同步 中打开文件同步。",
  "Zotero has synced since these conversation files were written but has not uploaded them — its file storage may be full. Check Zotero's Settings → Sync.":
    "这些对话文件写入后 Zotero 已经同步过，但没有上传它们——它的文件存储空间可能已满。请检查 Zotero 的 设置 → 同步。",
  "These conversations have arrived, but their files have not downloaded yet. AlphainZ asks Zotero for them on every pass; they appear once the download finishes.":
    "这些对话已经同步过来，但文件还没有下载完。AlphainZ 每一轮都会向 Zotero 请求它们，下载完成后就会出现。",
  "Your cloud service has not downloaded these conversation files to this computer yet. They are imported once they are here.":
    "你的云服务还没有把这些对话文件下载到这台电脑。下载到之后就会导入。",
  "Your cloud service left conflict copies (like \"… 2.json\") in the sync folder. They are not imported; open the folder to compare them and delete the ones you do not need.":
    "你的云服务在同步文件夹里留下了冲突副本（如“… 2.json”）。它们不会被导入；请打开文件夹比较一下，删掉不需要的。",
  "Some conversation files could not be read — damaged, or written by a newer version of AlphainZ. They are left untouched.":
    "有些对话文件无法读取——已损坏，或是由更新版本的 AlphainZ 写入的。它们会原样保留。",
  "sync folder not found":
    "找不到同步文件夹",
  "Zotero is not syncing files":
    "Zotero 没有同步文件",
  "last change not saved to the sync location":
    "最近的改动没有保存到同步位置",
  "{count} not uploaded by Zotero":
    "{count} 个未被 Zotero 上传",
  "{count} waiting to download":
    "{count} 个等待下载",
  "{count} conflict copy ignored":
    "已忽略 {count} 个冲突副本",
  "{count} conflict copies ignored":
    "已忽略 {count} 个冲突副本",
  "{count} unreadable":
    "{count} 个无法读取",

  // packages/agent-llm/src/embeddingHealth.ts
  "The embedding provider":
    "嵌入服务",
  "{who} failed: {text}.":
    "{who} 出错：{text}。",
  "{who} has used up today’s embedding allowance (on a free Google key, about 1000 texts a day).":
    "{who} 今天的嵌入额度已用完（免费的 Google key 每天约 1000 段文本）。",
  "It resets at midnight Pacific time ({time} here).":
    "额度在太平洋时间午夜重置（本地时间 {time}）。",
  "It resets at midnight Pacific time.":
    "额度在太平洋时间午夜重置。",
  "{who} does not accept the API key. Check it under Settings → Model.":
    "{who} 不接受这个 API key。请在 设置 → 模型 中检查。",
  "{who} rejected the API key ({status}). Check it under Settings → Model.":
    "{who} 拒绝了 API key（{status}）。请在 设置 → 模型 中检查。",
  "{who} reports that the account's quota or balance is used up.":
    "{who} 表示账户的额度或余额已用完。",
  "{who} is limiting requests right now (429); it should work again in a minute.":
    "{who} 目前正在限制请求（429），大约一分钟后应该就能恢复。",
  "{who} does not offer the embedding model (404).":
    "{who} 没有提供这个嵌入模型（404）。",
  "{who} could not be reached. Check the network, or that the server is running.":
    "无法连接 {who}。请检查网络，或确认服务器在运行。",
  "{who} did not answer in time.":
    "{who} 没有及时响应。",
  "{who} had a server problem ({status}).":
    "{who} 的服务器出了问题（{status}）。",
  "{who} failed ({status}): {text}.":
    "{who} 出错（{status}）：{text}。",
  "{who} failed ({status}).":
    "{who} 出错（{status}）。",
  "{who} failed.":
    "{who} 出错。",

  // packages/agent-llm/src/fulltextIndexer.ts
  "Figure indexing paused: {details}":
    "图片索引已暂停：{details}",
  "Indexing paused: {details}":
    "索引已暂停：{details}",
  "It picks up where it stopped on the next pass.":
    "下一轮会从中断处继续。",
  "{reason}.":
    "{reason}。",
  "{label} embeddings":
    "{label} 嵌入服务",
  "{who} has used today’s allowance.":
    "{who} 今天的额度已用完。",
  "It continues by itself after midnight Pacific time ({time} here).":
    "太平洋时间午夜后会自动继续（本地时间 {time}）。",
  "It continues by itself after midnight Pacific time.":
    "太平洋时间午夜后会自动继续。",
  "{who} rejected the API key ({status}). Check the key under Settings → Model → Providers; indexing resumes once it works.":
    "{who} 拒绝了 API key（{status}）。请在 设置 → 模型 → 服务商 中检查 key；恢复正常后会继续索引。",
  "{who} reports the quota or balance is used up.":
    "{who} 表示额度或余额已用完。",
  "{who} is limiting requests (429).":
    "{who} 正在限制请求（429）。",
  "{who} does not offer the embedding model (404). Check the provider's address under Settings → Model → Providers.":
    "{who} 没有提供这个嵌入模型（404）。请在 设置 → 模型 → 服务商 中检查服务商的地址。",
  "{who} could not be reached.":
    "无法连接 {who}。",
  "{who} had a server error ({status}).":
    "{who} 的服务器出错（{status}）。",

  // packages/agent-llm/src/localRunner.ts
  "Settings → Model → Providers":
    "设置 → 模型 → 服务商",
  "Run cancelled.":
    "回答已取消。",
  "The run failed.":
    "回答失败。",
  "The model provider":
    "模型服务商",
  "Could not reach {who}. Check your internet connection, or the address if this is a server you run yourself.":
    "无法连接 {who}。请检查网络连接；如果是你自己运行的服务器，请检查地址。",
  "{who} stopped responding. Try again in a moment.":
    "{who} 停止响应了，请稍后再试。",
  "The connection to {who} broke off mid-reply. Try again.":
    "与 {who} 的连接在回答中途断开了，请重试。",
  "{who} rejected the API key (401). Check the key on its card under {settings}.":
    "{who} 拒绝了 API key（401）。请在 {settings} 中检查它卡片上的 key。",
  "{who} is not available in your region (403). Choose another provider under Settings → Model.":
    "{who} 在你所在的地区不可用（403）。请在 设置 → 模型 中换一个服务商。",
  "{who} refused the request (403). The key may not have access to this model — check it on its card under {settings}.":
    "{who} 拒绝了请求（403）。这个 key 可能没有使用该模型的权限——请在 {settings} 中检查它的卡片。",
  "{who} says the account is out of credit (402). Top it up with the provider, or choose another model under Settings → Model.":
    "{who} 表示账户余额不足（402）。请到服务商那里充值，或在 设置 → 模型 中换一个模型。",
  "{who} says the quota or balance is used up{tag}. Top it up or wait for it to reset, or choose another model under Settings → Model.":
    "{who} 表示额度或余额已用完{tag}。请充值或等待额度重置，或在 设置 → 模型 中换一个模型。",
  "{who} is limiting how fast requests can be sent (429). Wait a moment, then retry.":
    "{who} 正在限制请求的发送速度（429）。请稍等片刻再重试。",
  "{who} could not find the model or the endpoint{tag}. Check the model name, and the address if you set one, under {settings}.":
    "{who} 找不到这个模型或端点{tag}。请在 {settings} 中检查模型名称，以及你设置的地址。",
  "This conversation is too long for the model{tag}. Start a new chat, or ask about fewer papers at once.":
    "这个对话对模型来说太长了{tag}。请开始新对话，或一次少问几篇论文。",
  "{who} took too long to answer{tag}. Try again in a moment.":
    "{who} 回答超时{tag}。请稍后再试。",
  "{who} had a server problem{tag}. Try again in a moment.":
    "{who} 的服务器出了问题{tag}。请稍后再试。",
  "{who} rejected the request{tag}.":
    "{who} 拒绝了请求{tag}。",
  "{who} could not finish the reply. Try again in a moment.":
    "{who} 没能写完回答。请稍后再试。",
  "{who} returned an error instead of a reply.":
    "{who} 返回了错误，而不是回答。",
  "Topic search could not run: {reason} Keyword and metadata search still work, so the answer may miss papers that use other words.":
    "主题搜索无法运行：{reason} 关键词和元数据搜索仍然可用，所以回答可能漏掉用词不同的论文。",
  "{message} (Tried {count} times.)":
    "{message}（已尝试 {count} 次。）",
  "Stopped after {count} steps, the limit set under \"Model requests per question\" in Settings → Advanced. Ask it to continue, raise the limit, or ask a narrower question.":
    "执行 {count} 步后停止，这是 设置 → 高级 中“每个问题的模型请求数”的上限。可以让它继续、提高上限，或问一个范围更小的问题。",
  "{tokens}-token":
    "{tokens} token 的",
  "per-reply":
    "单次回答的",
  "The reply reached the {cap} output limit while writing a {tool} call, so none of the {count} tool calls in that step ran. Raise \"Output tokens per reply\" in Settings → Advanced, or ask for less in one go.":
    "回答在写 {tool} 调用时达到了{cap}输出上限，所以这一步的 {count} 个工具调用都没有执行。请在 设置 → 高级 中调高“单次回答的输出 token 上限”，或一次少要求一些。",
  "The reply reached the {cap} output limit while writing a {tool} call, so that call did not run. Raise \"Output tokens per reply\" in Settings → Advanced, or ask for less in one go.":
    "回答在写 {tool} 调用时达到了{cap}输出上限，所以这个调用没有执行。请在 设置 → 高级 中调高“单次回答的输出 token 上限”，或一次少要求一些。",
  "The answer was cut off at the {cap} output limit. Ask it to continue, or raise \"Output tokens per reply\" in Settings → Advanced.":
    "回答在{cap}输出上限处被截断。可以让它继续，或在 设置 → 高级 中调高“单次回答的输出 token 上限”。",
  "The model spent its whole {cap} output budget thinking, before it could answer or use a tool. Raise \"Output tokens per reply\" in Settings → Advanced, or lower the thinking effort.":
    "模型把{cap}输出额度全部用在了思考上，还没来得及回答或使用工具。请在 设置 → 高级 中调高“单次回答的输出 token 上限”，或调低思考档位。",
  "The model ended its turn without writing a reply. Ask again, or try another model.":
    "模型结束了这一轮，却没有写出回答。请再问一次，或换一个模型。",
  "The provider's content filter stopped this response.":
    "服务商的内容过滤器拦下了这个回答。",
  "The connection closed before the model finished, so this answer may be incomplete. Ask it to continue, or retry.":
    "模型还没写完连接就断开了，所以这个回答可能不完整。可以让它继续，或重试。",

  // packages/agent-llm/src/thinkingTiers.ts
  "Low":
    "低",
  "High":
    "高",
  "Max":
    "最高",

  // packages/agent-llm/src/verifyKey.ts
  "{provider} said: “{detail}”":
    "{provider} 说：“{detail}”",
  "Could not reach {provider}. Check the network, or the base URL if this is a local server.":
    "无法连接 {provider}。请检查网络；如果是本地服务器，请检查基础 URL。",
  "No answer from {provider} in time. Check the network and the base URL; a local server may still be loading the model.":
    "{provider} 没有及时响应。请检查网络和基础 URL；本地服务器可能还在载入模型。",
  "The connection to {provider} broke off. Try again.":
    "与 {provider} 的连接断开了，请重试。",
  "The key was rejected. Check that you copied all of it, with no stray spaces.":
    "key 被拒绝了。请检查是否完整复制，没有多余的空格。",
  "{provider} is not available in your region.":
    "{provider} 在你所在的地区不可用。",
  "The endpoint refused the key (403): it may not have access to this model.":
    "端点拒绝了这个 key（403）：它可能没有使用该模型的权限。",
  "The key works, but the account is out of credit or quota.":
    "key 可用，但账户的余额或额度已用完。",
  "The key works, but it is rate limited right now. Try again in a moment.":
    "key 可用，但目前被限速。请稍后再试。",
  "The endpoint or model was not found. Check the model name, and the base URL if you set one.":
    "找不到端点或模型。请检查模型名称，以及你设置的基础 URL。",
  "{provider} had a server problem ({status}). Try again in a moment.":
    "{provider} 的服务器出了问题（{status}）。请稍后再试。",
  "The endpoint rejected the request ({status}).":
    "端点拒绝了请求（{status}）。",
  "The endpoint rejected the request: {detail}":
    "端点拒绝了请求：{detail}",
  "No answer from {provider} within {seconds} s. Check the network and the base URL; a server on this computer may still be loading the model.":
    "{provider} 在 {seconds} 秒内没有响应。请检查网络和基础 URL；这台电脑上的服务器可能还在载入模型。",
  "Enter a key first.":
    "请先输入 key。",
  "Enter the base URL first.":
    "请先输入基础 URL。",
  "Add a model under this endpoint first, then test.":
    "请先在这个端点下添加一个模型，再测试。",
  "Expected {expected}-dimensional vectors but got {got}. This endpoint ignores the dimensions request, so its vectors will not fit the existing index.":
    "预期是 {expected} 维的向量，实际得到 {got} 维。这个端点忽略了维度设置，所以它的向量与现有索引不匹配。",
  "Connected in {ms} ms · {dimensions} dimensions.":
    "已连接，用时 {ms} 毫秒 · {dimensions} 维。",

  // src/services/systemNotifications.ts
  "AlphainZ needs your approval":
    "AlphainZ 需要你批准",
  "Approve text extraction to let the task continue.":
    "批准提取文本，任务才能继续。",
  "Approve an external literature search to let the task continue.":
    "批准外部文献检索，任务才能继续。",
  "Review a note edit to let the task continue.":
    "审阅一处笔记修改，任务才能继续。",
  "Review an annotation change to let the task continue.":
    "审阅一处注释修改，任务才能继续。",
  "Review a metadata change to let the task continue.":
    "审阅一处元数据修改，任务才能继续。",
  "A task is waiting for your decision.":
    "有一个任务在等你决定。",
  "{count} actions are waiting for your decision.":
    "有 {count} 项操作在等你决定。",
  "AlphainZ has a question":
    "AlphainZ 有一个问题",
  "Answer a question to let the task continue.":
    "回答一个问题，任务才能继续。",
  "{count} questions are waiting for your answer.":
    "有 {count} 个问题在等你回答。",
  "AlphainZ finished":
    "AlphainZ 已完成",
  "Your response is ready. Click to open it.":
    "你的回答已准备好，点击打开。",
};
