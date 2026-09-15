import type { ReactNode } from 'react';
import type { Brand } from '@stackd/solana';
import { formatPct, monogram } from '@/lib/format';

/** Brand monogram tile. Stands in for a logo without shipping brand assets. */
export function BrandMark({ brand, size = 40 }: { brand: Brand; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg font-medium text-white"
      style={{
        width: size,
        height: size,
        backgroundColor: brand.accent,
        fontSize: size * 0.34,
      }}
      aria-hidden
    >
      {monogram(brand.name)}
    </span>
  );
}

/**
 * A single figure in the stats row.
 *
 * `loading` renders a skeleton instead of a zero, because a real zero and a
 * not-yet-loaded value mean very different things to someone checking a balance.
 */
export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  loading = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'gain' | 'loss';
  loading?: boolean;
}) {
  const valueTone =
    tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : 'text-ink';

  return (
    <div className="card px-5 py-4">
      <p className="label-caps">{label}</p>
      {loading ? (
        <div className="skeleton mt-2.5 h-7 w-28" />
      ) : (
        <p className={`num mt-1.5 text-2xl font-light leading-none ${valueTone}`}>{value}</p>
      )}
      {sub && !loading && <p className="mt-1.5 text-xs text-ink-subtle">{sub}</p>}
    </div>
  );
}

/** Signed 24h change. Green only ever appears here when the number is up. */
export function ChangePill({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="text-sm text-ink-subtle">—</span>;
  }

  const up = pct >= 0;
  return (
    <span
      className={`num inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
        up ? 'bg-gain-soft text-gain' : 'bg-loss-soft text-loss'
      }`}
    >
      {formatPct(pct)}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-4 text-ink-subtle">{icon}</div>}
      <h3 className="text-base font-medium text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-medium tracking-tight text-ink">{title}</h1>
        {description && (
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Small explanatory strip. Used for the price-source and mock-mode notes. */
export function Note({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'primary' }) {
  const styles =
    tone === 'primary'
      ? 'border-primary-border bg-primary-soft text-ink'
      : 'border-line bg-sunken text-ink-muted';

  return (
    <div className={`rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed ${styles}`}>
      {children}
    </div>
  );
}
