# yuanbao-lite v10.22.0

轻量独立版腾讯元宝 IM 机器人客户端 — WebSocket + Protobuf 通信，35+ 命令，`--all` 全量输出，LLM 即时接管，贴纸模糊搜索，零框架依赖。

## 核心特性

| 特性 | 说明 |
|------|------|
| **零框架依赖** | 无需 OpenClaw 或任何外部框架，独立运行 |
| **WebSocket + Protobuf** | 与元宝后端建立 Protobuf 编码长连接，自动鉴权、心跳、断线重连 |
| **事件驱动 API** | 简洁的 EventEmitter 风格，一行监听私聊/群聊/状态/错误 |
| **35+ 内置命令** | `/help` `/status` `/members` `/history` `/llm` `/shell` 等，CLI 与 IM 共享 |
| **`--all` / `-a` 全量输出** | 长输出命令默认截断，加 `--all` 显示全部（7 个命令支持） |
| **`/shell` 智能传参** | `/shell --all <cmd>` 取消截断；`/shell <cmd> --all` 原样传入 |
| **LLM 即时接管** | 默认零延迟响应（mergeWindowMs=0, cooldownMs=0），5 种供应商 |
| **贴纸模糊搜索** | NFKC 归一化 + bigram Jaccard + 编辑距离 + 子序列匹配，支持拼音/部分匹配 |
| **原生媒体** | 图片 TIMImageElem + 文件 TIMFileElem，COS 直传 |
| **@提及** | 双通道协议（TIMCustomElem elem_type=1002 + cloud_custom_data groupAtInfo） |
| **消息历史** | 持久化 JSONL，格式化输出含消息 ID（#xxxxxxxx），支持搜索/统计/过滤 |
| **交互式 CLI** | Tab 补全（含 `--all`）、语法高亮、历史搜索、REPL 风格 |
| **安全设计** | 敏感命令全部 dmOnly（仅私聊），`/unsafe` 临时提升权限 |
| **多账号** | 单进程管理多个机器人账号 |
| **临时文件分享** | GoFile / tmpfiles / uguu / litterbox 多供应商 |
| **联系人/群聊管理** | 持久化联系人、群聊收藏，备注、标签、收藏 |

## 安装

```bash
npm install yuanbao-lite
```

依赖：`protobufjs` `ws` `marked` `z-ai-web-dev-sdk` `chalk` `commander`（均自动安装）

## 快速开始

### 最小示例

```typescript
import { YuanbaoBot } from "yuanbao-lite";

const bot = new YuanbaoBot({
  appKey: "your_app_key",
  appSecret: "your_app_secret",
});

bot.on("groupMessage", async (msg) => {
  console.log(`[${msg.groupName}] ${msg.fromNickname}(${msg.fromUserId}): ${msg.text}`);
});

bot.on("ready", () => console.log("Bot connected!"));
await bot.start();
```

### 启用 LLM 即时回复

```typescript
const bot = new YuanbaoBot({
  appKey: "your_app_key",
  appSecret: "your_app_secret",
  llmConfig: {
    provider: "z-ai",                  // 内置免费供应商，无需 API Key
    // 或使用其他供应商：
    // provider: "openai",
    // apiKey: "sk-xxx",
    // model: "gpt-4o",
    systemPrompt: "你是元宝，一个友好的助手",
    markdownRawMode: true,              // 原始 Markdown 输出
    enableInGroup: true,                // 群聊中启用
    requireMentionInGroup: true,        // 群聊需 @机器人 才回复
    mergeWindowMs: 0,                   // 消息合并窗口（0=不等待，立即响应）
    cooldownMs: 0,                      // 响应冷却时间（0=无冷却）
  },
  llmAutoReply: true,                   // 默认开启
});

// LLM 自动处理非斜杠消息，即时响应
// 斜杠命令由命令系统处理
await bot.start();
```

### 自定义消息处理（不启用 LLM）

```typescript
const bot = new YuanbaoBot({
  appKey: "your_app_key",
  appSecret: "your_app_secret",
  llmAutoReply: false,
});

bot.on("directMessage", async (msg) => {
  await bot.sendDirectMessage(msg.fromUserId, `你说了: ${msg.text}`);
});

bot.on("groupMessage", async (msg) => {
  if (msg.isMentioned) {
    await bot.sendGroupMessage(msg.groupCode!, `收到你的 @提及！`);
  }
});

await bot.start();
```

