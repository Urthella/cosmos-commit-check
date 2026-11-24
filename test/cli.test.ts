// Runs the real CLI against a fake CometBFT RPC serving the saved Cosmos Hub blocks, which can be
// told to misbehave.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { SignedBlock } from "../src/rpc.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const blocks: SignedBlock[] = JSON.parse(gunzipSync(readFileSync(new URL("fixtures/cosmoshub.json.gz", import.meta.url))).toString());
const byHeight = new Map(blocks.map((b) => [Number(b.header.height), b]));
const LAST = Number(blocks.at(-1)!.header.height);

let unwrapped = false;
let rateLimits = 0;
let badSignature: number | undefined;

const server = createServer((request, response) => {
  const url = new URL(request.url!, "http://x");
  const reply = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (rateLimits > 0) {
    rateLimits--;
    return reply(429, { error: "too many requests" });
  }
  const ok = (result: unknown) => reply(200, unwrapped ? result : { jsonrpc: "2.0", id: -1, result });
  const height = url.searchParams.get("height");
  const block = byHeight.get(Number(height));
  if (url.pathname === "/commit" && !height) return ok({ signed_header: { header: { height: String(LAST + 1) } } });
  if (!block) return reply(200, { jsonrpc: "2.0", id: -1, error: { code: -32603, message: "Internal error", data: `height ${height} is not available, lowest height is ${blocks[0].header.height}` } });
  if (url.pathname === "/commit") {
    const commit = structuredClone(block.commit);
    if (badSignature === Number(height)) {
      const sig = commit.signatures.find((s) => s.block_id_flag === 2)!;
      sig.signature = Buffer.alloc(64, 7).toString("base64");
    }
    return ok({ signed_header: { header: block.header, commit }, canonical: true });
  }
  if (url.pathname === "/validators") {
    const [page, perPage] = [Number(url.searchParams.get("page")), Number(url.searchParams.get("per_page"))];
    return ok({ block_height: height, validators: block.validators.slice((page - 1) * perPage, page * perPage), count: "", total: String(block.validators.length) });
  }
  reply(404, {});
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
server.unref();
const RPC = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, "--rpc", RPC, ...args], (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }));
  });
}

test("checks the latest blocks but the newest, exit 0", async () => {
  const { code, stdout, stderr } = await run("--blocks", "3");
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^3 blocks on cosmoshub-4, 34,026,661 to 34,026,663: 180 validators\n/);
  for (const line of ["the header hashes to the block ID its commit signs: 3 of 3", "the validator set hashes to the header's validators_hash: 3 of 3", "every vote's signature verifies with its validator's ed25519 key: 3 of 3", "votes for the block carry more than 2/3 of the voting power: 3 of 3", "each block builds on the one before, with the validators it named: 2 of 2"]) assert.ok(stdout.includes(`check: ${line}\n`), line);
});

test("a node that answers without the JSON-RPC envelope, as Sei's does, works too", async () => {
  unwrapped = true;
  try {
    const { code, stderr } = await run("--blocks", "2");
    assert.equal(code, 0, stderr);
  } finally {
    unwrapped = false;
  }
});

test("--json prints the report, voting power as strings", async () => {
  const { code, stdout } = await run("--blocks", "2", "--json");
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.blocks.length, 2);
  assert.deepEqual(report.links, []);
  assert.match(report.blocks[0].totalPower, /^\d+$/);
});

test("a signature that doesn't verify exits 1 and names it", async () => {
  badSignature = LAST;
  try {
    const { code, stdout } = await run("--blocks", "2");
    assert.equal(code, 1, stdout);
    assert.match(stdout, /every vote's signature verifies with its validator's ed25519 key: 1 of 2\n/);
    assert.match(stdout, /\n    block 34,026,663: signature 0, from [0-9A-F]{40}, doesn't verify\n/);
  } finally {
    badSignature = undefined;
  }
});

test("a node that rate-limits is asked again", async () => {
  rateLimits = 2;
  const { code, stderr } = await run("--blocks", "1");
  assert.equal(code, 0, stderr);
  assert.equal(rateLimits, 0);
});

test("a height the node has pruned exits 2 with its reason", async () => {
  const { code, stderr } = await run("--blocks", "4");
  assert.equal(code, 2);
  assert.match(stderr, /cosmos-commit-check: \/commit\?height=34026660: Internal error: height 34026660 is not available/);
});

test("bad arguments and an unreachable node exit 2", async () => {
  for (const args of [["--blocks", "0"], ["--blocks", "51"], ["--blocks", "few"], ["--depth", "2"]]) {
    const bad = await run(...args);
    assert.equal(bad.code, 2, `${args}: ${bad.stderr}`);
    assert.match(bad.stderr, /usage: cosmos-commit-check/);
  }
  const closed = await new Promise<number>((resolve) => execFile(process.execPath, [MAIN, "--rpc", "http://127.0.0.1:1"], (error) => resolve(error ? Number(error.code) : 0)));
  assert.equal(closed, 2);
});
