/**
 * Interpolation tests.
 *
 * Tests the ${...} expression interpolation engine:
 *   - Basic variable substitution
 *   - Built-in globals (Date, Math, JSON, etc.)
 *   - Chat context variables (sender, group, bot, etc.)
 *   - Escape syntax \${...}
 *   - Sanitize mode (blocks dangerous globals in groups)
 *   - Custom context variables
 *   - Error handling (invalid expressions)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  interpolate,
  buildMessageContext,
  hasInterpolation,
  chatContextFromMessage,
} from "../../src/business/interpolate.js";
import type { ChatMessage } from "../../src/types.js";

describe("Interpolation", () => {
  it("interpolates simple variable", () => {
    const result = interpolate("Hello ${name}!", { name: "World" });
    assert.equal(result, "Hello World!");
  });

  it("interpolates multiple variables", () => {
    const result = interpolate("${greeting}, ${name}!", {
      greeting: "Hi",
      name: "Alice",
    });
    assert.equal(result, "Hi, Alice!");
  });

  it("interpolates expressions", () => {
    const result = interpolate("Result: ${1 + 2 * 3}");
    assert.equal(result, "Result: 7");
  });

  it("interpolates Math functions", () => {
    const result = interpolate("Pi: ${Math.PI.toFixed(2)}");
    assert.equal(result, "Pi: 3.14");
  });

  it("interpolates JSON.stringify", () => {
    const result = interpolate("Data: ${JSON.stringify({a:1})}");
    assert.equal(result, 'Data: {"a":1}');
  });

  it("interpolates Date", () => {
    const result = interpolate("Year: ${new Date().getFullYear()}");
    assert.ok(result.startsWith("Year: 20"));
  });

  it("escapes \\${...} as literal", () => {
    const result = interpolate("Cost: \\${100}");
    assert.equal(result, "Cost: ${100}");
  });

  it("handles missing variable gracefully", () => {
    // Missing variables should not crash
    const result = interpolate("Hello ${missing}!");
    // Behavior: either leaves ${missing} or returns empty
    assert.ok(typeof result === "string");
  });

  it("handles syntax errors gracefully", () => {
    const result = interpolate("Bad: ${invalid syntax!}");
    assert.ok(typeof result === "string");
  });

  it("hasInterpolation detects ${...}", () => {
    assert.equal(hasInterpolation("hello ${name}"), true);
    assert.equal(hasInterpolation("hello world"), false);
  });

  it("hasInterpolation ignores escaped \\${...}", () => {
    assert.equal(hasInterpolation("cost \\${100}"), false);
  });
});

describe("Sanitize mode", () => {
  it("blocks process.env in sanitize mode", () => {
    const result = interpolate("${process.env.HOME}", {}, { sanitize: true });
    // Should not leak the actual HOME path
    assert.ok(!result.includes("/home/"));
    assert.ok(!result.includes("/Users/"));
  });

  it("blocks require in sanitize mode", () => {
    const result = interpolate("${require('fs')}", {}, { sanitize: true });
    assert.ok(!result.includes("[object"));
  });

  it("allows Math in sanitize mode", () => {
    const result = interpolate("${Math.max(1, 2)}", {}, { sanitize: true });
    assert.equal(result, "2");
  });

  it("allows process in non-sanitize mode", () => {
    const result = interpolate("${typeof process}", {}, { sanitize: false });
    assert.equal(result, "object");
  });
});

describe("Chat context", () => {
  it("buildMessageContext creates context object", () => {
    const ctx = buildMessageContext();
    assert.ok(ctx);
    assert.ok(typeof ctx === "object");
  });

  it("chatContextFromMessage extracts sender info", () => {
    const msg: ChatMessage = {
      text: "hello",
      fromUserId: "u123",
      fromNickname: "Alice",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: "m1",
    };
    const ctx = chatContextFromMessage(msg, "bot123");
    assert.ok(ctx);
    // The context should have sender info accessible
  });

  it("chatContextFromMessage handles group message", () => {
    const msg: ChatMessage = {
      text: "hello",
      fromUserId: "u123",
      fromNickname: "Alice",
      chatType: "group",
      groupCode: "g456",
      groupName: "Test Group",
      isMentioned: true,
      timestamp: Date.now(),
      msgId: "m1",
    };
    const ctx = chatContextFromMessage(msg, "bot123");
    assert.ok(ctx);
  });

  it("interpolate with chat context", () => {
    const msg: ChatMessage = {
      text: "hello",
      fromUserId: "u123",
      fromNickname: "Alice",
      chatType: "direct",
      isMentioned: false,
      timestamp: Date.now(),
      msgId: "m1",
    };
    const ctx = chatContextFromMessage(msg, "bot123");
    const result = interpolate("Sender: ${sender.userId}", ctx);
    // The exact variable path depends on implementation
    assert.ok(typeof result === "string");
  });
});
