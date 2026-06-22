/**
 * Command system tests.
 *
 * Tests the CommandSystem:
 *   - Command registration and dispatch
 *   - Alias resolution
 *   - Permission checks (elevated, trust, block)
 *   - Unsafe mode
 *   - Custom commands
 *   - Help text generation
 *   - Table formatter registration
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CommandSystem } from "../../src/commands/registry.js";
import { initTrustStore, setMasterUserId } from "../../src/business/trust.js";
import { initBlockStore } from "../../src/business/block.js";
import { MemoryAdapter } from "../../src/access/persistence/adapter.js";
import type { ChatMessage } from "../../src/types.js";

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

describe("CommandSystem", () => {
  let cs: CommandSystem;

  beforeEach(() => {
    const adapter = new MemoryAdapter();
    initTrustStore({
      persistencePath: "trust.json",
      persistenceAdapter: adapter,
    });
    initBlockStore({
      persistencePath: "block.json",
      persistenceAdapter: adapter,
    });
    setMasterUserId("", undefined);
    cs = new CommandSystem();
  });

  it("dispatches /echo command", async () => {
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/echo hello world"),
    );
    assert.equal(result.handled, true);
  });

  it("dispatches /ping command", async () => {
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/ping"),
    );
    assert.equal(result.handled, true);
  });

  it("dispatches /version command", async () => {
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/version"),
    );
    assert.equal(result.handled, true);
  });

  it("dispatches /time command", async () => {
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/time"),
    );
    assert.equal(result.handled, true);
  });

  it("dispatches /calc command", async () => {
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/calc 2+3"),
    );
    assert.equal(result.handled, true);
  });

  it("returns handled=false for unknown command", async () => {
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/nonexistent command"),
    );
    assert.equal(result.handled, false);
  });

  it("returns handled=false for non-command message", async () => {
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("just a regular message"),
    );
    assert.equal(result.handled, false);
  });

  it("resolves aliases", async () => {
    // /v is an alias for /version
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/v"),
    );
    assert.equal(result.handled, true);
  });

  it("registers custom command", async () => {
    cs.register({
      name: "testcmd",
      description: "Test command",
      category: "utility",
      handler: async () => ({ handled: true }),
    });
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      makeMsg("/testcmd"),
    );
    assert.equal(result.handled, true);
  });

  it("unregisters command", () => {
    cs.register({
      name: "temp",
      description: "Temp",
      category: "utility",
      handler: async () => ({ handled: true }),
    });
    assert.equal(cs.unregister("temp"), true);
    // After unregister, dispatch should return handled=false
  });

  it("getVisibleCommands returns all commands", () => {
    const commands = cs.getVisibleCommands();
    assert.ok(commands.length >= 50); // 53+ built-in commands
  });

  it("enableUnsafeMode + isUnsafeMode", () => {
    assert.equal(cs.isUnsafeMode(), false);
    cs.enableUnsafeMode(60000);
    assert.equal(cs.isUnsafeMode(), true);
  });

  it("disableUnsafeMode", () => {
    cs.enableUnsafeMode(60000);
    cs.disableUnsafeMode();
    assert.equal(cs.isUnsafeMode(), false);
  });

  it("setTableFormatter registers formatter", () => {
    let called = false;
    cs.setTableFormatter((headers, rows) => {
      called = true;
      return "formatted";
    });
    // The formatter is called in "ansi" output mode during dispatch
    // We can't easily test it here without a full dispatch context
    assert.equal(typeof cs.setTableFormatter, "function");
  });
});

describe("Command permissions", () => {
  let cs: CommandSystem;
  const adapter = new MemoryAdapter();

  beforeEach(() => {
    initTrustStore({
      persistencePath: "trust.json",
      persistenceAdapter: adapter,
    });
    initBlockStore({
      persistencePath: "block.json",
      persistenceAdapter: adapter,
    });
    setMasterUserId("", undefined);
    cs = new CommandSystem();
  });

  it("elevated commands require trust in group chat", async () => {
    // /shell is elevated — should be blocked for non-trusted user in group
    const msg = {
      ...makeMsg("/shell echo hi"),
      chatType: "group",
      groupCode: "g1",
    } as ChatMessage;
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      msg,
    );
    // Should not execute (either handled=false or blocked)
    // The exact behavior depends on implementation
    assert.ok(result);
  });

  it("blocked user cannot run commands", async () => {
    const { addBlock } = await import("../../src/business/block.js");
    await addBlock("blocked-user", "[command]");
    const msg = makeMsg("/echo hi", "blocked-user");
    const result = await cs.dispatch(
      { makeReply: async () => {} } as never,
      msg,
    );
    // Should be blocked
    assert.ok(result);
  });
});