## 编程 API

### 发送消息

```typescript
// 文本消息
await bot.sendText({ to: groupCode, text: "你好", isGroup: true });
await bot.sendDirectMessage(userId, "私聊消息");
await bot.sendGroupMessage(groupCode, "群聊消息");

// 引用回复（消息 ID 可在 /history 中查看，格式 #xxxxxxxx）
await bot.sendText({ to: groupCode, text: "回复内容", isGroup: true, quoteMsgId: "msgId" });

// 含 @提及的消息（语法：@[昵称](用户ID)）
await bot.sendText({
  to: groupCode,
  text: "@[张三](userId123) 请查看",
  isGroup: true,
});

// 原始消息体（贴纸/图片/文件等）
await bot.sendRawMessage({ to: groupCode, msgBody: customMsgBody, isGroup: true });
```

### 图片与文件

```typescript
// 发送图片（原生 TIMImageElem）
await bot.sendImage({ to: groupCode, filePath: "/path/to/image.png", isGroup: true });

// 发送文件（原生 TIMFileElem）
await bot.sendFile({ to: userId, filePath: "/path/to/doc.pdf" });

// 上传媒体（获取 UUID/URL，不发送）
const result = await bot.uploadMedia("/path/to/file.zip", "file");
console.log(result.uuid, result.url, result.fileSize);
```

### 贴纸

```typescript
// 内置 QQ 表情
await bot.sendSticker({ to: groupCode, stickerId: "emoji_278", isGroup: true });

// 按名称模糊匹配发送
await bot.sendSticker({ to: groupCode, stickerId: "六六六", isGroup: true });

// 自定义贴纸包
await bot.sendSticker({ to: groupCode, stickerId: "my_pack:happy", isGroup: true });
```

### 查询 API

```typescript
// 群信息（自动获取群名称）
const info = await bot.queryGroupInfo("707881071");
console.log(info.group_info.group_name, info.group_info.group_size);

// 群成员列表
const members = await bot.getGroupMemberList("707881071");
for (const m of members.member_list) {
  console.log(m.nick_name, m.user_id, m.user_type);
  // user_type: 1=人类, 2=元宝, 3=龙虾
}
```

### 数据存储

```typescript
// 别名 — 为长 ID 定义短名
const aliasStore = bot.getAliasStore();
aliasStore.add("userId123", "zhangsan", "张三");
aliasStore.resolve("zhangsan");  // → "userId123"

// 联系人
const contactStore = bot.getContactStore();
contactStore.add("userId123", "张三", "同事");
contactStore.setNotes("张三", "周三下午开会");
contactStore.toggleFavorite("张三");

// 群聊收藏
const groupStore = bot.getGroupStore();
groupStore.add("707881071", "测试群", "开发");
groupStore.setFavorite("707881071", true);
groupStore.setNotes("707881071", "重要群聊");

// 消息历史
const historyStore = bot.getHistoryStore();
historyStore.searchByKeyword("关键词");
historyStore.getStats();
```

### LLM 供应商配置

| 供应商 | `provider` 值 | 必填参数 | 默认模型 |
|--------|--------------|---------|---------|
| Z-AI 内置 | `"z-ai"` | 无 | — |
| OpenAI 兼容 | `"openai"` | `apiKey`, 可选 `baseUrl` | `gpt-4o` |
| Anthropic Claude | `"anthropic"` | `apiKey` | `claude-sonnet-4-20250514` |
| DeepSeek | `"deepseek"` | `apiKey` | `deepseek-chat` |
| 自定义 OpenAI 兼容 | `"custom"` | `apiKey`, `baseUrl` | 需指定 |

```typescript
llmConfig: {
  provider: "openai",
  apiKey: "sk-xxx",
  baseUrl: "https://api.openai.com/v1",  // 可选
  model: "gpt-4o",
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: "你是一个友好的助手",
  markdownRawMode: true,           // true=原始 Markdown, false=IM 格式化
  enableInGroup: true,             // 群聊启用
  enableInDirect: true,            // 私聊启用
  requireMentionInGroup: true,     // 群聊需 @机器人
  mergeWindowMs: 0,                // 合并窗口（0=立即响应）
  cooldownMs: 0,                   // 冷却时间（0=无冷却）
  maxIterate: 0,                   // 最大迭代轮数（0=无限）
}
```

### 临时文件分享

