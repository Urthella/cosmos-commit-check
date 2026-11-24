// Checks a chain's latest blocks one by one, and each against the one before.

import type { Rpc, SignedBlock } from "./rpc.ts";
import { type BlockResult, links, verifyBlock } from "./verify.ts";

export async function collect(rpc: Rpc, count: number): Promise<SignedBlock[]> {
  // The newest commit can still be gathering votes: stop one block short of it.
  const last = (await rpc.latest()) - 1;
  const blocks: SignedBlock[] = [];
  for (let h = Math.max(1, last - count + 1); h <= last; h++) blocks.push(await rpc.block(h));
  return blocks;
}

export interface Report {
  chainId: string;
  first: number;
  last: number;
  validators: number;
  blocks: (Omit<BlockResult, "signedPower" | "totalPower"> & { signedPower: string; totalPower: string })[];
  /** Problems linking each block to the one before. */
  links: string[];
}

export function audit(blocks: SignedBlock[]): Report {
  const results = blocks.map((b) => verifyBlock(b));
  return {
    chainId: blocks[0].header.chain_id,
    first: results[0].height,
    last: results.at(-1)!.height,
    validators: blocks.at(-1)!.validators.length,
    blocks: results.map((r) => ({ ...r, signedPower: String(r.signedPower), totalPower: String(r.totalPower) })),
    links: blocks.slice(1).flatMap((b, i) => links(blocks[i], b)),
  };
}

export const exitCode = (report: Report) => (report.links.length || report.blocks.some((b) => b.problems.length) ? 1 : 0);

const CHECKS = {
  header: "the header hashes to the block ID its commit signs",
  validators: "the validator set hashes to the header's validators_hash",
  signatures: "every vote's signature verifies with its validator's ed25519 key",
  quorum: "votes for the block carry more than 2/3 of the voting power",
} as const;

const number = (n: number) => n.toLocaleString("en-US");

export function describe(report: Report): string {
  const n = report.blocks.length;
  const lines = [`${number(n)} blocks on ${report.chainId}, ${number(report.first)} to ${number(report.last)}: ${number(report.validators)} validators`];
  for (const [check, text] of Object.entries(CHECKS) as [keyof typeof CHECKS, string][]) {
    const passed = report.blocks.filter((b) => b.checks[check]).length;
    lines.push(`  check: ${text}: ${passed} of ${n}`);
  }
  lines.push(`  check: each block builds on the one before, with the validators it named: ${report.links.length ? "no" : `${n - 1} of ${n - 1}`}`);
  for (const p of [...report.blocks.flatMap((b) => b.problems.map((x) => `block ${number(b.height)}: ${x}`)), ...report.links].slice(0, 10)) lines.push(`    ${p}`);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  const share = Math.min(...report.blocks.map((b) => Number((BigInt(b.signedPower) * 10_000n) / BigInt(b.totalPower)) / 100));
  lines.push(`  votes: a median ${median(report.blocks.map((b) => b.signed))} validators signed each block, ${report.blocks.reduce((s, b) => s + b.nil, 0)} voted nil; the least signed power was ${share.toFixed(2)}%`);
  return lines.join("\n");
}
