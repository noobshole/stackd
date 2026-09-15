'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { shortenAddress } from '@/lib/format';

/**
 * Replaces the stock `WalletMultiButton`, which arrives as a rounded purple
 * pill and reads as a DEX. Same behaviour, brokerage clothes.
 */
export function WalletButton({ className = '' }: { className?: string }) {
  const { publicKey, wallet, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const address = publicKey?.toBase58();

  // Close the dropdown on an outside click or Escape.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const copyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked by permissions; the address is on screen anyway.
    }
  }, [address]);

  if (!address) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        disabled={connecting}
        className={`btn-primary ${className}`}
      >
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }

  return (
    <div className={`relative ${className}`} ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-secondary num"
      >
        {wallet?.adapter.icon && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={wallet.adapter.icon} alt="" aria-hidden className="h-4 w-4 rounded-sm" />
        )}
        {shortenAddress(address)}
        <svg
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          aria-hidden
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border
                     border-line bg-surface py-1 shadow-lift animate-fade-up"
        >
          <div className="border-b border-line px-3 pb-2.5 pt-2">
            <p className="label-caps">{wallet?.adapter.name ?? 'Wallet'}</p>
            <p className="num mt-1 break-all text-xs text-ink-muted">{shortenAddress(address, 8)}</p>
          </div>

          <MenuItem onClick={copyAddress}>{copied ? 'Copied' : 'Copy address'}</MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              setVisible(true);
            }}
          >
            Change wallet
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              void disconnect();
            }}
          >
            Disconnect
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-2 text-left text-sm text-ink-muted transition-colors
                 hover:bg-sunken hover:text-ink"
    >
      {children}
    </button>
  );
}
