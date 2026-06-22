/**
 * Persistence adapter tests.
 *
 * Tests all three built-in adapter implementations:
 *   - MemoryAdapter (in-memory, for tests)
 *   - NodeFsAdapter (Node.js filesystem)
 *   - BrowserLocalStorageAdapter (localStorage, tested with a polyfill)
 *
 * Covers:
 *   - exists / read / write / ensureParentDir
 *   - append (optional method)
 *   - remove (optional method)
 *   - listDir (optional method)
 *   - Error cases (read non-existent, etc.)
 *   - getDefaultPersistenceAdapter / setDefaultPersistenceAdapter
 *   - joinPath helper
 *   - nodeModulesReady promise
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryAdapter,
  NodeFsAdapter,
  BrowserLocalStorageAdapter,
  getDefaultPersistenceAdapter,
  setDefaultPersistenceAdapter,
  getDefaultPersistenceDir,
  joinPath,
  nodeModulesReady,
  getNodeModules,
} from "../../src/access/persistence/adapter.js";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── MemoryAdapter ───

describe("MemoryAdapter", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("write + read round-trip", () => {
    adapter.write("/test.json", '{"hello":"world"}');
    assert.equal(adapter.read("/test.json"), '{"hello":"world"}');
  });

  it("exists returns true after write", () => {
    assert.equal(adapter.exists("/test.json"), false);
    adapter.write("/test.json", "data");
    assert.equal(adapter.exists("/test.json"), true);
  });

  it("read throws on non-existent path", () => {
    assert.throws(() => adapter.read("/missing.json"), /path not found/);
  });

  it("append adds to existing content", () => {
    adapter.write("/log.txt", "line1\n");
    adapter.append("/log.txt", "line2\n");
    assert.equal(adapter.read("/log.txt"), "line1\nline2\n");
  });

  it("append creates file if not exists", () => {
    adapter.append("/new.txt", "first");
    assert.equal(adapter.read("/new.txt"), "first");
  });

  it("remove returns true when file existed", () => {
    adapter.write("/test.json", "data");
    assert.equal(adapter.remove("/test.json"), true);
    assert.equal(adapter.exists("/test.json"), false);
  });

  it("remove returns false when file didn't exist", () => {
    assert.equal(adapter.remove("/missing.json"), false);
  });

  it("listDir returns entries with prefix", () => {
    adapter.write("/dir/a.json", "a");
    adapter.write("/dir/b.json", "b");
    adapter.write("/other/c.json", "c");
    const entries = adapter.listDir("/dir/");
    assert.equal(entries.length, 2);
    assert.ok(entries.some(e => e.name === "a.json"));
    assert.ok(entries.some(e => e.name === "b.json"));
  });

  it("ensureParentDir is a no-op", () => {
    // Should not throw
    adapter.ensureParentDir("/some/deep/path/file.json");
  });

  it("clear resets all data", () => {
    adapter.write("/a", "1");
    adapter.write("/b", "2");
    assert.equal(adapter.size, 2);
    adapter.clear();
    assert.equal(adapter.size, 0);
  });
});

// ─── NodeFsAdapter ───

describe("NodeFsAdapter", () => {
  let adapter: NodeFsAdapter;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "yb-test-"));
    adapter = new NodeFsAdapter();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("write creates file and parent dirs", () => {
    const filePath = join(tempDir, "sub", "dir", "test.json");
    adapter.write(filePath, '{"data":42}');
    assert.equal(existsSync(filePath), true);
    assert.equal(adapter.read(filePath), '{"data":42}');
  });

  it("exists returns false for missing file", () => {
    assert.equal(adapter.exists(join(tempDir, "missing.json")), false);
  });

  it("append appends to existing file", () => {
    const filePath = join(tempDir, "log.txt");
    adapter.append(filePath, "line1\n");
    adapter.append(filePath, "line2\n");
    assert.equal(adapter.read(filePath), "line1\nline2\n");
  });

  it("remove deletes file", () => {
    const filePath = join(tempDir, "test.json");
    adapter.write(filePath, "data");
    assert.equal(adapter.remove(filePath), true);
    assert.equal(existsSync(filePath), false);
  });

  it("remove returns false for missing file", () => {
    assert.equal(adapter.remove(join(tempDir, "missing.json")), false);
  });

  it("listDir lists directory contents", () => {
    adapter.write(join(tempDir, "a.json"), "a");
    adapter.write(join(tempDir, "b.json"), "b");
    const entries = adapter.listDir(tempDir);
    assert.ok(entries.length >= 2);
    assert.ok(entries.some(e => e.name === "a.json"));
  });
});

// ─── BrowserLocalStorageAdapter ───

// Minimal localStorage polyfill for Node.js test environment
class LocalStoragePolyfill {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
  key(index: number): string | null {
    const keys = Array.from(this.data.keys());
    return keys[index] ?? null;
  }
  get length(): number {
    return this.data.size;
  }
}

describe("BrowserLocalStorageAdapter", () => {
  let adapter: BrowserLocalStorageAdapter;
  let storage: LocalStoragePolyfill;

  beforeEach(() => {
    storage = new LocalStoragePolyfill();
    adapter = new BrowserLocalStorageAdapter({
      prefix: "test:",
      storage: storage as unknown as Storage,
    });
  });

  it("write + read round-trip with prefix", () => {
    adapter.write("config.json", '{"v":1}');
    assert.equal(adapter.read("config.json"), '{"v":1}');
    // Verify the key has the prefix
    assert.equal(storage.getItem("test:config.json"), '{"v":1}');
  });

  it("exists checks prefixed key", () => {
    assert.equal(adapter.exists("config.json"), false);
    adapter.write("config.json", "{}");
    assert.equal(adapter.exists("config.json"), true);
  });

  it("read throws on missing key", () => {
    assert.throws(() => adapter.read("missing.json"), /path not found/);
  });

  it("append does read-modify-write", () => {
    adapter.write("log.txt", "a");
    adapter.append("log.txt", "b");
    assert.equal(adapter.read("log.txt"), "ab");
  });

  it("remove deletes key", () => {
    adapter.write("temp.json", "data");
    assert.equal(adapter.remove("temp.json"), true);
    assert.equal(adapter.exists("temp.json"), false);
  });

  it("listDir returns matching keys", () => {
    adapter.write("dir/a", "1");
    adapter.write("dir/b", "2");
    adapter.write("other/c", "3");
    const entries = adapter.listDir("dir/");
    assert.equal(entries.length, 2);
  });

  it("uses default prefix when not specified", () => {
    const a2 = new BrowserLocalStorageAdapter({
      storage: storage as unknown as Storage,
    });
    a2.write("x", "y");
    assert.equal(storage.getItem("yuanbao-lite:x"), "y");
  });

  it("throws when no localStorage available", () => {
    // Temporarily remove globalThis.localStorage if present
    const orig = (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { localStorage?: Storage }).localStorage;
    try {
      assert.throws(
        () => new BrowserLocalStorageAdapter(),
        /requires globalThis.localStorage/,
      );
    } finally {
      if (orig) (globalThis as { localStorage?: Storage }).localStorage = orig;
    }
  });
});

// ─── Default adapter resolution ───

describe("Default adapter resolution", () => {
  afterEach(() => {
    setDefaultPersistenceAdapter(null);
  });

  it("getDefaultPersistenceAdapter returns NodeFsAdapter under Node", () => {
    const adapter = getDefaultPersistenceAdapter();
    assert.ok(adapter instanceof NodeFsAdapter);
  });

  it("setDefaultPersistenceAdapter overrides default", () => {
    const custom = new MemoryAdapter();
    setDefaultPersistenceAdapter(custom);
    assert.equal(getDefaultPersistenceAdapter(), custom);
  });

  it("setDefaultPersistenceAdapter(null) reverts to default", () => {
    const custom = new MemoryAdapter();
    setDefaultPersistenceAdapter(custom);
    setDefaultPersistenceAdapter(null);
    const adapter = getDefaultPersistenceAdapter();
    assert.ok(adapter instanceof NodeFsAdapter);
  });
});

// ─── Path helpers ───

describe("Path helpers", () => {
  it("getDefaultPersistenceDir returns ~/.yuanbao-lite under Node", () => {
    const dir = getDefaultPersistenceDir();
    assert.ok(dir.endsWith(".yuanbao-lite"));
  });

  it("joinPath joins segments", () => {
    const result = joinPath("a", "b", "c");
    assert.ok(result.includes("a"));
    assert.ok(result.includes("b"));
    assert.ok(result.includes("c"));
  });

  it("joinPath handles empty parts", () => {
    const result = joinPath("a", "", "b");
    assert.ok(result.includes("a"));
    assert.ok(result.includes("b"));
  });
});

// ─── Node module loading ───

describe("Node module loading", () => {
  it("nodeModulesReady resolves to true under Node", async () => {
    const ready = await nodeModulesReady;
    assert.equal(ready, true);
  });

  it("getNodeModules returns loaded modules under Node", () => {
    const mods = getNodeModules();
    assert.ok(mods.fs, "fs should be loaded");
    assert.ok(mods.path, "path should be loaded");
    assert.ok(mods.os, "os should be loaded");
  });

  it("getNodeModules().fs.existsSync is callable", () => {
    const { fs } = getNodeModules();
    assert.equal(typeof fs?.existsSync, "function");
  });
});
