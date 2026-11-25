/**
 * Who can be paid, by where the request comes from.
 *
 *   both chains — no payouts to comprehensively sanctioned countries or regions.
 *   Base        — no payouts to US persons either: Coinbase's tokenized stocks
 *                 are not offered to them. Checked twice, by the country of the
 *                 request's IP and by the user's own declaration, since an IP
 *                 alone says nothing about who the person is.
 *
 * The country comes from Vercel's x-vercel-ip-country header, and the region
 * from x-vercel-ip-country-region (the part of the ISO 3166-2 code after the
 * dash). Off Vercel there is no header: local runs pass the country check, and
 * on Vercel a Base request without one is refused rather than guessed at.
 * Runs before the rate limits and the Claude call, because it costs nothing.
 */

import type { PayoutChain } from './chains.js';

/** The United States and its inhabited territories. */
export const US_COUNTRIES: ReadonlySet<string> = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM']);

/**
 * Comprehensively sanctioned countries. Kept conservative: Syria stays listed
 * although most US sanctions on it were lifted in 2025.
 */
export const SANCTIONED_COUNTRIES: ReadonlySet<string> = new Set(['CU', 'IR', 'KP', 'SY']);

/** Sanctioned regions inside an otherwise open country, by ISO 3166-2 code. */
export const SANCTIONED_REGIONS: ReadonlySet<string> = new Set([
  'UA-43', // Crimea
  'UA-40', // Sevastopol
  'UA-14', // Donetsk
  'UA-09', // Luhansk
]);

export interface EligibilityInput {
  chain: PayoutChain;
  /** ISO 3166-1 alpha-2, or null when no header was sent. */
  country: string | null;
  /** The region part of ISO 3166-2 (e.g. "43"), or null. */
  region: string | null;
  /** The user confirmed they are not a US person. Required for Base only. */
  declaredNotUsPerson: boolean;
  /** True when serving on Vercel, where the country header is always set. */
  onVercel: boolean;
}

export type Eligibility = { ok: true } | { ok: false; reason: string };

export const SANCTIONED_REASON =
  "Stackd can't pay out in your region. Payouts aren't available in countries and regions under US sanctions.";
export const US_REASON =
  "Payouts on Base aren't available in the US: Coinbase's tokenized stocks aren't offered to US persons.";
export const DECLARATION_REASON =
  "To be paid on Base, confirm you're not a US person. Coinbase's tokenized stocks aren't offered to US persons.";
export const NO_COUNTRY_REASON =
  "We couldn't tell which country you're in, so we can't pay out on Base. Try again, or choose Solana.";

/** Normalised country code from the header, or null. */
export function countryFrom(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const code = header.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Normalised region code from the header (the part after the dash), or null. */
export function regionFrom(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const code = header.trim().toUpperCase();
  return /^[A-Z0-9]{1,3}$/.test(code) ? code : null;
}

export function checkEligibility(input: EligibilityInput): Eligibility {
  const { chain, country, region } = input;

  if (country && SANCTIONED_COUNTRIES.has(country)) return { ok: false, reason: SANCTIONED_REASON };
  if (country && region && SANCTIONED_REGIONS.has(`${country}-${region}`)) {
    return { ok: false, reason: SANCTIONED_REASON };
  }

  if (chain !== 'base') return { ok: true };

  if (!country && input.onVercel) return { ok: false, reason: NO_COUNTRY_REASON };
  if (country && US_COUNTRIES.has(country)) return { ok: false, reason: US_REASON };
  if (!input.declaredNotUsPerson) return { ok: false, reason: DECLARATION_REASON };
  return { ok: true };
}

/** A multipart form field is a string: only an explicit yes counts. */
export function declaredYes(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()));
}
