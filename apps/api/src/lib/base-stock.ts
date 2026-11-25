/**
 * Base treasury stock, checked before a receipt is accepted, and the second
 * price source Base payouts use.
 *
 * Mirrors lib/inventory.ts for Solana: a brand the Base treasury holds too
 * little of is "paused while we restock" up front, not a failure at
 * /confirm-receipt. Fails open the same way: when the balance or a price
 * cannot be read the receipt proceeds, and the payout is still the real check.
 */

import { BRAND_BY_SLUG, fetchXStockPrices } from '@stackd/solana';
import {
  b20Abi,
  feedPriceUsd,
  guardedPriceUsd,
  rawToShares,
  readFeedRound,
  tokenAddressFor,
  tokenPriceFromUnderlying,
  type BaseStock,
} from '@stackd/base';
import { getBaseClients, getBasePriceClient, getBaseTreasury, requireBaseNetwork } from '@stackd/base/server';
import { STOCK_HEADROOM, type StockCheck } from './inventory.js';

/**
 * The listed share price of the stock's underlying, in USD, from Jupiter's
 * stock data for the same company's Solana xStock. Multiplied by the B20
 * token's own multiplier, it is the payout's second price source.
 */
export async function underlyingUsd(stock: BaseStock, signal: AbortSignal): Promise<number | null> {
  const brand = BRAND_BY_SLUG[stock.slug];
  if (!brand) return null;
  const price = (await fetchXStockPrices([brand.mint], signal))[brand.mint];
  if (!price) return null;
  const value = price.source === 'underlying' ? price.usd : price.underlyingUsd;
  return value != null && value > 0 ? value : null;
}

export interface BaseStockDeps {
  /** Treasury holding in shares, and the token's multiplier (WAD). */
  holding(stock: BaseStock): Promise<{ shares: number; multiplierWad: bigint }>;
  /** Chainlink round for the stock's feed, already turned into a fresh price or null. */
  feedUsd(stock: BaseStock): Promise<number | null>;
  underlyingUsd(stock: BaseStock): Promise<number | null>;
}

export const defaultBaseStockDeps: BaseStockDeps = {
  async holding(stock) {
    const { publicClient } = getBaseClients();
    const token = tokenAddressFor(stock, requireBaseNetwork());
    const at = { address: token, abi: b20Abi } as const;
    const [raw, decimals, multiplierWad] = await Promise.all([
      publicClient.readContract({ ...at, functionName: 'balanceOf', args: [getBaseTreasury().address] }),
      publicClient.readContract({ ...at, functionName: 'decimals' }),
      publicClient.readContract({ ...at, functionName: 'uiMultiplier' }),
    ]);
    return { shares: rawToShares(raw, multiplierWad, decimals), multiplierWad };
  },
  async feedUsd(stock) {
    const round = await readFeedRound(getBasePriceClient(), stock.feed);
    return feedPriceUsd(round, Math.floor(Date.now() / 1000));
  },
  underlyingUsd: (stock) => underlyingUsd(stock, AbortSignal.timeout(10_000)).catch(() => null),
};

/** Can the Base treasury pay `cashbackUsd` of this stock right now? */
export async function checkBaseStock(
  stock: BaseStock,
  cashbackUsd: number,
  deps: BaseStockDeps = defaultBaseStockDeps,
): Promise<StockCheck> {
  let holding: { shares: number; multiplierWad: bigint };
  let feed: number | null;
  let underlying: number | null;
  try {
    [holding, feed, underlying] = await Promise.all([
      deps.holding(stock),
      deps.feedUsd(stock),
      deps.underlyingUsd(stock),
    ]);
  } catch (error) {
    return { ok: null, reason: error instanceof Error ? error.message : String(error) };
  }

  // The same rule the payout prices by, so the estimate and the payout agree.
  const price = guardedPriceUsd([feed, tokenPriceFromUnderlying(underlying, holding.multiplierWad)]);
  if (price == null) return { ok: null, reason: `no trustworthy price for ${stock.ticker}` };

  // Shares, not tokens: the payout sends shares' worth, and the treasury's
  // holding is reported in shares too.
  const sharePriceUsd = price / (Number(holding.multiplierWad) / 1e18);
  const neededShares = (cashbackUsd / sharePriceUsd) * STOCK_HEADROOM;
  return { ok: holding.shares >= neededShares, heldShares: holding.shares, neededShares };
}
