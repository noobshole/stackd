/** Client for POST /verify-receipt and /confirm-receipt, and the API's health. */

/** The chain a receipt is paid on. Solana unless the user chooses Base. */
export type PayoutChain = 'solana' | 'base';

export interface VerifyResponse {
  flagged: boolean;
  /** The chain the receipt would be paid on. Absent on requests refused before it was read. */
  chain?: PayoutChain;
  reason?: string;
  /** Present only on an accepted receipt. Required to claim. */
  receiptId?: string;
  brand: string | null;
  ticker: string | null;
  amountUsd: number | null;
  confidence: number | null;
  pctBack?: number;
  cashbackUsd?: number;
  /** Only when an online order was capped: the part of amountUsd that earns cashback. */
  eligibleUsd?: number;
  /** The online-order cap that applied, in USD. */
  digitalCapUsd?: number;
  /** Present when the receipt was an email whose DKIM signature verified. */
  verifiedBy?: { method: 'dkim'; domain: string };
  merchantName?: string;
  date?: string;
  currency?: string;
  /** The total as printed, in `currency`. amountUsd is this converted. */
  originalAmount?: number;
  /** Units of `currency` per 1 USD (ECB reference). 1 for USD receipts. */
  fxRate?: number;
  /** Publication date of fxRate. Null for USD receipts. */
  fxRateDate?: string | null;
  submissionsRemaining?: number;
  /**
   * The receipt verified, but the brand's payouts are paused while the
   * treasury restocks. Flagged and unclaimable, with the reward fields filled.
   */
  paused?: boolean;
  /** With paused: the last day (YYYY-MM-DD) the receipt still fits the date window. */
  resendBy?: string;
}

export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

/**
 * Which Base network pays out, or null while Base payouts are switched off.
 * Read from the API's /health, so the site offers Base exactly when the API
 * accepts it.
 */
export async function fetchBaseNetwork(): Promise<'mainnet' | 'sepolia' | null> {
  const res = await fetch(`${apiBase()}/health`);
  if (!res.ok) throw new Error(`Health check failed (${res.status}).`);
  const health = (await res.json()) as { base?: unknown };
  return health.base === 'mainnet' || health.base === 'sepolia' ? health.base : null;
}

export interface VerifyOptions {
  /** Omitted means Solana, so a Solana request is the same as it always was. */
  chain?: PayoutChain;
  /** Base only: the user confirmed they are not a US person. */
  notUsPerson?: boolean;
}

/**
 * Send a receipt for verification.
 *
 * Every outcome the server has an opinion about — accepted, unreadable, fake,
 * duplicate, rate limited, not payable where you are — comes back as a
 * VerifyResponse, on a 2xx or a 4xx. Only a genuinely unreachable server throws.
 */
export async function verifyReceipt(
  file: File,
  walletAddress: string,
  options: VerifyOptions = {},
): Promise<VerifyResponse> {
  const body = new FormData();
  body.append('receipt', file);
  body.append('walletAddress', walletAddress);
  if (options.chain === 'base') {
    body.append('chain', 'base');
    if (options.notUsPerson) body.append('notUsPerson', 'true');
  }

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/verify-receipt`, { method: 'POST', body });
  } catch {
    throw new Error(
      'Could not reach the verification service. Is the API running on ' + apiBase() + '?',
    );
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`Verification failed (${res.status}).`);
  }

  const payload = parsed as VerifyResponse;
  if (typeof payload?.flagged !== 'boolean') {
    throw new Error(`Verification returned an unexpected response (${res.status}).`);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ConfirmResponse {
  receiptId: string;
  /** Optional because an older API does not send it; absent means Solana. */
  chain?: PayoutChain;
  xstock: {
    /** The Solana signature, or the transaction hash on Base. */
    signature: string;
    /** The transaction on the chain's explorer: Solscan or Basescan. */
    explorer?: string;
    /** Solana only. Kept for an older API that sends this and not `explorer`. */
    solscan?: string;
    ticker: string;
    amount: number | null;
  };
  /** Null when the bonus vault is paused. This is normal, not a failure. */
  bonus: { signature: string; solscan: string } | null;
  bonusPaused: boolean;
  /**
   * The bonus was held because this is the wallet's first paid receipt; it
   * starts from the second. Optional because an older API does not send it.
   */
  bonusFirstClaim?: boolean;
}

/**
 * The payout was broadcast but hadn't confirmed when the API stopped waiting.
 * Not a failure: the shares are on their way, and claiming again is refused.
 */
export class PayoutPendingError extends Error {
  constructor(
    message: string,
    /** The transaction on the explorer, when the API sent one. */
    readonly explorer: string | null,
  ) {
    super(message);
    this.name = 'PayoutPendingError';
  }
}

/**
 * Claim a verified receipt.
 *
 * Throws only when the xStock leg failed — a paused bonus comes back as a
 * successful response with `bonus: null` — or, as PayoutPendingError, when the
 * transfer is sent but not yet confirmed.
 */
export async function confirmReceipt(receiptId: string): Promise<ConfirmResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/confirm-receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId }),
    });
  } catch {
    throw new Error('Could not reach the payout service.');
  }

  const payload = (await res.json().catch(() => null)) as
    | (ConfirmResponse & { error?: string; explorer?: string })
    | null;

  if (res.status === 202) {
    throw new PayoutPendingError(
      payload?.error ?? "Your payout was sent but hasn't confirmed yet. There's no need to claim again.",
      typeof payload?.explorer === 'string' ? payload.explorer : null,
    );
  }

  if (!res.ok || !payload?.xstock?.signature) {
    throw new Error(payload?.error ?? `Payout failed (${res.status}).`);
  }

  return payload;
}
