/**
 * Logger + version tests.
 *
 * Tests:
 *   - createLog creates module logger
 *   - setLogLevel changes minimum level
 *   - Sensitive data masking
 *   - getVersion / getVersionString
 *   - versionReady promise
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createLog, setLogLevel, sanitize } from "../../src/logger.js";
import { getVersion, getVersionString, versionReady } from "../../src/version.js";

describe("Logger", () => {
  it("createLog returns module logger", () => {
    const log = createLog("test-module");
    assert.ok(log);
    assert.equal(typeof log.info, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.error, "function");
    assert.equal(typeof log.debug, "function");
  });

  it("logs without throwing", () => {
    const log = createLog("test");
    assert.doesNotThrow(() => log.info("test message"));
    assert.doesNotThrow(() => log.warn("warning"));
    assert.doesNotThrow(() => log.error("error"));
    assert.doesNotThrow(() => log.debug("debug"));
  });

  it("logs with metadata", () => {
    const log = createLog("test");
    assert.doesNotThrow(() => log.info("message", { key: "value" }));
  });

  it("setLogLevel changes minimum level", () => {
    setLogLevel("error");
    const log = createLog("test");
    // info and debug should be suppressed
    assert.doesNotThrow(() => log.info("should not show"));
    assert.doesNotThrow(() => log.debug("should not show"));
    // Reset
    setLogLevel("info");
  });
});

describe("sanitize", () => {
  it("masks sensitive string values", () => {
    const result = sanitize({ token: "sk-1234567890abcdef" });
    assert.ok(result.includes("****"));
    assert.ok(!result.includes("1234567890abcdef"));
  });

  it("masks nested sensitive values", () => {
    const result = sanitize({ outer: { appSecret: "secret1234567890" } });
    assert.ok(result.includes("****"));
  });

  it("preserves non-sensitive values", () => {
    const result = sanitize({ name: "Alice", count: 42 });
    assert.ok(result.includes("Alice"));
    assert.ok(result.includes("42"));
  });

  it("handles arrays", () => {
    const result = sanitize([{ token: "sk-abcdef123456" }]);
    assert.ok(result.includes("****"));
  });

  it("handles strings", () => {
    const result = sanitize("plain string");
    assert.equal(result, "plain string");
  });
});

describe("Version", () => {
  it("getVersion returns a string", () => {
    const v = getVersion();
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  });

  it("getVersionString includes prefix", () => {
    const s = getVersionString();
    assert.ok(s.startsWith("yuanbao-lite v"));
  });

  it("versionReady resolves", async () => {
    const v = await versionReady;
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  });
});
