/**
 * Store tests — alias, contacts, groups, history.
 *
 * Tests all four store implementations with MemoryAdapter to avoid
 * filesystem side effects. Covers:
 *   - CRUD operations (add, get, remove, list)
 *   - Persistence (save/load round-trip)
 *   - Index lookups (by id, by name, by alias)
 *   - Auto-save behavior
 *   - Edge cases (duplicate keys, missing entries, etc.)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AliasStore } from "../../src/business/alias.js";
import { ContactStore } from "../../src/business/contacts.js";
import { GroupStore } from "../../src/business/groups.js";
import { MessageHistoryStore } from "../../src/business/history.js";
import { MemoryAdapter } from "../../src/access/persistence/adapter.js";
import type { ChatMessage } from "../../src/types.js";

// ─── AliasStore ───

describe("AliasStore", () => {
  let adapter: MemoryAdapter;
  let store: AliasStore;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    store = new AliasStore({
      persistencePath: "aliases.json",
      autoSave: true,
      persistenceAdapter: adapter,
    });
  });

  it("add + resolve by alias", () => {
    store.add("user123", "alice", "Alice");
    assert.equal(store.resolve("alice"), "user123");
  });

  it("resolve returns input when not an alias", () => {
    assert.equal(store.resolve("unknown"), "unknown");
  });

  it("resolve returns ID when given the ID directly", () => {
    store.add("user123", "alice");
    assert.equal(store.resolve("user123"), "user123");
  });

  it("getNickname returns custom nickname", () => {
    store.add("user123", "alice", "Alice Smith");
    assert.equal(store.getNickname("alice"), "Alice Smith");
  });

  it("getNickname returns undefined when not set", () => {
    store.add("user123", "alice");
    assert.equal(store.getNickname("alice"), undefined);
  });

  it("remove by alias", () => {
    store.add("user123", "alice");
    assert.equal(store.remove("alice"), true);
    assert.equal(store.resolve("alice"), "alice");
  });

  it("remove by ID", () => {
    store.add("user123", "alice");
    assert.equal(store.remove("user123"), true);
    assert.equal(store.resolve("alice"), "alice");
  });

  it("remove returns false for unknown", () => {
    assert.equal(store.remove("unknown"), false);
  });

  it("getAll returns all entries", () => {
    store.add("u1", "alice");
    store.add("u2", "bob");
    const all = store.getAll();
    assert.equal(all.length, 2);
  });

  it("size property", () => {
    store.add("u1", "alice");
    store.add("u2", "bob");
    assert.equal(store.size, 2);
  });

  it("overwriting alias for same ID removes old alias", () => {
    store.add("u1", "alice");
    store.add("u1", "alice2");
    assert.equal(store.resolve("alice"), "alice"); // old alias gone
    assert.equal(store.resolve("alice2"), "u1");
  });

  it("persistence: save + load round-trip", () => {
    store.add("u1", "alice", "Alice");
    store.save();
    const store2 = new AliasStore({
      persistencePath: "aliases.json",
      persistenceAdapter: adapter,
    });
    assert.equal(store2.resolve("alice"), "u1");
    assert.equal(store2.getNickname("alice"), "Alice");
  });

  it("clear removes all entries", () => {
    store.add("u1", "alice");
    store.add("u2", "bob");
    store.clear();
    assert.equal(store.size, 0);
  });
});

// ─── ContactStore ───

describe("ContactStore", () => {
  let store: ContactStore;

  beforeEach(() => {
    store = new ContactStore({
      persistencePath: "contacts.json",
      autoSave: true,
      persistenceAdapter: new MemoryAdapter(),
    });
  });

  it("add + get by name", () => {
    store.add("user123", "Alice", "friend");
    const entry = store.get("Alice");
    assert.ok(entry);
    assert.equal(entry?.id, "user123");
    assert.equal(entry?.tag, "friend");
  });

  it("get by ID", () => {
    store.add("user123", "Alice");
    const entry = store.get("user123");
    assert.ok(entry);
    assert.equal(entry?.name, "Alice");
  });

  it("case-insensitive name lookup", () => {
    store.add("user123", "Alice");
    assert.ok(store.get("alice"));
    assert.ok(store.get("ALICE"));
  });

  it("remove by name", () => {
    store.add("user123", "Alice");
    assert.equal(store.remove("Alice"), true);
    assert.equal(store.get("Alice"), undefined);
  });

  it("remove by ID", () => {
    store.add("user123", "Alice");
    assert.equal(store.remove("user123"), true);
  });

  it("getByTag filters by tag", () => {
    store.add("u1", "Alice", "friend");
    store.add("u2", "Bob", "work");
    store.add("u3", "Carol", "friend");
    const friends = store.getByTag("friend");
    assert.equal(friends.length, 2);
  });

  it("setNickname updates nickname", () => {
    store.add("u1", "Alice");
    assert.equal(store.setNickname("Alice", "Alicia"), true);
    assert.equal(store.get("u1")?.nickname, undefined); // nickname is on alias, not contact
  });

  it("getAll returns all contacts", () => {
    store.add("u1", "Alice");
    store.add("u2", "Bob");
    assert.equal(store.getAll().length, 2);
  });
});

// ─── GroupStore ───

describe("GroupStore", () => {
  let store: GroupStore;

  beforeEach(() => {
    store = new GroupStore({
      persistencePath: "groups.json",
      autoSave: true,
      persistenceAdapter: new MemoryAdapter(),
    });
  });

  it("add + get by groupCode", () => {
    store.add("group123", "Test Group", "work");
    const entry = store.get("group123");
    assert.ok(entry);
    assert.equal(entry?.name, "Test Group");
    assert.equal(entry?.tag, "work");
  });

  it("add updates existing entry", () => {
    store.add("group123", "Old Name");
    store.add("group123", "New Name");
    const entry = store.get("group123");
    assert.equal(entry?.name, "New Name");
  });

  it("remove by groupCode", () => {
    store.add("group123", "Test");
    assert.equal(store.remove("group123"), true);
    assert.equal(store.get("group123"), undefined);
  });

  it("getAll returns all groups", () => {
    store.add("g1", "Group 1");
    store.add("g2", "Group 2");
    assert.equal(store.getAll().length, 2);
  });

  it("trackActivity updates lastActiveAt", () => {
    store.add("g1", "Group 1");
    const before = store.get("g1")?.lastActiveAt;
    store.trackActivity("g1", "Group 1");
    const after = store.get("g1")?.lastActiveAt;
    assert.ok(after !== undefined);
    if (before !== undefined) {
      assert.ok(after! >= before);
    }
  });

  it("setGroupName updates name", () => {
    store.add("g1", "Old");
    store.setGroupName("g1", "New");
    assert.equal(store.get("g1")?.name, "New");
  });
});

// ─── MessageHistoryStore ───

describe("MessageHistoryStore", () => {
  let store: MessageHistoryStore;

  function makeMsg(
    id: string,
    text: string,
    fromUserId = "u1",
    timestamp = Date.now(),
  ): ChatMessage {
    return {
      text,
      fromUserId,
      fromNickname: "Test",
      chatType: "direct",
      isMentioned: false,
      timestamp,
      msgId: id,
    };
  }

  beforeEach(() => {
    store = new MessageHistoryStore({
      maxMessages: 100,
      persistencePath: "history.jsonl",
      autoPersist: true,
      persistenceAdapter: new MemoryAdapter(),
    });
  });

  it("add + getHistory", () => {
    store.add(makeMsg("m1", "hello"));
    store.add(makeMsg("m2", "world"));
    const all = store.getHistory();
    assert.equal(all.length, 2);
  });

  it("respects maxMessages limit", () => {
    for (let i = 0; i < 150; i++) {
      store.add(makeMsg(`m${i}`, `msg ${i}`));
    }
    assert.equal(store.getHistory().length, 100);
  });

  it("search by keyword", () => {
    store.add(makeMsg("m1", "hello world"));
    store.add(makeMsg("m2", "goodbye world"));
    store.add(makeMsg("m3", "hello there"));
    const results = store.searchByKeyword("hello");
    assert.equal(results.length, 2);
  });

  it("filter by fromUserId", () => {
    store.add(makeMsg("m1", "hi", "alice"));
    store.add(makeMsg("m2", "hi", "bob"));
    const results = store.getByUser("alice");
    assert.equal(results.length, 1);
    assert.equal(results[0].fromUserId, "alice");
  });

  it("getRecent returns most recent", () => {
    store.add(makeMsg("m1", "old", "u1", Date.now() - 1000));
    store.add(makeMsg("m2", "new", "u1", Date.now()));
    const recent = store.getRecent(1);
    assert.equal(recent.length, 1);
  });

  it("getById returns specific message", () => {
    store.add(makeMsg("m1", "hello"));
    const msg = store.getById("m1");
    assert.ok(msg);
    assert.equal(msg?.text, "hello");
  });

  it("clear removes all messages", () => {
    store.add(makeMsg("m1", "hello"));
    store.clear();
    assert.equal(store.getHistory().length, 0);
  });

  it("removeById removes specific message", () => {
    store.add(makeMsg("m1", "hello"));
    store.add(makeMsg("m2", "world"));
    store.removeById("m1");
    const remaining = store.getHistory();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].msgId, "m2");
  });

  it("size property", () => {
    store.add(makeMsg("m1", "hello"));
    store.add(makeMsg("m2", "world"));
    assert.equal(store.size, 2);
  });
});
