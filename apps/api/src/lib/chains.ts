/**
 * Which chain pays a receipt, and the duplicate scope that chain's network
 * belongs to.
 *
 * Solana is the default. Base is opt-in per request, and only when
 * BASE_NETWORK is set: unset, the API behaves exactly as before.
 */

import { getBaseNetwork } from '@stackd/base';
import { getCluster, type Cluster, type PayoutChain } from '@stackd/solana/server';

export type { PayoutChain };

/** A missing or empty value means Solana. Anything unrecognised is null, a client error. */
export function parseChain(value: unknown): PayoutChain | null {
  if (value == null) return 'solana';
  if (typeof value !== 'string') return null;
  const chain = value.trim().toLowerCase();
  if (chain === '' || chain === 'solana') return 'solana';
  if (chain === 'base') return 'base';
  return null;
}

/** Base payouts are on when BASE_NETWORK names a network. */
export function baseEnabled(): boolean {
  return getBaseNetwork() != null;
}

/**
 * The scope duplicates and the daily cap are counted in: 'mainnet' for real
 * money on either chain, 'devnet' for any test network. A receipt used in a
 * test run stays claimable for real, and one paid for real on Solana cannot be
 * paid again on Base.
 */
export function scopeFor(chain: PayoutChain): Cluster {
  if (chain === 'solana') return getCluster();
  return getBaseNetwork() === 'mainnet' ? 'mainnet' : 'devnet';
}
