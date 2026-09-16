/**
 * Fuzzy merchant matching.
 *
 * Brands come from @stackd/solana — the same config the frontend renders and
 * the transfer path will spend against. Never redefine them here: a brand that
 * exists in one place and not the other is a payout to the wrong mint.
 */

import { BRANDS, type Brand } from '@stackd/solana';

/**
 * Lowercase, strip accents and punctuation, collapse whitespace, and split.
 *
 * Receipts print merchant names as "WAL-MART SUPERCENTER #2531" or
 * "STARBUCKS COFFEE  #04821", so punctuation and trailing store numbers have to
 * fall away before anything can be compared.
 */
function tokenize(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** True when `needle` appears as a contiguous run of tokens inside `haystack`. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export interface BrandMatch {
  brand: Brand;
  /** The brand name or alias that actually matched, for logging. */
  matchedOn: string;
}

/**
 * Resolve a merchant string from a receipt to a configured brand.
 *
 * Matching is on whole tokens, not raw substrings — "nike" must appear as its
 * own word. A substring test would match "Nikon" and pay out Nike shares for a
 * camera shop. Returns null when nothing matches; the caller rejects.
 */
export function matchBrand(merchantName: string): BrandMatch | null {
  const merchant = tokenize(merchantName);
  if (merchant.length === 0) return null;

  // Longest candidate first, so "walmart neighborhood market" is preferred over
  // the bare "walmart" and `matchedOn` reports the most specific hit.
  const candidates: Array<{ brand: Brand; tokens: string[]; label: string }> = [];

  for (const brand of BRANDS) {
    for (const label of [brand.name, ...brand.aliases]) {
      candidates.push({ brand, tokens: tokenize(label), label });
    }
  }
  candidates.sort((a, b) => b.tokens.length - a.tokens.length);

  for (const candidate of candidates) {
    if (containsSequence(merchant, candidate.tokens)) {
      return { brand: candidate.brand, matchedOn: candidate.label };
    }
  }

  return null;
}
