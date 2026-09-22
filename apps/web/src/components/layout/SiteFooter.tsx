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
    </nav>
  );
}

export const ISSUER_DISCLAIMER =
  'Tokenized shares are issued by Backed Finance and Backpack Securities. Stackd is not a ' +
  'broker-dealer and does not provide investment advice. Tokenized equities carry risk, ' +
  'including loss of principal.';
