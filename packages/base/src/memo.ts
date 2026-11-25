/**
 * The memo attached to each Base payout. SERVER ONLY (node:crypto).
 *
 * Every payout's transferWithMemo carries a bytes32 derived from the receipt's
 * fingerprint, so anyone can check on Basescan that each payout links to one
 * receipt and that no receipt was paid twice: the same receipt always gives
 * the same memo.
 *
 * It is a keyed hash (HMAC-SHA256), not a plain one. A fingerprint is built
 * from what the receipt says (merchant, date, total, transaction number), and
 * a plain hash of those could be confirmed by guessing them. Without the
 * secret, the memo reveals nothing about the purchase.
 */

import { createHmac } from 'node:crypto';
import type { Hex } from 'viem';

const DOMAIN = 'stackd/receipt-memo/v1';

/** Shortest secret accepted: 32 characters (e.g. 32 random bytes as hex is 64). */
const MIN_SECRET_LENGTH = 32;

export function receiptMemo(fingerprint: string, secret: string): Hex {
  if (!fingerprint) throw new Error('A receipt memo needs the receipt fingerprint.');
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BASE_MEMO_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const digest = createHmac('sha256', secret).update(`${DOMAIN}:${fingerprint}`).digest('hex');
  return `0x${digest}`;
}
