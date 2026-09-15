'use client';

import { WalletButton } from '@/components/wallet/WalletButton';
import { EmptyState } from '@/components/ui/primitives';

/** Shown on any DApp page that needs an address before it can show anything. */
export function ConnectPrompt({
  title = 'Connect a wallet',
  body = 'Stackd reads your xStock balances straight from Solana. Connect Phantom, Backpack or Solflare to see what you hold.',
}: {
  title?: string;
  body?: string;
}) {
  return (
    <div className="card">
      <EmptyState
        icon={
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
            <rect
              x="5.5"
              y="10.5"
              width="29"
              height="20"
              rx="4"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M5.5 16.5h29" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="28" cy="24" r="2" fill="currentColor" />
          </svg>
        }
        title={title}
        body={body}
        action={<WalletButton />}
      />
    </div>
  );
}
