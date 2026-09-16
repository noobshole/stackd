/** Client for POST /verify-receipt. */

export interface VerifyResponse {
  flagged: boolean;
  reason?: string;
  brand: string | null;
  ticker: string | null;
  amountUsd: number | null;
  confidence: number | null;
  pctBack?: number;
  cashbackUsd?: number;
  merchantName?: string;
  date?: string;
  currency?: string;
  submissionsRemaining?: number;
}

function apiBase(): string {
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
