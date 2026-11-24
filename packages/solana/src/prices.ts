/**
 * xStock pricing via the Jupiter Price API (v3).
 *
 * Jupiter returns `usdPrice` only for mints with enough routable DEX
 * liquidity. Thinly-traded listings have pools with little depth, and brand-new
 * ones none at all, so `usdPrice` can be absent. For those we fall
 * back to `stockData.price`, the price of the underlying listed equity, and
 * mark the source so the UI can be honest about which number it is showing.
 */

import { ALL_MINTS } from './brands';

const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3';

export type PriceSource = 'market' | 'underlying';

export interface XStockPrice {
  mint: string;
  /** USD per token, or null when neither source has a number. */
  usd: number | null;
  /**
   * 'market'     — Jupiter's on-chain routed price.
   * 'underlying' — the listed share price, used when the token has no depth.
   */
  source: PriceSource | null;
  /** 24h change as a percentage. Only available for 'market' prices. */
  change24hPct: number | null;
  /**
   * The listed share price, also reported alongside a market price. Payouts
   * compare the two (see payoutPriceUsd); display ignores it.
   */
  underlyingUsd?: number | null;
}

/**
 * Two sources that differ by more than this are not both right: a thin pool
 * pushed off its price, or a stale feed. Weekend drift, when the DEX keeps
 * trading and the listed price is frozen at Friday's close, stays well inside.
 */
export const MAX_PRICE_DIVERGENCE = 0.25;

/**
 * The price a payout is sized at, or null when there is none to trust.
 *
 * The payout sends `rewardUsd / price` shares, so a price pushed DOWN — one
 * swap against a thin pool — inflates the shares sent, and the daily cap,
 * counted in dollars, never sees it. With both sources present, the higher
 * one is used: the treasury never sends more shares than either price says
 * the reward is worth. Sources that disagree past MAX_PRICE_DIVERGENCE pause
 * the payout instead.
 */
export function payoutPriceUsd(price: XStockPrice | undefined): number | null {
  if (!price) return null;
  const valid = [price.usd, price.underlyingUsd].filter(
    (p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0,
  );
  if (valid.length === 0) return null;
  const high = Math.max(...valid);
  const low = Math.min(...valid);
  if (high / low > 1 + MAX_PRICE_DIVERGENCE) return null;
  return high;
}

interface JupiterPriceEntry {
  usdPrice?: number;
  priceChange24h?: number;
  stockData?: { price?: number };
}

/** Fetch USD prices for every configured xStock. */
export async function fetchXStockPrices(
  mints: string[] = ALL_MINTS,
  signal?: AbortSignal,
): Promise<Record<string, XStockPrice>> {
  const out: Record<string, XStockPrice> = {};
  if (mints.length === 0) return out;

  const res = await fetch(`${JUPITER_PRICE_URL}?ids=${mints.join(',')}`, {
    signal,
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Jupiter price lookup failed (${res.status})`);
  }

  const body = (await res.json()) as Record<string, JupiterPriceEntry | null>;

  for (const mint of mints) {
    const entry = body[mint];

    if (entry?.usdPrice != null) {
      out[mint] = {
        mint,
        usd: entry.usdPrice,
        source: 'market',
        change24hPct: entry.priceChange24h ?? null,
        underlyingUsd: entry.stockData?.price ?? null,
      };
    } else if (entry?.stockData?.price != null) {
      out[mint] = {
        mint,
        usd: entry.stockData.price,
        source: 'underlying',
        change24hPct: null,
      };
    } else {
      out[mint] = { mint, usd: null, source: null, change24hPct: null };
    }
  }

  return out;
}
