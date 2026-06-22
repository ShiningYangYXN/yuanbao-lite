# 安全模型

Yuanbao Lite 实现多层级安全机制，防止未授权用户执行危险操作。

## 权限优先级

```
block > trust > unsafe
```

1. **block（封禁）**：最高优先级，被封禁用户被拒绝所有交互
2. **trust（信任）**：受信用户可执行 elevated 命令
3. **unsafe（危险模式）**：临时全局授权（5 分钟窗口）

## 1. 封禁系统（block）

**位置**：`src/business/block.ts`
**持久化**：`~/.yuanbao-lite/block.json`

### 封禁范围

每个用户可有多个封禁范围（叠加）：

| 范围        | 说明                       |
| ----------- | -------------------------- |
| `[all]`     | 拒绝所有交互（命令 + LLM） |
| `[llm]`     | 拒绝 LLM 自动回复          |
| `[command]` | 拒绝所有斜杠命令           |
| `<命令名>`  | 拒绝特定命令（如 `shell`） |

**注意**：权限组必须带方括号，命令名不带。

### 操作命令

```text
/block status                    # 查看封禁状态
/block list                      # 查看封禁列表
/block add <用户ID|*> <范围>      # 封禁用户
/block remove <用户ID|*> [范围]   # 解封
```

### 示例

```text
/block add user123 [all]              # 全封禁 user123
/block add user123 [llm]              # 仅禁止 LLM
/block add user123 shell              # 仅禁止 /shell
/block add * [command]                # 所有人禁止命令（仅 master 例外）
/block remove user123                 # 完全解封
/block remove user123 [llm]           # 仅解除 LLM 封禁
```

### 主人保护

Bot 所有者（master）**不能被封禁**。`addBlock()` 会拒绝并返回错误。

## 2. 信任系统（trust）

**位置**：`src/business/trust.ts`
**持久化**：`~/.yuanbao-lite/trust.json`

### 信任列表

受信用户可以在群聊中执行 elevated 命令（不需 unsafe 模式）。

```text
/trust status                    # 查看信任状态
/trust list                      # 查看信任列表
/trust add <用户ID> [昵称]        # 添加信任
/trust remove <用户ID>            # 移除信任（master 不可移除）
```

### 单命令授权

更细粒度的控制：授权特定用户执行特定命令。

```text
/trust grant <用户ID> <命令> [分钟]   # 授权（默认 5 分钟，forever=永久）
/trust revoke <用户ID> <命令>          # 撤销
/trust grants [用户ID]                # 查看授权
```

### 主人（master）

- Bot 所有者自动成为 master，永远受信
- master 不可被移除信任
- master 不可被封禁
- master 可以使用 `/unsafe on`

```typescript
// 引擎自动检测并设置 master
bot.on("ready", async () => {
  const ownerId = bot.getAccount().botOwnerId;
  if (ownerId) {
    setMasterUserId(ownerId, "主人");
  }
});
```

## 3. Unsafe 模式

**位置**：`src/commands/registry.ts`

临时全局授权，允许群聊中所有 elevated 命令。

```text
/unsafe status                    # 查看状态
/unsafe on [分钟/forever]         # 开启（默认 5 分钟，需受信）
/unsafe off                       # 关闭
/unsafe allow <命令> [分钟]        # 全局授权单命令
/unsafe disallow <命令>            # 取消授权
```

### 不可授权命令

以下命令不能通过 `/unsafe allow` 授权（安全考虑）：

- `unsafe` 本身
- `trust`、`block`
- `config`、`init`
- `daemon`
- `shell`

## 4. 插值安全

`${}` 表达式插值可能允许用户执行任意 JavaScript。Yuanbao Lite 实现两级防护：

### 群聊默认安全模式

在群聊中（非 unsafe 模式），插值会屏蔽危险全局变量：

```typescript
const blocked = [
  "process",
  "require",
  "module",
  "exports",
  "global",
  "GLOBAL",
  "root",
  "child_process",
  "fs",
  "path",
  "os",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "eval",
  "Function",
];
```

这防止群成员通过 `${process.env.HOME}` 等提取服务器信息。

### 私聊/Unsafe 模式

在私聊或 unsafe 模式下，插值不受限制（Bot 所有者信任）。

### 转义

使用 `\${...}` 输出字面量 `${...}`。

## 5. 命令权限检查流程

```
收到命令 /xxx
    │
    ▼
检查 block ──→ 被封禁？ ──→ 是 ──→ 拒绝
    │
    否
    ▼
命令是 elevated？ ──→ 否 ──→ 执行
    │
    是
    ▼
检查 unsafe 模式 ──→ 开启？ ──→ 是 ──→ 执行
    │
    否
    ▼
检查 trust ──→ 受信？ ──→ 是 ──→ 执行
    │
    否
    ▼
检查单命令授权 ──→ 已授权？ ──→ 是 ──→ 执行
    │
    否
    ▼
检查来源 ──→ CLI？ ──→ 是 ──→ 执行（全局最高权限）
    │
    否
    ▼
拒绝（提示需要权限）
```

## 6. CLI 全局权限

通过 CLI 执行的所有命令绕过所有限制。这是设计行为：

- CLI 用户通常就是 Bot 所有者
- CLI 通过 daemon 本地 HTTP 执行（127.0.0.1）
- 远程访问需通过 SSH 隧道

## 7. 凭据安全

### 文件权限

```bash
chmod 600 ~/.yuanbao-lite/config.json
chmod 600 ~/.yuanbao-lite/llm-config.json
chmod 700 ~/.yuanbao-lite/
```

### 日志脱敏

Logger 自动屏蔽敏感字段：

```typescript
const SENSITIVE_KEYS = new Set([
  "token",
  "signature",
  "app_key",
  "appkey",
  "appsecret",
  "app_secret",
  "secret",
  "password",
  "x-token",
  "cloud_custom_data",
  "model_output",
]);

function maskValue(value: string): string {
  if (value.length < 8) return "***";
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}
```

### API Key 池安全

LLM API Keys 存储在 `llm-config.json`，日志中仅显示前 3 + 后 3 字符。

## 8. 网络安全

### daemon 仅监听本地

daemon 绑定 `127.0.0.1:8992`，不接受外部连接。

### WebSocket 加密

使用 `wss://`（WebSocket Secure），所有通信加密传输。

### Sign-Token 刷新

Token 有效期 24 小时，自动刷新。认证失败时立即刷新。

## 9. 安全审计清单

部署前检查：

- [ ] `~/.yuanbao-lite/` 目录权限 700
- [ ] `config.json` 权限 600
- [ ] `llm-config.json` 权限 600
- [ ] daemon 仅监听 127.0.0.1
- [ ] 非必要不开启 unsafe 模式
- [ ] 群聊中 requireMentionInGroup: true（默认）
- [ ] 定期检查 `/trust list` 和 `/block list`
- [ ] 不要在代码仓库中提交凭据
- [ ] LLM 系统提示词不暴露内部命令结构

## 10. 漏洞报告

发现安全问题请通过 [GitHub Issues](https://github.com/ShiningYangYXN/yuanbao-lite/issues) 私密报告。
