/**
 * Reward amount maths for B20 stocks. Pure: no network. Browser-safe.
 *
 * A B20 stock has two units, and confusing them is the bug to avoid:
 *   - token units: what transfer() moves, raw / 10^decimals;
 *   - shares (the "UI amount"): token units × multiplier / WAD. One token is
 *     redeemable for that many shares, and dividends raise the multiplier.
 *
 * The Chainlink feeds report the price of one token (underlying × multiplier),
 * so the amount to send is reward / token price. Shares are derived from the
 * raw amount for display, exactly as the token's toUIAmount() would.
 */

import { B20RewardError } from './errors';

export const WAD = 10n ** 18n;

/** B20 Asset decimals are bounded to [6, 18] by the factory. */
const MIN_DECIMALS = 6;
const MAX_DECIMALS = 18;

/** Most digits handled in floating point before padding with zeros. */
const FLOAT_DIGITS = 12;

export interface B20RewardAmount {
  /** Cashback in USD. */
  rewardUsd: number;
  /** Token units sent, raw / 10^decimals. */
  tokenAmount: number;
  /** Shares the user receives, as the token's toUIAmount() reports them. */
  shares: number;
  /** Base units moved on chain. */
  rawAmount: bigint;
}

/**
 * Convert token units to raw units, always rounding down. Never overpays: a
 * floating-point product just below an integer is floored, never rounded up.
 */
export function tokensToRaw(tokens: number, decimals: number): bigint {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new B20RewardError(`Invalid token amount: ${tokens}`);
  }
  const floatDigits = Math.min(decimals, FLOAT_DIGITS);
  const scaled = Math.floor(tokens * 10 ** floatDigits);
  if (!Number.isSafeInteger(scaled)) {
    throw new B20RewardError(`Token amount ${tokens} is too large to convert exactly.`);
  }
  return BigInt(scaled) * 10n ** BigInt(decimals - floatDigits);
}

/** Shares for a raw amount, as toUIAmount() computes them (integer division, then decimals). */
export function rawToShares(rawAmount: bigint, multiplierWad: bigint, decimals: number): number {
  return Number((rawAmount * multiplierWad) / WAD) / 10 ** decimals;
}

export function computeB20Reward(opts: {
  spendUsd: number;
  pctBack: number;
  /** Price of one token (not one share), in USD. */
  tokenPriceUsd: number;
  decimals: number;
  /** uiMultiplier(), WAD-scaled. */
  multiplierWad: bigint;
}): B20RewardAmount {
  const { spendUsd, pctBack, tokenPriceUsd, decimals, multiplierWad } = opts;

  if (!Number.isFinite(spendUsd) || spendUsd <= 0) {
    throw new B20RewardError(`Invalid spendUsd: ${spendUsd}`);
  }
  if (!Number.isFinite(pctBack) || pctBack <= 0 || pctBack > 100) {
    throw new B20RewardError(`Invalid pctBack: ${pctBack}`);
  }
  if (!Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) {
    throw new B20RewardError(`Invalid price: ${tokenPriceUsd}`);
  }
  if (!Number.isInteger(decimals) || decimals < MIN_DECIMALS || decimals > MAX_DECIMALS) {
    throw new B20RewardError(`Unexpected token decimals: ${decimals}`);
  }
  if (multiplierWad <= 0n) {
    throw new B20RewardError(`Invalid multiplier: ${multiplierWad}`);
  }

  const rewardUsd = (spendUsd * pctBack) / 100;
  const rawAmount = tokensToRaw(rewardUsd / tokenPriceUsd, decimals);
  if (rawAmount <= 0n) {
    throw new B20RewardError(
      `Reward rounds to zero base units (${rewardUsd} USD at ${tokenPriceUsd}/token).`,
    );
  }

  return {
    rewardUsd,
    tokenAmount: Number(rawAmount) / 10 ** decimals,
    shares: rawToShares(rawAmount, multiplierWad, decimals),
    rawAmount,
  };
}
