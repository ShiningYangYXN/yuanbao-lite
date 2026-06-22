# 命令系统

Yuanbao Lite 内置 49 个斜杠命令，覆盖聊天、群管、媒体、LLM、系统管理等场景。命令系统与 IM 共享同一套实现，CLI 与 Bot 收到的 `/cmd` 消息走相同的分发路径。

## 命令分类

| 分类    | 命令数 | 说明                                                |
| ------- | ------ | --------------------------------------------------- |
| info    | 9      | 信息查询（status, version, ping, ip, whoami 等）    |
| chat    | 8      | 聊天与贴纸（dm, group, reply, mention, sticker 等） |
| group   | 8      | 群聊管理（groups, members, join, search 等）        |
| history | 3      | 消息历史（history, inspect）                        |
| system  | 8      | 系统管理（shell, term, daemon, config, log 等）     |
| llm     | 2      | LLM 控制（llm, new）                                |
| media   | 5      | 媒体文件（upload, download, file, img, attachment） |
| utility | 9      | 实用工具（echo, calc, alias, contacts, account 等） |

完整命令列表请参考 [README.md](../README.md#命令列表) 或使用 `/help` 命令。

## 权限模型

### 三级权限优先级

```
block > trust > unsafe
```

1. **block（封禁）**：被封禁的用户被拒绝所有交互
2. **trust（信任）**：受信用户可执行 elevated 命令
3. **unsafe（危险模式）**：临时全局授权（5 分钟窗口）

### elevated 命令

标记为 `elevated: true` 的命令需要特殊权限才能在群聊中执行：

- 私聊：所有者（master）可直接执行
- 群聊：需要 `/unsafe on` 或 `/trust grant <用户> <命令>`

elevated 命令列表：`shell`, `term`, `config reset`, `llm reset`, `daemon stop/restart/reset` 等。

### CLI 全局最高权限

通过 CLI 执行命令时，绕过所有限制（相当于永久 unsafe 模式）。

## 自定义命令

### 注册自定义命令

```typescript
await bot.registerCommand({
  name: "weather",
  aliases: ["天气", "w"],
  description: "查询天气",
  usage: "/weather <城市>",
  category: "utility",
  elevated: false, // 是否需要 elevated 权限
  handler: async (ctx) => {
    const city = ctx.args[0];
    if (!city) {
      await ctx.reply("用法: /weather <城市>");
      return { handled: true };
    }
    // 调用天气 API...
    const weather = await fetchWeather(city);
    await ctx.reply(`📍 ${city}: ${weather.temp}°C, ${weather.desc}`);
    return { handled: true };
  },
});
```

### CommandContext（ctx）

```typescript
interface CommandContext {
  bot: YuanbaoBot;
  message: ChatMessage;
  args: string[]; // 已解析的参数
  text: string; // 完整命令文本
  commandName: string;
  isGroup: boolean;
  groupCode?: string;
  source: "cli" | "chat"; // 命令来源
  showAll: boolean; // --all 标志
  useTable: boolean; // 表格输出模式
  reply: (text: string) => Promise<void>;
}
```

### CommandResult

```typescript
interface CommandResult {
  handled: boolean; // 是否被处理
  reply?: string; // 回复文本（可选）
  error?: string; // 错误信息
}
```

### 命令定义文件

对于内置命令，推荐一命令一文件，放在 `src/commands/handlers/<category>/<name>.ts`：

```typescript
// src/commands/handlers/utility/weather.ts
import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "weather",
    aliases: ["天气"],
    description: "查询天气",
    usage: "/weather <城市>",
    category: "utility" as CommandCategory,
    handler: async (ctx) => {
      // ...实现...
      return { handled: true };
    },
  });
}
```

然后在 `src/commands/handlers/index.ts` 中注册：

```typescript
import { register as registerWeather } from "./utility/weather.js";
// ...
export function registerAll(cmdSys: CommandSystem): void {
  // ...
  registerWeather(cmdSys);
}
```

## 命令分发规则

1. **斜杠识别**：消息以 `/` 开头视为命令
2. **@前缀剥离**：群聊中 `@bot /cmd` 会剥离 `@bot`
3. **多行独立分发**：多行消息中的每条 `/cmd` 独立执行
4. **别名解析**：`/sh` → `/shell`，`/v` → `/version` 等
5. **大小写**：默认不区分大小写（可配置 `caseSensitive: true`）

## 阻塞式会话

以下命令进入阻塞模式，5 分钟无操作自动退出：

| 命令                   | 用途           | 退出方式                    |
| ---------------------- | -------------- | --------------------------- |
| `/init`                | 配置向导       | 完成或 `/init cancel`       |
| `/llm config`          | LLM 配置向导   | 完成或 `/llm config cancel` |
| `/term`                | 交互式终端     | `/term exit` 或 `exit`      |

阻塞式会话使用 session-scoped 隔离（同一用户 + 同一会话才捕获）。

## Node-only 命令

以下命令依赖 Node.js 运行时，在浏览器中调用会返回错误信息：

| 命令        | 依赖                 | 浏览器行为                      |
| ----------- | -------------------- | ------------------------------- |
| `/shell`    | `node:child_process` | 返回"需要 Node.js 运行时"       |
| `/term`     | `node:child_process` | 同上                            |
| `/myip`     | `node:os`（部分）    | 跳过本地接口检测，仅显示公网 IP |

## 命令帮助

- `/help` —— 显示所有命令分类
- `/help <命令名>` —— 显示单命令详细用法
- `/commands` —— 紧凑格式列出所有命令和别名

## 配置命令系统

```typescript
new YuanbaoBot({
  appKey,
  appSecret,
  commands: {
    prefix: "/", // 命令前缀
    caseSensitive: false, // 大小写敏感
    enableInGroup: true, // 群聊启用
    enableInDirect: true, // 私聊启用
    requireMentionInGroup: true, // 群聊需要 @bot
    helpHeader: "🤖 我的 Bot 命令",
    helpFooter: "输入 /help <命令名> 查看详细用法",
    showUsage: true, // 显示用法提示
  },
  customCommands: [
    /* ... */
  ],
});
```

禁用命令系统：

```typescript
new YuanbaoBot({
  appKey,
  appSecret,
  commands: false, // 完全禁用，减小 bundle
});
```
