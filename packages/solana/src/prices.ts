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