```typescript
import { uploadToTempFile, uploadAndFormatLink } from "yuanbao-lite";

// 默认供应商（GoFile）
const result = await uploadToTempFile("/path/to/file.zip");
console.log(result.directUrl || result.pageUrl);

// 指定供应商
await uploadToTempFile("/path/to/file.zip", "uguu");
await uploadToTempFile("/path/to/file.zip", "litterbox");

// 上传 + 生成格式化分享文本
const text = await uploadAndFormatLink("/path/to/file.zip", "版本更新包");
await bot.sendGroupMessage("707881071", text);
```

| 供应商 | 上传限制 | 保留时间 | 特点 |
|--------|---------|---------|------|
| **gofile** (默认) | 500 MB | 10天不活跃后删除 | 速度快，无需注册 |
| tmpfiles | 100 MB | 约1小时 | 快速上传，自动清理 |
| uguu | 128 MB | 约24小时 | 简单可靠，直链下载 |
| litterbox | 100 MB | 可选 1h/12h/24h/72h | 灵活过期时间 |

### 全局命令系统

```typescript
const cmdSystem = bot.getCommandSystem();

// 注册自定义命令（同时可用于 IM 和 CLI）
cmdSystem.register({
  name: "hello",
  description: "打招呼",
  aliases: ["hi"],
  handler: async (ctx) => {
    await ctx.reply(`Hello, ${ctx.message.fromNickname}!`);
  },
});
```

### 事件

```typescript
bot.on("message", (msg) => { ... });          // 所有消息
bot.on("directMessage", (msg) => { ... });     // 私聊
bot.on("groupMessage", (msg) => { ... });      // 群聊
bot.on("ready", ({ connectId }) => { ... });   // 连接就绪
bot.on("stateChange", (state) => { ... });     // 状态变更
bot.on("error", (error) => { ... });           // 错误
bot.on("close", () => { ... });                // 连接关闭
bot.on("kickout", ({ status, reason }) => { ... }); // 被踢下线
```

## IM 命令列表

### `--all` / `-a` 全量输出

以下命令默认截断长输出，加 `--all` 或 `-a` 显示全部：

| 命令 | 默认限制 | `--all` 行为 |
|------|---------|-------------|
| `/shell [--all] <命令>` | 输出截断 2000 字符 | 不截断 |
| `/members [--all] [群号]` | 最多 50 人 | 显示全部 |
| `/groups [--all]` | 最多 20 条 | 显示全部 |
| `/switch [--all] [编号]` | 最多 20 条 | 显示全部 |
| `/stickers [--all]` | 最多 30 条 | 显示全部 |
| `/history search [--all] <关键词>` | 最近 20 条 | 显示全部 |
| `/hsearch [--all] <关键词>` | 15 条+截断文本 | 全部+完整文本 |

> 💡 `/shell` 的 `--all` 有特殊语义：放在命令**前**（`/shell --all ls`）= 取消截断；放在命令**后**（`/shell ls --all`）= 原样传入 shell 命令。

### 基础命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/help [命令名]` | `h`, `?`, `帮助` | 显示帮助/查看指定命令详细用法 |
| `/status` | `state`, `状态` | 查看连接状态和账号信息 |
| `/echo <文本>` | `say`, `重复` | 回显文本 |
| `/ping` | `pong` | 测试响应延迟 |
| `/version` | `v`, `ver`, `版本` | 查看版本 |
| `/uptime` | `运行时间` | 查看运行时间 |
| `/shell [--all] <命令>` | `sh` | 运行系统命令（**仅私聊**，默认截断2000字符） |
| `/unsafe [on\|off\|status] [分钟]` | `危险模式` | 临时允许群聊使用受限命令（**仅私聊**，默认5分钟） |

### 群聊命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `/groupinfo [群号]` | `gi`, `info`, `群信息` | 查看群信息（群名、群主、成员数），群聊中可省略群号 |
| `/members [--all] [群号]` | `成员`, `群成员` | 查看群成员列表（含用户ID），默认50人 |

### 消息与聊天

| 命令 | 别名 | 说明 |
|------|------|------|
| `/dm <用户ID或别名> <消息>` | `私聊` | 发送私聊消息（支持别名解析） |
| `/group <群号> <消息>` | `群发` | 发送群聊消息 |
| `/reply <消息ID或#尾号> <内容>` | `引用回复` | 引用回复消息（支持任意长度尾号） |
| `/mention <目标> <消息>` | `at`, `提及` | 发送含 @提及的消息 |
| `/chat <用户ID\|group 群号> <消息>` | `聊天` | 向指定目标发送消息 |

