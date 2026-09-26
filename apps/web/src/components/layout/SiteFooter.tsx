import Link from 'next/link';

/**
 * One footer for the whole site. The disclaimer is the same sentence the app
 * shell shows, so the claim about who issues the tokens cannot drift between
 * the marketing pages and the app.
 */

export const FOOTER_LINKS = [
  { href: '/brand', label: 'Brand kit' },
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: 'https://github.com/noobshole/stackd', label: 'GitHub', external: true },
] as const;

const X_URL = 'https://x.com/stackd_';

/** The X logo, filled with the current text colour. */
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function FooterLinks({ className = '' }: { className?: string }) {
  return (
    <nav className={`flex flex-wrap items-center gap-x-5 gap-y-2 ${className}`}>
      {FOOTER_LINKS.map((link) =>
        'external' in link && link.external ? (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ink-muted transition-colors hover:text-ink"
          >
            {link.label}
          </a>
        ) : (
          <Link
            key={link.href}
            href={link.href}
            className="text-xs text-ink-muted transition-colors hover:text-ink"
          >
            {link.label}
          </Link>
        ),
      )}
      <a
        href={X_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Stackd on X"
        title="Stackd on X"
        className="text-ink-muted transition-colors hover:text-ink"
      >
        <XIcon />
      </a>
    </nav>
  );
}

export const ISSUER_DISCLAIMER =
  'Tokenized shares are issued by Backed Finance and Backpack Securities. Stackd is not a ' +
  'broker-dealer and does not provide investment advice. Tokenized equities carry risk, ' +
  'including loss of principal.';
