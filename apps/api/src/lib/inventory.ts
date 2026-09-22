/**
 * Treasury stock, checked before a receipt is accepted.
 *
 * A payout transfers xStocks the treasury already holds — nothing swaps USDC
 * for them on the fly — so a brand the treasury holds none of would pass
 * verification, show the user an estimate, and only fail at the transfer.
 * Checking here turns that into an honest "paused while we restock" up front.
 *
 * Fails open: when the balance or the price cannot be read, the receipt
 * proceeds. The transfer at /confirm-receipt is still the real check, and a
 * short treasury there fails with nothing sent — so an RPC blip must not
 * block every receipt.
 */

import { fetchXStockBalances, fetchXStockPrices, type Brand } from '@stackd/solana';
import { getCluster, getConnection, getTreasuryKeypair } from '@stackd/solana/server';

/** Headroom over the exact payout: the price can move between verify and confirm. */
export const STOCK_HEADROOM = 1.1;

export type StockCheck =
  | { ok: true; heldShares: number; neededShares: number }
  | { ok: false; heldShares: number; neededShares: number }
  /** Could not tell — the caller proceeds and lets the transfer decide. */
  | { ok: null; reason: string };

export interface StockDeps {
  /** Treasury holding of the brand's xStock, in shares (scaled UI amount). */
  heldShares(brand: Brand): Promise<number>;
  /** USD per share, or null when there is no price. */
  priceUsd(brand: Brand): Promise<number | null>;
}

export const defaultStockDeps: StockDeps = {
  async heldShares(brand) {
    const balances = await fetchXStockBalances(
      getConnection(),
      getTreasuryKeypair().publicKey,
      getCluster(),
    );
    return balances.find((b) => b.brand.ticker === brand.ticker)?.uiAmount ?? 0;
  },
  async priceUsd(brand) {
    // Priced by the brand's mainnet mint on every cluster, as payouts are.
    const prices = await fetchXStockPrices([brand.mint]);
    return prices[brand.mint]?.usd ?? null;
  },
};

/** Can the treasury pay `cashbackUsd` of this brand's xStock right now? */
export async function checkPayoutStock(
  brand: Brand,
  cashbackUsd: number,
  deps: StockDeps = defaultStockDeps,
): Promise<StockCheck> {
  let held: number;
  let price: number | null;
  try {
    [held, price] = await Promise.all([deps.heldShares(brand), deps.priceUsd(brand)]);
  } catch (error) {
    return { ok: null, reason: error instanceof Error ? error.message : String(error) };
  }
  if (price == null || !(price > 0)) {
    return { ok: null, reason: `no price for ${brand.ticker}` };
  }

  const neededShares = (cashbackUsd / price) * STOCK_HEADROOM;
  return { ok: held >= neededShares, heldShares: held, neededShares };
}
