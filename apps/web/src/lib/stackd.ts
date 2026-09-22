/**
 * $STACKD market state (from the API) and a wallet's STACKD balance (from RPC).
 *
 * Price and curve progress come from GET /stackd because they need the
 * Meteora SDK, which stays out of the browser bundle. The balance is a plain
 * legacy-SPL token read, so it goes straight through the RPC proxy.
 */

import type { Connection, PublicKey } from '@solana/web3.js';
import { apiBase } from './verify';

export interface StackdState {
  configured: boolean;
  cluster: 'mainnet' | 'devnet';
  mint: string | null;
  decimals: number | null;
  pool: string | null;
  priceUsd: number | null;
  progressPct: number | null;
  thresholdUsdc: number | null;
  migrated: boolean | null;
  updatedAt: string;
}

export async function fetchStackdState(signal?: AbortSignal): Promise<StackdState> {
  const res = await fetch(`${apiBase()}/stackd`, { signal });
  if (!res.ok) throw new Error(`$STACKD state unavailable (${res.status}).`);
  return (await res.json()) as StackdState;
}

/** Whole-token STACKD held by `owner`, summed across its accounts. */
export async function fetchStackdBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<number> {
  const { value } = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  return value.reduce((sum, { account }) => {
    const amount = account.data.parsed?.info?.tokenAmount;
    // amount + decimals, not uiAmount: the same discipline as the xStock reads.
    return amount ? sum + Number(amount.amount) / 10 ** amount.decimals : sum;
  }, 0);
}
