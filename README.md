# cosmos-commit-check

Checks a Cosmos chain's latest blocks the way a CometBFT light client does, from any public RPC
node, with no SDK. For each block, `cosmos-commit-check`:

1. **hashes the header** from its 14 fields, as CometBFT encodes them, and checks the result is
   the block ID the commit signs;
2. **hashes the validator set** and checks it's the one the header names;
3. **verifies every vote's ed25519 signature**, over the bytes CometBFT signs, with its
   validator's key;
4. **checks the votes for the block carry more than 2/3 of the voting power**;
5. **checks each block builds on the one before**, with the validators that block named.

It exits 1 if a block fails a check.

## Why

A light client follows a chain without replaying it: it trusts a block because more than 2/3 of
the validators' voting power signed it, and the signature covers everything else. That's how IBC
moves tokens between chains, and how wallets can avoid trusting an RPC node.

The checks need the exact bytes CometBFT hashes and signs: protobuf, some of it wrapped, with
proto3's habit of leaving zeros out. `cosmos-commit-check` rebuilds those bytes by hand and checks
every signature of real blocks:

- **Cosmos Hub, 2026-11-24:** 179 of 180 validators signed each of 20 blocks, carrying at least
  99.54% of the voting power. One vote was for nil, and its signature verifies too.
- **Seven more chains** pass every check from their public nodes: Osmosis, Celestia, dYdX, Akash,
  Injective, Kava and Sei. Sei's fork of CometBFT answers without the JSON-RPC envelope, which is
  handled.

## Quick start

Needs Node 24 or later, and nothing else.

```sh
git clone https://github.com/Urthella/cosmos-commit-check && cd cosmos-commit-check
node src/main.ts --blocks 20
```

```text
20 blocks on cosmoshub-4, 34,026,740 to 34,026,759: 180 validators
  check: the header hashes to the block ID its commit signs: 20 of 20
  check: the validator set hashes to the header's validators_hash: 20 of 20
  check: every vote's signature verifies with its validator's ed25519 key: 20 of 20
  check: votes for the block carry more than 2/3 of the voting power: 20 of 20
  check: each block builds on the one before, with the validators it named: 19 of 19
  votes: a median 179 validators signed each block, 1 voted nil; the least signed power was 99.54%
```

- `--rpc URL` picks the CometBFT RPC node: `https://cosmos-rpc.publicnode.com` by default. Any
  chain's works, `https://osmosis-rpc.publicnode.com` for one.
- `--blocks N` sets how many blocks to check, ending one before the newest, whose commit may still
  be gathering votes: 3 by default, up to 50.
- `--json` prints the report as JSON.

Exit codes: 0 when every check passes, 1 when a block fails one, and 2 when it couldn't check: a
node that has pruned the heights, a key type other than ed25519, or bad arguments.

## What it does

- **Reads each block's signed header and commit** from `/commit?height=H`, and its validator set
  from `/validators?height=H`, a hundred at a time.
- **The header hash** is the RFC 6962 merkle root of its fields, each encoded alone:
  - the version as `Consensus`, the time as `Timestamp` and the last block ID as `BlockID`;
  - the chain ID, the height and the nine hashes wrapped in gogoproto's `StringValue`,
    `Int64Value` and `BytesValue`.
- **The validator set hash** is the merkle root of each validator's `SimpleValidator`: its public
  key and voting power. Each validator's address must be the first 20 bytes of its key's SHA-256.
- **Each vote** is checked against the validator in its position: commit signature *i* belongs to
  validator *i*. A vote signs a length-prefixed `CanonicalVote`:
  - the type, the height and round as `sfixed64`, the block ID (left out for a vote for nil), the
    vote's own time and the chain ID;
  - a vote for nil must verify too, but its power doesn't count toward the block.

## How it's checked

- **The building blocks:**
  - varints and `sfixed64` against protobuf's encoding;
  - the merkle tree against RFC 6962's empty-tree and empty-leaf hashes;
  - timestamps keep their nanoseconds.
- **Real blocks:** three consecutive Cosmos Hub blocks and one with a vote for nil, saved with
  their validator sets by [`scripts/fetch-fixtures.ts`](scripts/fetch-fixtures.ts).
  - Every header, validator set and signature checks out.
  - Then they're broken one rule at a time: a header field, a voting power, a signature, a vote's
    time, two votes swapped, too few votes, exactly 2/3 of the power, a missing validator. Each
    fails the check it should, and only that.
- **End to end:** the CLI runs against a fake RPC node serving those blocks:
  - the latest blocks are checked, from replies with or without the JSON-RPC envelope;
  - a signature that doesn't verify exits 1;
  - a rate-limited node is asked again;
  - pruned heights, bad arguments and an unreachable node exit 2.
- **Mutation testing:** twenty-eight deliberate bugs were planted one at a time, and the tests
  caught every one.
- **Live**, on 2026-11-24, every block passed: 20 on Cosmos Hub, and two each on Osmosis,
  Celestia, dYdX, Akash, Injective, Kava and Sei.

## Limits

- **It checks consensus, not state.** A block's app hash commits to the chain's state, but checking
  a balance against it takes IAVL proofs this doesn't do.
- **ed25519 keys only.** That's what Cosmos SDK chains use; a validator with another key type stops
  the check, exit 2.
- **Each block is checked against the validator set the node serves for it**, and that set is
  checked against the header's hash. Following a chain from a block you already trust is what
  makes that sound.
- **No saved block went past round 0,** so the round in a vote's sign bytes is only ever zero in
  the tests.

## License

MIT
