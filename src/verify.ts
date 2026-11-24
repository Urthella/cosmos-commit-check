// What a CometBFT light client checks of a block: the header's hash, the validator set's hash,
// and the commit's signatures.

import { createPublicKey, verify } from "node:crypto";

import { bytesField, merkleRoot, messageField, sfixed64Field, sha256, timestamp, uintField, varint } from "./proto.ts";
import type { BlockId, Commit, CommitSig, Header, SignedBlock, Validator } from "./rpc.ts";

const hex = (s: string) => Buffer.from(s, "hex");
const ED25519 = "tendermint/PubKeyEd25519";

function ed25519Key(v: Validator): Buffer {
  if (v.pub_key.type !== ED25519) throw new Error(`validator ${v.address} has a ${v.pub_key.type} key; only ed25519 keys are supported`);
  return Buffer.from(v.pub_key.value, "base64");
}

/** An ed25519 validator's address: the first 20 bytes of its key's SHA-256. */
export const address = (v: Validator) => sha256(ed25519Key(v)).subarray(0, 20).toString("hex").toUpperCase();

/** ValidatorSet.Hash(): the merkle root of each validator's SimpleValidator { PublicKey { ed25519 }, voting_power }. */
export const validatorsHash = (validators: Validator[]) =>
  merkleRoot(validators.map((v) => Buffer.concat([messageField(1, bytesField(1, ed25519Key(v))), uintField(2, BigInt(v.voting_power))])))
    .toString("hex")
    .toUpperCase();

/** BlockID as CometBFT encodes it: the hash, and the part set header, always written. */
const blockId = (b: BlockId) => Buffer.concat([bytesField(1, hex(b.hash)), messageField(2, Buffer.concat([uintField(1, b.parts.total), bytesField(2, hex(b.parts.hash))]), true)]);

/**
 * Header.Hash(): the merkle root of its fields, each encoded on its own. The scalars and hashes
 * are wrapped as gogoproto's StringValue, Int64Value and BytesValue.
 */
export function headerHash(h: Header): string {
  const wrapped = [h.last_commit_hash, h.data_hash, h.validators_hash, h.next_validators_hash, h.consensus_hash, h.app_hash, h.last_results_hash, h.evidence_hash, h.proposer_address].map((x) => bytesField(1, hex(x)));
  const fields = [
    Buffer.concat([uintField(1, BigInt(h.version.block)), uintField(2, BigInt(h.version.app ?? 0))]),
    bytesField(1, Buffer.from(h.chain_id)),
    uintField(1, BigInt(h.height)),
    timestamp(h.time),
    blockId(h.last_block_id),
    ...wrapped,
  ];
  return merkleRoot(fields).toString("hex").toUpperCase();
}

const PRECOMMIT = 2;
const FOR_BLOCK = 2;
const FOR_NIL = 3;

/**
 * What a validator signed: CanonicalVote { type, height, round, block_id, timestamp, chain_id },
 * length-prefixed. A vote for nil carries no block ID.
 */
export function voteSignBytes(commit: Commit, sig: CommitSig, chainId: string): Buffer {
  const id = commit.block_id;
  const canonicalBlockId = Buffer.concat([bytesField(1, hex(id.hash)), messageField(2, Buffer.concat([uintField(1, id.parts.total), bytesField(2, hex(id.parts.hash))]), true)]);
  const vote = Buffer.concat([
    uintField(1, PRECOMMIT),
    sfixed64Field(2, BigInt(commit.height)),
    sfixed64Field(3, commit.round),
    sig.block_id_flag === FOR_BLOCK ? messageField(4, canonicalBlockId) : Buffer.alloc(0),
    messageField(5, timestamp(sig.timestamp), true),
    bytesField(6, Buffer.from(chainId)),
  ]);
  return Buffer.concat([varint(vote.length), vote]);
}

