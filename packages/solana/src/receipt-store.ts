/**
 * Receipt persistence — the idempotency backbone for payouts.
 *
 * The shape mirrors the Prisma `Receipt` model from the project brief, plus
 * `bonusTxSignature` for the second (STACKD) leg.
 *
 * ROADMAP — this ships with an in-memory implementation because the project has
 * no DATABASE_URL yet. That is genuinely dangerous for a payout system: process
 * memory dies on deploy, so a receipt paid out before a restart looks unpaid
 * afterwards and CAN BE PAID TWICE. Swap `InMemoryReceiptStore` for a Prisma
 * implementation of the same interface before real money moves.
 *
 * When you do, implement `claimLeg` as a conditional UPDATE rather than a
 * read-then-write, e.g.
 *
 *   UPDATE "Receipt" SET "txSignature" = '<in-flight>'
 *   WHERE id = $1 AND "txSignature" IS NULL
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
  amountUsd: number;
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

export interface ReceiptStore {
  get(receiptId: string): Promise<ReceiptRecord | null>;
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
}

export class ReceiptNotFoundError extends Error {
  constructor(receiptId: string) {
    super(`No receipt found with id ${receiptId}`);
  }
}

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

  async create(
    receipt: Omit<
      ReceiptRecord,
      'status' | 'txSignature' | 'bonusTxSignature' | 'createdAt' | 'confirmedAt'
    >,
  ): Promise<ReceiptRecord> {
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

  /** Test seam. */
  __reset(): void {
    this.rows.clear();
    this.inFlight.clear();
  }
}

/** Process-wide default. Replace with the Prisma-backed store. */
export const defaultReceiptStore = new InMemoryReceiptStore();
