/**
 * Rate limiting and duplicate detection.
 *
 * ROADMAP — move to Redis before this is real. Everything here lives in process
 * memory, which means limits reset on deploy and are not shared across
 * instances. On Vercel or any multi-instance host, three replicas means an
 * effective limit of 3n per wallet. Fine for a hackathon demo with one process;
 * not fine once the treasury holds anything worth stealing. The function
 * signatures below are all async-shaped in spirit, so swapping the Map for a
 * Redis client is a body change, not an interface change.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Submissions allowed per wallet per rolling 24h. */
export const MAX_PER_WINDOW = 3;

/** Timestamps of attempts that reached Claude, per wallet. */
const attempts = new Map<string, number[]>();

/** Receipts that verified successfully, per wallet, for duplicate detection. */
interface AcceptedReceipt {
  at: number;
  brandSlug: string;
  amountCents: number;
}
const accepted = new Map<string, AcceptedReceipt[]>();

function prune<T>(list: T[], at: (item: T) => number, now: number): T[] {
  return list.filter((item) => now - at(item) < WINDOW_MS);
}

export interface RateLimitStatus {
  allowed: boolean;
  used: number;
  remaining: number;
  /** Milliseconds until the oldest attempt falls out of the window. */
  retryAfterMs: number | null;
}

export function checkRateLimit(wallet: string, now = Date.now()): RateLimitStatus {
  const recent = prune(attempts.get(wallet) ?? [], (t) => t, now);
  attempts.set(wallet, recent);

  const used = recent.length;
  const allowed = used < MAX_PER_WINDOW;
  const oldest = recent[0];

  return {
    allowed,
    used,
    remaining: Math.max(0, MAX_PER_WINDOW - used),
    retryAfterMs: allowed || oldest === undefined ? null : oldest + WINDOW_MS - now,
  };
}

/**
 * Count an attempt against the wallet's quota.
 *
 * Called immediately before the Claude request, so a burst of concurrent
 * uploads cannot all pass the check and then all bill the API. Returns the
 * token needed to undo it.
 */
export function recordAttempt(wallet: string, now = Date.now()): number {
  const recent = attempts.get(wallet) ?? [];
  recent.push(now);
  attempts.set(wallet, recent);
  return now;
}

/**
 * Give a quota slot back.
 *
 * Only for the case where *we* failed — Claude unreachable, rate limited, key
 * rejected. A receipt that was checked and found wanting keeps its slot, so
 * fakes cannot be brute-forced for free.
 */
export function releaseAttempt(wallet: string, token: number): void {
  const recent = attempts.get(wallet);
  if (!recent) return;

  const index = recent.indexOf(token);
  if (index !== -1) recent.splice(index, 1);
}

/**
 * Has this wallet already claimed this brand at this amount in the window?
 *
 * Amount is keyed in whole cents so floating point noise ($4.30 vs
 * $4.2999999) cannot slip a second claim through on the same purchase.
 */
export function isDuplicate(
  wallet: string,
  brandSlug: string,
  amountUsd: number,
  now = Date.now(),
): boolean {
  const recent = prune(accepted.get(wallet) ?? [], (r) => r.at, now);
  accepted.set(wallet, recent);

  const amountCents = Math.round(amountUsd * 100);
  return recent.some((r) => r.brandSlug === brandSlug && r.amountCents === amountCents);
}

/** Remember a receipt that passed, so the same purchase cannot be claimed twice. */
export function recordAccepted(
  wallet: string,
  brandSlug: string,
  amountUsd: number,
  now = Date.now(),
): void {
  const recent = accepted.get(wallet) ?? [];
  recent.push({ at: now, brandSlug, amountCents: Math.round(amountUsd * 100) });
  accepted.set(wallet, recent);
}

/** Test seam — drops all state. */
export function __resetStores(): void {
  attempts.clear();
  accepted.clear();
}
