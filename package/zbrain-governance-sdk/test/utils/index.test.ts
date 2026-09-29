import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { computeJsonSha256Hash, sha256Digest, stableJsonStringify } from "../../src/index.js";

describe("governance hashing utilities", () => {
  it("serializes object keys deterministically and hashes the result", () => {
    const value = { z: 1, a: { c: true, b: ["ticket.read"] } };
    const stableJson = '{"a":{"b":["ticket.read"],"c":true},"z":1}';
    const expectedHash = `sha256:${createHash("sha256").update(stableJson).digest("hex")}`;

    expect(stableJsonStringify(value)).toBe(stableJson);
    expect(computeJsonSha256Hash(value)).toBe(expectedHash);
    expect(sha256Digest(stableJson)).toBe(expectedHash);
  });
});
