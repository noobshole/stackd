/**
 * Pure receipt checks: no network, no storage, so they are unit-tested directly.
 */

import { createHash } from 'node:crypto';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * A positive number from the environment, or `fallback` when unset. Throws at
 * boot on anything else: a mistyped limit must not become NaN, which fails
 * every comparison and so silently switches the limit off.
 */
export function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}".`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Date window
// ---------------------------------------------------------------------------

/** Oldest receipt we pay for: days between the printed date and submission. */
export const RECEIPT_MAX_AGE_DAYS = positiveNumberEnv('RECEIPT_MAX_AGE_DAYS', 14);

/**
 * Slack on both ends of the window. The printed date is local to wherever the
 * receipt came from — anywhere from UTC-12 to UTC+14 — while submission time
 * is UTC. A day covers every timezone, so a receipt dated "tomorrow" in Jakarta
 * while it is still today in London is not refused as future-dated, and one
 * printed late on its 14th day in Honolulu is not refused as too old.
 */
export const RECEIPT_DATE_GRACE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type DateCheck = { ok: true; date: string } | { ok: false; reason: string };

/**
 * Accept only recent purchases. Without this, a shoebox of year-old receipts
 * all pay out.
 *
 * The printed date is read as midnight UTC and compared with the submission
 * instant, in UTC. Refused when it is more than `maxAgeDays` before submission,
 * or after it (dated in the future) — each with RECEIPT_DATE_GRACE_HOURS of
 * slack for timezones.
 */
export function checkReceiptDate(
  raw: string | null | undefined,
  submittedAt: Date = new Date(),
  maxAgeDays: number = RECEIPT_MAX_AGE_DAYS,
): DateCheck {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw?.trim() ?? '');
  if (!match) {
    return { ok: false, reason: "The purchase date couldn't be read from this receipt." };
  }

  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Reject calendar nonsense like 2026-02-31, which Date would roll forward.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { ok: false, reason: "The purchase date couldn't be read from this receipt." };
  }

  const graceMs = RECEIPT_DATE_GRACE_HOURS * HOUR_MS;
  const ageMs = submittedAt.getTime() - date.getTime();

  if (ageMs < -graceMs) {
    return { ok: false, reason: 'That receipt is dated in the future.' };
  }
  if (ageMs > maxAgeDays * DAY_MS + graceMs) {
    return {
      ok: false,
      reason: `Receipts must be from the last ${maxAgeDays} days. This one is dated ${raw}.`,
    };
  }
  return { ok: true, date: match[0] };
}

// ---------------------------------------------------------------------------
// Online-order cap
// ---------------------------------------------------------------------------

/** Most of an online order's total that earns cashback, in USD. */
export const MAX_DIGITAL_RECEIPT_USD = positiveNumberEnv('MAX_DIGITAL_RECEIPT_USD', 100);

/**
 * How much of a receipt earns cashback.
 *
 * Online receipts — screenshots, emails, PDFs — are the cheapest to forge, and
 * a careful one has nothing in its pixels to disprove it: a fake Amazon order
 * with a correctly formatted order number and Seattle's real sales tax passed
 * every visual check in testing. So only the first `digitalCapUsd` of one
 * counts, which bounds what any single fake can earn while a genuine large
 * order still earns on part of it. Paper receipts count in full.
 */
export function eligibleAmountUsd(
  amountUsd: number,
  documentType: 'paper_receipt_photo' | 'digital_receipt' | 'other',
  digitalCapUsd: number = MAX_DIGITAL_RECEIPT_USD,
): { eligibleUsd: number; capped: boolean } {
  if (documentType === 'digital_receipt' && amountUsd > digitalCapUsd) {
    return { eligibleUsd: digitalCapUsd, capped: true };
  }
  return { eligibleUsd: amountUsd, capped: false };
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical transaction number. Receipts print it as "#0012 345", "TRX-12345"
 * and so on, and OCR confuses O/0 and I/1 — normalise all of that away so a
 * re-photographed copy produces the same fingerprint as the original.
 */
export function normaliseReceiptNumber(raw: string | null | undefined): string {
  return (raw ?? '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/I/g, '1')
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^0+(?=.)/, '');
}

/** "9:05 PM" / "21.05" / "21:05:33" -> "21:05". Empty when unreadable. */
export function normaliseTime(raw: string | null | undefined): string {
  const match = /^\s*(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([AaPp][Mm])?\s*$/.exec(raw ?? '');
  if (!match) return '';
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export type FingerprintResult =
  | {
      ok: true;
      /** Primary key, kept in stackd.receipts.fingerprint: fingerprints[0]. */
      fingerprint: string;
      /** Every identity key of this receipt. A match on ANY one is a duplicate. */
      fingerprints: string[];
      receiptNumber: string | null;
      /** Normalised HH:MM, or null when none was printed or read. */
      receiptTime: string | null;
    }
  | { ok: false; reason: string };

/**
 * What the receipt says, reduced to identities. Two photos of one receipt —
 * different angle, crop, lighting — produce different image hashes but share
 * a fingerprint, and the database refuses the second from any wallet.
 *
 * The brand slug is used rather than Claude's raw merchant text, which varies
 * between photos ("MCDONALD'S #1234" vs "McDonald's"). Brand + date + total
 * alone would collide for two strangers buying the same meal on the same day,
 * so a transaction number or a time of purchase is required to tell them
 * apart; a receipt showing neither is refused rather than guessed at.
 *
 * Each detail present yields its own key, rather than the number winning and
 * the time being dropped. Receipts print several numbers, and Claude does not
 * always pick the same one: two photos of one McDonald's receipt were read as
 * "ORD #34 -CSO #30" and as "34", and a number-only key let the copy through.
 * The time of purchase (15:11 on both) is read far more consistently, and a
 * match on either key now catches it.
 */
export function receiptFingerprint(input: {
  brandSlug: string;
  date: string;
  totalAmount: number;
  currency: string;
  receiptNumber: string | null | undefined;
  time: string | null | undefined;
}): FingerprintResult {
  const number = normaliseReceiptNumber(input.receiptNumber);
  const time = normaliseTime(input.time);
  if (!number && !time) {
    return {
      ok: false,
      reason:
        "We couldn't read a transaction number or time on this receipt, so we can't " +
        'tell it apart from others. Try a sharper photo of the whole receipt.',
    };
  }

  const base = [
    input.brandSlug,
    input.date,
    input.currency.trim().toUpperCase(),
    // Integer minor units, so 3.1 and 3.10 cannot hash differently.
    String(Math.round(input.totalAmount * 100)),
  ];
  const key = (detail: string) => sha256Hex([...base, detail].join('|'));
  const fingerprints = [...(number ? [key(`n:${number}`)] : []), ...(time ? [key(`t:${time}`)] : [])];

  return {
    ok: true,
    fingerprint: fingerprints[0],
    fingerprints,
    receiptNumber: number || null,
    receiptTime: time || null,
  };
}
