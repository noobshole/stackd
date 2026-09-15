'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { resolveRpcEndpoint } from '@/lib/rpc';

export function Providers({ children }: { children: ReactNode }) {
  // One client for the life of the tab — recreating it on render would throw
  // the cache away every time.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain reads are expensive and xStock balances do not move often.
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  const endpoint = useMemo(() => resolveRpcEndpoint(), []);

  /**
   * Phantom, Backpack and Solflare all ship Wallet Standard support, so the
   * adapter auto-detects them when installed and Backpack needs no entry here.
   * Phantom and Solflare are still listed explicitly: it gives them a row in
   * the modal (with an install link) on a browser where neither is present,
   * and keeps the mobile deep-link path working.
   */
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  );
}
