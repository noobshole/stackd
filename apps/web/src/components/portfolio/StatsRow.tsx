'use client';

import { StatTile } from '@/components/ui/primitives';
import { formatPct, formatUsd } from '@/lib/format';
import type { PortfolioSummary } from '@/hooks/useXStockData';

export function StatsRow({ portfolio }: { portfolio: PortfolioSummary }) {
  const { totalValue, dayChangeUsd, dayChangePct, positionCount, held, isLoading } = portfolio;

  const top = held
    .filter((r) => r.value != null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];

  const changeTone =
    dayChangeUsd == null ? 'neutral' : dayChangeUsd >= 0 ? 'gain' : 'loss';

  const changeValue =
    dayChangeUsd == null
      ? '—'
      : `${dayChangeUsd >= 0 ? '+' : '−'}${formatUsd(Math.abs(dayChangeUsd))}`;

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Portfolio value"
        value={formatUsd(totalValue)}
        sub={totalValue == null ? 'No priced holdings yet' : 'Across your xStock positions'}
        loading={isLoading}
      />
      <StatTile
        label="Today"
        value={changeValue}
        tone={changeTone}
        sub={dayChangePct == null ? '24h change unavailable' : formatPct(dayChangePct)}
        loading={isLoading}
      />
      <StatTile
        label="Positions"
        value={positionCount}
        sub={positionCount === 1 ? '1 brand held' : `${positionCount} brands held`}
        loading={isLoading}
      />
      <StatTile
        label="Top holding"
        value={top ? top.brand.ticker : '—'}
        sub={top ? formatUsd(top.value) : 'Nothing held yet'}
        loading={isLoading}
      />
    </div>
  );
}
