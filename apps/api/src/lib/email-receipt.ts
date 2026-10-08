/**
 * Receipt emails, proved by the merchant's own DKIM signature.
 *
 * A brand's mail server signs every email it sends: a hash of the body and of
 * the main headers, under a key the brand publishes in its DNS. Change one
 * digit of the total and the signature no longer matches. So a receipt email
 * that verifies under amazon.com's key was sent by Amazon, unedited, and the
 * only judgement left is reading it. That is stronger than anything a photo
 * can offer, where Claude can only weigh how genuine the pixels look.
 *
 * What the signature cannot prove is whose receipt it is: anyone holding the
 * .eml file can upload it. As with photos, each receipt still pays out once,
 * to whoever claims it first.
 *
 * Accepted only when every one of these holds:
 *   - exactly one From address, on a domain a supported brand sends from
 *     (Brand.emailDomains), and not a blocked subdomain;
 *   - at least one signature that passes, from that domain or a parent of it
 *     (DMARC-style relaxed alignment) that is itself one of the brand's;
 *   - that signature covers the From header and the whole body: an l= tag
 *     leaves room to append a second, unsigned receipt below the real one;
 *   - the key is not in testing mode (t=y), which RFC 6376 says to treat as
 *     unsigned;
 *   - no header that should appear once appears twice. A verifier reads the
 *     bottom copy and a mail parser the top one, so a second From or
 *     Content-Type is how a forger makes the two disagree.
 *
 * A forwarded email fails on purpose: forwarding re-sends it from the user's
 * own address, which is not the brand. The original, saved as a file
 * (Gmail: ⋮ → Download message), keeps the signature.
 */

import { dkimVerify, type DKIMResult, type DNSResolver } from 'mailauth';
import { simpleParser } from 'mailparser';
import { BRANDS, type Brand } from '@stackd/solana';
import { sha256Hex } from './receipt-checks.js';

/** What a browser or OS may report for an .eml file. */
const EMAIL_MIME_TYPES = new Set(['message/rfc822']);
/** Generic types an .eml can arrive with when the OS has no mapping for it. */
const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'text/plain', '']);

/** True when an upload is a saved email rather than an image or PDF. */
export function isEmailUpload(file: { mimetype: string; originalname?: string }): boolean {
  if (EMAIL_MIME_TYPES.has(file.mimetype)) return true;
  return GENERIC_MIME_TYPES.has(file.mimetype) && /\.eml$/i.test(file.originalname ?? '');
}

/** Header fields a genuine email carries at most once (RFC 5322 section 3.6). */
const SINGLE_HEADERS = [
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
];

/** Most of the email body passed on to Claude. Receipts fit with room to spare. */
export const MAX_EMAIL_TEXT_CHARS = 40_000;

