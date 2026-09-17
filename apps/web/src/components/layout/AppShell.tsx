'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/ui/Logo';
import { WalletButton } from '@/components/wallet/WalletButton';
import {
  BrandsIcon,
  CloseIcon,
  MenuIcon,
  PortfolioIcon,
  SubmitIcon,
} from '@/components/layout/nav-icons';

const NAV = [
  { href: '/app/portfolio', label: 'Portfolio', Icon: PortfolioIcon },
  { href: '/app/brands', label: 'Brands', Icon: BrandsIcon },
  { href: '/app/submit', label: 'Submit receipt', Icon: SubmitIcon },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigating should always dismiss the mobile drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock the page behind the drawer so the sheet scrolls, not the app.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col bg-sidebar lg:flex">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
          />
          <aside className="absolute left-0 top-0 flex h-full w-[264px] flex-col bg-sidebar shadow-modal">
            <SidebarContent pathname={pathname} onClose={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-40 flex h-16 items-center justify-between gap-3 border-b
                     border-line bg-canvas/85 px-4 backdrop-blur-md sm:px-6 lg:px-8"
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              className="btn-ghost -ml-2 px-2 lg:hidden"
            >
              <MenuIcon />
            </button>
            <span className="text-sm font-medium text-ink lg:hidden">
              {NAV.find((n) => pathname.startsWith(n.href))?.label ?? 'Stackd'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <NetworkChip />
            <WalletButton />
          </div>
        </header>

        <main className="flex-1 px-4 py-7 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-5xl animate-fade-up">{children}</div>
        </main>

        <footer className="border-t border-line px-4 py-5 text-xs text-ink-subtle sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Tokenized shares are issued by Backed Finance and Backpack Securities. Stackd is
              not a broker and does not give investment advice.
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SidebarContent({ pathname, onClose }: { pathname: string; onClose?: () => void }) {
  return (
    <>
      <div className="flex h-16 items-center justify-between px-5">
        <Logo href="/" tone="light" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-1.5 text-sidebar-text transition-colors hover:bg-sidebar-hover hover:text-white"
          >
            <CloseIcon />
          </button>
        )}
      </div>

      <nav className="flex-1 px-3 py-4">
        <p className="px-2.5 pb-2 text-2xs font-medium uppercase tracking-label text-sidebar-heading">
          Account
        </p>
        <ul className="space-y-0.5">
          {NAV.map(({ href, label, Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm transition-colors ${
                    active
                      ? 'bg-sidebar-active font-medium text-white'
                      : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white'
                  }`}
                >
                  <Icon className="shrink-0" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="px-3 pb-5">
        <div className="rounded-xl bg-sidebar-hover px-3.5 py-3.5">
          <p className="text-2xs font-medium uppercase tracking-label text-sidebar-heading">
            Cashback, but it compounds
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-sidebar-text">
            Every receipt pays out in real tokenized shares of the brand you shopped at.
          </p>
          <Link
            href="/app/submit"
            className="mt-3 inline-flex text-xs font-medium text-white underline underline-offset-4
                       decoration-white/30 transition-colors hover:decoration-white"
          >
            Submit a receipt
          </Link>
        </div>
      </div>
    </>
  );
}

/** Quiet confirmation of which chain the numbers come from. */
function NetworkChip() {
  return (
    <span
      className="hidden items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5
                 text-2xs font-medium text-ink-muted sm:inline-flex"
      title="Balances are read from Solana mainnet over Helius"
    >
      {/* Indigo, not green — in this palette green exclusively means "the number went up". */}
      <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
      Mainnet
    </span>
  );
}
