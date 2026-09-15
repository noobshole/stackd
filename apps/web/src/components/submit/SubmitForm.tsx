'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { BRANDS, BRAND_BY_SLUG, type Brand } from '@stackd/solana';
import { useXStockPrices } from '@/hooks/useXStockData';
import { ConnectPrompt } from '@/components/ui/ConnectPrompt';
import { BrandMark, Note, SectionHeader } from '@/components/ui/primitives';
import { formatTokenAmount, formatUsd } from '@/lib/format';

const MAX_BYTES = 10 * 1024 * 1024;

type Stage = 'compose' | 'verifying' | 'review' | 'submitting' | 'done';

/** Shape of what POST /verify-receipt will return. */
interface Extraction {
  merchant_name: string;
  total_amount: number;
  currency: string;
  date: string;
  looks_authentic: boolean;
  confidence: number;
}

export function SubmitForm() {
  const params = useSearchParams();
  const { publicKey } = useWallet();
  const { data: prices } = useXStockPrices();

  const initialSlug = params.get('brand');
  const [brand, setBrand] = useState<Brand>(
    (initialSlug && BRAND_BY_SLUG[initialSlug]) || BRANDS[0],
  );
  const [total, setTotal] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<Stage>('compose');
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Object URLs leak until revoked.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (!publicKey) {
    return (
      <>
        <SectionHeader
          title="Submit a receipt"
          description="Upload a receipt and get the brand's tokenized shares sent to your wallet."
        />
        <ConnectPrompt body="Cashback is paid straight to your Solana address, so Stackd needs a wallet connected before you can submit a receipt." />
      </>
    );
  }

  const totalValue = Number.parseFloat(total);
  const validTotal = Number.isFinite(totalValue) && totalValue > 0 ? totalValue : null;
  const canVerify = file != null && validTotal != null && stage === 'compose';

  const price = prices?.[brand.mint]?.usd ?? null;
  const cashUsd = validTotal != null ? (validTotal * brand.pctBack) / 100 : null;
  const shares = cashUsd != null && price ? cashUsd / price : null;

  function acceptFile(next: File | null) {
    setFileError(null);
    if (!next) return;

    if (!next.type.startsWith('image/')) {
      setFileError('That file is not an image. Upload a photo, screenshot, or scan of the receipt.');
      return;
    }
    if (next.size > MAX_BYTES) {
      setFileError('That image is over 10 MB. Try a photo instead of a full-resolution scan.');
      return;
    }
    setFile(next);
    setStage('compose');
    setExtraction(null);
  }

  function runVerification() {
    if (!canVerify || validTotal == null) return;
    setStage('verifying');

    // Stand-in for POST /verify-receipt. Nothing is uploaded and no image is
    // read — the fields below are assembled from what you typed.
    window.setTimeout(() => {
      setExtraction({
        merchant_name: brand.name,
        total_amount: validTotal,
        currency: 'USD',
        date: new Date().toISOString().slice(0, 10),
        looks_authentic: true,
        confidence: 0.94,
      });
      setStage('review');
    }, 1400);
  }

  function confirmPayout() {
    setStage('submitting');
    window.setTimeout(() => setStage('done'), 1200);
  }

  function reset() {
    setFile(null);
    setTotal('');
    setExtraction(null);
    setFileError(null);
    setStage('compose');
  }

  if (stage === 'done') {
    return (
      <>
        <SectionHeader title="Submit a receipt" />
        <div className="card px-6 py-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
              <path
                d="M5 11.5l4 4 8-9"
                stroke="#4F46E5"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-medium text-ink">Walkthrough complete</h2>
          <p className="num mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
            In the live flow this is where {shares != null ? formatTokenAmount(shares) : 'your'}{' '}
            {brand.ticker} would leave the treasury and land in your wallet.
          </p>
          <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-ink-subtle">
            Nothing was uploaded, verified or transferred. The backend that does the real work
            lands next.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={reset} className="btn-secondary">
              Run it again
            </button>
            <Link href="/app/portfolio" className="btn-primary">
              Back to portfolio
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <SectionHeader
        title="Submit a receipt"
        description="Upload a receipt and get the brand's tokenized shares sent to your wallet."
      />

      <div className="mb-6">
        <Note tone="primary">
          <strong className="font-medium">Preview mode.</strong> The receipt never leaves your
          browser and no tokens move. Claude Vision verification and the treasury transfer are
          wired up next — this walks the shape of the flow.
        </Note>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-4">
          {/* --- Brand --- */}
          <section className="card p-5">
            <h2 className="text-sm font-medium text-ink">1. Where did you shop?</h2>
            <div className="mt-3.5 grid grid-cols-2 gap-2">
              {BRANDS.map((b) => {
                const selected = b.slug === brand.slug;
                return (
                  <button
                    key={b.slug}
                    type="button"
                    onClick={() => setBrand(b)}
                    aria-pressed={selected}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left
                                transition-colors ${
                                  selected
                                    ? 'border-primary bg-primary-soft'
                                    : 'border-line hover:border-line-strong hover:bg-sunken'
                                }`}
                  >
                    <BrandMark brand={b} size={30} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{b.name}</span>
                      <span className="num block text-2xs text-ink-muted">{b.pctBack}% back</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* --- Image --- */}
          <section className="card p-5">
            <h2 className="text-sm font-medium text-ink">2. Upload the receipt</h2>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                acceptFile(e.dataTransfer.files?.[0] ?? null);
              }}
              className={`mt-3.5 rounded-xl border border-dashed transition-colors ${
                dragging ? 'border-primary bg-primary-soft' : 'border-line-strong bg-sunken'
              }`}
            >
              {previewUrl ? (
                <div className="flex items-center gap-4 p-4">
                  {/* Local object URL; next/image would only add indirection here. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt="Receipt preview"
                    className="h-24 w-20 rounded-lg border border-line object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{file?.name}</p>
                    <p className="num text-xs text-ink-subtle">
                      {((file?.size ?? 0) / 1024).toFixed(0)} KB
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setFile(null);
                        setStage('compose');
                        setExtraction(null);
                      }}
                      className="mt-2 text-xs font-medium text-primary hover:underline"
                    >
                      Replace
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="flex w-full flex-col items-center gap-2 px-6 py-9 text-center"
                >
                  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden className="text-ink-subtle">
                    <path
                      d="M13 17V6m0 0L8.5 10.5M13 6l4.5 4.5M4 18v2a2 2 0 002 2h14a2 2 0 002-2v-2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="text-sm text-ink">Drop a receipt or browse</span>
                  <span className="text-xs text-ink-subtle">JPG, PNG or HEIC · up to 10 MB</span>
                </button>
              )}
            </div>

            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
            />

            {fileError && <p className="mt-2.5 text-xs text-loss">{fileError}</p>}
          </section>

          {/* --- Total --- */}
          <section className="card p-5">
            <h2 className="text-sm font-medium text-ink">3. What was the total?</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Typed by hand for now. Claude Vision reads this off the image once the backend is
              live.
            </p>
            <div className="relative mt-3.5">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-ink-subtle">
                $
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={total}
                onChange={(e) => {
                  setTotal(e.target.value);
                  setStage('compose');
                  setExtraction(null);
                }}
                className="num w-full rounded-lg border border-line-strong bg-surface py-2.5 pl-8 pr-3
                           text-sm text-ink transition-colors focus:border-primary"
              />
            </div>
          </section>
        </div>

        {/* --- Summary rail --- */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="card p-5">
            <h2 className="text-sm font-medium text-ink">You&apos;ll receive</h2>

            <div className="mt-4 flex items-center gap-3 rounded-lg bg-sunken px-3.5 py-3">
              <BrandMark brand={brand} size={38} />
              <div className="min-w-0 flex-1">
                <p className="num text-sm text-ink">{brand.ticker}</p>
                <p className="truncate text-xs text-ink-muted">{brand.underlying}</p>
              </div>
            </div>

            <dl className="num mt-4 space-y-2.5 text-sm">
              <Row label="Receipt total" value={validTotal != null ? formatUsd(validTotal) : '—'} />
              <Row label={`Cashback (${brand.pctBack}%)`} value={formatUsd(cashUsd)} />
              <Row
                label="Share price"
                value={price != null ? formatUsd(price) : '—'}
              />
              <div className="border-t border-line pt-2.5">
                <Row
                  label={`${brand.ticker} to you`}
                  value={shares != null ? formatTokenAmount(shares) : '—'}
                  emphasis
                />
              </div>
            </dl>

            {extraction && (
              <div className="mt-4 rounded-lg border border-line bg-sunken px-3.5 py-3">
                <p className="label-caps">Simulated extraction</p>
                <dl className="num mt-2 space-y-1 text-xs text-ink-muted">
                  <Row label="Merchant" value={extraction.merchant_name} small />
                  <Row label="Total" value={formatUsd(extraction.total_amount)} small />
                  <Row label="Date" value={extraction.date} small />
                  <Row label="Confidence" value={extraction.confidence.toFixed(2)} small />
                  <Row
                    label="Looks authentic"
                    value={extraction.looks_authentic ? 'Yes' : 'No'}
                    small
                  />
                </dl>
              </div>
            )}

            <div className="mt-5">
              {stage === 'review' || stage === 'submitting' ? (
                <button
                  type="button"
                  onClick={confirmPayout}
                  disabled={stage === 'submitting'}
                  className="btn-primary w-full"
                >
                  {stage === 'submitting' ? 'Sending…' : 'Confirm payout'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={runVerification}
                  disabled={!canVerify}
                  className="btn-primary w-full"
                >
                  {stage === 'verifying' ? 'Verifying receipt…' : 'Verify receipt'}
                </button>
              )}
            </div>

            <p className="mt-3 text-center text-2xs leading-relaxed text-ink-subtle">
              3 receipts per wallet per day. Duplicate receipts are rejected.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  emphasis = false,
  small = false,
}: {
  label: string;
  value: React.ReactNode;
  emphasis?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={small ? 'text-ink-subtle' : 'text-ink-muted'}>{label}</dt>
      <dd className={emphasis ? 'text-base font-medium text-ink' : 'text-ink'}>{value}</dd>
    </div>
  );
}
