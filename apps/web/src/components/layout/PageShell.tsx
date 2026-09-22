import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/ui/Logo';
import { FooterLinks, ISSUER_DISCLAIMER } from '@/components/layout/SiteFooter';

/**
 * Frame for the standalone pages (brand kit, terms, privacy): landing-page
 * chrome without the app sidebar, since none of them need a wallet.
 */
export function PageShell({
  title,
  intro,
  updated,
  children,
}: {
  title: string;
  intro?: string;
  /** ISO date, shown for the legal pages. */
  updated?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-20 w-full max-w-4xl items-center justify-between px-5 sm:px-8">
        <Logo />
        <Link href="/app/portfolio" className="btn-secondary">
          Open the app
        </Link>
      </header>

      <main className="mx-auto w-full max-w-4xl animate-fade-up px-5 pb-20 pt-6 sm:px-8">
        <h1 className="text-2xl font-medium tracking-tight text-ink">{title}</h1>
        {intro && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted">{intro}</p>}
        {updated && (
          <p className="num mt-3 text-2xs text-ink-subtle">
            Last updated{' '}
            {new Date(updated).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
        )}
        <div className="mt-10">{children}</div>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-8 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Logo />
            <FooterLinks />
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-ink-subtle">{ISSUER_DISCLAIMER}</p>
        </div>
      </footer>
    </div>
  );
}

/** Numbered section used by the legal pages. */
export function LegalSection({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-line py-7 first:border-0 first:pt-0">
      <h2 className="flex gap-3 text-base font-medium text-ink">
        <span className="num text-primary">{String(n).padStart(2, '0')}</span>
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}
