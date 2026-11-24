// Just enough protobuf to rebuild the bytes CometBFT hashes and signs, and its RFC 6962 merkle
// tree. Proto3 leaves out zero values; gogoproto's non-nullable messages are always written.

import { createHash } from "node:crypto";

export const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

const EMPTY = Buffer.alloc(0);

export function varint(value: bigint | number): Buffer {
  let n = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    out.push(Number(n & 0x7fn) | (n > 0x7fn ? 0x80 : 0));
    n >>= 7n;
  } while (n > 0n);
  return Buffer.from(out);
}

const tag = (field: number, wireType: number) => varint((field << 3) | wireType);

export const uintField = (field: number, value: bigint | number) => (BigInt(value) ? Buffer.concat([tag(field, 0), varint(value)]) : EMPTY);

export function sfixed64Field(field: number, value: bigint | number): Buffer {
  if (!BigInt(value)) return EMPTY;
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return Buffer.concat([tag(field, 1), out]);
}

export const bytesField = (field: number, data: Uint8Array) => (data.length ? Buffer.concat([tag(field, 2), varint(data.length), data]) : EMPTY);

/** An embedded message; `always` for gogoproto's non-nullable ones, written even when empty. */
export const messageField = (field: number, body: Uint8Array, always = false) => (body.length || always ? Buffer.concat([tag(field, 2), varint(body.length), body]) : EMPTY);

/** google.protobuf.Timestamp from an RFC 3339 time with up to nanoseconds, as CometBFT prints it. */
export function timestamp(time: string): Buffer {
  const m = time.match(/^(.+?)(?:\.(\d{1,9}))?Z$/);
  if (!m) throw new Error(`not an RFC 3339 UTC time: ${time}`);
  const ms = Date.parse(`${m[1]}Z`);
  if (Number.isNaN(ms)) throw new Error(`not an RFC 3339 UTC time: ${time}`);
  return Buffer.concat([uintField(1, BigInt(ms / 1000)), uintField(2, Number((m[2] ?? "").padEnd(9, "0")))]);
}

/** RFC 6962's merkle tree: leaves hashed with 0x00, inner nodes with 0x01, split at the largest power of two below the count. */
export function merkleRoot(items: Uint8Array[]): Buffer {
  if (items.length === 0) return sha256(EMPTY);
  if (items.length === 1) return sha256(Buffer.of(0), items[0]);
  let split = 1;
  while (split * 2 < items.length) split *= 2;
  return sha256(Buffer.of(1), merkleRoot(items.slice(0, split)), merkleRoot(items.slice(split)));
}
