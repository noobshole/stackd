/** Payout errors for the Base leg. Browser-safe. */

export class B20RewardError extends Error {}

/** Today's payout budget is spent. Nothing was sent; the receipt stays claimable. */
export class B20PayoutPausedError extends B20RewardError {}

/**
 * The transfer was signed and may have been broadcast, but its outcome could
 * not be established. It may still land, so the claim is deliberately NOT
 * released: releasing it would let a retry send a second transfer. Reconcile
 * from the transaction hash.
 */
export class B20PayoutUnconfirmedError extends B20RewardError {
  constructor(
    readonly txHash: string,
    options?: { cause?: unknown },
  ) {
    super(`Transfer ${txHash} was signed but not confirmed. Not retrying automatically.`, options);
  }
}
