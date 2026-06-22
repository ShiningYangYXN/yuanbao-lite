# 核心 API 参考

## YuanbaoBot 类

主入口，提供事件驱动的 WebSocket 机器人客户端。

### 构造函数

```typescript
new YuanbaoBot(config: YuanbaoBotConfig)
```

**YuanbaoBotConfig**（继承 `YuanbaoAccountConfig`）：

| 字段                   | 类型                               | 默认值                                             | 说明                                  |
| ---------------------- | ---------------------------------- | -------------------------------------------------- | ------------------------------------- |
| `appKey`               | `string`                           | —                                                  | **必填**。腾讯元宝 AppKey             |
| `appSecret`            | `string`                           | —                                                  | **必填**。腾讯元宝 AppSecret          |
| `token`                | `string`                           | —                                                  | 预签名 token（替代 appKey+appSecret） |
| `apiDomain`            | `string`                           | `bot.yuanbao.tencent.com`                          | API 域名                              |
| `wsUrl`                | `string`                           | `wss://bot-wss.yuanbao.tencent.com/wss/connection` | WebSocket 网关                        |
| `logLevel`             | `"debug"\|"info"\|"warn"\|"error"` | `"info"`                                           | 日志级别                              |
| `logger`               | `PluginLogger`                     | —                                                  | 自定义日志器                          |
| `maxReconnectAttempts` | `number`                           | `100`                                              | 最大重连次数                          |
| `commands`             | `CommandSystemConfig \| false`     | —                                                  | 命令系统配置，`false` 禁用            |
| `customCommands`       | `CommandDefinition[]`              | —                                                  | 自定义命令                            |
| `llmConfig`            | `LlmTakeoverConfig`                | —                                                  | LLM 引擎配置                          |
| `llmAutoReply`         | `boolean`                          | `true`                                             | 非 / 消息是否触发 LLM 自动回复        |
| `persistence`          | `{adapter?, dir?} \| null`         | —                                                  | 持久化配置，`null` 禁用               |
| `historyLimit`         | `number`                           | `100`                                              | 内存中保留的历史消息数                |
| `mediaMaxMb`           | `number`                           | `20`                                               | 媒体上传大小限制（MB）                |

**persistence 配置详解**：

```typescript
// 1. 默认（Node）—— 使用 ~/.yuanbao-lite/ + NodeFsAdapter
new YuanbaoBot({ appKey, appSecret });

// 2. 禁用持久化（纯内存，重启丢失）
new YuanbaoBot({ appKey, appSecret, persistence: null });

// 3. 自定义适配器（浏览器）
new YuanbaoBot({
  appKey,
  appSecret,
  persistence: {
    dir: "my-app/yuanbao", // localStorage key 前缀
    adapter: myBrowserAdapter, // 实现 PersistenceAdapter 接口
  },
});
```

### 事件

通过 `bot.on(event, handler)` 订阅。

| 事件                | 载荷                    | 触发时机                  |
| ------------------- | ----------------------- | ------------------------- |
| `"message"`         | `ChatMessage`           | 收到任何消息（DM 或群聊） |
| `"directMessage"`   | `ChatMessage`           | 收到私聊消息              |
| `"groupMessage"`    | `ChatMessage`           | 收到群聊消息              |
| `"ready"`           | `{ connectId: string }` | WebSocket 连接 + 认证成功 |
| `"stateChange"`     | `BotState`              | 连接状态变化              |
| `"error"`           | `Error`                 | 发生错误                  |
| `"close"`           | `void`                  | 连接关闭                  |
| `"kickout"`         | `{ status, reason }`    | 被服务器踢下线            |
| `"outboundMessage"` | `{ text, to, isGroup }` | Bot 发送了消息            |

**ChatMessage 结构**：

```typescript
interface ChatMessage {
  text: string;
  fromUserId: string;
  fromNickname: string;
  chatType: "direct" | "group";
  groupCode?: string;
  groupName?: string;
  isMentioned: boolean;
  mentions?: MentionInfo[];
  timestamp: number;
  msgId: string;
  quoteMsgId?: string;
  rawBody?: YuanbaoMsgBodyElement[];
}
```

### 生命周期方法

#### `async init(): Promise<void>`

初始化重型子系统（持久化 store + 命令系统）。幂等。

**何时需要显式调用**：

- 使用默认 Node 持久化时，store 构造是异步的
- `start()` 内部会自动调用 `init()`
- 如需在 `start()` 前访问 store（如 `getAliasStore()`），需先 `await bot.init()`

```typescript
const bot = new YuanbaoBot({ appKey, appSecret });
await bot.init(); // 显式初始化
// 现在 store 可用
bot.getAliasStore().add("user123", "alice");
await bot.start();
```

#### `async start(): Promise<void>`

启动 Bot，连接 WebSocket。Promise 在 Bot 断开时 resolve。

```typescript
await bot.start(); // 阻塞直到 stop() 或致命错误
```

#### `stop(): void`

优雅断开 WebSocket。

```typescript
bot.stop();
```

### 发送消息方法

#### `async sendText(params): Promise<void>`

发送文本消息，支持 @提及 和 `${}` 插值。

