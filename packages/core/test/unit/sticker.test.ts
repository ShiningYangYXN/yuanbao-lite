/**
 * Sticker system tests.
 *
 * Tests:
 *   - Sticker pack registration
 *   - Sticker search
 *   - Built-in emojis
 *   - detectSticker
 *   - Sticker cache persistence
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerStickerPack,
  unregisterStickerPack,
  getSticker,
  getStickerPacks,
  searchStickers,
  getBuiltinEmojis,
  detectSticker,
  buildEmojiMsgBody,
  initStickerCacheStore,
} from "../../src/business/sticker.js";
import { MemoryAdapter } from "../../src/access/persistence/adapter.js";

describe("Sticker system", () => {
  beforeEach(() => {
    initStickerCacheStore({
      persistencePath: "sticker-cache.json",
      persistenceAdapter: new MemoryAdapter(),
    });
  });

  it("registerStickerPack adds a pack", () => {
    registerStickerPack({
      name: "test-pack",
      description: "Test stickers",
      stickers: [
        {
          id: "test:smile",
          name: "smile",
          type: "custom",
          source: "https://example.com/smile.png",
          description: "Smiling face",
          pack: "test-pack",
        },
      ],
    });
    const packs = getStickerPacks();
    assert.ok(packs.some((p) => p.name === "test-pack"));
  });

  it("getSticker returns sticker by id", () => {
    registerStickerPack({
      name: "test-pack",
      description: "Test",
      stickers: [
        {
          id: "test:happy",
          name: "happy",
          type: "custom",
          source: "https://example.com/happy.png",
          description: "Happy",
          pack: "test-pack",
        },
      ],
    });
    const sticker = getSticker("test:happy");
    assert.ok(sticker);
    assert.equal(sticker?.name, "happy");
  });

  it("getSticker returns undefined for missing sticker", () => {
    assert.equal(getSticker("nonexistent"), undefined);
  });

  it("unregisterStickerPack removes a pack", () => {
    registerStickerPack({
      name: "temp-pack",
      description: "Temp",
      stickers: [
        {
          id: "temp:1",
          name: "1",
          type: "custom",
          source: "",
          description: "",
          pack: "temp-pack",
        },
      ],
    });
    unregisterStickerPack("temp-pack");
    const packs = getStickerPacks();
    assert.ok(!packs.some((p) => p.name === "temp-pack"));
  });

  it("searchStickers finds by keyword", () => {
    registerStickerPack({
      name: "emojis",
      description: "Emoji stickers",
      stickers: [
        {
          id: "e:smile",
          name: "smile",
          type: "custom",
          source: "",
          description: "happy smile",
          pack: "emojis",
        },
        {
          id: "e:cry",
          name: "cry",
          type: "custom",
          source: "",
          description: "sad cry",
          pack: "emojis",
        },
        {
          id: "e:laugh",
          name: "laugh",
          type: "custom",
          source: "",
          description: "funny laugh",
          pack: "emojis",
        },
      ],
    });
    const results = searchStickers("smile");
    assert.ok(results.length >= 1);
    assert.ok(results.some((s) => s.name === "smile"));
  });

  it("searchStickers returns empty for no match", () => {
    const results = searchStickers("nonexistent-sticker-xyz");
    assert.equal(results.length, 0);
  });

  it("getBuiltinEmojis returns built-in set", () => {
    const emojis = getBuiltinEmojis();
    assert.ok(Array.isArray(emojis));
    assert.ok(emojis.length > 0);
  });
});

describe("detectSticker", () => {
  it("returns null for text-only message", () => {
    const result = detectSticker([
      { msg_type: "TIMTextElem", msg_content: { text: "hello" } },
    ]);
    assert.equal(result, null);
  });
});

describe("buildEmojiMsgBody", () => {
  it("builds TIMFaceElem for emoji", () => {
    const result = buildEmojiMsgBody(0, "test_data");
    assert.ok(result);
    assert.equal(result.msg_type, "TIMFaceElem");
  });
});
