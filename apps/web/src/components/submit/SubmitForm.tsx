'use client';

import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { BRANDS, BRAND_BY_TICKER } from '@stackd/solana';
import { useXStockPrices } from '@/hooks/useXStockData';
import { verifyReceipt, type VerifyResponse } from '@/lib/verify';
import { ConnectPrompt } from '@/components/ui/ConnectPrompt';
import { BrandMark, SectionHeader } from '@/components/ui/primitives';
import { formatTokenAmount, formatUsd } from '@/lib/format';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'application/pdf'];

type Stage = 'idle' | 'verifying' | 'result';

/**
 * The phases the backend actually moves through, surfaced while the request is
 * in flight. Claude's vision call is the long pole and reports no progress of
 * its own, so these advance on a timer rather than on real events.
 */
const PHASES = [
  'Uploading receipt',
  'Reading the image',
  'Extracting merchant and total',
  'Checking for tampering',
  'Matching against Stackd brands',
];

export function SubmitForm() {
  const { publicKey } = useWallet();
  const { data: prices } = useXStockPrices();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [phase, setPhase] = useState(0);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
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

  // Advance the status line while the request is in flight.
  useEffect(() => {
    if (stage !== 'verifying') return;
    setPhase(0);
    const id = window.setInterval(() => {
      setPhase((p) => Math.min(p + 1, PHASES.length - 1));
    }, 1700);
    return () => window.clearInterval(id);
  }, [stage]);

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

  function acceptFile(next: File | null) {
    setFileError(null);
    setResult(null);
    setRequestError(null);
    setStage('idle');
    if (!next) return;

    if (!ACCEPTED.includes(next.type)) {
      setFileError('Upload a JPG, PNG or PDF receipt.');
      return;
    }
    if (next.size > MAX_BYTES) {
      setFileError('That file is over 10 MB. Try a photo instead of a full-resolution scan.');
      return;
    }
    setFile(next);
  }

  async function submit() {
    if (!file || !publicKey) return;

    setStage('verifying');
    setRequestError(null);
    setResult(null);

    try {
      const response = await verifyReceipt(file, publicKey.toBase58());
      setResult(response);
      setStage('result');
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Verification failed.');
      setStage('idle');
    }
  }

  function reset() {
    setFile(null);
    setResult(null);
    setRequestError(null);
    setFileError(null);
    setStage('idle');
  }

  // Convert the USD cashback into a share count using the live Jupiter price.
  const brand = result?.ticker ? BRAND_BY_TICKER[result.ticker] : undefined;
  const price = brand ? (prices?.[brand.mint]?.usd ?? null) : null;
  const shares =
    result?.cashbackUsd != null && price ? result.cashbackUsd / price : null;

  const busy = stage === 'verifying';

  return (
    <>
      <SectionHeader
        title="Submit a receipt"
        description="Claude reads the receipt, checks it's genuine, and works out what you've earned."
      />

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        {/* --- Upload --- */}
        <div className="space-y-4">
          <section className="card p-5">
            <h2 className="text-sm font-medium text-ink">Your receipt</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Any receipt from a supported brand. The merchant and total are read from the image —
              nothing to type in.
            </p>

            <div
              onDragOver={(e) => {
                if (busy) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                if (busy) return;
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
                  <div className="relative h-28 w-20 shrink-0 overflow-hidden rounded-lg border border-line">
                    {file?.type === 'application/pdf' ? (
                      <div className="flex h-28 w-20 items-center justify-center bg-surface text-2xs text-ink-subtle">
                        PDF
                      </div>
                    ) : (
                      /* Local object URL; next/image would only add indirection. */
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={previewUrl}
                        alt="Receipt preview"
                        className="h-28 w-20 object-cover"
                      />
                    )}

                    {/* Scan line, only while Claude is actually reading it. */}
                    {busy && (
                      <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 top-0 h-full"
                      >
                        <div className="h-8 w-full animate-scan bg-gradient-to-b from-transparent via-primary/35 to-transparent" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{file?.name}</p>
                    <p className="num text-xs text-ink-subtle">
                      {((file?.size ?? 0) / 1024).toFixed(0)} KB
                    </p>
                    {!busy && (
                      <button
                        type="button"
                        onClick={() => inputRef.current?.click()}
                        className="mt-2 text-xs font-medium text-primary hover:underline"
                      >
                        Replace
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="flex w-full flex-col items-center gap-2 px-6 py-9 text-center"
                >
                  <svg
                    width="26"
                    height="26"
                    viewBox="0 0 26 26"
                    fill="none"
                    aria-hidden
                    className="text-ink-subtle"
                  >
                    <path
                      d="M13 17V6m0 0L8.5 10.5M13 6l4.5 4.5M4 18v2a2 2 0 002 2h14a2 2 0 002-2v-2"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="text-sm text-ink">Drop a receipt or browse</span>
                  <span className="text-xs text-ink-subtle">JPG, PNG or PDF · up to 10 MB</span>
                </button>
              )}
            </div>

            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              className="sr-only"
              onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
            />

            {fileError && <p className="mt-2.5 text-xs text-loss">{fileError}</p>}
            {requestError && <p className="mt-2.5 text-xs text-loss">{requestError}</p>}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-medium text-ink">Supported brands</h2>
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {BRANDS.map((b) => (
                <li key={b.slug} className="flex items-center gap-2.5 rounded-lg bg-sunken px-3 py-2">
                  <BrandMark brand={b} size={26} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink">{b.name}</span>
                    <span className="num block text-2xs text-ink-muted">{b.pctBack}% back</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* --- Result rail --- */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="card p-5">
            {stage === 'verifying' && <Verifying phase={phase} />}

            {stage !== 'verifying' && !result && (
              <>
                <h2 className="text-sm font-medium text-ink">Ready when you are</h2>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                  Claude extracts the merchant, total and date, and flags anything that looks
                  edited or generated.
                </p>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!file}
                  className="btn-primary mt-5 w-full"
                >
                  Verify receipt
                </button>
                <p className="mt-3 text-center text-2xs leading-relaxed text-ink-subtle">
                  3 receipts per wallet per day. Duplicates are rejected.
                </p>
              </>
            )}

            {stage === 'result' && result && (
              <Result
                result={result}
                shares={shares}
                priceKnown={price != null}
                onReset={reset}
              />
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function Verifying({ phase }: { phase: number }) {
  return (
    <div className="py-2">
      <h2 className="text-sm font-medium text-ink">Verifying</h2>

      <ul className="mt-4 space-y-2.5">
        {PHASES.map((label, i) => {
          const done = i < phase;
          const active = i === phase;
          return (
            <li
              key={label}
              className={`flex items-center gap-2.5 text-xs transition-colors ${
                active ? 'text-ink' : done ? 'text-ink-muted' : 'text-ink-subtle'
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {done ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <path
                      d="M2.5 6.5l2.5 2.5 4.5-5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : active ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />
                )}
              </span>
              {label}
            </li>
          );
        })}
      </ul>

      <div className="skeleton mt-5 h-9 w-full rounded-lg" />
    </div>
  );
}

function Result({
  result,
  shares,
  priceKnown,
  onReset,
}: {
  result: VerifyResponse;
  shares: number | null;
  priceKnown: boolean;
  onReset: () => void;
}) {
  const brand = result.ticker ? BRAND_BY_TICKER[result.ticker] : undefined;

  if (result.flagged) {
    return (
      <>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-loss-soft">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M8 4.5v4M8 11.5h.01"
                stroke="#DC2626"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ink">Not eligible</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{result.reason}</p>
          </div>
        </div>

        {(result.merchantName || result.confidence != null) && (
          <div className="mt-4 rounded-lg bg-sunken px-3.5 py-3">
            <p className="label-caps">What Claude read</p>
            <dl className="num mt-2 space-y-1 text-xs text-ink-muted">
              {result.merchantName && <Row label="Merchant" value={result.merchantName} />}
              {result.date && <Row label="Date" value={result.date} />}
              {result.confidence != null && (
                <Row label="Confidence" value={`${Math.round(result.confidence * 100)}%`} />
              )}
            </dl>
          </div>
        )}

        <button type="button" onClick={onReset} className="btn-secondary mt-5 w-full">
          Try another receipt
        </button>

        {result.submissionsRemaining != null && (
          <p className="num mt-3 text-center text-2xs text-ink-subtle">
            {result.submissionsRemaining} of 3 submissions left today
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3">
        {brand && <BrandMark brand={brand} size={38} />}
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">{result.brand} receipt verified</h2>
          <p className="num text-xs text-ink-muted">
            {result.confidence != null && `${Math.round(result.confidence * 100)}% confidence`}
          </p>
        </div>
      </div>

      <dl className="num mt-4 space-y-2.5 text-sm">
        <Row label="Receipt total" value={formatUsd(result.amountUsd)} muted />
        <Row label={`Cashback (${result.pctBack}%)`} value={formatUsd(result.cashbackUsd)} muted />
        <div className="border-t border-line pt-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted">{result.ticker} to you</dt>
            <dd className="text-base font-medium text-ink">
              {shares != null ? formatTokenAmount(shares) : '—'}
            </dd>
          </div>
        </div>
      </dl>

      {!priceKnown && (
        <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
          Share count pending — no live price for {result.ticker} right now.
        </p>
      )}

      <button type="button" disabled className="btn-primary mt-5 w-full">
        Claim {result.ticker}
      </button>
      <p className="mt-2.5 text-center text-2xs leading-relaxed text-ink-subtle">
        Verification is live. The treasury transfer that pays this out lands next.
      </p>

      <button type="button" onClick={onReset} className="btn-ghost mt-2 w-full">
        Submit another
      </button>

      {result.submissionsRemaining != null && (
        <p className="num mt-2 text-center text-2xs text-ink-subtle">
          {result.submissionsRemaining} of 3 submissions left today
        </p>
      )}
    </>
  );
}

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={muted ? 'text-ink-muted' : 'text-ink-subtle'}>{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
