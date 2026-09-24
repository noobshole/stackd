import type { Metadata } from 'next';
import { LegalSection, PageShell } from '@/components/layout/PageShell';

/**
 * Every claim here is checked against the code, not aspirational:
 *   - the receipt image is sent to Claude and never persisted
 *     (apps/api/src/routes/verify-receipt.ts passes imageUrl: null)
 *   - a SHA-256 of the image and a fingerprint of its printed details are
 *     stored, which is what makes duplicates detectable without keeping photos
 *   - IP + wallet + timestamp rows live in stackd.submission_attempts and are
 *     deleted after 25 hours (PgGuards.tryAttempt cleanup)
 *   - a wallet's earlier payouts are read for one decision only: whether the
 *     $STACKD bonus applies (hasPriorPayout, apps/api/src/routes/confirm-receipt.ts)
 *   - usage is counted in aggregate only: scripts/mainnet/check.ts reports
 *     totals and a repeat rate, and never prints an address
 *   - no analytics, no tracking cookies anywhere in apps/web
 * If any of that changes, this page has to change with it.
 */

const UPDATED = '2026-09-24';
const CONTACT = 'https://github.com/noobshole/stackd/issues';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'What Stackd collects, who else sees it, and how long it is kept.',
};

export default function PrivacyPage() {
  return (
    <PageShell
      title="Privacy"
      intro="Stackd has no accounts, no passwords and no tracking. It does handle receipts and wallet addresses, so here is exactly what happens to them."
      updated={UPDATED}
    >
      <LegalSection n={1} title="What we collect">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong className="font-medium text-ink">The wallet address you submit.</strong> Needed
            to send the payout.
          </li>
          <li>
            <strong className="font-medium text-ink">The receipt image.</strong> It is sent to
            Claude to be read, and <strong className="font-medium text-ink">we do not store it</strong>.
          </li>
          <li>
            <strong className="font-medium text-ink">A fingerprint of the receipt.</strong> A
            one-way hash of the image, plus the merchant, date, total and transaction number. This
            is how the same receipt is refused a second time without keeping the photo. A hash
            cannot be turned back into your image.
          </li>
          <li>
            <strong className="font-medium text-ink">What Claude read:</strong> merchant, total,
            currency, date, transaction number, and how confident it was.
          </li>
          <li>
            <strong className="font-medium text-ink">The payout record:</strong> the amount, the
            exchange rate used, and the Solana transaction signatures.
          </li>
          <li>
            <strong className="font-medium text-ink">Your IP address and a timestamp,</strong> used
            only to enforce rate limits.
          </li>
        </ul>
        <p>
          We never ask for your name, email address, phone number, date of birth, payment details
          or any government ID. There is no account to create and no password to store. We never
          ask for your seed phrase or private key.
        </p>
      </LegalSection>

      <LegalSection n={2} title="Why we collect it">
        <p>
          To read your receipt, to check it is genuine and has not already been claimed, to convert
          the total to US dollars, to send the payout, and to stop one person draining the treasury
          with repeated or automated submissions. Your wallet&apos;s earlier payouts decide one more
          thing: the $STACKD bonus starts from your second paid receipt.
        </p>
        <p>
          We also count receipts in aggregate — how many wallets come back for a second claim, for
          example — to learn whether Stackd works. Those figures are totals and never identify a
          person or a wallet. Nothing is used for advertising or profiling, and nothing is sold.
        </p>
      </LegalSection>

      <LegalSection n={3} title="Who else sees it">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong className="font-medium text-ink">Anthropic (Claude API)</strong> receives the
            receipt image and returns the extracted fields, either directly or through{' '}
            <strong className="font-medium text-ink">OpenRouter</strong>, which relays the request
            to Anthropic. Their terms govern what they do with it.
          </li>
          <li>
            <strong className="font-medium text-ink">Supabase</strong> hosts the database, in
            Singapore, holding the receipt records described above.
          </li>
          <li>
            <strong className="font-medium text-ink">Helius</strong> relays our Solana requests, so
            it sees the addresses being looked up.
          </li>
          <li>
            <strong className="font-medium text-ink">Vercel</strong> hosts the site and keeps
            standard server logs.
          </li>
          <li>
            <strong className="font-medium text-ink">Jupiter</strong> and the{' '}
            <strong className="font-medium text-ink">European Central Bank (via Frankfurter)</strong>{' '}
            provide prices and exchange rates. Neither receives anything about you.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n={4} title="Solana is public and permanent">
        <p>
          Your payout is a public blockchain transaction. Your wallet address, the token, the
          amount and the time are visible to anyone, forever, and cannot be deleted or hidden by
          us or by you. Anyone who knows your address can also see everything else it holds.
        </p>
        <p>If that matters to you, use a separate wallet address for Stackd.</p>
      </LegalSection>

      <LegalSection n={5} title="How long we keep it">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong className="font-medium text-ink">Receipt records</strong> (the fingerprint,
            extracted fields and payout details) are kept indefinitely. Deleting them would let the
            same receipt be claimed again.
          </li>
          <li>
            <strong className="font-medium text-ink">IP addresses</strong> are deleted
            automatically about a day after the submission.
          </li>
          <li>
            <strong className="font-medium text-ink">Receipt images</strong> are never written to
            our storage at all.
          </li>
        </ul>
      </LegalSection>

      <LegalSection n={6} title="Cookies and tracking">
        <p>
          Stackd sets no cookies, runs no analytics and embeds no third-party trackers. Your wallet
          software may store your choice of wallet in your own browser so it can reconnect. That
          stays on your device.
        </p>
      </LegalSection>

      <LegalSection n={7} title="Your choices">
        <p>
          The simplest control is not submitting a receipt — nothing is collected until you do. You
          can ask what we hold about an address, or ask us to delete it, and we will do what is
          technically possible. Two limits are worth stating plainly: blockchain transactions
          cannot be deleted by anyone, and we keep receipt fingerprints so a deleted receipt cannot
          be re-claimed.
        </p>
      </LegalSection>

      <LegalSection n={8} title="Children">
        <p>Stackd is not for anyone under 18, and we do not knowingly collect their data.</p>
      </LegalSection>

      <LegalSection n={9} title="Changes and contact">
        <p>
          If what we collect changes, this page changes with it, and the date at the top will show
          it.
        </p>
        <p>
          To ask a question or request deletion,{' '}
          <a
            href={CONTACT}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            open an issue on GitHub
          </a>
          .
        </p>
      </LegalSection>
    </PageShell>
  );
}
