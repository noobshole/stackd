/**
 * Receipt persistence — the idempotency backbone for payouts.
 *
 * The shape mirrors the Prisma `Receipt` model from the project brief, plus
 * `bonusTxSignature` for the second (STACKD) leg.
 *
 * Two implementations: `InMemoryReceiptStore` here (tests, local dev) and the
 * Postgres store in apps/api/src/lib/store/pg-receipt-store.ts, which the API
 * installs via `useReceiptStore` whenever DATABASE_URL is set — and requires on
 * mainnet. In-memory state dies on restart, taking the duplicate history and
 * payout records with it, which is not acceptable once money is real.
 *
 * `claimLeg` in Postgres is a conditional UPDATE rather than a read-then-write:
 *
 *   UPDATE stackd.receipts SET xstock_in_flight = true
 *   WHERE id = $1 AND tx_signature IS NULL AND NOT xstock_in_flight
 *   RETURNING id;
 *
 * so two concurrent confirms cannot both pass the check and both transfer.
 */

export type ReceiptStatus = 'pending' | 'confirmed' | 'failed';

export interface ReceiptRecord {
  id: string;
  walletAddress: string;
  brandName: string;
  brandTicker: string;
  /** Converted from originalAmount at fxRate. Everything downstream pays on this. */
  amountUsd: number;
  /**
   * The audit trail for amountUsd: the total as printed, its currency, and the
   * rate it was converted at. Optional only so older rows and tests still fit.
   */
  originalAmount?: number;
  originalCurrency?: string;
  /** Units of originalCurrency per 1 USD. 1 for USD receipts. */
  fxRate?: number;
  /** Publication date of fxRate (YYYY-MM-DD). Null for USD receipts. */
  fxRateDate?: string | null;
  /**
   * Fraud controls. A receipt is identified two ways, and a store must refuse
   * a second receipt matching either — from ANY wallet, at ANY time:
   *   imageSha256  — the exact uploaded bytes (catches a straight re-upload)
   *   fingerprints — what the receipt says: merchant, date, total, and one key
   *                  per identifying detail (transaction number, time), so a
   *                  re-photographed copy matches even when one detail is read
   *                  differently the second time
   * `fingerprint` is the primary key of the set, kept on the receipt row.
   */
  imageSha256?: string;
  fingerprint?: string;
  fingerprints?: string[];
  /** Purchase date as printed (YYYY-MM-DD). */
  receiptDate?: string | null;
  receiptNumber?: string | null;
  /** Time of purchase, normalised HH:MM. */
  receiptTime?: string | null;
  xstockAmount: number | null;
  imageUrl: string | null;
  claudeConfidence: number | null;
  status: ReceiptStatus;
  /** xStock payout signature. Non-null means this leg is already paid. */
  txSignature: string | null;
  /** STACKD bonus signature. Null is a valid terminal state (vault paused). */
  bonusTxSignature: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

/** Which payout leg a claim refers to. */
export type PayoutLeg = 'xstock' | 'bonus';

/** Which identity a duplicate matched on. */
export type DuplicateKind = 'image' | 'fingerprint';

/** All identity keys of a receipt; older records carry only the primary one. */
export function fingerprintKeys(receipt: Pick<ReceiptRecord, 'fingerprint' | 'fingerprints'>): string[] {
  if (receipt.fingerprints?.length) return receipt.fingerprints;
  return receipt.fingerprint ? [receipt.fingerprint] : [];
}

export interface ReceiptStore {
  get(receiptId: string): Promise<ReceiptRecord | null>;

  /**
   * Has a receipt with this image, or matching ANY of these fingerprints,
   * been seen before, by anyone?
   */
  findDuplicate(keys: { imageSha256?: string; fingerprints?: string[] }): Promise<DuplicateKind | null>;

  /**
   * Insert a receipt. Throws {@link DuplicateReceiptError} when its image or
   * any of its fingerprints already exists — the insert itself is the
   * race-safe check, so two simultaneous submissions of one receipt cannot
   * both get through.
   */
  create(
    receipt: Omit<
      ReceiptRecord,
      'status' | 'txSignature' | 'bonusTxSignature' | 'createdAt' | 'confirmedAt'
    >,
  ): Promise<ReceiptRecord>;

  /**
   * Take exclusive ownership of one payout leg.
   *
   * Returns false when another caller already owns it or it is already paid.
   * This is what stops a double-click or a retried request from sending twice.
   */
  claimLeg(receiptId: string, leg: PayoutLeg): Promise<boolean>;

  /** Release a claim after a failed attempt so the user can retry. */
  releaseLeg(receiptId: string, leg: PayoutLeg): Promise<void>;

  /** Record a landed signature and close out the claim. */
  recordPayout(receiptId: string, leg: PayoutLeg, signature: string): Promise<void>;

  /** Record the resolved share quantity once pricing is known. */
  recordXStockAmount(receiptId: string, xstockAmount: number): Promise<void>;