### 媒体

| 命令 | 别名 | 说明 | 权限 |
|------|------|------|------|
| `/img <路径> [目标ID]` | `图片` | 发送图片消息（目标默认当前会话） | **仅私聊** |
| `/file <路径> [目标ID]` | `文件` | 发送文件消息（目标默认当前会话） | **仅私聊** |
| `/upload <路径>` | `上传` | 上传文件到媒体服务器 | **仅私聊** |
| `/download <URL> [文件名]` | `下载` | 下载媒体文件到本地 | **仅私聊** |

### 贴纸

| 命令 | 别名 | 说明 |
|------|------|------|
| `/sticker <贴纸ID\|名称>` | `贴纸` | 发送贴纸（支持名称模糊匹配，emoji_编号格式） |
| `/stickers [--all]` | `贴纸列表` | 查看内置表情列表（默认30条，--all全部） |
| `/stickers emojis [--all]` | — | 查看内置 QQ 表情列表 |
| `/stickers search [--all] <关键词>` | — | 模糊搜索贴纸（拼音/部分匹配/编辑距离） |
| `/stickers load <目录>` | — | 加载自定义贴纸包 |

### 消息历史

| 命令 | 别名 | 说明 |
|------|------|------|
| `/history search [--all] <关键词>` | `hist`, `历史` | 搜索消息（默认20条，--all全部） |
| `/history recent [数量]` | — | 查看最近消息 |
| `/history stats` | `统计` | 消息统计 |
| `/history user <用户ID> [数量]` | — | 查看用户消息 |
| `/history group <群号> [数量]` | — | 查看群消息 |
| `/hsearch [--all] <关键词>` | `搜索历史` | 快速搜索历史（默认15条+截断，--all全部+全文） |
| `/hclear` | `清除历史` | 清除消息历史（不可恢复，**仅私聊**） |

> 💡 历史消息格式中 `#xxxxxxxx` 是消息 ID 的后 8 位，可直接用于 `/reply` 命令引用回复，支持任意长度尾号匹配。

### LLM 接管

| 命令 | 别名 | 说明 | 权限 |
|------|------|------|------|
| `/llm on` | `ai` | 开启自动回复 | **仅私聊** |
| `/llm off` | — | 关闭自动回复 | **仅私聊** |
| `/llm status` | — | 查看状态 | **仅私聊** |
| `/llm chat <消息>` | `问` | 直接与 LLM 对话 | **仅私聊** |
| `/llm prompt <提示词>` | `系统提示` | 设置系统提示词 | **仅私聊** |
| `/llm model <模型名>` | `模型` | 设置模型 | **仅私聊** |
| `/llm temp <0-2>` | `温度` | 设置温度 | **仅私聊** |
| `/llm provider <供应商>` | `供应商` | 切换供应商 | **仅私聊** |
| `/llm apikey <密钥>` | `密钥` | 设置 API 密钥 | **仅私聊** |
| `/llm baseurl <URL>` | — | 设置 API 基础 URL | **仅私聊** |
| `/llm raw` | — | Markdown 原始模式 | **仅私聊** |
| `/llm im` | — | IM 格式化模式 | **仅私聊** |
| `/llm history` | `历史` | 查看对话历史 | **仅私聊** |
| `/llm clear [对话ID]` | `清除` | 清除对话历史（不指定则清除全部） | **仅私聊** |
| `/llm merge <毫秒>` | `合并` | 设置消息合并窗口（0=立即响应） | **仅私聊** |
| `/llm cooldown <毫秒>` | `冷却` | 设置响应冷却时间（0=无冷却） | **仅私聊** |
| `/llm iterate <轮数>` | `迭代` | 设置最大迭代轮数（0=无限） | **仅私聊** |
| `/llm group <on\|off\|mention>` | `群聊` | 群聊响应控制 | **仅私聊** |

> 💡 默认 mergeWindowMs=0（不等待合并，立即响应），cooldownMs=0（无冷却）。如需合并窗口（群聊等待连续消息），可 `/llm merge 3000`。

### 联系人与群聊

