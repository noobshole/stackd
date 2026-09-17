import Link from 'next/link';
import { BRANDS, MAX_PCT_BACK } from '@stackd/solana';
import { Logo } from '@/components/ui/Logo';
import { BrandMark } from '@/components/ui/primitives';

const STEPS = [
  {
    n: '01',
    title: 'Snap the receipt',
    body: 'Photograph any receipt from a launch brand. Paper, email, app screenshot — all fine.',
  },
  {
    n: '02',
    title: 'Claude reads it',
    body: 'A vision model pulls the merchant, total and date, and flags anything that looks edited or generated. No review queue, no waiting on a human.',
  },
  {
    n: '03',
    title: 'Shares land in your wallet',
    body: 'Tokenized stock transfers from our treasury to your Solana address. You hold it directly — Stackd never custodies anything.',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-20 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Logo />
        <nav className="flex items-center gap-1.5">
          <Link href="/app/brands" className="btn-ghost hidden sm:inline-flex">
            Brands
          </Link>
          <Link href="/app/portfolio" className="btn-primary">
            Open the app
          </Link>
        </nav>
      </header>

      <main>
        {/* --- Hero --- */}
        <section className="mx-auto w-full max-w-6xl px-5 pb-16 pt-10 sm:px-8 sm:pt-16">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="animate-fade-up">
              <p className="label-caps">Cashback that compounds</p>

              {/* Fraunces 300 italic — the hero and the logo, nowhere else. */}
              <h1 className="mt-4 font-display text-[2.6rem] font-light italic leading-[1.08] tracking-tight text-ink sm:text-[3.6rem]">
                Spend at the brands you love.
                <br />
                Own a piece of them.
              </h1>

              <p className="mt-6 max-w-lg text-base leading-relaxed text-ink-muted">
                Upload a receipt and get real tokenized shares back — up to {MAX_PCT_BACK}% of
                every purchase, sent straight to your Solana wallet. Not points. Not a token we
                invented. Actual equity exposure, issued by Backed Finance.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link href="/app/submit" className="btn-primary px-5 py-3">
                  Submit a receipt
                </Link>
                <Link href="/app/brands" className="btn-secondary px-5 py-3">
                  See the brands
                </Link>
              </div>

              <p className="mt-5 text-xs text-ink-subtle">
                Non-custodial · Solana mainnet · No account to create
              </p>
            </div>

            <HeroCard />
          </div>
        </section>

        {/* --- Brands --- */}
        <section className="border-y border-line bg-surface/60">
          <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-lg font-medium text-ink">
                {BRANDS.length} brands at launch
              </h2>
              <Link
                href="/app/brands"
                className="text-sm font-medium text-primary hover:underline"
              >
                See all rates →
              </Link>
            </div>

            <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {BRANDS.map((brand) => (
                <li key={brand.slug} className="card flex items-center gap-3 p-4">
                  <BrandMark brand={brand} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{brand.name}</p>
                    <p className="num text-xs text-ink-muted">{brand.ticker}</p>
                  </div>
                  <span className="num shrink-0 text-sm font-medium text-primary">
                    {brand.pctBack}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* --- How it works --- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
          <h2 className="text-lg font-medium text-ink">How it works</h2>
          <ol className="mt-7 grid gap-8 sm:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.n}>
                <p className="num text-sm font-medium text-primary">{step.n}</p>
                <h3 className="mt-2.5 text-base font-medium text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* --- What you own --- */}
        <section className="border-t border-line bg-surface/60">
          <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
              <div>
                <h2 className="text-lg font-medium text-ink">What you actually own</h2>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-muted">
                  Loyalty points expire, get devalued, and only ever buy more of the thing you
                  already bought. A share does not.
                </p>
              </div>

              <dl className="grid gap-6 sm:grid-cols-2">
                <Fact
                  term="Real tokenized equity"
                  detail="Tokens are issued by Backed Finance and Backpack Securities and collateralised 1:1 by the underlying share. Your MCDx tracks McDonald's because it is backed by McDonald's."
                />
                <Fact
                  term="Yours, not ours"
                  detail="Tokens transfer to your own wallet address. There is no Stackd balance to withdraw from and nothing for us to freeze."
                />
                <Fact
                  term="No new token"
                  detail="Stackd does not mint anything. We hold a treasury of xStocks and send you some of it."
                />
                <Fact
                  term="Verified in seconds"
                  detail="Claude reads the receipt and checks it for tampering the moment you upload. No approval queue."
                />
              </dl>
            </div>
          </div>
        </section>

        {/* --- Closing CTA --- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-20 text-center sm:px-8">
          <h2 className="mx-auto max-w-lg font-display text-[2rem] font-light italic leading-tight text-ink sm:text-[2.5rem]">
            Your next coffee can buy you a sliver of the company.
          </h2>
          <div className="mt-8">
            <Link href="/app/submit" className="btn-primary px-6 py-3">
              Submit a receipt
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Logo />
          <p className="max-w-lg text-xs leading-relaxed text-ink-subtle">
            xStocks are issued by Backed Finance. Stackd is not a broker-dealer and does not
            provide investment advice. Tokenized equities carry risk, including loss of principal.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Fact({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="text-sm font-medium text-ink">{term}</dt>
      <dd className="mt-1.5 text-sm leading-relaxed text-ink-muted">{detail}</dd>
    </div>
  );
}

/**
 * Static illustration of the portfolio view. Deliberately not wired to live
 * data — the landing page should render identically for everyone, and these
 * numbers are plainly a sample.
 */
function HeroCard() {
  const sample = [
    { brand: BRANDS[0], qty: '0.0412', value: '$4.09', change: '+1.24%' },
    { brand: BRANDS[3], qty: '0.0187', value: '$2.01', change: '+0.23%' },
    { brand: BRANDS[2], qty: '0.0096', value: '$0.75', change: '−0.41%' },
  ];

  return (
    <div className="animate-fade-up lg:pl-6">
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <p className="label-caps">Portfolio value</p>
            <p className="num mt-1.5 text-2xl font-light text-ink">$6.85</p>
          </div>
          <span className="num rounded-md bg-gain-soft px-2 py-1 text-xs font-medium text-gain">
            +0.94%
          </span>
        </div>

        <ul>
          {sample.map((row) => {
            const up = row.change.startsWith('+');
            return (
              <li
                key={row.brand.slug}
                className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-0"
              >
                <BrandMark brand={row.brand} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="num text-sm text-ink">{row.brand.ticker}</p>
                  <p className="num text-xs text-ink-subtle">{row.qty} shares</p>
                </div>
                <div className="text-right">
                  <p className="num text-sm text-ink">{row.value}</p>
                  <p className={`num text-xs ${up ? 'text-gain' : 'text-loss'}`}>{row.change}</p>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="bg-sunken px-5 py-2.5 text-2xs text-ink-subtle">Sample portfolio</p>
      </div>
    </div>
  );
}
