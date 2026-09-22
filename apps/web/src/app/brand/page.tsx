import type { Metadata } from 'next';
import { BRANDS } from '@stackd/solana';
import { PageShell } from '@/components/layout/PageShell';
import { LogoMark } from '@/components/ui/Logo';

/**
 * Brand kit. Colours and type are read from the same values the app uses
 * (tailwind.config.ts), so this page is documentation rather than a
 * second, drifting source of truth.
 */

export const metadata: Metadata = {
  title: 'Brand kit',
  description: 'Stackd logo, colours, typography and usage rules.',
};

const NEUTRALS = [
  { name: 'Canvas', hex: '#F7F5F0', use: 'Page background' },
  { name: 'Surface', hex: '#FFFFFF', use: 'Cards' },
  { name: 'Sunken', hex: '#F1EEE7', use: 'Wells, table headers' },
  { name: 'Line', hex: '#E6E2D9', use: 'Borders' },
  { name: 'Line strong', hex: '#D6D1C5', use: 'Secondary buttons' },
];

const CORE = [
  { name: 'Navy', hex: '#17294F', use: 'Logo ribbons, text, sidebar' },
  { name: 'Indigo', hex: '#4046B5', use: 'Logo bar, actions, links' },
  { name: 'Indigo hover', hex: '#343A9C', use: 'Pressed state' },
  { name: 'Indigo soft', hex: '#ECEDF8', use: 'Tinted backgrounds' },
  { name: 'Slate', hex: '#A7B2C9', use: 'Text on navy' },
];

const SIGNAL = [
  { name: 'Gain', hex: '#16A34A', use: 'Only when a number goes up' },
  { name: 'Loss', hex: '#DC2626', use: 'Only when a number goes down' },
  { name: 'Ink muted', hex: '#5E6A80', use: 'Secondary text' },
  { name: 'Ink subtle', hex: '#939CAE', use: 'Labels, fine print' },
];

const ASSETS = [
  { href: '/brand/stackd-logo-on-white.png', label: 'Logo on white (PNG)', note: '1080px square' },
  { href: '/brand/stackd-logo-on-navy.png', label: 'Logo on navy (PNG)', note: '1080px square' },
  { href: '/brand/stackd-mark.svg', label: 'Mark (SVG)', note: 'Vector, for light backgrounds' },
  {
    href: '/brand/stackd-mark-light.svg',
    label: 'Mark, light (SVG)',
    note: 'Vector, for navy or dark backgrounds',
  },
  { href: '/brand/stackd-mark.png', label: 'Mark (PNG)', note: '1024px tall, transparent' },
  { href: '/brand/stackd-icon.svg', label: 'App icon (SVG)', note: 'Navy tile, as the favicon' },
];