| 命令 | 别名 | 说明 | 权限 |
|------|------|------|------|
| `/contacts` | `联系人` | 查看联系人列表 | **仅私聊** |
| `/contacts add <ID> <名称> [标签]` | — | 添加联系人 | **仅私聊** |
| `/contacts rm <名称\|ID>` | — | 删除联系人 | **仅私聊** |
| `/contacts rename <名称\|ID> <新名称>` | — | 重命名联系人 | **仅私聊** |
| `/contacts note <名称\|ID> <备注>` | `备注` | 添加联系人备注 | **仅私聊** |
| `/contacts tag <名称\|ID> <标签>` | — | 设置标签 | **仅私聊** |
| `/contacts fav <名称\|ID>` | `收藏` | 切换收藏状态 | **仅私聊** |
| `/contacts dm <名称\|ID>` | — | 进入私聊模式 | **仅私聊** |
| `/contacts search <关键词>` | — | 搜索联系人 | **仅私聊** |
| `/groups [--all]` | `glist` | 列出群聊（含收藏，默认20条） | **仅私聊** |
| `/groups add <群号> [名称] [标签]` | — | 添加到收藏 | **仅私聊** |
| `/groups rm <群号>` | — | 从收藏移除 | **仅私聊** |
| `/groups rename <群号> <名称>` | — | 重命名群聊备注 | **仅私聊** |
| `/groups note <群号> <备注>` | `备注` | 添加群聊备注 | **仅私聊** |
| `/groups tag <群号> <标签>` | — | 设置群聊标签 | **仅私聊** |
| `/groups fav <群号>` | `收藏` | 切换收藏状态 | **仅私聊** |
| `/groups join <群号>` | — | 加入群聊会话 | **仅私聊** |
| `/groups search <关键词>` | — | 搜索群聊 | **仅私聊** |
| `/search groups <关键词>` | `搜索` | 搜索群组 | — |
| `/search members <关键词> <群号>` | — | 搜索群成员 | — |

### 别名

| 命令 | 别名 | 说明 | 权限 |
|------|------|------|------|
| `/alias add <ID> <别名> [昵称]` | `别名` | 添加别名 | **仅私聊** |
| `/alias remove <别名\|ID>` | — | 删除别名 | **仅私聊** |
| `/alias list` | — | 列出所有别名 | **仅私聊** |
| `/alias save` | — | 保存到磁盘 | **仅私聊** |
| `/alias load` | — | 从磁盘加载别名 | **仅私聊** |
| `/alias resolve <别名\|ID>` | — | 解析别名 | **仅私聊** |

### 临时文件

| 命令 | 别名 | 说明 | 权限 |
|------|------|------|------|
| `/tempfile <路径> [描述]` | `临时文件` | 上传到临时平台（默认gofile） | **仅私聊** |
| `/tempfile gofile <路径>` | — | GoFile（10天不活跃删除） | **仅私聊** |
| `/tempfile tmpfiles <路径>` | — | tmpfiles.org（1小时） | **仅私聊** |
| `/tempfile uguu <路径>` | — | uguu.se（24小时） | **仅私聊** |
| `/tempfile litterbox <路径> [过期]` | — | litterbox（可选 1h/12h/24h/72h） | **仅私聊** |

### 多账号与系统

| 命令 | 别名 | 说明 | 权限 |
|------|------|------|------|
| `/account add <ID> <appKey> <appSecret> [名称]` | `账号` | 添加账号 | **仅私聊** |
| `/account remove <ID>` | — | 移除账号 | **仅私聊** |
| `/account list` | — | 列出所有账号 | **仅私聊** |
| `/account switch <ID>` | — | 切换活跃账号 | **仅私聊** |
| `/account start <ID>` | — | 启动指定账号 | **仅私聊** |
| `/account stop <ID>` | — | 停止指定账号 | **仅私聊** |
| `/batch text <目标> <数量> <间隔> <模板>` | `批量` | 批量发送（支持 ${i} ${n} ${total} ${timestamp} 插值） | **仅私聊** |
| `/log <debug\|info\|warn\|error>` | `日志` | 切换日志级别（持久化保存） | **仅私聊** |
| `/join <群号>` | `加入` | 加入群聊会话 | **仅私聊** |
| `/switch [--all] [编号]` | `切换`, `sw` | 查看/切换活跃群组（默认20条） | — |

## CLI 使用

```bash
# 交互式模式（默认）
npx yb-cli

# 非交互：发送私聊/群聊
npx yb-cli send dm <userId> "你好"
npx yb-cli send group <groupCode> "群消息"

# 配置管理
npx yb-cli config init
npx yb-cli config show
npx yb-cli config set appKey XXX
npx yb-cli config set llmProvider z-ai
```