function lower(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** `domain` is `root` or a subdomain of it. */
function within(domain: string, root: string): boolean {
  const d = lower(domain);
  const r = lower(root);
  return d === r || d.endsWith(`.${r}`);
}

/** The brand a sending domain belongs to, or null if it is not a brand's. */
export function brandForSenderDomain(domain: string): Brand | null {
  for (const brand of BRANDS) {
    if (brand.emailDomainsBlocked?.some((blocked) => within(domain, blocked))) return null;
    if (brand.emailDomains.some((root) => within(domain, root))) return brand;
  }
  return null;
}

export type EmailRefusal = 'malformed' | 'not_brand' | 'unsigned' | 'invalid' | 'dns';

export type EmailVerdict =
  | {
      ok: true;
      brand: Brand;
      /** The From domain, e.g. "email.apple.com". */
      senderDomain: string;
      /** The d= of the passing signature, e.g. "apple.com". */
      signingDomain: string;
      /** Hash of each passing signature's value: one email, one id each. */
      signatureIds: string[];
      messageId: string | null;
      /** When the brand signed it: the t= tag, else a signed Date header. */
      signedAt: Date | null;
      subject: string;
      /** The readable body, at most MAX_EMAIL_TEXT_CHARS. */
      text: string;
    }
  | { ok: false; kind: EmailRefusal; reason: string };

const REASONS: Record<Exclude<EmailRefusal, 'not_brand'>, string> = {
  malformed:
    "This email file can't be verified as sent. Upload the original email, or a screenshot of the receipt instead.",
  unsigned:
    "This email doesn't carry the store's signature. Forwarded emails lose it, so download the " +
    'original from your inbox (Gmail: ⋮ → Download message), or upload a screenshot instead.',
  invalid:
    "The store's signature doesn't match this email, so it was changed after it was sent. Upload " +
    'the original email, or a screenshot of the receipt instead.',
  dns: "We couldn't reach the store's signing key to check this email. Try again in a moment.",
};

function refuse(kind: EmailRefusal, reason?: string): EmailVerdict {
  return { ok: false, kind, reason: reason ?? REASONS[kind as Exclude<EmailRefusal, 'not_brand'>] };
}

/** Header names a signature covers (its h= tag), lowercased. */
function signedHeaders(result: DKIMResult): string[] {
  return (result.signingHeaders?.keys ?? '')
    .split(':')
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
}

function isTempError(result: DKIMResult): boolean {
  return result.status.result === 'temperror' || result.status.result === 'temperr';
}

export interface VerifyEmailOptions {
  /** DNS lookups for DKIM keys. Tests pass their own; production uses DNS. */
  resolver?: DNSResolver;
  /** Clock for signature expiry (x=). */
  now?: Date;
}

/**
 * Verify a receipt email's signature and return what it says. Free apart from
 * DNS lookups, and run before Claude ever sees the email.
 */
export async function verifyReceiptEmail(
  raw: Buffer,
  options: VerifyEmailOptions = {},
): Promise<EmailVerdict> {
  let dkim;
  try {
    dkim = await dkimVerify(raw, {
      resolver: options.resolver,
      curTime: options.now,
      minBitLength: 1024,
    });
  } catch (error) {
    console.warn('[stackd-api] email could not be parsed for DKIM:', error);
    return refuse('malformed');
  }

  // A second copy of a header that should appear once: the verifier and the
  // parser below would read different values.
  const counts = new Map<string, number>();
  for (const header of dkim.headers?.parsed ?? []) {
    const key = header.key.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (SINGLE_HEADERS.some((key) => (counts.get(key) ?? 0) > 1)) return refuse('malformed');
  if (dkim.fromFields !== 1 || dkim.headerFrom.length !== 1) return refuse('malformed');

  const senderDomain = lower(dkim.headerFrom[0].split('@').pop() ?? '');
  const brand = senderDomain ? brandForSenderDomain(senderDomain) : null;
  if (!brand) {
    return refuse(
      'not_brand',
      `Receipt emails count only when they come straight from a supported brand, and this one ` +
        `is from ${senderDomain || 'an unknown sender'}.`,
    );
  }

  // Signatures from the brand's own domain that line up with the From address.
  const brandSignatures = dkim.results.filter(
    (result) =>
      result.signingDomain &&
      within(senderDomain, result.signingDomain) &&
      brand.emailDomains.some((root) => within(result.signingDomain!, root)),
  );
  const passing = brandSignatures.filter(
    (result) =>
      result.status.result === 'pass' &&
      !result.canonBodyLengthLimited &&
      !result.status.testing &&
      signedHeaders(result).includes('from'),
  );

  if (passing.length === 0) {
    // Our failure, not theirs: the key could not be fetched.
    if (dkim.results.some(isTempError)) return refuse('dns');
    // A brand signature that is there but does not hold: the email was edited,
    // or signed in a way that leaves part of it open.
    if (brandSignatures.length > 0) {
      console.warn(
        `[stackd-api] ${senderDomain} email signature refused: ` +
          brandSignatures
            .map((r) => `${r.signingDomain} ${r.status.result}${r.canonBodyLengthLimited ? ' l=' : ''}`)
            .join(', '),
      );
      return refuse('invalid');
    }
    return refuse('unsigned');
  }

  let parsed;
  try {
    parsed = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true });
  } catch (error) {
    console.warn('[stackd-api] signed email could not be parsed:', error);
    return refuse('malformed');
  }

  const signTimes = passing
    .map((result) => (result.signTime ? new Date(result.signTime) : null))
    .filter((date): date is Date => date !== null && !Number.isNaN(date.getTime()));
  const dateSigned = passing.some((result) => signedHeaders(result).includes('date'));
  const signedAt = signTimes[0] ?? (dateSigned && parsed.date ? parsed.date : null);

  const text = (parsed.text ?? '').replace(/\n{3,}/g, '\n\n').trim();

  return {
    ok: true,
    brand,
    senderDomain,
    signingDomain: lower(passing[0].signingDomain!),
    signatureIds: [...new Set(passing.map((result) => result.id).filter(Boolean) as string[])],
    messageId: parsed.messageId?.trim() || null,
    signedAt,
    subject: parsed.subject?.trim() ?? '',
    text: text.slice(0, MAX_EMAIL_TEXT_CHARS),
  };
}

/**
 * Identity keys of a verified email, on top of the receipt's own fingerprint.
 * The same email always carries the same signature, so its hash refuses a
 * second upload of the file however its unsigned headers were touched; the
 * Message-ID catches a copy the brand signed again.
 */
export function emailIdentityKeys(input: {
  brandSlug: string;
  signatureIds: string[];
  messageId: string | null;
}): string[] {
  const keys = input.signatureIds.map((id) => sha256Hex(`dkim|${id}`));
  if (input.messageId) {
    keys.push(sha256Hex(`msgid|${input.brandSlug}|${input.messageId.toLowerCase()}`));
  }
  return keys;
}
