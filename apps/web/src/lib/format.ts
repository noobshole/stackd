/** Display formatting. Everything money-shaped goes through here. */

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatUsd(value: number | null | undefined, fallback = '—'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  return usd.format(value);
}

export function formatUsdCompact(value: number | null | undefined, fallback = '—'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  return usdCompact.format(value);
}

/**
 * Fractional share quantities. xStocks are 8-decimal and cashback pays out in
 * slivers, so a $4 Starbucks run at 4% buys roughly 0.0016 SBUXx — trailing
 * precision is the whole product, not noise. Show up to 6 places and trim.
 */
export function formatTokenAmount(value: number | null | undefined, fallback = '—'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  if (value === 0) return '0';

  if (value > 0 && value < 0.000001) return '<0.000001';

  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : 6;
  return value
    .toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .replace(/\.?0+$/, '');
}

export function formatPct(value: number | null | undefined, fallback = '—'): string {
  if (value == null || !Number.isFinite(value)) return fallback;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** First letter of each word, capped at two. Used for the brand monograms. */
export function monogram(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}