### CLI 增强特性

- **Tab 补全** — 命令、子命令、`--all` 标志、文件路径、联系人、群号、供应商名称
- **语法高亮** — 命令名（青色）、子命令（黄色）、文件路径（绿色）、@提及（洋红）、标志（暗青）
- **历史搜索** — 上下箭头浏览，`/hsearch <关键词>` 搜索命令历史
- **历史持久化** — 保存到 `~/.yuanbao-lite/history`，跨会话保留
- **敏感数据过滤** — API 密钥等敏感命令不写入历史文件

## 配置

### Bot 配置

```typescript
const bot = new YuanbaoBot({
  appKey: "your_app_key",          // 必填
  appSecret: "your_app_secret",    // 必填
  name: "My Bot",                  // 可选
  apiDomain: "bot.yuanbao.tencent.com",
  wsUrl: "wss://bot-wss.yuanbao.tencent.com/wss/connection",
  token: "pre-signed-token",       // 替代 appKey+appSecret
  mediaMaxMb: 20,
  historyLimit: 100,
  logLevel: "info",
  maxReconnectAttempts: 100,
  commands: {
    prefix: "/",
    caseSensitive: false,
    enableInGroup: true,
    requireMentionInGroup: true,    // 默认：群聊需 @机器人
  },
  customCommands: [/* CommandDefinition[] */],
  llmConfig: { /* 见 LLM 供应商配置 */ },
  llmAutoReply: true,
});
```

### CLI 配置

配置文件位于 `~/.yuanbao-lite/config.json`，支持多档案。

数据目录 `~/.yuanbao-lite/`：

| 文件 | 说明 |
|------|------|
| `config.json` | CLI 配置与档案 |
| `aliases.json` | 别名存储 |
| `contacts.json` | 联系人存储 |
| `groups.json` | 群聊收藏存储 |
| `history.jsonl` | 消息历史 |
| `history` | CLI 命令历史 |
| `sticker-cache/` | 贴纸缓存 |

## 项目结构

```text
src/
├── index.ts                    # 主入口，YuanbaoBot 类
├── types.ts                    # 核心类型定义
├── accounts.ts                 # 账号解析
├── logger.ts                   # 日志与脱敏
├── access/
│   ├── ws/                     # WebSocket 层
│   │   ├── client.ts           # WS 客户端（连接/重连/心跳）
│   │   ├── conn-codec.ts       # 连接层 Protobuf 编解码
│   │   ├── biz-codec.ts        # 业务层 Protobuf 编解码
│   │   ├── types.ts            # WS 类型定义
│   │   └── proto/              # Protobuf 定义
│   └── http/
│       ├── request.ts          # HTTP 请求层（签名/缓存/刷新）
│       ├── media.ts            # 媒体上传下载（COS + 旧版）
│       ├── gofile.ts           # GoFile 临时文件分享
│       └── tempfile.ts         # 多供应商临时文件分享
├── business/
│   ├── messaging/extract.ts    # 消息提取与转换
│   ├── sticker.ts              # 贴纸系统（模糊搜索）
│   ├── mention.ts              # @提及（双通道协议）
│   ├── alias.ts                # 别名系统
│   ├── contacts.ts             # 联系人管理
│   ├── groups.ts               # 群聊收藏管理
│   ├── history.ts              # 消息历史（含格式化输出）
│   ├── interpolate.ts          # $插值引擎
│   ├── llm-takeover.ts         # LLM 接管模块（5种供应商，即时响应）
│   ├── batch.ts                # 批量发送
│   ├── multi-account.ts        # 多账号管理
│   └── search.ts               # 搜索引擎
├── commands/
│   ├── index.ts                # 命令系统导出
│   ├── registry.ts             # 命令注册与分发（35+ 内置命令）
│   └── types.ts                # 命令类型定义
├── cli/
│   ├── index.ts                # 交互式 CLI
│   ├── non-interactive.ts      # 非交互模式 (Commander)
│   ├── config.ts               # 配置持久化
│   ├── rich-history.ts         # 历史记录
│   ├── auto-complete.ts        # Tab 补全（含 --all 标志）
│   └── syntax-highlight.ts     # 语法高亮
└── cli-new/                    # daemon-first 现代化 CLI
    ├── index.ts                # 入口，daemon-first 路由
    ├── config.ts               # 重新导出 src/cli/config.ts
    ├── theme.ts                # 颜色调色板 + 无边框渲染
    ├── daemon/
    │   ├── server.ts           # HTTP 服务器 + SSE
    │   ├── routes.ts           # 路由处理器
    │   └── pid-file.ts         # PID 文件 + 自动杀菌
    └── client/
        ├── daemon-client.ts    # HTTP 客户端 + ensureDaemon()
        ├── commands.ts         # Commander 程序
        ├── interactive.ts      # Clack REPL
        └── wizard.ts           # 配置初始化向导
```