export default function BrandPage() {
  return (
    <PageShell
      title="Brand kit"
      intro="Everything needed to show Stackd correctly in a deck, an article or a token list. Take what you need — no permission required, as long as the rules at the bottom are respected."
    >
      {/* --- Logo --- */}
      <section>
        <h2 className="text-base font-medium text-ink">Logo</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          An S built from stacked ribbons — receipts piling up — capped by an indigo bar: the
          share you end up owning. The wordmark is Fraunces 600 italic. On navy or any dark
          background the ribbons turn white; the indigo bar never changes.
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="card flex items-center justify-center gap-3 p-10">
            <LogoMark height={52} />
            <span className="font-display text-[2.6rem] font-semibold italic leading-none text-ink">
              Stackd
            </span>
          </div>
          <div className="flex items-center justify-center gap-3 rounded-card bg-sidebar p-10">
            <LogoMark tone="light" height={52} />
            <span className="font-display text-[2.6rem] font-semibold italic leading-none text-white">
              Stackd
            </span>
          </div>
        </div>

        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ASSETS.map((asset) => (
            <li key={asset.href}>
              <a
                href={asset.href}
                download
                className="card flex h-full flex-col gap-0.5 p-4 transition-shadow hover:shadow-lift"
              >
                <span className="text-sm font-medium text-primary">{asset.label}</span>
                <span className="text-xs text-ink-muted">{asset.note}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      {/* --- Colour --- */}
      <section className="mt-12">
        <h2 className="text-base font-medium text-ink">Colour</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
          A warm off-white canvas with a deep navy sidebar. Indigo carries every action. Green is
          reserved: in this palette it only ever means a number went up, never &ldquo;success&rdquo;.
        </p>

        <Swatches title="Neutrals" colors={NEUTRALS} />
        <Swatches title="Core" colors={CORE} />
        <Swatches title="Signal and text" colors={SIGNAL} />
      </section>

      {/* --- Type --- */}
      <section className="mt-12">
        <h2 className="text-base font-medium text-ink">Typography</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="card p-5">
            <p className="label-caps">Inter · all interface text</p>
            <p className="mt-3 text-2xl font-light text-ink">Portfolio value</p>
            <p className="num mt-1 text-2xl font-light text-ink">$1,284.09</p>
            <p className="mt-3 text-xs leading-relaxed text-ink-muted">
              Weights 300, 400, 500 and 600. Body text is 300. Figures use tabular numerals so
              columns line up.
            </p>
          </div>
          <div className="card p-5">
            <p className="label-caps">Fraunces · logo and hero only</p>
            <p className="mt-3 font-display text-[1.75rem] font-light italic leading-tight text-ink">
              Own a piece of them.
            </p>
            <p className="mt-3 text-xs leading-relaxed text-ink-muted">
              Italic only: 600 for the wordmark, 300 for the landing headline. Never for interface
              text, buttons or labels.
            </p>
          </div>
        </div>
      </section>

      {/* --- $STACKD --- */}
      <section className="mt-12">
        <h2 className="text-base font-medium text-ink">$STACKD</h2>
        <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start">
          <a
            href="/stackd-token.png"
            download
            className="card flex shrink-0 flex-col items-center gap-2.5 p-4 transition-shadow hover:shadow-lift"
          >
            {/* A plain file from /public: next/image would only add indirection. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/stackd-token.png"
              alt="$STACKD token icon"
              width={96}
              height={96}
              className="rounded-full"
            />
            <span className="text-xs font-medium text-primary">Token icon (PNG)</span>
            <span className="text-2xs text-ink-muted">512px, circle-safe</span>
          </a>
          <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
            The bonus token, launched on Meteora&apos;s Dynamic Bonding Curve: a fixed supply of
            one billion, six decimals, and no mint authority, so no more can ever exist. It is a
            bonus on top of the cashback, never the cashback itself. The icon is solid navy so it
            holds up in dark-mode wallets, with the mark kept inside the circle wallets crop to.
            The mint address is published here at launch.
          </p>
        </div>
      </section>

      {/* --- Rules --- */}
      <section className="mt-12">
        <h2 className="text-base font-medium text-ink">Using the brand</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="card p-5">
            <p className="text-sm font-medium text-ink">Please do</p>
            <ul className="mt-2.5 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-muted">
              <li>Use the supplied SVGs and keep their proportions.</li>
              <li>Leave clear space around the logo of at least the height of the indigo bar.</li>
              <li>Use the light logomark on navy or any dark background.</li>
              <li>Call it &ldquo;Stackd&rdquo; — one word, capital S, no trailing &ldquo;e&rdquo;.</li>
            </ul>
          </div>
          <div className="card p-5">
            <p className="text-sm font-medium text-ink">Please don&apos;t</p>
            <ul className="mt-2.5 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-muted">
              <li>Recolour, rotate, stretch or add effects to the mark.</li>
              <li>Set the wordmark in another typeface.</li>
              <li>Use the logo to suggest a partnership or endorsement.</li>
              <li>Present Stackd as a broker, an exchange, or a source of investment advice.</li>
            </ul>
          </div>
        </div>

        <div className="card mt-3 p-5">
          <p className="text-sm font-medium text-ink">About the {BRANDS.length} retail brands</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            Stackd ships no third-party logos. Each brand appears as a lettered tile in its own
            colour, because those logos belong to their owners and Stackd has no licence to use
            them. Their names appear only to say which receipts are supported, and none of these
            companies is affiliated with, or has endorsed, Stackd.
          </p>
        </div>
      </section>
    </PageShell>
  );
}

function Swatches({
  title,
  colors,
}: {
  title: string;
  colors: Array<{ name: string; hex: string; use: string }>;
}) {
  return (
    <div className="mt-5">
      <p className="label-caps">{title}</p>
      <ul className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {colors.map((color) => (
          <li key={color.hex} className="card flex items-center gap-3 p-3">
            <span
              aria-hidden
              className="h-11 w-11 shrink-0 rounded-lg border border-line"
              style={{ backgroundColor: color.hex }}
            />
            <span className="min-w-0">
              <span className="block text-sm text-ink">{color.name}</span>
              <span className="num block text-xs uppercase text-ink-muted">{color.hex}</span>
              <span className="block truncate text-2xs text-ink-subtle">{color.use}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
