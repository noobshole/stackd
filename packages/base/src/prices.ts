/**
 * Payout pricing for B20 stocks. The decisions are pure; the one read takes a
 * client. Browser-safe.
 *
 * Two independent sources, the same rule as the Solana leg:
 *   A. the token's Chainlink feed on Base (total return: underlying × multiplier);
 *   B. the underlying share price × the token's current multiplier, from a
 *      caller-supplied source (the API uses the xStock's listed price).
 * Pay at the higher of the valid ones, so the user gets the smaller amount
 * when they disagree, and refuse when they disagree by more than
 * MAX_PRICE_DIVERGENCE: a payout waits rather than trusting either.
 *
 * The feeds stop updating outside US market hours and freeze during a
 * corporate action, holding their last value. Staleness and a pending
 * multiplier change are therefore checked explicitly, never assumed.
 */

import type { Address, PublicClient } from 'viem';
import { chainlinkFeedAbi } from './abi';
import { WAD } from './amount';

/** Same bound as @stackd/solana's payout guard. Keep the two in step. */
export const MAX_PRICE_DIVERGENCE = 0.25;

/**
 * Oldest feed value a payout accepts. During market hours a feed updates at
 * least daily; outside them it holds the last close, and a long weekend plus a
 * holiday comes to about three and a half days.
 */
export const MAX_FEED_AGE_S = 4 * 24 * 60 * 60;

/** Clock skew tolerated for a feed timestamp ahead of ours. */
const FUTURE_TOLERANCE_S = 5 * 60;

/**
 * How close to a scheduled multiplier change payouts pause. The feed freezes
 * around corporate actions and the multiplier and price can update at
 * different moments, so neither number is trusted near the change.
 */
export const CORPORATE_ACTION_WINDOW_S = 3 * 24 * 60 * 60;

export interface FeedRound {
  answer: bigint;
  decimals: number;
  /** Unix seconds. */
  updatedAt: bigint;
}

/** The feed's token price in USD, or null when it is missing, non-positive, stale or from the future. */
export function feedPriceUsd(round: FeedRound | null, nowS: number): number | null {
  if (!round || round.answer <= 0n || round.updatedAt <= 0n) return null;
  const updatedAt = Number(round.updatedAt);
  if (updatedAt > nowS + FUTURE_TOLERANCE_S) return null;
  if (nowS - updatedAt > MAX_FEED_AGE_S) return null;
  const price = Number(round.answer) / 10 ** round.decimals;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Underlying share price × multiplier: the price of one token. Null when unusable. */
export function tokenPriceFromUnderlying(
  underlyingUsd: number | null | undefined,
  multiplierWad: bigint,
): number | null {
  if (typeof underlyingUsd !== 'number' || !Number.isFinite(underlyingUsd) || underlyingUsd <= 0) {
    return null;
  }
  if (multiplierWad <= 0n) return null;
  const price = underlyingUsd * (Number(multiplierWad) / Number(WAD));
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * The higher of the valid prices, or null when there is none or they differ
 * by more than MAX_PRICE_DIVERGENCE.
 */
export function guardedPriceUsd(prices: ReadonlyArray<number | null | undefined>): number | null {
  const valid = prices.filter(
    (p): p is number => typeof p === 'number' && Number.isFinite(p) && p > 0,
  );
  if (valid.length === 0) return null;
  const high = Math.max(...valid);
  const low = Math.min(...valid);
  if (high / low > 1 + MAX_PRICE_DIVERGENCE) return null;
  return high;
}

/**
 * True when a scheduled multiplier change takes effect, or took effect, within
 * CORPORATE_ACTION_WINDOW_S of now. `effectiveAt` of 0 (or unreadable) means
 * none is scheduled.
 */
export function corporateActionNear(effectiveAt: bigint | null, nowS: number): boolean {
  if (effectiveAt == null || effectiveAt <= 0n) return false;
  return Math.abs(Number(effectiveAt) - nowS) < CORPORATE_ACTION_WINDOW_S;
}

/** Read a Chainlink feed's latest round. Null when the feed cannot be read. */
export async function readFeedRound(
  client: Pick<PublicClient, 'readContract'>,
  feed: Address,
): Promise<FeedRound | null> {
  try {
    const [decimals, round] = await Promise.all([
      client.readContract({ address: feed, abi: chainlinkFeedAbi, functionName: 'decimals' }),
      client.readContract({ address: feed, abi: chainlinkFeedAbi, functionName: 'latestRoundData' }),
    ]);
    const [, answer, , updatedAt] = round;
    return { answer, decimals, updatedAt };
  } catch {
    return null;
  }
}
