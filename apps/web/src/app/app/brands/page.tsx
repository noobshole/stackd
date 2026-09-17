'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BRANDS } from '@stackd/solana';
import { useXStockPrices } from '@/hooks/useXStockData';
import { BrandMark, Note, SectionHeader } from '@/components/ui/primitives';
import { formatTokenAmount, formatUsd, shortenAddress } from '@/lib/format';

export default function BrandsPage() {
  const { data: prices, isLoading } = useXStockPrices();

  // Drives the "what a receipt this size pays out" preview on every card.
  const [spend, setSpend] = useState('50');
  const spendValue = Number.parseFloat(spend);
  const validSpend = Number.isFinite(spendValue) && spendValue > 0 ? spendValue : null;

  return (
    <>
      <SectionHeader
        title="Brands"
        description="Every payout is a real tokenized share, issued by Backed Finance or Backpack Securities and collateralised 1:1 by the underlying stock — not points."
      />

      <div className="card mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <label htmlFor="spend" className="text-sm text-ink-muted">
          If I spend
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-subtle">
            $
          </span>
          <input
            id="spend"
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={spend}
            onChange={(e) => setSpend(e.target.value)}
            className="num w-28 rounded-lg border border-line-strong bg-surface py-2 pl-7 pr-3
                       text-sm text-ink transition-colors focus:border-primary"
          />
        </div>
        <span className="text-sm text-ink-muted">I get back:</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {BRANDS.map((brand) => {
          const price = prices?.[brand.mint];
          const cashUsd = validSpend != null ? (validSpend * brand.pctBack) / 100 : null;
          const shares = cashUsd != null && price?.usd ? cashUsd / price.usd : null;

          return (
            <article key={brand.slug} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <BrandMark brand={brand} size={44} />
                  <div>
                    <h2 className="font-medium text-ink">{brand.name}</h2>
                    <p className="num text-xs text-ink-muted">{brand.ticker}</p>
                  </div>
                </div>

                {/* Indigo, not green: this is a rate, not a gain. */}
                <span
                  className="num shrink-0 rounded-md bg-primary-soft px-2 py-1 text-sm
                             font-medium text-primary"
                >
                  {brand.pctBack}% back
                </span>
              </div>

              <p className="mt-4 text-xs leading-relaxed text-ink-muted">{brand.underlying}</p>

              <div className="mt-4 rounded-lg bg-sunken px-3.5 py-3">
                <p className="label-caps">Your cashback</p>
                {isLoading ? (
                  <div className="skeleton mt-2 h-5 w-32" />
                ) : (
                  <p className="num mt-1 text-sm text-ink">
                    {cashUsd == null ? (
                      <span className="text-ink-subtle">Enter an amount</span>
                    ) : (
                      <>
                        {formatUsd(cashUsd)}
                        {shares != null ? (
                          <span className="text-ink-muted">
                            {' '}
                            ≈ {formatTokenAmount(shares)} {brand.ticker}
                          </span>
                        ) : (
                          <span className="text-ink-subtle"> · price unavailable</span>
                        )}
                      </>
                    )}
                  </p>
                )}
                {price?.usd != null && (
                  <p className="num mt-1 text-2xs text-ink-subtle">
                    {formatUsd(price.usd)} per share
                    {price.source === 'underlying' && ' (underlying)'}
                  </p>
                )}
              </div>

              <dl className="mt-4 space-y-1.5 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-subtle">Category</dt>
                  <dd className="text-ink-muted">{brand.category}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-subtle">Mint</dt>
                  <dd className="num text-ink-muted" title={brand.mint}>
                    {shortenAddress(brand.mint, 6)}
                  </dd>
                </div>
              </dl>

              <Link
                href="/app/submit"
                className="btn-secondary mt-4 w-full"
              >
                Submit {/^[aeiou]/i.test(brand.name) ? 'an' : 'a'} {brand.name} receipt
              </Link>
            </article>
          );
        })}
      </div>

      <div className="mt-6">
        <Note>
          Rates apply to the receipt total before tax and tips. Three receipts per wallet per day.
          More brands land after the MVP set proves out.
        </Note>
      </div>
    </>
  );
}
