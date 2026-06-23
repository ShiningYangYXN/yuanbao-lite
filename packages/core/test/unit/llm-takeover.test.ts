/**
 * LLM takeover engine tests.
 *
 * Tests:
 *   - Engine construction and config
 *   - isReady state
 *   - Provider configuration
 *   - Key pool management
 *   - Conversation manager
 *   - Markdown to IM text conversion
 *   - Context message formatting
 *
 * Note: Does NOT test actual LLM API calls (requires real API keys).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LlmTakeoverEngine,
  ConversationManager,
  markdownToImText,
  createLlmTakeover,
  API_FORMATS,
} from "../../src/business/llm-takeover.js";
import { MemoryAdapter } from "../../src/access/persistence/adapter.js";
import type { ChatMessage } from "../../src/types.js";

describe("LlmTakeoverEngine", () => {
  let engine: LlmTakeoverEngine;

  beforeEach(() => {
    engine = new LlmTakeoverEngine({
      persistencePath: "llm-config.json",
      persistenceAdapter: new MemoryAdapter(),
    });
  });

  it("constructs with default config", () => {
    const cfg = engine.getConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.temperature, 0.7);
    assert.ok(cfg.maxTokens > 0);
  });

  it("isReady is false without provider configured", () => {
    assert.equal(engine.isReady, false);
  });

  it("updateConfig sets provider", () => {
    engine.updateConfig({
      provider: "test-openai",
      customProviders: {
        "test-openai": {
          apiFormat: "openai-chat-completions",
          model: "gpt-4o",
          baseUrl: "https://api.openai.com/v1",
          apiKeys: ["sk-test"],
        },
      },
    });
    const cfg = engine.getConfig();
    assert.equal(cfg.provider, "test-openai");
    assert.ok(cfg.customProviders["test-openai"]);
  });

  it("isReady becomes true after configuring provider", () => {
    engine.updateConfig({
      provider: "test-openai",
      customProviders: {
        "test-openai": {
          apiFormat: "openai-chat-completions",
          model: "gpt-4o",
          baseUrl: "https://api.openai.com/v1",
          apiKeys: ["sk-test"],
        },
      },
    });
    assert.equal(engine.isReady, true);
  });

  it("getPoolStatus returns pool info", () => {
    const status = engine.getPoolStatus();
    assert.ok(typeof status.activeProvider === "string");
    assert.ok(typeof status.providerPoolSize === "number");
  });

  it("persistencePath is accessible", () => {
    assert.equal(engine.getPersistencePath(), "llm-config.json");
  });

  it("persistConfig writes to adapter", () => {
    engine.updateConfig({
      provider: "test",
      customProviders: {
        test: {
          apiFormat: "openai-chat-completions",
          model: "gpt-4o",
          baseUrl: "https://api.openai.com/v1",
          apiKeys: ["sk-test"],
        },
      },
    });
    // persistConfig is called internally by updateConfig
    // Verify by creating a new engine with same adapter
    const adapter = new MemoryAdapter();
    const e1 = new LlmTakeoverEngine({
      persistencePath: "llm.json",
      persistenceAdapter: adapter,
    });
    e1.updateConfig({ provider: "x" });
    const e2 = new LlmTakeoverEngine({
      persistencePath: "llm.json",
      persistenceAdapter: adapter,
    });
    assert.equal(e2.getConfig().provider, "x");
  });
});

describe("API_FORMATS", () => {
  it("exports supported API formats", () => {
    assert.ok(API_FORMATS);
    assert.ok(Array.isArray(API_FORMATS) || typeof API_FORMATS === "object");
  });
});

describe("createLlmTakeover factory", () => {
  it("creates engine instance", () => {
    const engine = createLlmTakeover({
      persistencePath: "test.json",
      persistenceAdapter: new MemoryAdapter(),
    });
    assert.ok(engine instanceof LlmTakeoverEngine);
  });
});

describe("ConversationManager", () => {
  it("constructs with max turns", () => {
    const cm = new ConversationManager(10);
    assert.ok(cm);
  });

  it("addMessage + getHistory", () => {
    const cm = new ConversationManager(10);
    cm.addMessage("session1", "user", "hello");
    cm.addMessage("session1", "assistant", "hi there");
    const history = cm.getHistory("session1");
    assert.ok(history.length >= 2);
  });

  it("respects maxTurns limit", () => {
    const cm = new ConversationManager(2);
    cm.addMessage("s1", "user", "msg1");
    cm.addMessage("s1", "assistant", "resp1");
    cm.addMessage("s1", "user", "msg2");
    cm.addMessage("s1", "assistant", "resp2");
    cm.addMessage("s1", "user", "msg3");
    const history = cm.getHistory("s1");
    // Should be limited to maxTurns * 2 (user + assistant pairs)
    assert.ok(history.length <= 4);
  });

  it("clearHistory removes messages", () => {
    const cm = new ConversationManager(10);
    cm.addMessage("s1", "user", "hello");
    cm.clear("s1");
    assert.equal(cm.getHistory("s1").length, 0);
  });
});

describe("markdownToImText", () => {
  it("converts bold", () => {
    const result = markdownToImText("**bold text**");
    assert.ok(result.includes("bold text"));
  });

  it("converts italic", () => {
    const result = markdownToImText("*italic*");
    assert.ok(result.includes("italic"));
  });

  it("converts links", () => {
    const result = markdownToImText("[click](https://example.com)");
    assert.ok(result.includes("click"));
    assert.ok(result.includes("example.com"));
  });

  it("preserves code blocks", () => {
    const result = markdownToImText("```\ncode\n```");
    assert.ok(result.includes("code"));
  });

  it("handles plain text unchanged", () => {
    const result = markdownToImText("just plain text");
    assert.ok(result.includes("just plain text"));
  });
});

describe("formatChatMessageForContext", () => {
  it("formats DM message", async () => {
    const { formatChatMessageForContext } =
      await import("../../src/business/llm-takeover.js");
    const msg: ChatMessage = {
      text: "hello",
      fromUserId: "u123",
      fromNickname: "Alice",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: "m1",
    };
    const formatted = formatChatMessageForContext(msg);
    assert.ok(formatted.includes("Alice"));
    assert.ok(formatted.includes("u123"));
    assert.ok(formatted.includes("hello"));
    assert.ok(formatted.includes("DM"));
  });

  it("formats group message", async () => {
    const { formatChatMessageForContext } =
      await import("../../src/business/llm-takeover.js");
    const msg: ChatMessage = {
      text: "hi everyone",
      fromUserId: "u123",
      fromNickname: "Alice",
      chatType: "group",
      groupCode: "g456",
      groupName: "Test Group",
      isMentioned: true,
      timestamp: Date.now(),
      msgId: "m1",
    };
    const formatted = formatChatMessageForContext(msg);
    assert.ok(formatted.includes("Test Group"));
    assert.ok(formatted.includes("hi everyone"));
  });

  it("includes quote suffix when present", async () => {
    const { formatChatMessageForContext } =
      await import("../../src/business/llm-takeover.js");
    const msg: ChatMessage = {
      text: "reply",
      fromUserId: "u1",
      fromNickname: "A",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: "m1",
      quoteMsgId: "quoted_msg_12345678",
    };
    const formatted = formatChatMessageForContext(msg);
    assert.ok(formatted.includes("引用"));
    assert.ok(formatted.includes("12345678"));
  });
});
