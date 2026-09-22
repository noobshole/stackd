import Link from 'next/link';
import { MARK_BAR, MARK_RIBBONS, MARK_VIEWBOX } from '@/components/ui/logo-paths';

/**
 * The Stackd lockup: the mark plus the wordmark, as in the designer's master
 * files. The wordmark is live Fraunces 600 italic rather than an image, so it
 * stays crisp at every size — the logo was set in the same typeface and weight.
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
    <Link href={href} className={`group inline-flex items-center gap-2 ${className}`}>
      <LogoMark tone={tone} />
      <span className={`font-display text-[1.4rem] font-semibold italic leading-none ${text}`}>
        Stackd
      </span>
    </Link>
  );
}

/**
 * The mark alone. On navy the ribbons turn white to stay visible; the indigo
 * bar is the same on both.
 */
export function LogoMark({
  tone = 'dark',
  height = 26,
}: {
  tone?: 'dark' | 'light';
  height?: number;
}) {
  const ribbons = tone === 'light' ? '#FFFFFF' : '#17294F';
  // The mark is taller than it is wide (1056 x 1420).
  const width = Math.round((height * 1056) / 1420);

  return (
    <svg width={width} height={height} viewBox={MARK_VIEWBOX} aria-hidden>
      <path fill="#4046B5" d={MARK_BAR} />
      <path fill={ribbons} d={MARK_RIBBONS} />
    </svg>
  );
}
