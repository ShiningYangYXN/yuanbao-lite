/**
 * Yuanbao Lite 浏览器示例 —— Vite + TypeScript
 *
 * 展示如何在浏览器中使用 yuanbao-lite：
 *   1. 配置 BrowserLocalStorageAdapter 持久化
 *   2. 设置 HTTP 代理（开发环境用 Vite proxy，生产环境用 Cloudflare Worker）
 *   3. 连接、收发消息
 */

import { YuanbaoBot, BrowserLocalStorageAdapter, setHttpProxy } from "@yuanbao-lite/core";

// ─── DOM 元素 ───
const logEl = document.getElementById("log")!;
const connectBtn = document.getElementById("connect") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const msgInput = document.getElementById("msgInput") as HTMLInputElement;
const appKeyInput = document.getElementById("appKey") as HTMLInputElement;
const appSecretInput = document.getElementById("appSecret") as HTMLInputElement;

let bot: YuanbaoBot | null = null;

// ─── 日志输出 ───
function log(text: string, cls = "msg-sys"): void {
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── 连接 ───
connectBtn.addEventListener("click", async () => {
  const appKey = appKeyInput.value.trim();
  const appSecret = appSecretInput.value.trim();
  if (!appKey || !appSecret) {
    log("❌ 请输入 AppKey 和 AppSecret");
    return;
  }

  // 开发环境：使用 Vite proxy（见 vite.config.ts）
  // 生产环境：替换为你的 CORS 代理 URL
  setHttpProxy("/yb-api/");

  log("🔄 正在连接...");

  bot = new YuanbaoBot({
    appKey,
    appSecret,
    commands: false, // 浏览器可禁用命令系统减小 bundle
    persistence: {
      dir: "yuanbao-lite",
      adapter: new BrowserLocalStorageAdapter({ prefix: "yb-demo:" }),
    },
  });

  bot.on("ready", () => {
    log("✅ 已连接！");
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    sendBtn.disabled = false;
    msgInput.disabled = false;
  });

  bot.on("message", (msg) => {
    log(`📩 [${msg.fromNickname}]: ${msg.text}`, "msg-in");
  });

  bot.on("error", (err) => {
    log(`❌ 错误: ${err.message}`);
  });

  bot.on("close", () => {
    log("🔌 连接已关闭");
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    sendBtn.disabled = true;
    msgInput.disabled = true;
  });

  await bot.start();
});

// ─── 断开 ───
disconnectBtn.addEventListener("click", () => {
  bot?.stop();
});

// ─── 发送消息 ───
sendBtn.addEventListener("click", async () => {
  const text = msgInput.value.trim();
  if (!text || !bot) return;

  const selfId = bot.getAccount().botOwnerId;
  if (!selfId) {
    log("❌ 尚未获取到自己的 userId");
    return;
  }

  try {
    await bot.sendDirectMessage(selfId, text);
    log(`📤 ${text}`, "msg-out");
    msgInput.value = "";
  } catch (err) {
    log(`❌ 发送失败: ${(err as Error).message}`);
  }
});

msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

log("💡 输入 AppKey 和 AppSecret，然后点击连接");
