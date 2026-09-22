/** Client for POST /verify-receipt. */

export interface VerifyResponse {
  flagged: boolean;
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
}

export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

/**
 * Send a receipt for verification.
 *
 * Every outcome the server has an opinion about — accepted, unreadable, fake,
 * duplicate, rate limited — comes back as a VerifyResponse, on a 2xx or a 4xx.
 * Only a genuinely unreachable server throws.
 */
export async function verifyReceipt(file: File, walletAddress: string): Promise<VerifyResponse> {
  const body = new FormData();
  body.append('receipt', file);
  body.append('walletAddress', walletAddress);

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
  xstock: {
    signature: string;
    solscan: string;
    ticker: string;
    amount: number | null;
  };
  /** Null when the bonus vault is paused. This is normal, not a failure. */
  bonus: { signature: string; solscan: string } | null;
  bonusPaused: boolean;
}

/**
 * Claim a verified receipt.
 *
 * Throws only when the xStock leg failed — a paused bonus comes back as a
 * successful response with `bonus: null`.
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
    | (ConfirmResponse & { error?: string })
    | null;

  if (!res.ok || !payload?.xstock?.signature) {
    throw new Error(payload?.error ?? `Payout failed (${res.status}).`);
  }

  return payload;
}
