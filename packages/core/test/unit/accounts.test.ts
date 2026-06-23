/**
 * Account resolver tests.
 *
 * Tests:
 *   - resolveAccount with full config
 *   - Default values
 *   - Token parsing (appKey:appSecret format)
 *   - Missing credentials
 *   - Overflow policy / reply-to mode
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAccount } from "../../src/accounts.js";
import type { YuanbaoAccountConfig } from "../../src/types.js";

describe("resolveAccount", () => {
  it("resolves with appKey + appSecret", () => {
    const account = resolveAccount({
      appKey: "test-key",
      appSecret: "test-secret",
    });
    assert.equal(account.configured, true);
    assert.equal(account.appKey, "test-key");
    assert.equal(account.appSecret, "test-secret");
  });

  it("uses default API domain", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.equal(account.apiDomain, "bot.yuanbao.tencent.com");
  });

  it("uses default WS gateway URL", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.ok(account.wsGatewayUrl.includes("bot-wss.yuanbao.tencent.com"));
  });

  it("parses token in appKey:appSecret format", () => {
    const account = resolveAccount({
      token: "mykey:mysecret",
    } as YuanbaoAccountConfig);
    assert.equal(account.appKey, "mykey");
    assert.equal(account.appSecret, "mysecret");
    assert.equal(account.token, undefined); // token cleared after parsing
  });

  it("configured=false when missing credentials", () => {
    const account = resolveAccount({});
    assert.equal(account.configured, false);
  });

  it("respects custom apiDomain", () => {
    const account = resolveAccount({
      appKey: "k",
      appSecret: "s",
      apiDomain: "custom.example.com",
    });
    assert.equal(account.apiDomain, "custom.example.com");
  });

  it("respects custom wsUrl", () => {
    const account = resolveAccount({
      appKey: "k",
      appSecret: "s",
      wsUrl: "wss://custom-ws.example.com/path",
    });
    assert.equal(account.wsGatewayUrl, "wss://custom-ws.example.com/path");
  });

  it("applies default mediaMaxMb", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.equal(account.mediaMaxMb, 20);
  });

  it("respects custom mediaMaxMb", () => {
    const account = resolveAccount({
      appKey: "k",
      appSecret: "s",
      mediaMaxMb: 50,
    });
    assert.equal(account.mediaMaxMb, 50);
  });

  it("applies default historyLimit", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.equal(account.historyLimit, 100);
  });

  it("applies default overflowPolicy", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.equal(account.overflowPolicy, "split");
  });

  it("respects overflowPolicy=stop", () => {
    const account = resolveAccount({
      appKey: "k",
      appSecret: "s",
      overflowPolicy: "stop",
    });
    assert.equal(account.overflowPolicy, "stop");
  });

  it("applies default replyToMode", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.equal(account.replyToMode, "first");
  });

  it("respects replyToMode=all", () => {
    const account = resolveAccount({
      appKey: "k",
      appSecret: "s",
      replyToMode: "all",
    });
    assert.equal(account.replyToMode, "all");
  });

  it("applies default requireMention", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.equal(account.requireMention, true);
  });

  it("applies default fallbackReply", () => {
    const account = resolveAccount({ appKey: "k", appSecret: "s" });
    assert.ok(account.fallbackReply.length > 0);
  });
});
