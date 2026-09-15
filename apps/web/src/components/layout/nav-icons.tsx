/** 18px stroke icons for the sidebar. Kept inline to avoid an icon dependency. */

type IconProps = { className?: string };

export function PortfolioIcon({ className }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className={className} aria-hidden>
      <path
        d="M2.5 13.5V8m4 5.5V4m4 9.5v-7m4 7v-10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BrandsIcon({ className }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className={className} aria-hidden>
      <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="2.5" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.5" y="10" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="10" width="5.5" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function SubmitIcon({ className }: IconProps) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className={className} aria-hidden>
      <path
        d="M4 2.5h10v13l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3V2.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M6.5 6h5M6.5 9h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function MenuIcon({ className }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
