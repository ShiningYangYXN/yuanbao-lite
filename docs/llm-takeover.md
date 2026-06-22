# LLM 接管引擎

Yuanbao Lite 内置基于 Vercel AI SDK 的 LLM 接管引擎，支持多供应商、密钥池、自动切换、迭代调用和用量统计。

## 支持的 API 格式

| 格式                      | 说明                                       | 浏览器支持            |
| ------------------------- | ------------------------------------------ | --------------------- |
| `openai-chat-completions` | OpenAI 及兼容 API（DeepSeek、Moonshot 等） | ✅                    |
| `anthropic-messages`      | Anthropic Claude                           | ✅                    |
| `google-gemini-rest`      | Google Gemini                              | ✅                    |
| `aws-bedrock-converse`    | AWS Bedrock                                | ❌（依赖 SigV4 签名） |
| `azure-openai`            | Azure OpenAI                               | ✅                    |

## 配置方式

### 1. 交互式向导

私聊发送 `/llm config`，向导引导完成配置：

1. 选择 API 格式（5 种）
2. 输入供应商名称
3. 输入模型名称
4. 输入端点 URL
5. 输入 API Key
6. 输入系统提示词（可选）

### 2. 命令行配置

```text
# 添加供应商
/llm customprovider add my-openai openai-chat-completions gpt-4o https://api.openai.com/v1 sk-xxx

# 添加密钥到池
/llm customprovider addkey my-openai sk-yyy

# 切换供应商
/llm customprovider use my-openai

# 查看用量
/llm billing
```

### 3. 代码配置

```typescript
new YuanbaoBot({
  appKey,
  appSecret,
  llmConfig: {
    enabled: true,
    provider: "my-openai",
    customProviders: {
      "my-openai": {
        apiFormat: "openai-chat-completions",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
        apiKeys: ["sk-xxx", "sk-yyy"], // 密钥池
      },
      "my-claude": {
        apiFormat: "anthropic-messages",
        model: "claude-3-5-sonnet-20241022",
        baseUrl: "https://api.anthropic.com",
        apiKeys: ["sk-ant-xxx"],
      },
    },
    temperature: 0.7,
    maxTokens: 4096,
    maxHistoryTurns: 20,
    requireMentionInGroup: true, // 群聊需要 @bot 才回复
    cooldownMs: 0, // 响应冷却（0=关闭）
    mergeWindowMs: 0, // 消息合并窗口（0=关闭）
    userSystemPrompt: "你是一个友好的助手。", // 追加到默认提示词
  },
  llmAutoReply: true, // 非 / 消息触发 LLM
});
```

## 密钥池与自动切换

### 密钥池

每个供应商可配置多个 API Key，引擎自动轮换：

- 每次请求使用下一个 key（round-robin）
- key 失败（401/429）时进入冷却（默认 5 分钟）
- 所有 key 都在冷却时，切换到下一个供应商

### 供应商池

配置多个供应商时，引擎自动故障转移：

- 主供应商连续失败 3 次（可配置）后切换
- 切换后重置失败计数
- 所有供应商都失败时返回 fallbackReply

```typescript
llmConfig: {
  autoSwitchProvider: true,
  maxFailuresBeforeSwitch: 3,
  keyCooldownMs: 5 * 60 * 1000,
  autoRotateKeys: true,
}
```

## 迭代调用（invoke）

LLM 可以通过 `invoke()` 命令调用其他命令，实现工具使用：

```text
用户: 帮我查一下 8.8.8.8 的归属地
Bot: [调用 /ip 8.8.8.8]
Bot: 8.8.8.8 位于美国，ISP: Google LLC
```

引擎默认启用迭代调用，最大迭代次数可配置：

```typescript
llmConfig: {
  maxIterate: 5,  // 默认 5 次迭代
}
```

## 系统提示词

### 默认提示词（不可覆盖）

包含：

- 命令执行规则
- 迭代调用机制
- 安全机制说明
- @提及语法
- 消息条目格式
- 日期时间戳上下文

### 用户自定义提示词

通过 `userSystemPrompt` 追加到默认提示词之后：

```typescript
llmConfig: {
  userSystemPrompt: `
你是某公司的客服助手。
- 只回答与公司产品相关的问题
- 遇到投诉时调用 /escalate <用户ID>
`,
}
```

## 消息上下文格式

注入 LLM 上下文的消息格式：

```text
[YYYY-MM-DD HH:MM:SS] [昵称](用户ID)@群名或DM: 消息文本 [引用: #消息ID尾号]
```

- **时间戳**：让 LLM 有时间感知（"昨天"、"上周"等）
- **[昵称](用户ID)**：让 LLM 能通过 `@[昵称](id)` 语法 @用户
- **@群名/DM**：标识对话范围
- **引用后缀**：显示用户引用了哪条消息

Bot 的回复也会自动注入为 ASSISTANT 上下文（按会话分开）。

## 用量统计

```text
/llm billing
```

显示：

- 各供应商的请求次数、token 用量
- 各 key 的使用次数
- 失败次数和冷却状态

## 消息合并窗口

群聊中用户可能连续发送多条消息，引擎可合并处理：

```typescript
llmConfig: {
  mergeWindowMs: 2000,  // 2 秒内的消息合并为一条
}
```

合并期间的消息会缓存在内存中，超时后一次性发送给 LLM。

## 响应冷却

防止 LLM 过快响应：

```typescript
llmConfig: {
  cooldownMs: 3000,  // 3 秒冷却
}
```

冷却期间收到的消息会被丢弃（不触发 LLM）。

## Markdown 处理

LLM 返回的 Markdown 会被转换为纯文本以适配 IM：

- `**bold**` → `bold`
- `*italic*` → `italic`
- `[link](url)` → `link (url)`
- 代码块保持原样

可通过 `markdownRawMode: false` 禁用转换（保留原始 Markdown）。

## API

### `bot.getLlmEngine(): LlmTakeoverEngine | null`

获取 LLM 引擎实例。

### `engine.isReady: boolean`

引擎是否就绪（至少配置了一个有效供应商）。

### `engine.getConfig(): Readonly<Required<LlmTakeoverConfig>>`

获取当前配置。

### `async engine.chat(message: ChatMessage): Promise<LlmResponse>`

单次对话（不注入历史上下文）。

### `engine.addContextMessage(msg: ChatMessage, formatted: string): void`

注入上下文消息（不触发 API 调用）。

### `engine.clearContext(sessionKey: string): void`

清空指定会话的上下文。

### `engine.updateConfig(partial: Partial<LlmTakeoverConfig>): void`

更新配置（会持久化）。
