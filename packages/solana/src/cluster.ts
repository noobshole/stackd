/**
 * Which Solana cluster the app runs against. Browser-safe.
 *
 * The API reads SOLANA_CLUSTER; the web app reads NEXT_PUBLIC_SOLANA_CLUSTER
 * (Next inlines it at build time). Unset means mainnet, which is what the
 * deployed site has always done.
 *
 * An unrecognised value throws instead of defaulting. A typo like "devent"
 * silently falling through to mainnet would point a test run at real money.
 */

export type Cluster = 'mainnet' | 'devnet';

export function getCluster(): Cluster {
  const raw = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? process.env.SOLANA_CLUSTER ?? 'mainnet')
    .trim()
    .toLowerCase();

  if (raw === 'mainnet' || raw === 'mainnet-beta' || raw === '') return 'mainnet';
  if (raw === 'devnet') return 'devnet';
  throw new Error(`SOLANA_CLUSTER must be "mainnet" or "devnet", got "${raw}".`);
}

/** Solscan link for a transaction, on the right cluster. */
export function solscanTx(signature: string, cluster: Cluster = getCluster()): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://solscan.io/tx/${signature}${suffix}`;
}
