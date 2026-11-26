'use client';

import Link from 'next/link';
import { getCluster } from '@stackd/solana';
import type { PayoutChain } from '@/lib/verify';
import { BaseWalletConnect } from '@/components/submit/BaseWallet';

/**
 * Where the shares go: the chain, and on Base the wallet and the US-person
 * declaration. Rendered only while the API pays on Base; otherwise the form is
 * the Solana-only one it always was.
 */
export function PayoutDestination({
  chain,
  onChain,
  network,
  locked,
  baseInput,
  onBaseInput,
  notUsPerson,
  onNotUsPerson,
}: {
  chain: PayoutChain;
  onChain: (chain: PayoutChain) => void;
  network: 'mainnet' | 'sepolia';
  /** True while a receipt is being checked or a result is on screen. */
  locked: boolean;
  baseInput: string;
  onBaseInput: (value: string) => void;
  notUsPerson: boolean;
  onNotUsPerson: (value: boolean) => void;
}) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-medium text-ink">Get paid on</h2>

      <div
        role="radiogroup"
        aria-label="Payout chain"
        className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1"
      >
        <ChainOption
          label="Solana"
          testnet={getCluster() === 'devnet'}
          selected={chain === 'solana'}
          disabled={locked}
          onSelect={() => onChain('solana')}
        />
        <ChainOption
          label="Base"
          testnet={network === 'sepolia'}
          selected={chain === 'base'}
          disabled={locked}
          onSelect={() => onChain('base')}
        />
      </div>

      {chain === 'solana' && (
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Shares go to the Solana wallet you connect at the top of the page.
        </p>
      )}

      {/* Kept mounted while Solana is chosen, so a connected Base wallet stays connected. */}
      <div className={chain === 'base' ? 'mt-4 space-y-4' : 'hidden'}>
        <BaseWalletConnect address={baseInput} onAddress={onBaseInput} locked={locked} />

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={notUsPerson}
            disabled={locked}
            onChange={(e) => onNotUsPerson(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span className="text-xs leading-relaxed text-ink">
            I&apos;m not a US person.
            <span className="block text-2xs text-ink-subtle">
              Coinbase&apos;s tokenized stocks aren&apos;t offered to US persons, so payouts on Base
              aren&apos;t available in the US. See the{' '}
              <Link href="/terms" className="text-primary hover:underline">
                terms
              </Link>
              .
            </span>
          </span>
        </label>

        {network === 'sepolia' && (
          <p className="rounded-lg bg-sunken px-3 py-2 text-2xs leading-relaxed text-ink-muted">
            Base is on its test network. The shares it pays are test tokens with no value.
          </p>
        )}
      </div>
    </section>
  );
}

function ChainOption({
  label,
  testnet,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  testnet: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled && !selected}
      onClick={onSelect}
      className={`flex items-center justify-center gap-2 rounded-md px-3 py-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        selected ? 'bg-surface shadow-card' : 'hover:bg-surface/60'
      }`}
    >
      <span className={`text-sm ${selected ? 'font-medium text-ink' : 'text-ink-muted'}`}>{label}</span>
      {testnet && (
        <span className="rounded-full border border-line-strong px-1.5 py-px text-2xs font-medium text-ink-subtle">
          Testnet
        </span>
      )}
    </button>
  );
}
