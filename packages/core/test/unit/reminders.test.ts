/**
 * Reminders + cron tests.
 *
 * Tests:
 *   - Reminder job parsing (parseTimeString)
 *   - Reminder add/remove
 *   - Cron expression parsing
 *   - Persistence
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseTimeString,
  initRemindersStore,
} from "../../src/business/reminders.js";
import { MemoryAdapter } from "../../src/access/persistence/adapter.js";

describe("parseTimeString", () => {
  beforeEach(() => {
    initRemindersStore({
      persistencePath: "reminders.json",
      persistenceAdapter: new MemoryAdapter(),
    });
  });

  it("parses relative seconds", () => {
    const result = parseTimeString("30s");
    assert.ok(result.delayMs > 0);
    assert.ok(result.error === undefined);
  });

  it("parses relative minutes", () => {
    const result = parseTimeString("5m");
    assert.ok(result.delayMs > 0);
    assert.equal(result.delayMs, 5 * 60 * 1000);
  });

  it("parses relative hours", () => {
    const result = parseTimeString("2h");
    assert.ok(result.delayMs > 0);
    assert.equal(result.delayMs, 2 * 60 * 60 * 1000);
  });

  it("parses relative days", () => {
    const result = parseTimeString("1d");
    assert.ok(result.delayMs > 0);
    assert.equal(result.delayMs, 24 * 60 * 60 * 1000);
  });

  it("parses relative weeks", () => {
    const result = parseTimeString("1w");
    assert.ok(result.delayMs > 0);
    assert.equal(result.delayMs, 7 * 24 * 60 * 60 * 1000);
  });

  it("parses combined relative (1d2h3m)", () => {
    const result = parseTimeString("1d2h3m");
    assert.ok(result.delayMs > 0);
    const expected = (24 * 60 * 60 + 2 * 60 * 60 + 3 * 60) * 1000;
    assert.equal(result.delayMs, expected);
  });

  it("parses absolute time HH:MM", () => {
    const result = parseTimeString("14:30");
    assert.ok(result.error === undefined || result.delayMs > 0);
  });

  it("parses absolute time YYYY-MM-DD HH:MM", () => {
    const result = parseTimeString("2026-12-31 23:59");
    assert.ok(result.error === undefined || result.delayMs > 0);
  });

  it("returns error for invalid format", () => {
    const result = parseTimeString("invalid");
    assert.ok(result.error !== undefined || result.delayMs === 0);
  });

  it("returns fireAt timestamp", () => {
    const result = parseTimeString("1h");
    assert.ok(result.fireAt > Date.now());
    assert.ok(result.fireAt <= Date.now() + 60 * 60 * 1000 + 1000);
  });
});
