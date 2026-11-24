// Saves the blocks the tests run against, each with its validator set: three consecutive Cosmos
// Hub blocks, and block 34,026,742, which has a validator's vote for nil.
// Run: node scripts/fetch-fixtures.ts [HEIGHT]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { Rpc } from "../src/rpc.ts";

const rpc = new Rpc("https://cosmos-rpc.publicnode.com");
const save = (name: string, data: unknown) => writeFileSync(new URL(`../test/fixtures/${name}.json.gz`, import.meta.url), gzipSync(JSON.stringify(data), { level: 9 }));

const last = Number(process.argv[2] ?? (await rpc.latest()) - 1);
const blocks = [];
for (let h = last - 2; h <= last; h++) blocks.push(await rpc.block(h));
save("cosmoshub", blocks);
save("nil-vote", await rpc.block(34_026_742));
console.log(`blocks ${last - 2} to ${last}, ${blocks[0].validators.length} validators, and the nil vote`);
