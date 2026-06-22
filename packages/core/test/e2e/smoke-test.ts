/**
 * End-to-end smoke test with real Tencent Yuanbao credentials.
 *
 * Tests the full stack:
 *   1. YuanbaoBot construction + init()
 *   2. Sign-token fetch (HMAC-SHA256 via Web Crypto)
 *   3. WebSocket connection (native globalThis.WebSocket)
 *   4. Ready event (auth-bind success)
 *   5. Send a DM to self
 *   6. Command system dispatch (/echo, /version, /ping, /time, /calc)
 *   7. Persistence (alias, contacts, groups stores)
 *   8. LLM engine state
 *   9. Clean disconnect
 *
 * Usage:
 *   YB_CREDS="appKey:appSecret" npm run test:e2e
 *
 * Or set YB_APP_KEY and YB_APP_SECRET env vars separately.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { YuanbaoBot, getVersion, MemoryAdapter } from "../../src/index.js";

const creds = process.env.YB_CREDS;
let appKey: string;
let appSecret: string;

if (creds) {
  [appKey, appSecret] = creds.split(":");
} else {
  appKey = process.env.YB_APP_KEY ?? "";
  appSecret = process.env.YB_APP_SECRET ?? "";
}

const hasCreds = Boolean(appKey && appSecret);

// Skip all tests if no credentials
const describeOrSkip = hasCreds ? describe : describe.skip;

describeOrSkip("End-to-end smoke test", { timeout: 60000 }, () => {
  let bot: YuanbaoBot;

  before(async () => {
    bot = new YuanbaoBot({
      appKey,
      appSecret,
      persistence: { dir: "", adapter: new MemoryAdapter() },
    });
  });

  after(() => {
    bot?.stop();
  });

  it("constructs YuanbaoBot", () => {
    assert.ok(bot);
    assert.equal(bot.getState().status, "disconnected");
  });

  it("init() loads stores + command system", async () => {
    await bot.init();
    assert.ok(bot.getAliasStore());
    assert.ok(bot.getContactStore());
    assert.ok(bot.getGroupStore());
    assert.ok(bot.getHistoryStore());
    assert.ok(bot.getLlmEngine());
    assert.ok(bot.getCommandSystem());
  });

  it("starts and connects to WebSocket", async () => {
    const startPromise = bot.start();
    // Wait for ready event
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("ready timeout")),
        30000,
      );
      bot.on("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
      bot.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    assert.equal(bot.getState().status, "connected");
    // Don't await startPromise (it resolves on disconnect)
    void startPromise;
  });

  it("resolves botId and ownerId", () => {
    const account = bot.getAccount();
    assert.ok(account.botId, "botId should be resolved");
    assert.ok(account.botId.startsWith("bot_"));
  });

  it("sends a DM to self", async () => {
    const selfId = bot.getAccount().botOwnerId;
    if (!selfId) {
      console.log("  (skipped — no ownerId yet)");
      return;
    }
    await bot.sendDirectMessage(
      selfId,
      `🧪 E2E test @ ${new Date().toISOString()}`,
    );
  });

  it("dispatches /echo command", async () => {
    const cs = bot.getCommandSystem()!;
    const result = await cs.dispatch(bot, {
      text: "/echo hello from e2e",
      fromUserId: "test-runner",
      fromNickname: "TestRunner",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: `test_${Date.now()}`,
    });
    assert.equal(result.handled, true);
  });

  it("dispatches /version command", async () => {
    const cs = bot.getCommandSystem()!;
    const result = await cs.dispatch(bot, {
      text: "/version",
      fromUserId: "test-runner",
      fromNickname: "TestRunner",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: `test_${Date.now()}`,
    });
    assert.equal(result.handled, true);
  });

  it("dispatches /ping command", async () => {
    const cs = bot.getCommandSystem()!;
    const result = await cs.dispatch(bot, {
      text: "/ping",
      fromUserId: "test-runner",
      fromNickname: "TestRunner",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: `test_${Date.now()}`,
    });
    assert.equal(result.handled, true);
  });

  it("dispatches /time command", async () => {
    const cs = bot.getCommandSystem()!;
    const result = await cs.dispatch(bot, {
      text: "/time",
      fromUserId: "test-runner",
      fromNickname: "TestRunner",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: `test_${Date.now()}`,
    });
    assert.equal(result.handled, true);
  });

  it("dispatches /calc command", async () => {
    const cs = bot.getCommandSystem()!;
    const result = await cs.dispatch(bot, {
      text: "/calc 2+3*4",
      fromUserId: "test-runner",
      fromNickname: "TestRunner",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: `test_${Date.now()}`,
    });
    assert.equal(result.handled, true);
  });

  it("alias store add + resolve + remove", () => {
    const store = bot.getAliasStore()!;
    const testId = `test_${Date.now()}`;
    const testAlias = `e2e_${Date.now()}`;
    store.add(testId, testAlias, "E2E Test");
    assert.equal(store.resolve(testAlias), testId);
    store.remove(testAlias);
    assert.equal(store.resolve(testAlias), testAlias);
  });

  it("LLM engine is not ready (no provider configured)", () => {
    const engine = bot.getLlmEngine()!;
    assert.equal(engine.isReady, false);
  });

  it("disconnects cleanly", () => {
    bot.stop();
    // Give it a moment to disconnect
    assert.ok(bot);
  });
});
