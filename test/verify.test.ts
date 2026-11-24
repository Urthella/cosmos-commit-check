// Checks the saved Cosmos Hub blocks, then breaks them one rule at a time.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { address, headerHash, links, validatorsHash, verifyBlock } from "../src/verify.ts";
import { audit, exitCode } from "../src/audit.ts";
import type { SignedBlock } from "../src/rpc.ts";

const load = (): SignedBlock[] => JSON.parse(gunzipSync(readFileSync(new URL("fixtures/cosmoshub.json.gz", import.meta.url))).toString());

test("a real header hashes to the block ID its commit signs", () => {
  for (const { header, commit } of load()) assert.equal(headerHash(header), commit.block_id.hash, header.height);
});

test("the validator set hashes to the header's validators_hash, and its addresses to their keys", () => {
  for (const { header, validators } of load()) {
    assert.equal(validators.length, 180);
    assert.equal(validatorsHash(validators), header.validators_hash, header.height);
    for (const v of validators) assert.equal(address(v), v.address);
  }
});

test("every vote's signature verifies, and more than 2/3 of the voting power signed the block", () => {
  for (const block of load()) {
    const result = verifyBlock(block);
    assert.deepEqual(result.problems, [], block.header.height);
    const forBlock = block.commit.signatures.filter((s) => s.block_id_flag === 2);
    assert.equal(result.signed, forBlock.length);
    const power = new Map(block.validators.map((v) => [v.address, BigInt(v.voting_power)]));
    assert.equal(result.signedPower, forBlock.reduce((sum, s) => sum + power.get(s.validator_address)!, 0n));
    assert.equal(result.totalPower, [...power.values()].reduce((a, b) => a + b));
    assert.ok(result.checks.quorum);
  }
});

test("each block builds on the one before, with the validators it named", () => {
  const [a, b, c] = load();
  assert.equal(headerHash(a.header), b.header.last_block_id.hash);
  assert.deepEqual(links(a, b), []);
  assert.deepEqual(links(b, c), []);
  assert.match(links(a, c)[0], /names .* as the block before, not 34026661's/);
  const renamed = structuredClone(a);
  renamed.header.next_validators_hash = "00".repeat(32);
  assert.deepEqual(links(renamed, b).length, 2, "a changed header changes its hash too");
});

test("a vote for nil verifies too, and its power doesn't count toward the block", () => {
  const block: SignedBlock = JSON.parse(gunzipSync(readFileSync(new URL("fixtures/nil-vote.json.gz", import.meta.url))).toString());
  const nil = block.commit.signatures.findIndex((s) => s.block_id_flag === 3);
  assert.ok(nil >= 0);
  const result = verifyBlock(block);
  assert.deepEqual(result.problems, []);
  assert.equal(result.nil, 1);
  const forBlock = block.commit.signatures.flatMap((s, i) => (s.block_id_flag === 2 ? [BigInt(block.validators[i].voting_power)] : []));
  assert.equal(result.signedPower, forBlock.reduce((a, b) => a + b));
});

const failing = (block: SignedBlock) => Object.entries(verifyBlock(block).checks).filter(([, ok]) => !ok).map(([name]) => name);

test("a changed header field fails the header check, and only that", () => {
  const block = load()[2];
  block.header.app_hash = block.header.app_hash.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  assert.deepEqual(failing(block), ["header"]);
});

test("a changed voting power fails the validator set check", () => {
  const block = load()[2];
  block.validators[7].voting_power = String(BigInt(block.validators[7].voting_power) + 1n);
  assert.deepEqual(failing(block), ["validators"]);
});

test("a changed signature, vote time or order fails the signature check", () => {
  const flip = load()[2];
  const sig = flip.commit.signatures.find((s) => s.block_id_flag === 2)!;
  const bytes = Buffer.from(sig.signature!, "base64");
  bytes[10] ^= 1;
  sig.signature = bytes.toString("base64");
  assert.deepEqual(failing(flip), ["signatures"]);

  const late = load()[2];
  const vote = late.commit.signatures.find((s) => s.block_id_flag === 2)!;
  vote.timestamp = vote.timestamp.replace(/\.(\d)/, (_, d) => `.${(Number(d) + 1) % 10}`);
  assert.deepEqual(failing(late), ["signatures"]);

  const swapped = load()[2];
  const s = swapped.commit.signatures;
  const [i, j] = [s.findIndex((x) => x.block_id_flag === 2), s.findLastIndex((x) => x.block_id_flag === 2)];
  [s[i], s[j]] = [s[j], s[i]];
  assert.deepEqual(failing(swapped), ["signatures"]);
  assert.match(verifyBlock(swapped).problems[0], /validator \d+ is [0-9A-F]{40}/);
});

test("votes for the block at 2/3 of the voting power or less fail the quorum", () => {
  const block = load()[2];
  const total = block.validators.reduce((sum, v) => sum + BigInt(v.voting_power), 0n);
  let signed = verifyBlock(block).signedPower;
  // Mark the biggest signers absent until the rest hold 2/3 or less.
  for (const [i, sig] of block.commit.signatures.entries()) {
    if (signed * 3n <= total * 2n) break;
    if (sig.block_id_flag !== 2) continue;
    signed -= BigInt(block.validators[i].voting_power);
    block.commit.signatures[i] = { block_id_flag: 1, validator_address: "", timestamp: "0001-01-01T00:00:00Z", signature: null };
  }
  assert.deepEqual(failing(block), ["quorum"]);
});

test("exactly 2/3 of the voting power isn't enough", () => {
  const block = load()[2];
  const sigs = block.commit.signatures;
  const signer = sigs.findIndex((s) => s.block_id_flag === 2);
  const absent = sigs.findIndex((s) => s.block_id_flag === 1);
  assert.ok(absent >= 0, "the fixture has a validator who didn't vote");
  // One signer with power 2, one absent validator with power 1, everyone else 0: 2 of 3 signed.
  block.validators.forEach((v, i) => (v.voting_power = i === signer ? "2" : i === absent ? "1" : "0"));
  const result = verifyBlock(block);
  assert.equal(result.signedPower, 2n);
  assert.equal(result.totalPower, 3n);
  assert.equal(result.checks.quorum, false);
});

test("a commit with a signature for each validator but one fails", () => {
  const block = load()[2];
  block.validators.pop();
  assert.ok(failing(block).includes("signatures"));
  assert.match(verifyBlock(block).problems.join("\n"), /180 commit signatures for 179 validators/);
});

test("a broken link alone makes the exit code 1", () => {
  const report = audit(load());
  assert.equal(exitCode(report), 0);
  report.links.push("block 2 names X as the block before");
  assert.equal(exitCode(report), 1);
});

test("a validator with a key type other than ed25519 can't be checked", () => {
  const block = load()[0];
  block.validators[0].pub_key.type = "tendermint/PubKeySecp256k1";
  assert.throws(() => verifyBlock(block), /has a tendermint\/PubKeySecp256k1 key; only ed25519 keys are supported/);
});