  /**
   * Has this wallet been paid for any receipt other than `exceptReceiptId`?
   * Paid means the xStock leg landed. Used to hold the $STACKD bonus back
   * until a wallet's second paid receipt.
   */
  hasPriorPayout(walletAddress: string, exceptReceiptId: string): Promise<boolean>;
}

export class ReceiptNotFoundError extends Error {
  constructor(receiptId: string) {
    super(`No receipt found with id ${receiptId}`);
  }
}

export class DuplicateReceiptError extends Error {
  constructor(readonly kind: DuplicateKind) {
    super(`A receipt with the same ${kind === 'image' ? 'image' : 'details'} was already claimed.`);
  }
}

/**
 * In-memory store. Fine for tests and a single local process; everything is
 * lost on restart, including the duplicate history — use the Postgres store
 * (apps/api) anywhere real money moves.
 */
export class InMemoryReceiptStore implements ReceiptStore {
  private readonly rows = new Map<string, ReceiptRecord>();
  /** Legs currently mid-transfer, so a concurrent call cannot also send. */
  private readonly inFlight = new Set<string>();

  private key(receiptId: string, leg: PayoutLeg): string {
    return `${receiptId}:${leg}`;
  }

  async get(receiptId: string): Promise<ReceiptRecord | null> {
    return this.rows.get(receiptId) ?? null;
  }

  async findDuplicate(keys: {
    imageSha256?: string;
    fingerprints?: string[];
  }): Promise<DuplicateKind | null> {
    const wanted = new Set(keys.fingerprints ?? []);
    for (const row of this.rows.values()) {
      if (keys.imageSha256 && row.imageSha256 === keys.imageSha256) return 'image';
      if (fingerprintKeys(row).some((key) => wanted.has(key))) return 'fingerprint';
    }
    return null;
  }

  async create(
    receipt: Omit<
      ReceiptRecord,
      'status' | 'txSignature' | 'bonusTxSignature' | 'createdAt' | 'confirmedAt'
    >,
  ): Promise<ReceiptRecord> {
    // Single-threaded, so check-then-insert is atomic here. Postgres relies on
    // its unique indexes instead.
    const duplicate = await this.findDuplicate({
      imageSha256: receipt.imageSha256,
      fingerprints: fingerprintKeys(receipt),
    });
    if (duplicate) throw new DuplicateReceiptError(duplicate);

    const row: ReceiptRecord = {
      ...receipt,
      status: 'pending',
      txSignature: null,
      bonusTxSignature: null,
      createdAt: new Date(),
      confirmedAt: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async claimLeg(receiptId: string, leg: PayoutLeg): Promise<boolean> {
    const row = this.rows.get(receiptId);
    if (!row) throw new ReceiptNotFoundError(receiptId);

    const already = leg === 'xstock' ? row.txSignature : row.bonusTxSignature;
    if (already) return false;

    const key = this.key(receiptId, leg);
    if (this.inFlight.has(key)) return false;

    this.inFlight.add(key);
    return true;
  }

  async releaseLeg(receiptId: string, leg: PayoutLeg): Promise<void> {
    this.inFlight.delete(this.key(receiptId, leg));
  }

  async recordPayout(receiptId: string, leg: PayoutLeg, signature: string): Promise<void> {
    const row = this.rows.get(receiptId);
    if (!row) throw new ReceiptNotFoundError(receiptId);

    if (leg === 'xstock') {
      row.txSignature = signature;
      // The xStock leg is the payout that matters; the bonus is best-effort.
      row.status = 'confirmed';
      row.confirmedAt = new Date();
    } else {
      row.bonusTxSignature = signature;
    }

    this.inFlight.delete(this.key(receiptId, leg));
  }

  async recordXStockAmount(receiptId: string, xstockAmount: number): Promise<void> {
    const row = this.rows.get(receiptId);
    if (!row) throw new ReceiptNotFoundError(receiptId);
    row.xstockAmount = xstockAmount;
  }

  async hasPriorPayout(walletAddress: string, exceptReceiptId: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.walletAddress === walletAddress && row.id !== exceptReceiptId && row.txSignature) {
        return true;
      }
    }
    return false;
  }

  /** Test seam. */
  __reset(): void {
    this.rows.clear();
    this.inFlight.clear();
  }
}

let activeStore: ReceiptStore = new InMemoryReceiptStore();

/**
 * Swap the process-wide store. apps/api calls this at boot with the Postgres
 * store when DATABASE_URL is set; everything that holds `defaultReceiptStore`
 * follows automatically, because it delegates rather than being an instance.
 */
export function useReceiptStore(store: ReceiptStore): void {
  activeStore = store;
}

/** Process-wide default. Delegates to whatever {@link useReceiptStore} set. */
export const defaultReceiptStore: ReceiptStore = {
  get: (id) => activeStore.get(id),
  findDuplicate: (keys) => activeStore.findDuplicate(keys),
  create: (receipt) => activeStore.create(receipt),
  claimLeg: (id, leg) => activeStore.claimLeg(id, leg),
  releaseLeg: (id, leg) => activeStore.releaseLeg(id, leg),
  recordPayout: (id, leg, sig) => activeStore.recordPayout(id, leg, sig),
  recordXStockAmount: (id, amount) => activeStore.recordXStockAmount(id, amount),
  hasPriorPayout: (wallet, exceptId) => activeStore.hasPriorPayout(wallet, exceptId),
};
