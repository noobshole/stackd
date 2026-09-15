'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  ALL_MINTS,
  BRANDS,
  fetchXStockBalances,
  fetchXStockPrices,
  type Brand,
  type PriceSource,
  type XStockBalance,
  type XStockPrice,
} from '@stackd/solana';

/** Live Token-2022 balances for the connected wallet. */
export function useXStockBalances() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const owner = publicKey?.toBase58() ?? null;

  return useQuery({
    queryKey: ['xstock-balances', owner],
    queryFn: () => fetchXStockBalances(connection, publicKey!),
    enabled: Boolean(publicKey),
    staleTime: 30_000,
  });
}

/** USD prices for every configured xStock. Does not need a wallet. */
export function useXStockPrices() {
  return useQuery({
    queryKey: ['xstock-prices'],
    queryFn: ({ signal }) => fetchXStockPrices(ALL_MINTS, signal),
    staleTime: 30_000,
    // Prices drift while a holder watches the table; balances do not.
    refetchInterval: 60_000,
  });
}

export interface PortfolioRow {
  brand: Brand;
  /** Share quantity, already scaled. Null until the balance read lands. */
  quantity: number | null;
  price: number | null;
  priceSource: PriceSource | null;
  change24hPct: number | null;
  /** quantity × price, or null if either side is unknown. */
  value: number | null;
  multiplier: number;
}

export interface PortfolioSummary {
  rows: PortfolioRow[];
  /** Rows with a non-zero balance. What the holdings table renders. */
  held: PortfolioRow[];
  totalValue: number | null;
  /** Weighted 24h change across priced holdings, in USD. */
  dayChangeUsd: number | null;
  dayChangePct: number | null;
  /** Distinct brands with a balance. */
  positionCount: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  /** True when a wallet is connected but the balance read has not resolved. */
  hasWallet: boolean;
  refetch: () => void;
}

/** Balances joined to prices, plus the numbers the stats row needs. */
export function usePortfolio(): PortfolioSummary {
  const { publicKey } = useWallet();
  const balances = useXStockBalances();
  const prices = useXStockPrices();

  return useMemo(() => {
    const byMint = new Map<string, XStockBalance>(
      (balances.data ?? []).map((b) => [b.brand.mint, b]),
    );
    const priceMap: Record<string, XStockPrice> = prices.data ?? {};

    const rows: PortfolioRow[] = BRANDS.map((brand) => {
      const balance = byMint.get(brand.mint);
      const price = priceMap[brand.mint];
      const quantity = balance ? balance.uiAmount : null;
      const usd = price?.usd ?? null;

      return {
        brand,
        quantity,
        price: usd,
        priceSource: price?.source ?? null,
        change24hPct: price?.change24hPct ?? null,
        value: quantity != null && usd != null ? quantity * usd : null,
        multiplier: balance?.multiplier ?? 1,
      };
    });

    const held = rows.filter((r) => (r.quantity ?? 0) > 0);

    // Only count rows we can actually price, so a missing price reads as
    // "excluded from the total" rather than silently as zero.
    const priced = held.filter((r) => r.value != null);
    const totalValue = priced.length > 0 ? priced.reduce((sum, r) => sum + r.value!, 0) : null;

    const movers = priced.filter((r) => r.change24hPct != null);
    const dayChangeUsd =
      movers.length > 0
        ? movers.reduce((sum, r) => {
            const prior = r.value! / (1 + r.change24hPct! / 100);
            return sum + (r.value! - prior);
          }, 0)
        : null;

    const priorTotal =
      movers.length > 0
        ? movers.reduce((sum, r) => sum + r.value! / (1 + r.change24hPct! / 100), 0)
        : null;

    const dayChangePct =
      dayChangeUsd != null && priorTotal != null && priorTotal !== 0
        ? (dayChangeUsd / priorTotal) * 100
        : null;

    return {
      rows,
      held,
      totalValue,
      dayChangeUsd,
      dayChangePct,
      positionCount: held.length,
      isLoading: balances.isLoading || prices.isLoading,
      isFetching: balances.isFetching || prices.isFetching,
      error: (balances.error ?? prices.error) as Error | null,
      hasWallet: Boolean(publicKey),
      refetch: () => {
        void balances.refetch();
        void prices.refetch();
      },
    };
  }, [balances, prices, publicKey]);
}
