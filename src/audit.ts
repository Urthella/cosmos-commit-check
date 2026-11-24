// Checks a chain's latest blocks one by one, and each against the one before.

import type { Rpc, SignedBlock } from "./rpc.ts";
import { type BlockResult, links, trusting, verifyBlock } from "./verify.ts";

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
  /** With --skip: whether the first block can be trusted straight from an older one. */
  skip?: Skip;
}

interface Skip {
  from: number;
  to: number;
  hours: number;
  /** The older block's own checks, as for the rest. */
  checks: BlockResult["checks"];
  /** Of the older block's voting power, what signed the first block. */
  power: string;
  total: string;
  signers: number;
  trustedValidators: number;
  problems: string[];
  ok: boolean;
}

function skip(trusted: SignedBlock, first: SignedBlock): Skip {
  // The older block is checked like the rest: trusting a block that fails is no help.
  const own = verifyBlock(trusted);
  const trust = trusting(trusted, first);
  const problems = [...own.problems.map((p) => `block ${number(own.height)}: ${p}`), ...trust.problems];
  return {
    from: own.height,
    to: Number(first.header.height),
    hours: (Date.parse(first.header.time) - Date.parse(trusted.header.time)) / 3_600_000,
    checks: own.checks,
    power: String(trust.power),
    total: String(trust.total),
    signers: trust.signers,
    trustedValidators: trusted.validators.length,
    problems,
    ok: trust.ok && !problems.length,
  };
}

export function audit(blocks: SignedBlock[], trusted?: SignedBlock): Report {
  const results = blocks.map((b) => verifyBlock(b));
  return {
    chainId: blocks[0].header.chain_id,
    first: results[0].height,
    last: results.at(-1)!.height,
    validators: blocks.at(-1)!.validators.length,
    blocks: results.map((r) => ({ ...r, signedPower: String(r.signedPower), totalPower: String(r.totalPower) })),
    links: blocks.slice(1).flatMap((b, i) => links(blocks[i], b)),
    skip: trusted && skip(trusted, blocks[0]),
  };
}

export const exitCode = (report: Report) => (report.links.length || report.blocks.some((b) => b.problems.length) || (report.skip && !report.skip.ok) ? 1 : 0);

const CHECKS = {
  header: "the header hashes to the block ID its commit signs",
  validators: "the validator set hashes to the header's validators_hash",
  signatures: "every vote's signature verifies with its validator's ed25519 key",
  quorum: "votes for the block carry more than 2/3 of the voting power",
} as const;

const number = (n: number) => n.toLocaleString("en-US");
/** A share of voting power, in percent, rounded down to hundredths. */
const percent = (part: string, whole: string) => Number((BigInt(part) * 10_000n) / BigInt(whole)) / 100;

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
  if (report.skip) {
    const s = report.skip;
    const gap = s.hours < 48 ? `${s.hours.toFixed(1)} hours` : `${Math.round(s.hours / 24)} days`;
    const verdict = s.ok ? `more than the 1/3 a light client needs to skip the ${number(s.to - s.from - 1)} blocks between` : s.problems.length ? "but a light client can't skip to it:" : "not more than 1/3, so a light client can't skip to it";
    lines.push(`  skip: validators holding ${percent(s.power, s.total).toFixed(2)}% of block ${number(s.from)}'s voting power, ${s.signers} of its ${s.trustedValidators}, signed block ${number(s.to)}, ${gap} later: ${verdict}`);
    for (const p of s.problems.slice(0, 5)) lines.push(`    ${p}`);
  }
  const least = Math.min(...report.blocks.map((b) => percent(b.signedPower, b.totalPower)));
  lines.push(`  votes: a median ${median(report.blocks.map((b) => b.signed))} validators signed each block, ${report.blocks.reduce((s, b) => s + b.nil, 0)} voted nil; the least signed power was ${least.toFixed(2)}%`);
  return lines.join("\n");
}
