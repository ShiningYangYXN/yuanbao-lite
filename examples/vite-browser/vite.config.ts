import { defineConfig } from "vite";

// Vite 配置 —— 含开发环境 CORS 代理
//
// 浏览器无法直接访问 bot.yuanbao.tencent.com（CORS 限制）。
// 开发模式下，Vite dev server 可以代理请求，绕过 CORS。
//
// 生产环境需要部署一个独立的 CORS 代理（Cloudflare Worker / Vercel
// Edge Function），然后通过 setHttpProxy() 配置。
export default defineConfig({
  // 将 yuanbao-lite 的 node:* 依赖标记为 external（浏览器运行时不需要）
  optimizeDeps: {
    exclude: ["node:*"],
  },
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "ai",
        "@ai-sdk/*",
        "protobufjs",
        "marked",
        "node:*",
        "util",
        "os",
      ],
    },
  },
  server: {
    // 开发环境代理 —— 将 /yb-api/* 转发到腾讯端点
    proxy: {
      "/yb-api": {
        target: "https://bot.yuanbao.tencent.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yb-api/, ""),
      },
      // COS 上传代理
      "/yb-cos": {
        target: "https://yuanbao-bot-1300000000.cos.ap-shanghai.myqcloud.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yb-cos/, ""),
      },
    },
  },
});
