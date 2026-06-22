/**
 * HTTP request + crypto tests.
 *
 * Tests:
 *   - computeSignature (HMAC-SHA256 via Web Crypto)
 *   - verifySignature (constant-time comparison)
 *   - randomHex
 *   - setHttpProxy / getHttpProxy
 *   - URL proxy rewriting
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  computeSignature,
  verifySignature,
  setHttpProxy,
  getHttpProxy,
} from "../../src/access/http/request.js";

describe("HTTP crypto", () => {
  it("computeSignature returns HMAC-SHA256 hex", async () => {
    const sig = await computeSignature({
      nonce: "abc123",
      timestamp: "2026-01-01T00:00:00+08:00",
      appKey: "test-key",
      appSecret: "test-secret",
    });
    assert.ok(typeof sig === "string");
    assert.equal(sig.length, 64); // SHA-256 hex = 32 bytes = 64 chars
    assert.ok(/^[0-9a-f]+$/.test(sig));
  });

  it("computeSignature is deterministic", async () => {
    const params = {
      nonce: "abc123",
      timestamp: "2026-01-01T00:00:00+08:00",
      appKey: "test-key",
      appSecret: "test-secret",
    };
    const sig1 = await computeSignature(params);
    const sig2 = await computeSignature(params);
    assert.equal(sig1, sig2);
  });

  it("computeSignature differs with different secret", async () => {
    const params = {
      nonce: "abc123",
      timestamp: "2026-01-01T00:00:00+08:00",
      appKey: "test-key",
      appSecret: "secret1",
    };
    const sig1 = await computeSignature(params);
    const sig2 = await computeSignature({ ...params, appSecret: "secret2" });
    assert.notEqual(sig1, sig2);
  });

  it("verifySignature returns true for matching signatures", () => {
    const sig = "abc123def456";
    assert.equal(verifySignature(sig, sig), true);
  });

  it("verifySignature returns false for different signatures", () => {
    assert.equal(verifySignature("abc123", "def456"), false);
  });

  it("verifySignature returns false for different lengths", () => {
    assert.equal(verifySignature("abc", "abcd"), false);
  });
});

describe("HTTP proxy", () => {
  afterEach(() => {
    setHttpProxy(null);
  });

  it("getHttpProxy returns null by default", () => {
    assert.equal(getHttpProxy(), null);
  });

  it("setHttpProxy sets the proxy URL", () => {
    setHttpProxy("https://proxy.example.com/");
    assert.equal(getHttpProxy(), "https://proxy.example.com/");
  });

  it("setHttpProxy(null) clears the proxy", () => {
    setHttpProxy("https://proxy.example.com/");
    setHttpProxy(null);
    assert.equal(getHttpProxy(), null);
  });
});
