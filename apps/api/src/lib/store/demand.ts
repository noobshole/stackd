/**
 * Demand while paused: receipts that verified for a brand whose payouts were
 * paused while the treasury restocks (verify-receipt step 7b).
 *
 * Nothing here is owed. The receipt itself is not stored, and it can be sent
 * again once the brand is restocked. What this keeps is the number a sponsor
 * asks for: how many receipts, at which brand, would have paid how much.
 *
 * Totals only. No wallet address, IP, image or receipt detail is kept. Each of
 * a receipt's duplicate keys is stored only as a SHA-256 hash, so the same
 * receipt sent again, or photographed again, is counted once.
 *
 * Two backends with identical behaviour, as for the guards: Postgres when
 * DATABASE_URL is set, memory otherwise.
 */

import { randomUUID } from 'node:crypto';
import { getCluster, type Cluster } from '@stackd/solana/server';
import { sha256Hex } from '../receipt-checks.js';
import { getPool, hasDatabase } from './db.js';

export interface DemandEntry {
  ticker: string;
  /** What the receipt would have paid, in USD. */
  cashbackUsd: number;
  /** The receipt's duplicate keys, as verify-receipt computed them. */
  keys: string[];
}

export interface DemandTotal {
  ticker: string;
  receipts: number;
  cashbackUsd: number;
  /** When the first of these receipts was seen, ISO 8601. */
  since: string;
}

export interface DemandStore {
  readonly backend: 'postgres' | 'memory';
  /** True when the receipt was counted; false when it already had been. */
  record(entry: DemandEntry): Promise<boolean>;
  /** Per brand, the most receipts first. */
  totals(): Promise<DemandTotal[]>;
}

/** Domain-separated, so a stored hash never equals a key used elsewhere. */
export function demandKeyHash(key: string): string {
  return sha256Hex(`paused-demand:${key}`);
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

function hashedKeys(keys: string[]): string[] {
  return [...new Set(keys.filter(Boolean).map(demandKeyHash))];
}

function byReceipts(a: DemandTotal, b: DemandTotal): number {
  return b.receipts - a.receipts || a.ticker.localeCompare(b.ticker);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export class MemoryDemand implements DemandStore {
  readonly backend = 'memory' as const;
  private seenKeys = new Set<string>();
  private receipts: Array<{ ticker: string; cashbackUsd: number; at: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  async record(entry: DemandEntry): Promise<boolean> {
    const keys = hashedKeys(entry.keys);
    if (keys.length === 0 || keys.some((k) => this.seenKeys.has(k))) return false;
    for (const k of keys) this.seenKeys.add(k);
    this.receipts.push({ ticker: entry.ticker, cashbackUsd: entry.cashbackUsd, at: this.now() });
    return true;
  }

  async totals(): Promise<DemandTotal[]> {
    const byTicker = new Map<string, DemandTotal>();
    for (const r of this.receipts) {
      const t = byTicker.get(r.ticker);
      if (!t) {
        byTicker.set(r.ticker, {
          ticker: r.ticker,
          receipts: 1,
          cashbackUsd: r.cashbackUsd,
          since: new Date(r.at).toISOString(),
        });
        continue;
      }
      t.receipts += 1;
      t.cashbackUsd += r.cashbackUsd;
    }
    return [...byTicker.values()]
      .map((t) => ({ ...t, cashbackUsd: cents(t.cashbackUsd) }))
      .sort(byReceipts);
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export class PgDemand implements DemandStore {
  readonly backend = 'postgres' as const;

  /** Per cluster, like the receipts: devnet testing must not inflate mainnet's demand. */
  constructor(private readonly cluster: Cluster = getCluster()) {}

  async record(entry: DemandEntry): Promise<boolean> {
    const keys = hashedKeys(entry.keys);
    if (keys.length === 0) return false;

    // One statement: insert every key under a new receipt id, unless any key
    // was counted before. The primary key catches the rare race between two
    // copies of one receipt arriving together.
    const { rowCount } = await getPool().query(
      `insert into stackd.paused_demand (cluster, key_hash, demand_id, ticker, cashback_usd)
       select $1, k, $3, $4, $5
         from unnest($2::text[]) as k
        where not exists (
          select 1 from stackd.paused_demand where cluster = $1 and key_hash = any($2::text[])
        )
       on conflict do nothing`,
      [this.cluster, keys, randomUUID(), entry.ticker, entry.cashbackUsd],
    );
    return Boolean(rowCount);
  }

  async totals(): Promise<DemandTotal[]> {
    // A receipt has one row per key; count and sum each receipt once.
    const { rows } = await getPool().query<{
      ticker: string;
      receipts: number;
      cashback_usd: number;
      since: Date;
    }>(
      `select ticker,
              count(*)::int              as receipts,
              sum(cashback_usd)::float8  as cashback_usd,
              min(seen_at)               as since
         from (select distinct demand_id, ticker, cashback_usd, seen_at
                 from stackd.paused_demand
                where cluster = $1) receipts
        group by ticker`,
      [this.cluster],
    );
    return rows
      .map((r) => ({
        ticker: r.ticker,
        receipts: r.receipts,
        cashbackUsd: cents(r.cashback_usd),
        since: r.since.toISOString(),
      }))
      .sort(byReceipts);
  }
}

let demand: DemandStore | null = null;

/** Process-wide store: Postgres when DATABASE_URL is set, memory otherwise. */
export function getDemand(): DemandStore {
  demand ??= hasDatabase() ? new PgDemand() : new MemoryDemand();
  return demand;
}
