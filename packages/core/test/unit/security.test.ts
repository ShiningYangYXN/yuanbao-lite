/**
 * Trust + Block system tests.
 *
 * Tests the security model:
 *   - Trust list (add, remove, list, check)
 *   - Block list (add, remove, list, check)
 *   - Priority: block > trust > unsafe
 *   - Master user protection (cannot be blocked/removed)
 *   - Single-command grants
 *   - Persistence
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  initTrustStore,
  addTrust,
  removeTrust,
  isTrusted,
  getTrustEntry,
  listTrust,
  setMasterUserId,
  getMasterUserId,
  removeTrustOnBlock,
  grantCommand,
  revokeCommand,
  listCommandGrants,
  hasCommandGrant,
  clearGrantTimers,
} from "../../src/business/trust.js";
import {
  initBlockStore,
  addBlock,
  removeBlock,
  isBlocked,
  isBlockedFrom,
  isBlockedFromLlm,
  isBlockedFromCommand,
  listBlocks,
  getBlockEntry,
} from "../../src/business/block.js";
import { MemoryAdapter } from "../../src/access/persistence/adapter.js";

describe("Trust system", () => {
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
    setMasterUserId("", undefined); // reset
  });

  afterEach(() => {
    clearGrantTimers();
  });

  it("addTrust + isTrusted", async () => {
    await addTrust("user123", "Alice");
    assert.equal(isTrusted("user123"), true);
  });

  it("isTrusted returns false for unknown user", () => {
    assert.equal(isTrusted("unknown"), false);
  });

  it("removeTrust", async () => {
    await addTrust("user123", "Alice");
    const result = await removeTrust("user123");
    assert.equal(result.ok, true);
    assert.equal(isTrusted("user123"), false);
  });

  it("listTrust returns all entries", async () => {
    await addTrust("u1", "Alice");
    await addTrust("u2", "Bob");
    const list = listTrust();
    assert.equal(list.length, 2);
  });

  it("getTrustEntry returns entry", async () => {
    await addTrust("u1", "Alice");
    const entry = getTrustEntry("u1");
    assert.ok(entry);
    assert.equal(entry?.userId, "u1");
    assert.equal(entry?.nickname, "Alice");
  });

  it("setMasterUserId + getMasterUserId", () => {
    setMasterUserId("master123", "Master");
    assert.equal(getMasterUserId(), "master123");
  });

  it("master is automatically trusted", () => {
    setMasterUserId("master123", "Master");
    assert.equal(isTrusted("master123"), true);
  });

  it("master cannot be removed from trust", async () => {
    setMasterUserId("master123", "Master");
    const result = await removeTrust("master123");
    assert.equal(result.ok, false);
    assert.equal(isTrusted("master123"), true);
  });
});

describe("Block system", () => {
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
  });

  it("addBlock [all] blocks everything", async () => {
    await addBlock("user123", "[all]");
    assert.equal(isBlocked("user123"), true);
    assert.equal(isBlockedFrom("user123", "all"), true);
    assert.equal(isBlockedFromLlm("user123"), true);
    assert.equal(isBlockedFromCommand("user123", "shell"), true);
  });

  it("addBlock [llm] only blocks LLM", async () => {
    await addBlock("user123", "[llm]");
    assert.equal(isBlockedFromLlm("user123"), true);
    assert.equal(isBlockedFromCommand("user123", "shell"), false);
  });

  it("addBlock [command] blocks all commands", async () => {
    await addBlock("user123", "[command]");
    assert.equal(isBlockedFromCommand("user123", "shell"), true);
    assert.equal(isBlockedFromCommand("user123", "echo"), true);
    assert.equal(isBlockedFromLlm("user123"), false);
  });

  it("addBlock <cmd> blocks specific command", async () => {
    await addBlock("user123", "shell");
    assert.equal(isBlockedFromCommand("user123", "shell"), true);
    assert.equal(isBlockedFromCommand("user123", "echo"), false);
  });

  it("addBlock * matches all users", async () => {
    await addBlock("*", "[llm]");
    assert.equal(isBlockedFromLlm("anyUser"), true);
  });

  it("removeBlock removes specific scope", async () => {
    await addBlock("user123", "[llm]");
    await addBlock("user123", "shell");
    const result = removeBlock("user123", "[llm]");
    assert.equal(result.ok, true);
    assert.equal(isBlockedFromLlm("user123"), false);
    assert.equal(isBlockedFromCommand("user123", "shell"), true);
  });

  it("removeBlock without scope removes all", async () => {
    await addBlock("user123", "[llm]");
    await addBlock("user123", "shell");
    const result = removeBlock("user123");
    assert.equal(result.ok, true);
    assert.equal(isBlocked("user123"), false);
  });

  it("listBlocks returns all entries", async () => {
    await addBlock("u1", "[all]");
    await addBlock("u2", "[llm]");
    const list = listBlocks();
    assert.equal(list.length, 2);
  });

  it("master cannot be blocked", async () => {
    setMasterUserId("master123", "Master");
    const result = await addBlock("master123", "[all]");
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("主人"));
  });

  it("blocking a user removes them from trust", async () => {
    await addTrust("user123", "Alice");
    assert.equal(isTrusted("user123"), true);
    await addBlock("user123", "[all]");
    assert.equal(isTrusted("user123"), false);
  });
});

describe("Single-command grants", () => {
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
  });

  afterEach(() => {
    clearGrantTimers();
  });

  it("grantCommand + listCommandGrants", async () => {
    await grantCommand("user123", "shell", 60 * 60 * 1000); // 60 minutes in ms
    const grants = listCommandGrants("user123");
    assert.ok(grants.some((g) => g.command === "shell"));
  });

  it("revokeCommand", async () => {
    await grantCommand("user123", "shell", 60 * 60 * 1000);
    const result = revokeCommand("user123", "shell");
    assert.equal(result.ok, true);
    const grants = listCommandGrants("user123");
    assert.ok(!grants.some((g) => g.command === "shell"));
  });
});
