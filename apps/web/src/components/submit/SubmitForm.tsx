'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { BRANDS, BRAND_BY_SLUG, BRAND_BY_TICKER, type Brand } from '@stackd/solana';
import { baseStock, parseBaseAddress } from '@stackd/base/web';
import { useXStockPrices } from '@/hooks/useXStockData';
import { useBaseNetwork } from '@/hooks/useBaseNetwork';
import {
  confirmReceipt,
  PayoutPendingError,
  verifyReceipt,
  type ConfirmResponse,
  type PayoutChain,
  type VerifyResponse,
} from '@/lib/verify';
import { ConnectPrompt } from '@/components/ui/ConnectPrompt';
import { BrandMark, SectionHeader } from '@/components/ui/primitives';
import { PayoutDestination } from '@/components/submit/PayoutDestination';
import { BASE_BRANDS, BASE_BRAND_NAMES } from '@/lib/base-brands';
import { formatMoney, formatTokenAmount, formatUsd } from '@/lib/format';

/** The brand behind a result: its Solana xStock ticker, or its Base stock's. */
function brandOf(ticker: string | null | undefined): Brand | undefined {
  if (!ticker) return undefined;
  const stock = baseStock(ticker);
  return BRAND_BY_TICKER[ticker] ?? (stock ? BRAND_BY_SLUG[stock.slug] : undefined);
}

// The API refuses anything bigger (its host caps a request at 4.5 MB).
const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'application/pdf'];

/**
 * A saved receipt email. Browsers label .eml files message/rfc822 when the OS
 * knows the type and leave it empty when it doesn't, so the name decides too.
 */
function isEmailFile(file: File): boolean {
  return file.type === 'message/rfc822' || /\.eml$/i.test(file.name);
}

type Stage = 'idle' | 'verifying' | 'result';

/**
 * The phases the backend actually moves through, surfaced while the request is
 * in flight. Claude's call is the long pole and reports no progress of its
 * own, so these advance on a timer rather than on real events.
 */
const PHOTO_PHASES = [
  'Uploading receipt',
  'Reading the image',
  'Extracting merchant and total',
  'Checking for tampering',
  'Matching against Stackd brands',
];

const EMAIL_PHASES = [
  'Uploading email',
  "Checking the store's signature",
  'Reading the total',
  'Matching against Stackd brands',
];

