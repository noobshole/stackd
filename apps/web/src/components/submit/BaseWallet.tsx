'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseBaseAddress } from '@stackd/base/web';
import { shortenAddress } from '@/lib/format';

/**
 * Connecting a Base wallet, with no wallet library: browser wallets announce
 * themselves over EIP-6963, and a payout only needs the address, so nothing
 * is ever signed. The wallet's own prompt is the only thing the user approves.
 */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

interface BrowserWallet {
  /** EIP-6963 reverse-DNS id, e.g. "io.metamask". Stable across visits. */
  rdns: string;
  name: string;
  /** A data: image URL from the wallet, or null. */
  icon: string | null;
  provider: Eip1193Provider;
}

/** Which wallet was connected, so a return visit reconnects without a prompt. */
const STORAGE_KEY = 'stackd:base-wallet';

function remembered(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(rdns: string | null) {
  try {
    if (rdns) window.localStorage.setItem(STORAGE_KEY, rdns);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; the user just connects again next time.
  }
}

/** A wallet's icon, only as an inline image: never a URL the browser would fetch. */
function safeIcon(icon: unknown): string | null {
  return typeof icon === 'string' && icon.startsWith('data:image/') ? icon : null;
}

/** The first account a wallet reports, checksummed, or null when there is none we can pay. */
function firstAccount(accounts: unknown): string | null {
  return Array.isArray(accounts) ? parseBaseAddress(accounts[0]) : null;
}

/** Browser wallets announced over EIP-6963, or window.ethereum when none announces. */
function useBrowserWallets(): { wallets: BrowserWallet[]; searched: boolean } {
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const found = new Map<string, BrowserWallet>();

    function onAnnounce(event: Event) {
      const detail = (event as CustomEvent).detail as
        | { info?: { uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown }; provider?: Eip1193Provider }
        | undefined;
      const info = detail?.info;
      const provider = detail?.provider;
      if (!info || typeof provider?.request !== 'function') return;
      const rdns = typeof info.rdns === 'string' ? info.rdns : String(info.uuid ?? '');
      if (!rdns) return;
      found.set(rdns, {
        rdns,
        name: typeof info.name === 'string' && info.name ? info.name : 'Browser wallet',
        icon: safeIcon(info.icon),
        provider,
      });
      setWallets([...found.values()]);
    }

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // Wallets answer at once; one that predates EIP-6963 only sets window.ethereum.
    const timer = window.setTimeout(() => {
      if (found.size === 0) {
        const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
        if (eth && typeof eth.request === 'function') {
          found.set('injected', { rdns: 'injected', name: 'Browser wallet', icon: null, provider: eth });
          setWallets([...found.values()]);
        }
      }
      setSearched(true);
    }, 500);

    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      window.clearTimeout(timer);
    };
  }, []);

  return { wallets, searched };
}

/**
 * Connect, or fall back to pasting. `onAddress` receives the checksummed
 * address, or '' when the wallet disconnects.
 */