const verifies = (key: Buffer, message: Buffer, signature: Buffer) => verify(null, message, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" }), signature);

export interface BlockResult {
  height: number;
  checks: {
    /** The header hashes to the block ID the commit signs. */
    header: boolean;
    /** The validator set hashes to the header's validators_hash. */
    validators: boolean;
    /** Every vote's signature verifies with its validator's key. */
    signatures: boolean;
    /** Votes for the block carry more than 2/3 of the voting power. */
    quorum: boolean;
  };
  signed: number;
  nil: number;
  absent: number;
  signedPower: bigint;
  totalPower: bigint;
  problems: string[];
}

const totalPower = (validators: Validator[]) => validators.reduce((sum, v) => sum + BigInt(v.voting_power), 0n);

export interface Trust {
  /** Voting power, in the trusted set, of its validators whose votes for the newer block verify. */
  power: bigint;
  total: bigint;
  signers: number;
  problems: string[];
  /** No problems, and more than 1/3: at least one honest validator vouches for the newer block. */
  ok: boolean;
}

/**
 * CometBFT's VerifyNonAdjacent checks: the newer block is on the trusted block's chain, at a
 * later height and time, and VerifyCommitLightTrusting at a trust level of 1/3 holds. That takes
 * the votes for it from validators in the trusted set, checked with that set's keys and the
 * trusted chain's ID; as there, a second vote or one that doesn't verify fails it.
 */
export function trusting(trusted: SignedBlock, untrusted: SignedBlock): Trust {
  const [t, u] = [trusted.header, untrusted.header];
  const result: Trust = { power: 0n, total: totalPower(trusted.validators), signers: 0, problems: [], ok: false };
  if (u.chain_id !== t.chain_id) result.problems.push(`block ${u.height} is on ${u.chain_id}, not ${t.chain_id}`);
  if (BigInt(u.height) <= BigInt(t.height)) result.problems.push(`block ${u.height} isn't after block ${t.height}`);
  if (Date.parse(u.time) <= Date.parse(t.time)) result.problems.push(`block ${u.height}'s time isn't after block ${t.height}'s`);
  const known = new Map(trusted.validators.map((v) => [v.address, v]));
  const seen = new Set<string>();
  for (const sig of untrusted.commit.signatures) {
    if (sig.block_id_flag !== FOR_BLOCK) continue;
    const v = known.get(sig.validator_address);
    if (!v) continue;
    if (seen.has(v.address)) {
      result.problems.push(`a second vote from ${v.address}`);
      continue;
    }
    seen.add(v.address);
    if (!sig.signature || !verifies(ed25519Key(v), voteSignBytes(untrusted.commit, sig, t.chain_id), Buffer.from(sig.signature, "base64"))) {
      result.problems.push(`the vote from ${v.address} doesn't verify`);
      continue;
    }
    result.power += BigInt(v.voting_power);
    result.signers++;
  }
  result.ok = !result.problems.length && result.power * 3n > result.total;
  return result;
}

/** What's wrong with `block` following `prev`: it must name prev's hash, and the validators prev said come next. */
export function links(prev: SignedBlock, block: SignedBlock): string[] {
  const problems: string[] = [];
  const [h, p] = [block.header.height, prev.header.height];
  const prevHash = headerHash(prev.header);
  if (block.header.last_block_id.hash !== prevHash) problems.push(`block ${h} names ${block.header.last_block_id.hash} as the block before, not ${p}'s ${prevHash}`);
  if (prev.header.next_validators_hash !== block.header.validators_hash) problems.push(`block ${p} named the next validators ${prev.header.next_validators_hash}, but block ${h} has ${block.header.validators_hash}`);
  return problems;
}

/** Checks one block as a light client would. Commit signature i belongs to validator i. */
export function verifyBlock({ header, commit, validators }: SignedBlock): BlockResult {
  const problems: string[] = [];
  const hash = headerHash(header);
  const header_ = hash === commit.block_id.hash;
  if (!header_) problems.push(`the header hashes to ${hash}, but the commit signs ${commit.block_id.hash}`);
  const setHash = validatorsHash(validators);
  const validators_ = setHash === header.validators_hash;
  if (!validators_) problems.push(`the validator set hashes to ${setHash}, but the header names ${header.validators_hash}`);

  const result: BlockResult = { height: Number(header.height), checks: { header: header_, validators: validators_, signatures: true, quorum: false }, signed: 0, nil: 0, absent: 0, signedPower: 0n, totalPower: totalPower(validators), problems };
  if (commit.signatures.length !== validators.length) {
    result.checks.signatures = false;
    problems.push(`${commit.signatures.length} commit signatures for ${validators.length} validators`);
  }
  commit.signatures.forEach((sig, i) => {
    if (sig.block_id_flag !== FOR_BLOCK && sig.block_id_flag !== FOR_NIL) return void result.absent++;
    const v = validators[i];
    const ok = v && sig.validator_address === v.address && address(v) === v.address && sig.signature && verifies(ed25519Key(v), voteSignBytes(commit, sig, header.chain_id), Buffer.from(sig.signature, "base64"));
    if (!ok) {
      result.checks.signatures = false;
      problems.push(`signature ${i}, from ${sig.validator_address}, doesn't verify${v && sig.validator_address !== v.address ? `: validator ${i} is ${v.address}` : ""}`);
    } else if (sig.block_id_flag === FOR_BLOCK) {
      result.signed++;
      result.signedPower += BigInt(v.voting_power);
    } else {
      result.nil++;
    }
  });
  result.checks.quorum = result.signedPower * 3n > result.totalPower * 2n;
  if (!result.checks.quorum) problems.push(`votes for the block carry ${result.signedPower} of ${result.totalPower} voting power, not more than 2/3`);
  return result;
}
