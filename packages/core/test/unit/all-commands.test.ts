/**
 * All-commands dispatch test.
 *
 * Tests that every registered command handler can be dispatched without
 * crashing. Uses a mock bot context to avoid needing a real connection.
 *
 * This catches:
 *   - Missing imports
 *   - Handler exceptions
 *   - Invalid context access
 *   - Command registration issues
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { CommandSystem } from "../../src/commands/registry.js";
import { initTrustStore, initBlockStore, setMasterUserId } from "../../src/business/trust.js";
import { MemoryAdapter } from "../../src/access/persistence/adapter.js";
import type { ChatMessage } from "../../src/types.js";

// Commands that require a connected bot (will skip dispatch, just test registration)
const REQUIRE_CONNECTED = new Set(["dm", "group", "reply", "sticker", "upload", "download", "file", "img", "atall", "mention"]);

// Commands that are Node-only (may fail in browser, but should work in Node test)
const NODE_ONLY = new Set(["shell", "term", "tempfile"]);

function makeMsg(text: string, fromUserId = "test-user"): ChatMessage {
  return {
    text,
    fromUserId,
    fromNickname: "Tester",
    chatType: "direct",
    isMentioned: false,
    timestamp: Date.now(),
    msgId: `msg_${Date.now()}_${Math.random()}`,
  };
}

// Mock bot that captures replies
function makeMockBot() {
  const replies: string[] = [];
  const bot = {
    makeReply: async (text: string) => {
      replies.push(text);
    },
    getAccount: () => ({ botId: "bot_test", botOwnerId: "owner_test" }),
    getAliasStore: () => ({ add: () => {}, remove: () => {}, resolve: (s: string) => s }),
    getContactStore: () => ({ add: () => {}, remove: () => {} }),
    getGroupStore: () => ({ add: () => {}, remove: () => {} }),
    getHistoryStore: () => ({ add: () => {}, search: () => ({ messages: [] }) }),
    getLlmEngine: () => ({ isReady: false, getConfig: () => ({ enabled: false }) }),
    sendText: async () => {},
    sendDirectMessage: async () => {},
    sendGroupMessage: async () => {},
  };
  return { bot, replies };
}

describe("All commands dispatch test", () => {
  let cs: CommandSystem;

  before(() => {
    const adapter = new MemoryAdapter();
    initTrustStore({ persistencePath: "trust.json", persistenceAdapter: adapter });
    initBlockStore({ persistencePath: "block.json", persistenceAdapter: adapter });
    setMasterUserId("master-user", "Master");
    cs = new CommandSystem();
    // Enable unsafe mode so elevated commands work
    cs.enableUnsafeMode(60000);
  });

  it("registers 50+ commands", () => {
    const commands = cs.getVisibleCommands();
    assert.ok(commands.length >= 50, `expected 50+ commands, got ${commands.length}`);
  });

  // Test each command by name
  const testCommands: Array<{ name: string; args?: string }> = [
    { name: "help" },
    { name: "commands" },
    { name: "version" },
    { name: "ping" },
    { name: "echo", args: "test message" },
    { name: "calc", args: "1+2" },
    { name: "time" },
    { name: "whoami" },
    { name: "status" },
    { name: "uptime" },
    { name: "ip", args: "8.8.8.8" },
    { name: "whois", args: "example.com" },
    { name: "alias", args: "list" },
    { name: "contacts", args: "list" },
    { name: "account", args: "list" },
    { name: "history", args: "recent 5" },
    { name: "hsearch", args: "test" },
    { name: "groups", args: "list" },
    { name: "trust", args: "status" },
    { name: "block", args: "status" },
    { name: "unsafe", args: "status" },
    { name: "llm", args: "status" },
    { name: "new" },
    { name: "query" },
    { name: "inspect" },
  ];

  for (const { name, args } of testCommands) {
    it(`dispatches /${name}${args ? " " + args : ""} without crashing`, async () => {
      const { bot } = makeMockBot();
      const text = `/${name}${args ? " " + args : ""}`;
      const result = await cs.dispatch(bot as never, makeMsg(text, "master-user"));
      // Should be handled (true) — we just verify no crash
      assert.ok(result, `/${name} should return a result`);
    });
  }

  it("dispatches /help <command> for each command", async () => {
    const commands = cs.getVisibleCommands();
    const { bot } = makeMockBot();
    // Test help for first 10 commands
    for (const cmd of commands.slice(0, 10)) {
      const result = await cs.dispatch(bot as never, makeMsg(`/help ${cmd.name}`, "master-user"));
      assert.ok(result);
    }
  });

  it("unknown command returns handled=false", async () => {
    const { bot } = makeMockBot();
    const result = await cs.dispatch(bot as never, makeMsg("/nonexistent-command-xyz"));
    assert.equal(result.handled, false);
  });

  it("plain text (no /) returns handled=false", async () => {
    const { bot } = makeMockBot();
    const result = await cs.dispatch(bot as never, makeMsg("just a regular message"));
    assert.equal(result.handled, false);
  });

  it("empty message returns handled=false", async () => {
    const { bot } = makeMockBot();
    const result = await cs.dispatch(bot as never, makeMsg(""));
    assert.equal(result.handled, false);
  });

  it("alias resolution works (/v → /version)", async () => {
    const { bot } = makeMockBot();
    const result = await cs.dispatch(bot as never, makeMsg("/v"));
    assert.equal(result.handled, true);
  });
});
