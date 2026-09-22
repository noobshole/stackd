'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { getCluster } from '@stackd/solana';
import { usePortfolio } from '@/hooks/useXStockData';
import { ConnectPrompt } from '@/components/ui/ConnectPrompt';
import { Note, SectionHeader } from '@/components/ui/primitives';
import { StatsRow } from '@/components/portfolio/StatsRow';
import { HoldingsTable } from '@/components/portfolio/HoldingsTable';
import { shortenAddress } from '@/lib/format';

const NETWORK = getCluster() === 'devnet' ? 'Solana devnet' : 'Solana mainnet';

/** `?address=` → a PublicKey, or an error string for a malformed one. */
function parseAddress(raw: string | null): PublicKey | string | null {
  if (!raw) return null;
  try {
    return new PublicKey(raw.trim());
  } catch {
    return `"${raw}" is not a valid Solana address.`;
  }
}

function Portfolio() {
  const { publicKey } = useWallet();
  const params = useSearchParams();
  const rawAddress = params.get('address');

  // Memoised on the string so the query key and hook deps stay stable.
  const parsed = useMemo(() => parseAddress(rawAddress), [rawAddress]);
  const viewing = parsed instanceof PublicKey ? parsed : null;
  const owner = viewing ?? publicKey;

  const portfolio = usePortfolio(owner);

  if (typeof parsed === 'string') {
    return (
      <>
        <SectionHeader title="Portfolio" description={`Read live from ${NETWORK}.`} />
        <Note>{parsed}</Note>
      </>
    );
  }

  if (!owner) {
    return (
      <>
        <SectionHeader
          title="Portfolio"
          description={`Your xStock holdings, read live from ${NETWORK}.`}
        />
        <ConnectPrompt />
      </>
    );
  }

  const usesUnderlyingPrice = portfolio.held.some((r) => r.priceSource === 'underlying');

  return (
    <>
      <SectionHeader
        title="Portfolio"
        description={
          viewing
            ? `Holdings of ${shortenAddress(viewing.toBase58())}, read-only, live from ${NETWORK}.`
            : `Your xStock holdings, read live from ${NETWORK}.`
        }
        actions={
          <button
            type="button"
            onClick={portfolio.refetch}
            disabled={portfolio.isFetching}
            className="btn-secondary"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              aria-hidden
              className={portfolio.isFetching ? 'animate-spin' : undefined}
            >
              <path
                d="M12 7a5 5 0 1 1-1.46-3.54M12 1.5V5H8.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {portfolio.isFetching ? 'Refreshing' : 'Refresh'}
          </button>
        }
      />

      {portfolio.error && (
        <div className="mb-6">
          <Note>
            <strong className="font-medium text-loss">Could not reach the network.</strong>{' '}
            {portfolio.error.message} Balances below may be stale.
          </Note>
        </div>
      )}

      <StatsRow portfolio={portfolio} />

      <HoldingsTable rows={portfolio.held} isLoading={portfolio.isLoading} />

      {usesUnderlyingPrice && (
        <div className="mt-4">
          <Note>
            † Some of your xStocks have no meaningful on-chain liquidity yet, so Jupiter returns no
            routed price. Those rows show the underlying listed share price instead — what the
            token is a claim on, not what it would fetch on a DEX right now.
          </Note>
        </div>
      )}

      {portfolio.held.length > 0 && (
        <p className="mt-4 text-xs leading-relaxed text-ink-subtle">
          Quantities reflect the Token-2022 scaled-UI multiplier issuers apply for corporate
          actions, so they match what your wallet and the issuer&apos;s own dashboard show.
        </p>
      )}
    </>
  );
}

// useSearchParams needs a Suspense boundary, or Next bails the whole page out
// of static rendering at build time.
export default function PortfolioPage() {
  return (
    <Suspense fallback={null}>
      <Portfolio />
    </Suspense>
  );
}
