// Skipping verification: trusting a block because validators from an older, trusted block's set
// signed it with more than 1/3 of that set's voting power.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { audit, describe, exitCode } from "../src/audit.ts";
import type { SignedBlock } from "../src/rpc.ts";
import { trusting } from "../src/verify.ts";

const load = (): SignedBlock[] => JSON.parse(gunzipSync(readFileSync(new URL("fixtures/cosmoshub.json.gz", import.meta.url))).toString());
const power = (block: SignedBlock) => new Map(block.validators.map((v) => [v.address, BigInt(v.voting_power)]));

test("the trusted set's signers of the newer block carry its voting power", () => {
  const [a, , c] = load();
  const known = power(a);
  const signers = c.commit.signatures.filter((s) => s.block_id_flag === 2 && known.has(s.validator_address));
  const result = trusting(a, c);
  assert.equal(result.signers, signers.length);
  assert.deepEqual(result.problems, []);
  assert.equal(result.power, signers.reduce((sum, s) => sum + known.get(s.validator_address)!, 0n));
  assert.equal(result.total, [...known.values()].reduce((x, y) => x + y));
  assert.equal(result.ok, true);
});

test("signers who weren't in the trusted set don't count", () => {
  const [a, , c] = load();
  const signer = c.commit.signatures.find((s) => s.block_id_flag === 2)!.validator_address;
  const before = trusting(a, c).power;
  a.validators = a.validators.filter((v) => v.address !== signer);
  assert.equal(trusting(a, c).power, before - power(load()[0]).get(signer)!, "less the power the trusted set gave it");
});

test("a vote that doesn't verify, or a validator's second vote, fails the skip, as in CometBFT", () => {
  const [a, , c] = load();
  const i = c.commit.signatures.findIndex((s) => s.block_id_flag === 2);
  const forged = structuredClone(c);
  forged.commit.signatures[i].signature = Buffer.alloc(64, 9).toString("base64");
  const bad = trusting(a, forged);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(), /the vote from [0-9A-F]{40} doesn't verify/);
  const twice = structuredClone(c);
  twice.commit.signatures.push(twice.commit.signatures[i]);
  const double = trusting(a, twice);
  assert.equal(double.ok, false);
  assert.equal(double.power, trusting(a, c).power, "the second vote isn't counted either");
  assert.match(double.problems.join(), /a second vote from [0-9A-F]{40}/);
});

test("the newer block must be on the same chain, at a later height and time", () => {
  const [a, , c] = load();
  assert.match(trusting(c, a).problems.join("\n"), /block 34026661 isn't after block 34026663\n.*block 34026661's time isn't after block 34026663's/);
  const elsewhere = structuredClone(c);
  elsewhere.header.chain_id = "consumer-1";
  const result = trusting(a, elsewhere);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /block 34026663 is on consumer-1, not cosmoshub-4/);
  assert.equal(result.signers, trusting(a, c).signers, "votes are checked against the trusted chain's ID, which they were signed for");
});

test("a trusted validator's vote for nil doesn't vouch for the block", () => {
  const [a] = load();
  const nilBlock: SignedBlock = JSON.parse(gunzipSync(readFileSync(new URL("fixtures/nil-vote.json.gz", import.meta.url))).toString());
  const known = power(a);
  const nil = nilBlock.commit.signatures.find((s) => s.block_id_flag === 3)!;
  assert.ok(known.has(nil.validator_address), "the nil voter was in the trusted set");
  const forBlock = nilBlock.commit.signatures.filter((s) => s.block_id_flag === 2 && known.has(s.validator_address));
  assert.equal(trusting(a, nilBlock).signers, forBlock.length);
});

test("1/3 of the trusted power, or less, isn't enough", () => {
  const [a, , c] = load();
  const signer = c.commit.signatures.find((s) => s.block_id_flag === 2)!.validator_address;
  // The one signer holds 1, a validator who didn't sign holds 2: exactly 1/3 signed.
  const absent = a.validators.find((v) => !c.commit.signatures.some((s) => s.block_id_flag === 2 && s.validator_address === v.address))!;
  for (const v of a.validators) v.voting_power = v.address === signer ? "1" : v === absent ? "2" : "0";
  const result = trusting(a, c);
  assert.deepEqual([result.power, result.total, result.ok], [1n, 3n, false]);
  absent.voting_power = "1";
  assert.equal(trusting(a, c).ok, true, "1 of 2 is more than 1/3");
});

test("a skip without enough trusted power exits 1, and says a light client can't make it", () => {
  const [a, , c] = load();
  const report = audit([c], a);
  assert.equal(exitCode(report), 0);
  report.skip = { ...report.skip!, ok: false };
  assert.equal(exitCode(report), 1);
  assert.match(describe(report), /signed block 34,026,663, 0\.\d hours later: not more than 1\/3, so a light client can't skip to it\n/);
});
