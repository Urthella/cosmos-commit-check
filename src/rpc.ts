// A small client for CometBFT's HTTP RPC, as every Cosmos chain's nodes serve it.

const ATTEMPTS = 4;
const PER_PAGE = 100;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export interface BlockId {
  hash: string;
  parts: { total: number; hash: string };
}

export interface Header {
  version: { block: string; app?: string };
  chain_id: string;
  height: string;
  time: string;
  last_block_id: BlockId;
  last_commit_hash: string;
  data_hash: string;
  validators_hash: string;
  next_validators_hash: string;
  consensus_hash: string;
  app_hash: string;
  last_results_hash: string;
  evidence_hash: string;
  proposer_address: string;
}

export interface CommitSig {
  /** 1 absent, 2 for the block, 3 for nil. */
  block_id_flag: number;
  validator_address: string;
  timestamp: string;
  signature: string | null;
}

export interface Commit {
  height: string;
  round: number;
  block_id: BlockId;
  signatures: CommitSig[];
}

export interface Validator {
  address: string;
  pub_key: { type: string; value: string };
  voting_power: string;
}

/** What a light client needs for one height: the signed header and the validators who signed it. */
export interface SignedBlock {
  header: Header;
  commit: Commit;
  validators: Validator[];
}

export class Rpc {
  readonly url: string;
  constructor(url: string) {
    this.url = url.replace(/\/+$/, "");
  }

  async get<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${this.url}${path}`, { headers: { "user-agent": "cosmos-commit-check" }, signal: AbortSignal.timeout(30_000) });
      // Public nodes answer bursts with 429; wait and ask again.
      if ((response.status === 429 || response.status >= 500) && attempt < ATTEMPTS) {
        await response.body?.cancel();
        await sleep(1000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { message: string; data?: string } };
      if (body.error) throw new Error(`${path}: ${body.error.message}${body.error.data ? `: ${body.error.data}` : ""}`);
      // Sei's fork of CometBFT answers with the result alone, no JSON-RPC envelope.
      return "result" in body ? body.result! : (body as T);
    }
  }

  latest = async () => Number((await this.get<{ signed_header: { header: Header } }>("/commit")).signed_header.header.height);

  async block(height: number): Promise<SignedBlock> {
    const { signed_header } = await this.get<{ signed_header: { header: Header; commit: Commit } }>(`/commit?height=${height}`);
    const validators: Validator[] = [];
    for (let page = 1; ; page++) {
      const r = await this.get<{ validators: Validator[]; total: string }>(`/validators?height=${height}&page=${page}&per_page=${PER_PAGE}`);
      validators.push(...r.validators);
      if (validators.length >= Number(r.total) || !r.validators.length) break;
    }
    return { header: signed_header.header, commit: signed_header.commit, validators };
  }
}
