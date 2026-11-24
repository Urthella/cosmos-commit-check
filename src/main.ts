#!/usr/bin/env node
// cosmos-commit-check: checks a Cosmos chain's latest blocks the way a CometBFT light client does:
// the header's hash, the validator set's hash, every vote's ed25519 signature, and that more than
// 2/3 of the voting power signed. Exits 1 if a block fails a check, 2 if it couldn't check.

import { parseArgs } from "node:util";

import { audit, collect, describe, exitCode } from "./audit.ts";
import { Rpc } from "./rpc.ts";

const USAGE = "usage: cosmos-commit-check [--rpc URL] [--blocks N] [--json]";

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        rpc: { type: "string", default: "https://cosmos-rpc.publicnode.com" },
        blocks: { type: "string", default: "3" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.error(USAGE);
    return 0;
  }
  const blocks = Number(values.blocks);
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > 50) {
    console.error(`--blocks must be 1 to 50: ${values.blocks}\n${USAGE}`);
    return 2;
  }
  try {
    const report = audit(await collect(new Rpc(values.rpc), blocks));
    console.log(values.json ? JSON.stringify(report, null, 2) : describe(report));
    return exitCode(report);
  } catch (error) {
    console.error(`cosmos-commit-check: ${(error as Error).message}`);
    return 2;
  }
}

// Not process.exit(): it can trip a libuv assertion on Windows.
process.exitCode = await main();
