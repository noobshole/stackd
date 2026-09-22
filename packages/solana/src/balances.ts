/**
 * Reading a wallet's xStock holdings.
 *
 * Two RPC calls total, regardless of how many brands are configured:
 *   1. getParsedTokenAccountsByOwner, scoped to the Token-2022 program
 *   2. getMultipleAccountsInfo over the mints, for the scaled-UI multipliers
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { BRANDS, mintFor, type Brand } from './brands';
import { getCluster, type Cluster } from './cluster';
import { fetchScaledUiAmountStates, toUiAmount, NO_SCALING } from './scaled-amount';

export interface XStockBalance {
  brand: Brand;
  /** Raw u64 from the token account, as a string (never pre-scaled). */
  rawAmount: string;
  /** What the holder should see: raw / 10^decimals * multiplier. */
  uiAmount: number;
  /** The scaled-UI multiplier applied to get `uiAmount`. */
  multiplier: number;
  /** The holder's associated token account, when one exists. */
  tokenAccount: string | null;
}

/**
 * Fetch every MVP xStock balance for `owner`.
 *
 * Brands the wallet holds nothing of come back with `uiAmount: 0` rather than
 * being omitted, so callers can decide whether to render a zero row or an
 * empty state without a second lookup.
 */
export async function fetchXStockBalances(
  connection: Connection,
  owner: PublicKey,
  cluster: Cluster = getCluster(),
): Promise<XStockBalance[]> {
  const mints = BRANDS.map((b) => mintFor(b, cluster));
  const known = new Set(mints);

  const [parsed, scaling] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    fetchScaledUiAmountStates(
      connection,
      mints.map((m) => new PublicKey(m)),
    ),
  ]);

  // Collapse to one entry per mint. A wallet can hold several accounts for the
  // same mint (an ATA plus auxiliary accounts); sum them rather than picking one.
  const raw = new Map<string, { amount: bigint; account: string }>();

  for (const { pubkey, account } of parsed.value) {
    const info = account.data.parsed?.info;
    const mint: string | undefined = info?.mint;
    if (!mint || !known.has(mint)) continue;

    // `amount` is the unscaled u64. Do not use `uiAmount` here — whether the
    // RPC applies the scaled-UI multiplier to it varies by node version.
    const amount = BigInt(info?.tokenAmount?.amount ?? '0');
    const prev = raw.get(mint);
    raw.set(mint, {
      amount: (prev?.amount ?? BigInt(0)) + amount,
      account: prev?.account ?? pubkey.toBase58(),
    });
  }

  return BRANDS.map((brand, i) => {
    const entry = raw.get(mints[i]);
    const { multiplier } = scaling.get(mints[i]) ?? NO_SCALING;
    const amount = entry?.amount ?? BigInt(0);

    return {
      brand,
      rawAmount: amount.toString(),
      uiAmount: toUiAmount(amount, brand.decimals, multiplier),
      multiplier,
      tokenAccount: entry?.account ?? null,
    };
  });
}
