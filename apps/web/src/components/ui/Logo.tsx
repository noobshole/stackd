import Link from 'next/link';

/**
 * The one place Fraunces is allowed outside the landing hero.
 * 300 italic, always.
 */
export function Logo({
  href = '/',
  tone = 'dark',
  className = '',
}: {
  href?: string;
  tone?: 'dark' | 'light';
  className?: string;
}) {
  const text = tone === 'light' ? 'text-white' : 'text-ink';

  return (
    <Link href={href} className={`group inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark tone={tone} />
      <span className={`font-display text-[1.35rem] font-light italic leading-none ${text}`}>
        Stackd
      </span>
    </Link>
  );
}

export function LogoMark({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  // On navy the base bar has to be light to stay visible; on the canvas it is navy.
  const base = tone === 'light' ? '#FFFFFF' : '#1A1A2E';
  const mid = tone === 'light' ? '#6C6A85' : '#A5A3B8';

  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="15" width="16" height="4" rx="2" fill={base} />
      <rect x="4" y="9.5" width="16" height="4" rx="2" fill={mid} />
      <rect x="4" y="4" width="16" height="4" rx="2" fill="#4F46E5" />
    </svg>
  );
}
