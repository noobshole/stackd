'use client';

import Link from 'next/link';
import { BrandMark, ChangePill, EmptyState } from '@/components/ui/primitives';
import { formatSmallUsd, formatTokenAmount, formatUsd } from '@/lib/format';
import type { PortfolioRow } from '@/hooks/useXStockData';

/** The $STACKD bonus-token row. Not a Brand, so it rides alongside the table. */
export interface StackdHolding {
  quantity: number;
  priceUsd: number | null;
}

export function HoldingsTable({
  rows,
  isLoading,
  stackd,
}: {
  rows: PortfolioRow[];
  isLoading: boolean;
  stackd?: StackdHolding | null;
}) {
  if (isLoading) return <LoadingTable />;

  const showStackd = stackd != null && stackd.quantity > 0;

  if (rows.length === 0 && !showStackd) {
    return (
      <div className="card">
        <EmptyState
          icon={
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
              <path
                d="M8 31V18m8 13V11m8 20v-9m8 9V9"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          }
          title="No xStock holdings yet"
          body="Once a receipt clears, the tokenized shares land in this wallet and show up here automatically."
          action={
            <Link href="/app/submit" className="btn-primary">
              Submit your first receipt
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      {/* Table scrolls sideways on narrow screens rather than squashing columns. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken">
              <Th className="text-left">Holding</Th>
              <Th className="text-right">Quantity</Th>
              <Th className="text-right">Price</Th>
              <Th className="text-right">24h</Th>
              <Th className="text-right">Value</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.brand.mint}
                className="border-b border-line last:border-0 transition-colors hover:bg-sunken/60"
              >
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <BrandMark brand={row.brand} size={36} />
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{row.brand.ticker}</p>
                      <p className="truncate text-xs text-ink-muted">{row.brand.name}</p>
                    </div>
                  </div>
                </td>
                <td className="num px-5 py-3.5 text-right text-ink">
                  {formatTokenAmount(row.quantity)}
                </td>
                <td className="num px-5 py-3.5 text-right text-ink-muted">
                  {formatUsd(row.price)}
                  {row.priceSource === 'underlying' && (
                    <sup
                      className="ml-0.5 cursor-help text-primary"
                      title="No on-chain liquidity for this xStock yet — showing the underlying share price."
                    >
                      †
                    </sup>
                  )}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <ChangePill pct={row.change24hPct} />
                </td>
                <td className="num px-5 py-3.5 text-right font-medium text-ink">
                  {formatUsd(row.value)}
                </td>
              </tr>
            ))}
            {showStackd && <StackdRow holding={stackd} />}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * $STACKD sits in the same table as the xStocks but is visibly a different
 * kind of thing: a bonus token on a bonding curve, not a share. Its price is
 * tiny, so it is shown in scientific-friendly form rather than rounding to $0.00.
 */
function StackdRow({ holding }: { holding: StackdHolding }) {
  const value = holding.priceUsd != null ? holding.quantity * holding.priceUsd : null;
  return (
    <tr className="border-t border-dashed border-line-strong bg-primary-soft/40">
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-medium text-white"
          >
            $S
          </span>
          <div className="min-w-0">
            <p className="font-medium text-ink">STACKD</p>
            <p className="truncate text-xs text-ink-muted">Bonus token · Meteora curve</p>
          </div>
        </div>
      </td>
      <td className="num px-5 py-3.5 text-right text-ink">{formatTokenAmount(holding.quantity)}</td>
      <td className="num px-5 py-3.5 text-right text-ink-muted">{formatSmallUsd(holding.priceUsd)}</td>
      <td className="px-5 py-3.5 text-right">
        <ChangePill pct={null} />
      </td>
      <td className="num px-5 py-3.5 text-right font-medium text-ink">{formatUsd(value)}</td>
    </tr>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`px-5 py-2.5 text-2xs font-medium uppercase tracking-label text-ink-subtle ${className}`}
    >
      {children}
    </th>
  );
}

function LoadingTable() {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-line bg-sunken px-5 py-3">
        <div className="skeleton h-3 w-24" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line px-5 py-4 last:border-0">
          <div className="skeleton h-9 w-9 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <div className="skeleton h-3.5 w-20" />
            <div className="skeleton h-2.5 w-28" />
          </div>
          <div className="skeleton h-3.5 w-16" />
          <div className="skeleton hidden h-3.5 w-16 sm:block" />
          <div className="skeleton h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}
