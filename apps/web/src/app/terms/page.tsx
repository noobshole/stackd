import type { Metadata } from 'next';
import Link from 'next/link';
import { MAX_PCT_BACK } from '@stackd/solana';
import { LegalSection, PageShell } from '@/components/layout/PageShell';

/**
 * Plain-language terms describing what the code actually does: every limit
 * quoted here is enforced in apps/api (receipt age, per-wallet quota, global
 * duplicate check, receipt cap, daily payout cap). If a limit changes in the
 * code, change it here too.
 *
 * TODO before onboarding real users: have a lawyer review this, and add a
 * governing-law clause naming your jurisdiction. It is deliberately omitted
 * rather than guessed at.
 */

const UPDATED = '2026-09-22';
const CONTACT = 'https://github.com/noobshole/stackd/issues';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'The terms that apply when you use Stackd.',
};

export default function TermsPage() {
  return (
    <PageShell
      title="Terms of use"
      intro="Stackd pays cashback in tokenized shares. These terms explain what that means, what the limits are, and what we do and do not promise. Plain language on purpose."
      updated={UPDATED}
    >
      <LegalSection n={1} title="What Stackd does">
        <p>
          You upload a photo of a receipt from a supported brand. Claude, an AI model, reads the
          merchant, total, date and transaction number, and judges whether the receipt looks
          genuine. If it passes, Stackd transfers tokenized shares of that brand from its treasury
          to the Solana address you provided — up to {MAX_PCT_BACK}% of the receipt total,
          depending on the brand.
        </p>
        <p>
          Stackd never holds your tokens. They go straight to your wallet, and only you can move
          them.
        </p>
      </LegalSection>

      <LegalSection n={2} title="Not advice, and not a broker">
        <p>
          Stackd is not a broker, dealer, exchange, bank or investment adviser, and nothing here is
          investment advice or a recommendation to buy or hold anything. The tokenized shares are
          issued by third parties — Backed Finance and Backpack Securities — under their own terms,
          and their availability may be restricted where you live. Check their terms before you
          use Stackd.
        </p>
        <p>
          Tokenized equities carry risk, including the loss of the full value of the token. Prices
          can fall. Past performance tells you nothing about future performance.
        </p>
      </LegalSection>

      <LegalSection n={3} title="Who can use it">
        <p>
          You must be at least 18 and legally able to hold tokenized securities where you live.
          Complying with your local law is your responsibility, not ours. You must use your own
          wallet and submit only your own receipts.
        </p>
      </LegalSection>

      <LegalSection n={4} title="How rewards are calculated, and their limits">
        <p>Rewards are discretionary and subject to these limits, which the service enforces:</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>The cashback rate depends on the brand and is shown on the brands page.</li>
          <li>
            Receipts must be dated within the last 14 days, and not in the future. Dates are
            compared in UTC, with a day of allowance for time zones.
          </li>
          <li>Receipts totalling over $1,000 are held for manual review.</li>
          <li>
            Online orders (screenshots, emails and PDFs) earn cashback on up to $100 of the
            order total.
          </li>
          <li>Three receipts per wallet per 24 hours.</li>
          <li>
            Each receipt can be claimed once, ever, by anyone. We identify a receipt by its
            merchant, date, total, transaction number and time of purchase, and by a
            fingerprint of the image.
          </li>
          <li>
            Images labelled as AI-generated, or saved from photo-editing software, are refused.
            Upload the original photo or screenshot.
          </li>
          <li>
            Stackd applies a daily cap on total payouts. When it is reached, claims pause until the
            next day; your verified receipt stays claimable.
          </li>
          <li>
            Receipts in other currencies are converted to US dollars at the European Central Bank
            reference rate for that day. If no rate is available, the receipt is refused rather
            than guessed at.
          </li>
          <li>
            The number of shares depends on the share price at the moment of payout, so the figure
            you are shown before claiming is an estimate.
          </li>
        </ul>
        <p>
          We may change the rates and limits at any time. Changes apply to receipts submitted after
          the change.
        </p>
      </LegalSection>

      <LegalSection n={5} title="The $STACKD bonus">
        <p>
          Some payouts include a bonus in $STACKD, a token launched on Meteora&apos;s Dynamic
          Bonding Curve with a fixed supply of one billion and no mint authority, meaning no more
          can ever be created. The bonus is optional and often paused — the reward that matters is
          the tokenized share, and a paused bonus is normal, not a failure.
        </p>
        <p>
          $STACKD is not a share, carries no claim on Stackd or on any company, and we make no
          promise about its value.
        </p>
      </LegalSection>

      <LegalSection n={6} title="Fair use">
        <p>Do not:</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>submit altered, generated, duplicated or someone else&apos;s receipts;</li>
          <li>submit the same receipt from several wallets;</li>
          <li>script, scrape or otherwise automate submissions;</li>
          <li>attempt to bypass the limits above.</li>
        </ul>
        <p>
          We may refuse a receipt, withhold a payout, or block a wallet or network address where we
          reasonably believe these rules were broken.
        </p>
      </LegalSection>

      <LegalSection n={7} title="Blockchain transfers are final">
        <p>
          Payouts are Solana transactions. Once one is confirmed it cannot be reversed by us or by
          anyone else. If you give an address you do not control, or an exchange deposit address
          that does not support these tokens, the tokens are gone and we cannot recover them.
        </p>
        <p>
          You are responsible for your wallet and your keys. Stackd never asks for your seed phrase
          or private key, and nobody from Stackd will ever ask you for them.
        </p>
      </LegalSection>

      <LegalSection n={8} title="Availability">
        <p>
          Stackd is an early-stage project, originally built for a hackathon. It may be
          unavailable, paused, changed or discontinued at any time, and payouts depend on the
          treasury holding inventory. A test version runs on Solana&apos;s devnet, where tokens are
          worthless test assets.
        </p>
      </LegalSection>

      <LegalSection n={9} title="Services we rely on">
        <p>
          Verification uses Anthropic&apos;s Claude API. Blockchain reads and writes go through
          Helius. Prices come from Jupiter, exchange rates from the European Central Bank via
          Frankfurter, hosting from Vercel, and the database from Supabase. Their outages are
          outside our control. What each one receives is set out in the{' '}
          <Link href="/privacy" className="text-primary hover:underline">
            privacy policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection n={10} title="No warranty, and limited liability">
        <p>
          Stackd is provided as-is and free of charge, with no warranty of any kind. To the fullest
          extent the law allows, we are not liable for lost profits, lost tokens, missed rewards,
          price movements, or any indirect or consequential loss arising from your use of Stackd.
        </p>
        <p>Nothing here limits liability that cannot be limited by law.</p>
      </LegalSection>

      <LegalSection n={11} title="Changes and contact">
        <p>
          We may update these terms. The date at the top always reflects the current version, and
          continuing to use Stackd means accepting it.
        </p>
        <p>
          Questions, or a problem with a payout?{' '}
          <a
            href={CONTACT}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Open an issue on GitHub
          </a>
          .
        </p>
      </LegalSection>
    </PageShell>
  );
}
