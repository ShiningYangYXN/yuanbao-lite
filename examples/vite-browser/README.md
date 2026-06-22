# Vite 浏览器示例

这是一个最小化的 Vite + 浏览器示例，展示如何在前端应用中使用 yuanbao-lite。

## 运行

```bash
# 安装依赖
npm install

# 开发模式（带 CORS 代理）
npm run dev

# 构建
npm run build
```

## CORS 代理

浏览器无法直接访问 `bot.yuanbao.tencent.com`（CORS 限制）。本示例在
`vite.config.ts` 中配置了开发服务器代理，将 `/yb-api/*` 转发到腾讯端点。

生产环境需要部署一个 CORS 代理（Cloudflare Worker / Vercel Edge Function），
然后通过 `setHttpProxy()` 配置：

```typescript
import { setHttpProxy } from "yuanbao-lite";
setHttpProxy("https://your-proxy.workers.dev/");
```

## 文件说明

- `index.html` — 入口 HTML
- `src/main.ts` — 浏览器 Bot 示例
- `vite.config.ts` — Vite 配置（含开发代理）
- `src/browser-adapter.ts` — BrowserLocalStorageAdapter 示例实现
