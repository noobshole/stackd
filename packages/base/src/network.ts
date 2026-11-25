/**
 * Which Base network payouts run on. Browser-safe.
 *
 * The API reads BASE_NETWORK; the web app reads NEXT_PUBLIC_BASE_NETWORK (Next
 * inlines it at build time). Unset means Base payouts are off. Unlike the
 * Solana cluster, there is no historical default to keep, so mainnet has to be
 * asked for by name.
 *
 * An unrecognised value throws instead of defaulting: a typo must not point a
 * test run at real money, or switch real payouts off without anyone noticing.
 */

import { base, baseSepolia, type Chain } from 'viem/chains';

export type BaseNetwork = 'mainnet' | 'sepolia';

export function getBaseNetwork(): BaseNetwork | null {
  const raw = (process.env.NEXT_PUBLIC_BASE_NETWORK ?? process.env.BASE_NETWORK ?? '')
    .trim()
    .toLowerCase();

  if (raw === '' || raw === 'off') return null;
  if (raw === 'mainnet' || raw === 'base') return 'mainnet';
  if (raw === 'sepolia' || raw === 'base-sepolia') return 'sepolia';
  throw new Error(`BASE_NETWORK must be "mainnet", "sepolia" or "off", got "${raw}".`);
}

export function chainFor(network: BaseNetwork): Chain {
  return network === 'mainnet' ? base : baseSepolia;
}

function explorer(network: BaseNetwork): string {
  return network === 'mainnet' ? 'https://basescan.org' : 'https://sepolia.basescan.org';
}

/** Basescan link for a transaction, on the right network. */
export function basescanTx(hash: string, network: BaseNetwork): string {
  return `${explorer(network)}/tx/${hash}`;
}

/** Basescan link for an address, on the right network. */
export function basescanAddress(address: string, network: BaseNetwork): string {
  return `${explorer(network)}/address/${address}`;
}
