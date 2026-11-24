import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { merkleRoot, sfixed64Field, timestamp, varint } from "../src/proto.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha = (...parts: number[][]) => createHash("sha256").update(Buffer.from(parts.flat())).digest();

test("varints follow protobuf's encoding", () => {
  assert.equal(hex(varint(0)), "00");
  assert.equal(hex(varint(1)), "01");
  assert.equal(hex(varint(300)), "ac02", "protobuf's documented example");
  assert.equal(hex(varint(-1)), "ffffffffffffffffff01", "a negative int64 takes ten bytes");
});

test("sfixed64 is eight little-endian bytes, and zero is left out", () => {
  assert.equal(hex(sfixed64Field(2, 34_026_663n)), "11a7340702" + "00000000");
  assert.equal(hex(sfixed64Field(3, 0)), "");
});

test("the merkle tree is RFC 6962's", () => {
  assert.equal(hex(merkleRoot([])), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "the empty tree is SHA-256 of nothing");
  assert.equal(hex(merkleRoot([Buffer.alloc(0)])), "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d", "RFC 6962's hash of an empty leaf");
  const leaf = (b: number) => [...sha([0], [b])];
  const node = (l: number[], r: number[]) => [...sha([1], l, r)];
  const [a, b, c] = [1, 2, 3].map((x) => Buffer.of(x));
  assert.equal(hex(merkleRoot([a, b, c])), hex(Buffer.from(node(node(leaf(1), leaf(2)), leaf(3)))), "three leaves split two and one");
});

test("timestamps keep their nanoseconds, and leave out zero", () => {
  const seconds = Date.UTC(2026, 10, 24, 12, 16, 19) / 1000;
  assert.equal(hex(timestamp("2026-11-24T12:16:19.183777946Z")), hex(Buffer.concat([Buffer.of(0x08), varint(seconds), Buffer.of(0x10), varint(183_777_946)])));
  assert.equal(hex(timestamp("2026-11-24T12:16:19.5Z")), hex(Buffer.concat([Buffer.of(0x08), varint(seconds), Buffer.of(0x10), varint(500_000_000)])), "short fractions are tenths, not nanoseconds");
  assert.equal(hex(timestamp("2026-11-24T12:16:19Z")), hex(Buffer.concat([Buffer.of(0x08), varint(seconds)])));
  assert.throws(() => timestamp("yesterday"), /not an RFC 3339 UTC time/);
});
