/**
 * Postgres implementation of the ReceiptStore (table stackd.receipts).
 *
 * The two properties that matter, both enforced by the database rather than by
 * application code, so they hold across restarts and across instances:
 *   - duplicates: a unique index on image_sha256, and a primary key on every
 *     fingerprint in stackd.receipt_fingerprints (one row per identity key)
 *   - exactly-once payout legs: claimLeg is a single conditional UPDATE
 */

import {
  DuplicateReceiptError,
  ReceiptNotFoundError,
  fingerprintKeys,
  getCluster,
  type Cluster,
  type DuplicateKind,
  type PayoutLeg,
  type ReceiptRecord,
  type ReceiptStore,
} from '@stackd/solana/server';
import { getPool, uniqueViolation } from './db.js';

type NewReceipt = Parameters<ReceiptStore['create']>[0];

interface Row {
  id: string;
  wallet_address: string;
  brand_name: string;
  brand_ticker: string;
  amount_usd: string;
  original_amount: string | null;
  original_currency: string | null;
  fx_rate: string | null;
  fx_rate_date: string | null; // 'YYYY-MM-DD' — see the DATE parser in db.ts
  xstock_amount: number | null;
  image_url: string | null;
  claude_confidence: number | null;
  status: ReceiptRecord['status'];
  tx_signature: string | null;
  bonus_tx_signature: string | null;
  created_at: Date;
  confirmed_at: Date | null;
  image_sha256: string | null;
  fingerprint: string | null;
  receipt_date: string | null;
  receipt_number: string | null;
  receipt_time: string | null;
}

const num = (v: string | null) => (v == null ? undefined : Number(v));

function toRecord(r: Row): ReceiptRecord {
  return {
    id: r.id,
    walletAddress: r.wallet_address,
    brandName: r.brand_name,
    brandTicker: r.brand_ticker,
    amountUsd: Number(r.amount_usd), // numeric comes back as a string
    originalAmount: num(r.original_amount),
    originalCurrency: r.original_currency ?? undefined,
    fxRate: num(r.fx_rate),
    fxRateDate: r.fx_rate_date,
    xstockAmount: r.xstock_amount,
    imageUrl: r.image_url,
    claudeConfidence: r.claude_confidence,
    status: r.status,
    txSignature: r.tx_signature,
    bonusTxSignature: r.bonus_tx_signature,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    imageSha256: r.image_sha256 ?? undefined,
    fingerprint: r.fingerprint ?? undefined,
    receiptDate: r.receipt_date,
    receiptNumber: r.receipt_number,
    receiptTime: r.receipt_time,
  };
}

/**
 * Scoped to one cluster. Devnet and mainnet share the database, and the
 * duplicate check must not reach across: the receipt used in a devnet test run
 * has to stay claimable on mainnet.
 */
export class PgReceiptStore implements ReceiptStore {
  constructor(private readonly cluster: Cluster = getCluster()) {}

  async get(receiptId: string): Promise<ReceiptRecord | null> {
    const { rows } = await getPool().query<Row>('select * from stackd.receipts where id = $1', [
      receiptId,
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findDuplicate(keys: {
    imageSha256?: string;
    fingerprints?: string[];
  }): Promise<DuplicateKind | null> {
    const fingerprints = keys.fingerprints ?? [];
    if (!keys.imageSha256 && fingerprints.length === 0) return null;
    const { rows } = await getPool().query<{ image: boolean; fingerprint: boolean }>(
      `select
         exists (select 1 from stackd.receipts
                  where cluster = $1 and image_sha256 = $2) as image,
         exists (select 1 from stackd.receipt_fingerprints
                  where cluster = $1 and fingerprint = any($3::text[])) as fingerprint`,
      [this.cluster, keys.imageSha256 ?? null, fingerprints],
    );
    if (rows[0].image) return 'image';
    return rows[0].fingerprint ? 'fingerprint' : null;
  }

  /**
   * The receipt and all of its fingerprints land in one transaction: if any
   * key already exists, the primary key rejects it and nothing is kept.
   */
  async create(receipt: NewReceipt): Promise<ReceiptRecord> {
    const client = await getPool().connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<Row>(
        `insert into stackd.receipts (
           id, wallet_address, brand_name, brand_ticker, amount_usd,
           original_amount, original_currency, fx_rate, fx_rate_date,
           xstock_amount, image_url, claude_confidence,
           image_sha256, fingerprint, receipt_date, receipt_number, cluster, receipt_time
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         returning *`,
        [
          receipt.id,
          receipt.walletAddress,
          receipt.brandName,
          receipt.brandTicker,
          receipt.amountUsd,
          receipt.originalAmount ?? null,
          receipt.originalCurrency ?? null,
          receipt.fxRate ?? null,
          receipt.fxRateDate ?? null,
          receipt.xstockAmount,
          receipt.imageUrl,
          receipt.claudeConfidence,
          receipt.imageSha256 ?? null,
          receipt.fingerprint ?? null,
          receipt.receiptDate ?? null,
          receipt.receiptNumber ?? null,
          this.cluster,
          receipt.receiptTime ?? null,
        ],
      );
      const keys = fingerprintKeys(receipt);
      if (keys.length > 0) {
        await client.query(
          `insert into stackd.receipt_fingerprints (cluster, fingerprint, receipt_id)
           select $1, unnest($2::text[]), $3`,
          [this.cluster, keys, receipt.id],
        );
      }
      await client.query('commit');
      return toRecord(rows[0]);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      const index = uniqueViolation(error);
      if (index != null) {
        throw new DuplicateReceiptError(index.includes('image') ? 'image' : 'fingerprint');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async claimLeg(receiptId: string, leg: PayoutLeg): Promise<boolean> {
    const sql =
      leg === 'xstock'
        ? `update stackd.receipts set xstock_in_flight = true
            where id = $1 and tx_signature is null and not xstock_in_flight
            returning id`
        : `update stackd.receipts set bonus_in_flight = true
            where id = $1 and bonus_tx_signature is null and not bonus_in_flight
            returning id`;
    const { rowCount } = await getPool().query(sql, [receiptId]);
    if (rowCount) return true;

    // Lost the race, already paid, or missing — only the last is an error.
    if (!(await this.get(receiptId))) throw new ReceiptNotFoundError(receiptId);
    return false;
  }

  async releaseLeg(receiptId: string, leg: PayoutLeg): Promise<void> {
    const column = leg === 'xstock' ? 'xstock_in_flight' : 'bonus_in_flight';
    await getPool().query(`update stackd.receipts set ${column} = false where id = $1`, [
      receiptId,
    ]);
  }

  async recordPayout(receiptId: string, leg: PayoutLeg, signature: string): Promise<void> {
    const sql =
      leg === 'xstock'
        ? `update stackd.receipts
              set tx_signature = $2, xstock_in_flight = false,
                  status = 'confirmed', confirmed_at = now()
            where id = $1`
        : `update stackd.receipts
              set bonus_tx_signature = $2, bonus_in_flight = false
            where id = $1`;
    const { rowCount } = await getPool().query(sql, [receiptId, signature]);
    if (!rowCount) throw new ReceiptNotFoundError(receiptId);
  }

  async recordXStockAmount(receiptId: string, xstockAmount: number): Promise<void> {
    await getPool().query('update stackd.receipts set xstock_amount = $2 where id = $1', [
      receiptId,
      xstockAmount,
    ]);
  }
}