export function BaseWalletConnect({
  address,
  onAddress,
  locked,
}: {
  address: string;
  onAddress: (value: string) => void;
  /** While a receipt is checked or its result is on screen, the address is fixed. */
  locked: boolean;
}) {
  const { wallets, searched } = useBrowserWallets();
  const [connected, setConnected] = useState<BrowserWallet | null>(null);
  const [picking, setPicking] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // A return visit: ask the remembered wallet for its account without a prompt.
  useEffect(() => {
    if (connected || pasting) return;
    const rdns = remembered();
    const wallet = rdns ? wallets.find((w) => w.rdns === rdns) : undefined;
    if (!wallet) return;
    let cancelled = false;
    wallet.provider
      .request({ method: 'eth_accounts' })
      .then((accounts) => {
        const account = firstAccount(accounts);
        if (cancelled || !account) return;
        setConnected(wallet);
        onAddress(account);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wallets, connected, pasting, onAddress]);

  const disconnect = useCallback(() => {
    // Best effort: wallets that support it forget the site too.
    connected?.provider
      .request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
      .catch(() => {});
    setConnected(null);
    remember(null);
    onAddress('');
  }, [connected, onAddress]);

  // Follow account switches in the wallet, except under a result: that
  // receipt pays the address it was checked with.
  useEffect(() => {
    const provider = connected?.provider;
    if (!provider?.on) return;
    function onAccounts(accounts: unknown) {
      if (lockedRef.current) return;
      const account = firstAccount(accounts);
      if (account) onAddress(account);
      else disconnect();
    }
    provider.on('accountsChanged', onAccounts);
    return () => provider.removeListener?.('accountsChanged', onAccounts);
  }, [connected, onAddress, disconnect]);

  async function connect(wallet: BrowserWallet) {
    setError(null);
    setBusy(wallet.rdns);
    try {
      const account = firstAccount(await wallet.provider.request({ method: 'eth_requestAccounts' }));
      if (!account) throw new Error('no account');
      setConnected(wallet);
      setPicking(false);
      setPasting(false);
      remember(wallet.rdns);
      onAddress(account);
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      setError(
        code === 4001
          ? `The request was declined in ${wallet.name}.`
          : code === -32002
            ? `Open ${wallet.name}: a connection request is already waiting there.`
            : `${wallet.name} didn't share an address. Try again, or paste it instead.`,
      );
    } finally {
      setBusy(null);
    }
  }

  if (connected && address) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line bg-sunken px-3 py-2.5">
        <WalletIcon wallet={connected} />
        <div className="min-w-0 flex-1">
          <p className="num truncate text-sm text-ink">{shortenAddress(address, 6)}</p>
          <p className="text-2xs text-ink-subtle">Connected with {connected.name}</p>
        </div>
        {!locked && (
          <button type="button" onClick={disconnect} className="shrink-0 text-xs font-medium text-primary hover:underline">
            Disconnect
          </button>
        )}
      </div>
    );
  }

  const noWallet = searched && wallets.length === 0;

  if (pasting || noWallet) {
    const trimmed = address.trim();
    const valid = trimmed === '' || parseBaseAddress(trimmed) != null;
    return (
      <div>
        {noWallet && (
          <p className="mb-2.5 text-xs leading-relaxed text-ink-muted">
            No browser wallet found. Open Stackd in your wallet app&apos;s browser to connect, or
            paste your Base address.
          </p>
        )}
        <label htmlFor="base-address" className="sr-only">
          Your Base address
        </label>
        <input
          id="base-address"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="0x…"
          value={address}
          disabled={locked}
          onChange={(e) => onAddress(e.target.value)}
          aria-invalid={!valid}
          aria-describedby="base-address-help"
          className={`num w-full rounded-lg border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle disabled:opacity-60 ${
            valid ? 'border-line-strong' : 'border-loss'
          }`}
        />
        <p id="base-address-help" className="mt-1.5 text-2xs leading-relaxed text-ink-subtle">
          {valid
            ? 'Use a wallet you control on Base, not an exchange deposit address.'
            : "That isn't an address we can pay. Check it, or paste it again from your wallet."}
        </p>
        {!noWallet && !locked && (
          <button
            type="button"
            onClick={() => {
              setPasting(false);
              onAddress('');
            }}
            className="mt-1.5 text-2xs font-medium text-primary hover:underline"
          >
            Connect a wallet instead
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      {picking && wallets.length > 1 ? (
        <ul className="space-y-1.5" aria-label="Wallets in this browser">
          {wallets.map((wallet) => (
            <li key={wallet.rdns}>
              <button
                type="button"
                onClick={() => connect(wallet)}
                disabled={locked || busy != null}
                className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left text-sm text-ink transition-colors hover:bg-sunken disabled:opacity-60"
              >
                <WalletIcon wallet={wallet} />
                <span className="flex-1">{wallet.name}</span>
                {busy === wallet.rdns && <span className="text-2xs text-ink-subtle">Check your wallet…</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <button
          type="button"
          onClick={() => (wallets.length === 1 ? connect(wallets[0]!) : setPicking(true))}
          disabled={locked || busy != null || !searched}
          className="btn-primary w-full"
        >
          {busy ? 'Check your wallet…' : 'Connect a Base wallet'}
        </button>
      )}
      {error && <p className="mt-2 text-2xs text-loss">{error}</p>}
      {!locked && (
        <button
          type="button"
          onClick={() => {
            setPicking(false);
            setPasting(true);
            setError(null);
          }}
          className="mt-2 text-2xs font-medium text-primary hover:underline"
        >
          Paste an address instead
        </button>
      )}
    </div>
  );
}

function WalletIcon({ wallet }: { wallet: BrowserWallet }) {
  return wallet.icon ? (
    /* A data: URL from the wallet itself; next/image would add nothing. */
    /* eslint-disable-next-line @next/next/no-img-element */
    <img src={wallet.icon} alt="" className="h-7 w-7 shrink-0 rounded-md" />
  ) : (
    <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-2xs font-medium text-ink-muted">
      {wallet.name.slice(0, 1)}
    </span>
  );
}