## 版本历史

### v10.22.0

- **`--all` / `-a` 全量输出** — 7 个截断命令支持 `--all` 显示全部结果
- **`/shell --all` 智能传参** — `/shell --all <cmd>` 取消截断；`/shell <cmd> --all` 原样传入
- **全部命令帮助文本更新** — 30+ 命令 description/usage 全覆盖
- **CLI HELP_TEXT 重写** — 完整命令参考，▲ 标记 `--all` 命令
- **自动补全增强** — 覆盖全部命令/别名，支持 `--all`/`-a` 标志补全
- **语法高亮增强** — 覆盖全部命令名和别名

### v10.21.0

- **LLM 迭代控制** — `/llm iterate <轮数>` 设置最大迭代轮数（0=无限）

### v10.13.0

- **LLM 即时响应** — mergeWindowMs=0, cooldownMs=0，默认零延迟
- **`/llm merge` / `/llm cooldown`** — 运行时动态调整合并窗口和冷却时间
- **LLM 状态增强** — 显示合并窗口和冷却时间

### v10.12.0

- **贴纸模糊搜索** — NFKC 归一化 + bigram Jaccard + 编辑距离 + 子序列匹配
- **`/reply` 任意长度尾号** — 移除 8 位限制，endsWith 匹配
- **群名称自动获取** — `/groups` `/switch` 自动 queryGroupInfo
- **`/shell` (`/sh`)** — 运行系统命令，仅私聊
- **`/stickers` 默认列表** — 无参数显示内置表情
- **dmOnly 全覆盖** — 敏感命令全部仅限私聊

### v10.8.0

- **成员显示 ID** — `/members` 输出包含用户 ID
- **历史消息显示 ID** — `#xxxxxxxx` 格式，可直接用于 `/reply`
- **历史消息显示发送者 ID** — 昵称(userId) 格式

### v10.7.0

- **@提及检测修复** — botId 精确匹配 + cloud_custom_data 回退
- **LLM 自动回复修复** — 非斜杠消息正确转发 LLM
- **打包体积优化** — 排除 dist/node_modules，6MB → 141KB

### v10.6.0

- **人类友好输出** — 命令不再输出原始 JSON
- **dmOnly 标记** — 敏感命令仅限私聊
- **群聊默认需 @提及** — requireMentionInGroup=true

### v10.5.0

- **全局命令系统** — CLI 与 IM 共享命令代码
- **LLM 默认开启** — 配置即接管
- **24+ 内置命令** — 全套命令支持

## 与原版的区别

| 特性 | openclaw-plugin | Lite 版 |
|------|----------------|---------|
| OpenClaw 依赖 | 必须 | **无** |
| Agent 路由 | 支持 | 不支持 |
| 命令系统 | OpenClaw 框架 | **独立实现（35+ 全局命令）** |
| `--all` 全量输出 | 无 | **7 个命令支持** |
| LLM 接管 | 无 | **5 种供应商，默认即时响应** |
| 贴纸搜索 | 精确匹配 | **模糊搜索（拼音/部分/编辑距离）** |
| 系统命令 | 无 | **`/shell` (仅私聊，智能传参)** |
| 交互式 CLI | 无 | **Tab 补全 / 高亮 / 历史** |
| 消息历史 | 无 | **持久化 + 格式化 + 搜索** |
| 原生媒体 | 支持 | **支持 (COS 直传)** |
| @提及 | 支持 | **支持 (双通道协议)** |
| 安全控制 | 无 | **dmOnly 全覆盖 + /unsafe 临时提升** |
| 别名/联系人/群收藏 | 无 | **支持** |
| 多账号 | 无 | **支持** |

## 开发

```bash
npm install       # 安装依赖
npm run build     # TypeScript 编译
npm start         # 运行 CLI
```

## 许可证

MIT