export function SubmitForm() {
  const { publicKey } = useWallet();
  const { data: prices } = useXStockPrices();
  const { network: baseNetwork } = useBaseNetwork();
  const params = useSearchParams();

  // ?chain=base preselects Base; it only takes effect while the API pays on Base.
  const [chainChoice, setChainChoice] = useState<PayoutChain>(
    params.get('chain') === 'base' ? 'base' : 'solana',
  );
  const chain: PayoutChain = baseNetwork ? chainChoice : 'solana';
  const [baseInput, setBaseInput] = useState('');
  const [notUsPerson, setNotUsPerson] = useState(false);
  const baseAddress = chain === 'base' ? parseBaseAddress(baseInput) : null;

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [phase, setPhase] = useState(0);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [claim, setClaim] = useState<ConfirmResponse | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [pending, setPending] = useState<PayoutPendingError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isEmail = file ? isEmailFile(file) : false;
  const phases = isEmail ? EMAIL_PHASES : PHOTO_PHASES;

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
      setPhase((p) => Math.min(p + 1, phases.length - 1));
    }, 1700);
    return () => window.clearInterval(id);
  }, [stage, phases.length]);

  const busy = stage === 'verifying';

  // The chain can't change under a result: a verified receipt is claimable
  // only on the chain it was checked for.
  const destination = baseNetwork && (
    <PayoutDestination
      chain={chain}
      onChain={setChainChoice}
      network={baseNetwork}
      locked={busy || stage === 'result'}
      baseInput={baseInput}
      onBaseInput={setBaseInput}
      notUsPerson={notUsPerson}
      onNotUsPerson={setNotUsPerson}
    />
  );

  if (chain === 'solana' && !publicKey) {
    return (
      <>
        <SectionHeader
          title="Submit a receipt"
          description="Upload a receipt and get the brand's tokenized shares sent to your wallet."
        />
        {destination && <div className="mb-4 max-w-xl">{destination}</div>}
        <ConnectPrompt
          body={
            baseNetwork
              ? 'Cashback on Solana is paid straight to your Solana address, so connect a wallet first. Or choose Base above and paste a Base address.'
              : 'Cashback is paid straight to your Solana address, so Stackd needs a wallet connected before you can submit a receipt.'
          }
        />
      </>
    );
  }

  function acceptFile(next: File | null) {
    setFileError(null);
    setResult(null);
    setRequestError(null);
    setStage('idle');
    if (!next) return;

    if (!ACCEPTED.includes(next.type) && !isEmailFile(next)) {
      setFileError('Upload a JPG, PNG or PDF receipt, or the receipt email as an .eml file.');
      return;
    }
    if (next.size > MAX_BYTES) {
      setFileError('That file is over 4 MB. Try a photo instead of a full-resolution scan.');
      return;
    }
    setFile(next);
  }

  const wallet = chain === 'base' ? baseAddress : (publicKey?.toBase58() ?? null);
  const ready = Boolean(file && wallet && (chain === 'solana' || notUsPerson));

  async function submit() {
    if (!file || !wallet || !ready) return;

    setStage('verifying');
    setRequestError(null);
    setResult(null);

    try {
      const response = await verifyReceipt(
        file,
        wallet,
        chain === 'base' ? { chain, notUsPerson } : {},
      );
      setResult(response);
      setStage('result');
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Verification failed.');
      setStage('idle');
    }
  }

  async function claimReward() {
    if (!result?.receiptId) return;

    setClaiming(true);
    setClaimError(null);
    try {
      setClaim(await confirmReceipt(result.receiptId));
    } catch (error) {
      if (error instanceof PayoutPendingError) setPending(error);
      else setClaimError(error instanceof Error ? error.message : 'Payout failed.');
    } finally {
      setClaiming(false);
    }
  }

  function reset() {
    setFile(null);
    setResult(null);
    setRequestError(null);
    setFileError(null);
    setClaim(null);
    setClaimError(null);
    setPending(null);
    setClaiming(false);
    setStage('idle');
  }

  // Convert the USD cashback into a share count using the live Jupiter price.
  // Solana only: a Base stock's token price carries its own multiplier, so the
  // count there is worked out by the API at payout.
  const resultChain: PayoutChain = result?.chain ?? chain;
  const brand = resultChain === 'solana' ? brandOf(result?.ticker) : undefined;
  const price = brand ? (prices?.[brand.mint]?.usd ?? null) : null;
  const shares =
    result?.cashbackUsd != null && price ? result.cashbackUsd / price : null;

  return (
    <>
      <SectionHeader
        title="Submit a receipt"
        description="We check the receipt is genuine, read the total, and work out what you've earned."
      />

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        {/* --- Upload --- */}
        <div className="space-y-4">
          {destination}

          <section className="card p-5">
            <h2 className="text-sm font-medium text-ink">Your receipt</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Any receipt from a supported brand. The merchant and total are read for you — nothing
              to type in.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
              <span className="font-medium text-ink">Got the receipt by email?</span> Upload the email
              itself as an .eml file (Gmail: ⋮ → Download message). It carries the store&apos;s own
              signature, so it&apos;s proved genuine and earns on the full total.
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
                    {file?.type === 'application/pdf' || isEmail ? (
                      <div className="flex h-28 w-20 items-center justify-center bg-surface text-2xs text-ink-subtle">
                        {isEmail ? 'Email' : 'PDF'}
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
                  <span className="text-xs text-ink-subtle">
                    JPG, PNG, PDF or receipt email (.eml) · up to 4 MB
                  </span>
                </button>
              )}
            </div>

            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,application/pdf,message/rfc822,.eml"
              className="sr-only"
              onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
            />

            {fileError && <p className="mt-2.5 text-xs text-loss">{fileError}</p>}
            {requestError && <p className="mt-2.5 text-xs text-loss">{requestError}</p>}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-medium text-ink">
              {chain === 'base' ? 'Brands paid on Base' : 'Supported brands'}
            </h2>
            {chain === 'base' && (
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                On Base, Stackd pays {BASE_BRAND_NAMES} receipts in Coinbase Tokenized Stocks. Other
                brands pay on Solana.
              </p>
            )}
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {(chain === 'base'
                ? BASE_BRANDS
                : BRANDS.map((b) => ({ brand: b, ticker: null }))
              ).map(({ brand: b, ticker }) => (
                <li key={b.slug} className="flex items-center gap-2.5 rounded-lg bg-sunken px-3 py-2">
                  <BrandMark brand={b} size={26} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ink">{b.name}</span>
                    <span className="num block text-2xs text-ink-muted">
                      {b.pctBack}% back{ticker ? ` · ${ticker}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* --- Result rail --- */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="card p-5">
            {stage === 'verifying' && <Verifying phases={phases} phase={phase} />}

            {stage !== 'verifying' && !result && (
              <>
                <h2 className="text-sm font-medium text-ink">Ready when you are</h2>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                  {isEmail
                    ? "We check the store's signature on the email, then read the total, date and order number."
                    : 'Claude extracts the merchant, total and date, and flags anything that looks edited or generated.'}
                </p>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!ready}
                  className="btn-primary mt-5 w-full"
                >
                  Verify receipt
                </button>
                {chain === 'base' && !(baseAddress && notUsPerson) && (
                  <p className="mt-2.5 text-center text-2xs leading-relaxed text-ink-muted">
                    {baseAddress
                      ? "Confirm you're not a US person to be paid on Base."
                      : "Add the Base address to pay, then confirm you're not a US person."}
                  </p>
                )}
                <p className="mt-3 text-center text-2xs leading-relaxed text-ink-subtle">
                  3 receipts per wallet per day. Duplicates are rejected.
                </p>
              </>
            )}

            {stage === 'result' && result && (
              <Result
                result={result}
                chain={resultChain}
                shares={shares}
                priceKnown={price != null}
                claim={claim}
                claiming={claiming}
                claimError={claimError}
                pending={pending}
                onClaim={claimReward}
                onReset={reset}
              />
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function Verifying({ phases, phase }: { phases: string[]; phase: number }) {
  return (
    <div className="py-2">
      <h2 className="text-sm font-medium text-ink">Verifying</h2>

      <ul className="mt-4 space-y-2.5">
        {phases.map((label, i) => {
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
  chain,
  shares,
  priceKnown,
  claim,
  claiming,
  claimError,
  pending,
  onClaim,
  onReset,
}: {
  result: VerifyResponse;
  chain: PayoutChain;
  shares: number | null;
  priceKnown: boolean;
  claim: ConfirmResponse | null;
  claiming: boolean;
  claimError: string | null;
  pending: PayoutPendingError | null;
  onClaim: () => void;
  onReset: () => void;
}) {
  const brand = brandOf(result.ticker);
  const converted =
    result.currency != null && result.currency !== 'USD' && result.originalAmount != null;

  const header = (
    <div className="flex items-center gap-3">
      {brand && <BrandMark brand={brand} size={38} />}
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-ink">{result.brand} receipt verified</h2>
        <p className="num text-xs text-ink-muted">
          {result.verifiedBy
            ? `Signed by ${result.verifiedBy.domain}`
            : result.confidence != null && `${Math.round(result.confidence * 100)}% confidence`}
        </p>
      </div>
    </div>
  );

  const breakdown = (
    <>
      <dl className="num mt-4 space-y-2.5 text-sm">
        <Row
          label="Receipt total"
          value={
            converted
              ? `${formatMoney(result.originalAmount, result.currency)} ≈ ${formatUsd(result.amountUsd)}`
              : formatUsd(result.amountUsd)
          }
          muted
        />
        {result.eligibleUsd != null && (
          <Row label="Earns cashback" value={formatUsd(result.eligibleUsd)} muted />
        )}
        <Row label={`Cashback (${result.pctBack}%)`} value={formatUsd(result.cashbackUsd)} muted />
        <div className="border-t border-line pt-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted">{result.ticker} to you</dt>
            <dd className="text-base font-medium text-ink">
              {chain === 'base'
                ? `${formatUsd(result.cashbackUsd)} worth`
                : shares != null
                  ? formatTokenAmount(shares)
                  : '—'}
            </dd>
          </div>
        </div>
      </dl>

      {chain === 'base' && (
        <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
          Paid on Base in Coinbase Tokenized Stocks. The number of shares is worked out from the
          live price when you claim.
        </p>
      )}

      {converted && result.fxRate != null && (
        <p className="num mt-2 text-2xs leading-relaxed text-ink-subtle">
          Converted at 1 USD = {result.fxRate.toLocaleString('en-US')} {result.currency}
          {result.fxRateDate && `, ECB reference rate for ${result.fxRateDate}`}.
        </p>
      )}

      {result.digitalCapUsd != null && (
        <p className="num mt-2 text-2xs leading-relaxed text-ink-subtle">
          Online orders earn cashback on up to {formatUsd(result.digitalCapUsd)} of the total.
        </p>
      )}

      {chain === 'solana' && !priceKnown && (
        <p className="mt-2 text-2xs leading-relaxed text-ink-subtle">
          Share count pending — no live price for {result.ticker} right now.
        </p>
      )}
    </>
  );

  const remaining = result.submissionsRemaining != null && (
    <p className="num mt-2 text-center text-2xs text-ink-subtle">
      {result.submissionsRemaining} of 3 submissions left today
    </p>
  );

  if (result.paused) {
    return (
      <>
        {header}
        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-2.5 py-1 text-2xs font-medium text-primary">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
          Payout pending
        </span>
        {breakdown}

        <p className="mt-4 rounded-lg bg-sunken px-3 py-2.5 text-2xs leading-relaxed text-ink-muted">
          Payouts in {result.ticker} are paused while we restock. This receipt wasn&apos;t used up
          {result.resendBy
            ? `: if they reopen by ${formatDay(result.resendBy)}, send it again then.`
            : ': send it again once they reopen.'}
        </p>

        <a
          href={shareOnXUrl(result, shares)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary mt-5 w-full"
        >
          Share on X
        </a>
        <button type="button" onClick={onReset} className="btn-ghost mt-2 w-full">
          Try another receipt
        </button>
        {remaining}
      </>
    );
  }

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
      {header}
      {breakdown}

      {claim ? (
        <Claimed claim={claim} />
      ) : pending ? (
        <div className="mt-5 rounded-lg bg-sunken px-3 py-2.5 text-2xs leading-relaxed text-ink-muted">
          {pending.message}
          {pending.explorer && (
            <>
              {' '}
              <a
                href={pending.explorer}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {explorerName(chain)}
              </a>
            </>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={onClaim}
            disabled={claiming || !result.receiptId}
            className="btn-primary mt-5 w-full"
          >
            {claiming ? `Sending ${result.ticker}…` : `Claim ${result.ticker}`}
          </button>
          {claimError && <p className="mt-2.5 text-xs text-loss">{claimError}</p>}
        </>
      )}

      <button type="button" onClick={onReset} className="btn-ghost mt-2 w-full">
        Submit another
      </button>
      {remaining}
    </>
  );
}

/** "2026-11-03" → "3 Nov", read as the calendar day it names. */
function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * A post about a paused receipt's reward. The brand and the amount only: no
 * receipt total, image or wallet address.
 */
function shareOnXUrl(result: VerifyResponse, shares: number | null): string {
  const amount =
    shares != null
      ? `${formatTokenAmount(shares)} ${result.ticker}`
      : `${formatUsd(result.cashbackUsd)} of ${result.ticker}`;
  const text = `My ${result.brand} receipt is worth ${amount} on @stackd_: cashback paid in tokenized ${result.brand} stock.`;
  const site =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    (typeof window !== 'undefined' ? window.location.origin : 'https://usestackd.vercel.app');
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(site)}`;
}

/**
 * Landed payouts.
 *
 * Both legs confirmed shows two rows. A held or paused bonus shows one row plus
 * a quiet note — deliberately not an error: the bonus starts from a wallet's
 * second receipt, a refilling vault is a normal operating state, and either way
 * the user got paid the thing they came for.
 */
function Claimed({ claim }: { claim: ConfirmResponse }) {
  const chain = claim.chain ?? 'solana';
  const href = claim.xstock.explorer ?? claim.xstock.solscan;
  return (
    <div className="mt-5">
      <p className="label-caps">Sent{chain === 'base' ? ' on Base' : ''}</p>

      <ul className="mt-2.5 space-y-2">
        <PayoutRow
          label={`${claim.xstock.ticker}${
            claim.xstock.amount != null ? ` · ${formatTokenAmount(claim.xstock.amount)}` : ''
          }`}
          href={href}
          explorer={explorerName(chain)}
        />
        {claim.bonus && (
          <PayoutRow label="STACKD bonus" href={claim.bonus.solscan} explorer="Solscan" />
        )}
      </ul>

      {claim.bonusFirstClaim ? (
        <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-2xs leading-relaxed text-ink-muted">
          Your $STACKD bonus starts from your next receipt. Your {claim.xstock.ticker} is on its
          way.
        </p>
      ) : (
        claim.bonusPaused && (
          <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-2xs leading-relaxed text-ink-muted">
            Bonus paused — vault refilling. Your {claim.xstock.ticker} is on its way.
          </p>
        )
      )}
    </div>
  );
}

function explorerName(chain: PayoutChain): string {
  return chain === 'base' ? 'Basescan' : 'Solscan';
}

function PayoutRow({
  label,
  href,
  explorer,
}: {
  label: string;
  href: string | undefined;
  explorer: string;
}) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg bg-sunken px-3 py-2.5">
      {/* Indigo, not green — green means "the number went up", not "it sent". */}
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-soft">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            d="M2.5 6.5l2.5 2.5 4.5-5"
            stroke="#4046B5"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="num min-w-0 flex-1 truncate text-xs text-ink">{label}</span>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-2xs font-medium text-primary hover:underline"
        >
          {explorer}
        </a>
      )}
    </li>
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