```typescript
await bot.sendText({
  to: "user123", // userId 或 groupCode
  text: "你好 @{小明}(user123)!",
  isGroup: false,
  quoteMsgId: "msg_abc", // 可选：引用消息
  contextMsg: chatMessage, // 可选：插值上下文
});
```

#### `async sendDirectMessage(userId, text): Promise<void>`

发送私聊消息（简写）。

```typescript
await bot.sendDirectMessage("user123", "你好！");
```

#### `async sendGroupMessage(groupCode, text): Promise<void>`

发送群聊消息（简写）。

```typescript
await bot.sendGroupMessage("group456", "大家好！");
```

#### `async sendReply(target, text, quoteMsgId?): Promise<void>`

引用回复。

```typescript
await bot.sendReply({ to: "user123", isGroup: false }, "收到", "msg_abc");
```

### 消息查询方法

#### `async getGroupMemberList(groupCode): Promise<GetGroupMemberListResponse>`

获取群成员列表。

```typescript
const members = await bot.getGroupMemberList("group456");
for (const m of members.member_list) {
  console.log(`${m.nick_name} (${m.user_id})`);
}
```

#### `async queryGroupInfo(groupCode): Promise<QueryGroupInfoResponse>`

查询群信息。

#### `async queryBotInfo(botId): Promise<QueryBotInfoResponse>`

查询 Bot 信息（包括公开 ID 和所有者 ID）。

### Store 访问方法

所有 store getter 在 `init()` 完成前调用会抛错。使用 `getXxxStoreOrNull()` 获取 null-safe 变体。

| 方法                 | 返回类型                    | 说明                                    |
| -------------------- | --------------------------- | --------------------------------------- |
| `getAliasStore()`    | `AliasStore`                | 别名存储                                |
| `getContactStore()`  | `ContactStore`              | 联系人存储                              |
| `getGroupStore()`    | `GroupStore`                | 群组存储                                |
| `getHistoryStore()`  | `MessageHistoryStore`       | 消息历史存储                            |
| `getLlmEngine()`     | `LlmTakeoverEngine \| null` | LLM 引擎                                |
| `getCommandSystem()` | `CommandSystem \| null`     | 命令系统（`commands: false` 时为 null） |

### 命令系统方法

#### `async registerCommand(def: CommandDefinition): Promise<void>`

注册自定义命令。

```typescript
await bot.registerCommand({
  name: "ping",
  description: "测试响应",
  category: "utility",
  usage: "/ping",
  handler: async (ctx) => {
    await ctx.reply("pong!");
    return { handled: true };
  },
});
```

#### `async unregisterCommand(name: string): Promise<boolean>`

注销命令。

### 状态方法

#### `getState(): BotState`

```typescript
const state = bot.getState();
// state.status: "disconnected" | "connecting" | "authenticating" | "connected"
// state.connected: boolean
// state.connectId?: string
// state.botId?: string
```

#### `getAccount(): ResolvedYuanbaoAccount`

获取已解析的账号配置（含 `botId`、`botOwnerId` 等）。

#### `isSelfUserId(userId: string): boolean`

判断 userId 是否为当前 Bot（用于 @提及检测）。

#### `getSelfUserIds(): string[]`

获取所有表示"自己"的 userId（sign-token ID + 平台公开 ID）。

## 类型导出

主入口 `yuanbao-lite` 导出所有公开类型：

```typescript
import type {
  YuanbaoBotConfig,
  ChatMessage,
  BotState,
  BotEventType,
  YuanbaoAccountConfig,
  ResolvedYuanbaoAccount,
  YuanbaoMsgBodyElement,
  SendTextMessageParams,
  MentionInfo,
  // Store 类型
  AliasStore,
  AliasEntry,
  ContactStore,
  ContactEntry,
  GroupStore,
  GroupEntry,
  MessageHistoryStore,
  HistoryFilter,
  HistoryPage,
  // LLM 类型
  LlmTakeoverEngine,
  LlmTakeoverConfig,
  ProviderConfig,
  ApiFormat,
  // 命令类型
  CommandSystem,
  CommandDefinition,
  CommandContext,
  CommandResult,
  // 持久化类型
  PersistenceAdapter,
  // 工具
  SearchEngine,
  MultiAccountManager,
} from "yuanbao-lite";
```

## 子路径导入

### `yuanbao-lite/commands`

获取 `CommandSystem` 运行时类（主入口仅导出类型）：

```typescript
import { CommandSystem } from "yuanbao-lite/commands";

const cs = new CommandSystem();
cs.register({ name: "test", handler: async () => ({ handled: true }) });
```

### `yuanbao-lite/cli`

CLI 入口（仅 Node）。通常通过 `npx yb-cli` 调用，无需代码导入。

## 错误处理

所有网络方法可能抛出以下错误：

```typescript
try {
  await bot.sendText({ to: "user123", text: "hi", isGroup: false });
} catch (err) {
  if (err.message.includes("not connected")) {
    // Bot 未连接
  } else if (err.message.includes("timeout")) {
    // 超时
  } else {
    // 其他错误
  }
}
```

监听 `"error"` 事件以捕获异步错误：

```typescript
bot.on("error", (err) => {
  console.error("Bot 错误:", err);
});
```
