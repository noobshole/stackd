/**
 * Abuse limits and the daily payout circuit breaker.
 *
 * Submission limits — checked before every Claude call, because every call
 * costs real money whether or not the receipt pays:
 *   wallet  WALLET_MAX_PER_DAY  (default 3 per rolling 24h)
 *   IP      IP_MAX_PER_HOUR     (default 10 per rolling hour)
 *   global  CLAUDE_MAX_PER_HOUR (default 60 per rolling hour, all users)
 * The wallet limit alone is not enough: the address is an unsigned form field,
 * so a script can invent a fresh one per request. IP and global limits bound
 * what that script can spend.
 *
 * Payout budget — DAILY_PAYOUT_CAP_USD (default 25) of xStock cashback per UTC
 * day. Set it to 0 to pause all payouts instantly: a kill switch.
 *
 * Two backends with identical behaviour: Postgres when DATABASE_URL is set
 * (survives restarts, shared across instances), memory otherwise.
 */

import { randomUUID } from 'node:crypto';
import { getCluster, type Cluster, type PayoutBudget } from '@stackd/solana/server';
import { getPool, hasDatabase } from './db.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}".`);
  }
  return value;
}

export const limits = {
  walletPerDay: envNumber('WALLET_MAX_PER_DAY', 3),
  ipPerHour: envNumber('IP_MAX_PER_HOUR', 10),
  globalPerHour: envNumber('CLAUDE_MAX_PER_HOUR', 60),
  dailyPayoutCapUsd: envNumber('DAILY_PAYOUT_CAP_USD', 25),
};

export type LimitKind = 'wallet' | 'ip' | 'global';

export interface AttemptDecision {
  allowed: boolean;
  /** Pass to releaseAttempt when the failure was ours, not the user's. */
  token: string | null;
  /** Which limit refused it. */
  limit: LimitKind | null;
  /** When the refusing limit frees a slot. */
  retryAfterMs: number | null;
}

export interface BudgetStatus {
  day: string;
  capUsd: number;
  usedUsd: number;
  remainingUsd: number;
}

export interface Guards {
  readonly backend: 'postgres' | 'memory';
  tryAttempt(wallet: string, ip: string): Promise<AttemptDecision>;
  releaseAttempt(token: string): Promise<void>;
  walletRemaining(wallet: string): Promise<number>;
  budget: PayoutBudget & { status(): Promise<BudgetStatus> };
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const cents = (usd: number) => Math.round(usd * 100) / 100;

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

interface Attempt {
  token: string;
  wallet: string;
  ip: string;
  at: number;
}

export class MemoryGuards implements Guards {
  readonly backend = 'memory' as const;
  private attempts: Attempt[] = [];
  private spent = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private recent(windowMs: number, match: (a: Attempt) => boolean): Attempt[] {
    const cutoff = this.now() - windowMs;
    return this.attempts.filter((a) => a.at > cutoff && match(a));
  }

  async tryAttempt(wallet: string, ip: string): Promise<AttemptDecision> {
    this.attempts = this.attempts.filter((a) => a.at > this.now() - DAY_MS);

    const checks: Array<[LimitKind, number, number, Attempt[]]> = [
      ['wallet', limits.walletPerDay, DAY_MS, this.recent(DAY_MS, (a) => a.wallet === wallet)],
      ['ip', limits.ipPerHour, HOUR_MS, this.recent(HOUR_MS, (a) => a.ip === ip)],
      ['global', limits.globalPerHour, HOUR_MS, this.recent(HOUR_MS, () => true)],
    ];

    for (const [limit, max, windowMs, used] of checks) {
      if (used.length >= max) {
        const oldest = Math.min(...used.map((a) => a.at));
        return {
          allowed: false,
          token: null,
          limit,
          retryAfterMs: used.length ? oldest + windowMs - this.now() : null,
        };
      }
    }

    const token = randomUUID();
    this.attempts.push({ token, wallet, ip, at: this.now() });
    return { allowed: true, token, limit: null, retryAfterMs: null };
  }

  async releaseAttempt(token: string): Promise<void> {
    this.attempts = this.attempts.filter((a) => a.token !== token);
  }

  async walletRemaining(wallet: string): Promise<number> {
    const used = this.recent(DAY_MS, (a) => a.wallet === wallet).length;
    return Math.max(0, limits.walletPerDay - used);
  }

  budget = {
    reserve: async (usd: number): Promise<boolean> => {
      const day = today(this.now());
      const used = this.spent.get(day) ?? 0;
      if (cents(used + usd) > limits.dailyPayoutCapUsd) return false;
      this.spent.set(day, cents(used + usd));
      return true;
    },
    release: async (usd: number): Promise<void> => {
      const day = today(this.now());
      this.spent.set(day, Math.max(0, cents((this.spent.get(day) ?? 0) - usd)));
    },
    status: async (): Promise<BudgetStatus> => {
      const day = today(this.now());
      const usedUsd = this.spent.get(day) ?? 0;
      return {
        day,
        capUsd: limits.dailyPayoutCapUsd,
        usedUsd,
        remainingUsd: Math.max(0, cents(limits.dailyPayoutCapUsd - usedUsd)),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export class PgGuards implements Guards {
  readonly backend = 'postgres' as const;

  /**
   * The payout budget is per cluster: devnet test payouts must not eat
   * mainnet's cap. Submission limits are deliberately NOT per cluster — they
   * bound Claude spend, which is the same money on either network.
   */
  constructor(private readonly cluster: Cluster = getCluster()) {}

  async tryAttempt(wallet: string, ip: string): Promise<AttemptDecision> {
    const pool = getPool();
    const token = randomUUID();

    // Insert first, then count including ourselves. Two concurrent requests
    // can both be refused at the boundary, but never both admitted over it.
    await pool.query(
      'insert into stackd.submission_attempts (token, wallet_address, ip) values ($1, $2, $3)',
      [token, wallet, ip],
    );

    const { rows } = await pool.query<{
      wallet_used: number;
      wallet_oldest: Date | null;
      ip_used: number;
      ip_oldest: Date | null;
      global_used: number;
      global_oldest: Date | null;
    }>(
      `select
         count(*) filter (where wallet_address = $1 and at > now() - interval '24 hours')::int as wallet_used,
         min(at)  filter (where wallet_address = $1 and at > now() - interval '24 hours')      as wallet_oldest,
         count(*) filter (where ip = $2 and at > now() - interval '1 hour')::int              as ip_used,
         min(at)  filter (where ip = $2 and at > now() - interval '1 hour')                   as ip_oldest,
         count(*) filter (where at > now() - interval '1 hour')::int                          as global_used,
         min(at)  filter (where at > now() - interval '1 hour')                               as global_oldest
       from stackd.submission_attempts
       where at > now() - interval '24 hours'`,
      [wallet, ip],
    );
    const c = rows[0];

    const over: Array<[LimitKind, boolean, Date | null, number]> = [
      ['wallet', c.wallet_used > limits.walletPerDay, c.wallet_oldest, DAY_MS],
      ['ip', c.ip_used > limits.ipPerHour, c.ip_oldest, HOUR_MS],
      ['global', c.global_used > limits.globalPerHour, c.global_oldest, HOUR_MS],
    ];

    for (const [limit, exceeded, oldest, windowMs] of over) {
      if (exceeded) {
        await this.releaseAttempt(token);
        return {
          allowed: false,
          token: null,
          limit,
          retryAfterMs: oldest ? Math.max(0, oldest.getTime() + windowMs - Date.now()) : null,
        };
      }
    }

    // Opportunistic cleanup keeps the table to one day of rows.
    void pool
      .query(`delete from stackd.submission_attempts where at < now() - interval '25 hours'`)
      .catch(() => undefined);

    return { allowed: true, token, limit: null, retryAfterMs: null };
  }

  async releaseAttempt(token: string): Promise<void> {
    await getPool().query('delete from stackd.submission_attempts where token = $1', [token]);
  }

  async walletRemaining(wallet: string): Promise<number> {
    const { rows } = await getPool().query<{ used: number }>(
      `select count(*)::int as used from stackd.submission_attempts
        where wallet_address = $1 and at > now() - interval '24 hours'`,
      [wallet],
    );
    return Math.max(0, limits.walletPerDay - rows[0].used);
  }

  budget = {
    reserve: async (usd: number): Promise<boolean> => {
      const pool = getPool();
      const day = today();
      await pool.query(
        `insert into stackd.payout_budget (cluster, day) values ($1, $2)
         on conflict (cluster, day) do nothing`,
        [this.cluster, day],
      );
      // One conditional UPDATE: Postgres re-checks the WHERE after taking the
      // row lock, so concurrent reservations cannot jointly exceed the cap.
      const { rowCount } = await pool.query(
        `update stackd.payout_budget
            set reserved_usd = reserved_usd + $3
          where cluster = $1 and day = $2 and reserved_usd + $3 <= $4`,
        [this.cluster, day, cents(usd), limits.dailyPayoutCapUsd],
      );
      return Boolean(rowCount);
    },
    release: async (usd: number): Promise<void> => {
      await getPool().query(
        `update stackd.payout_budget
            set reserved_usd = greatest(reserved_usd - $3, 0)
          where cluster = $1 and day = $2`,
        [this.cluster, today(), cents(usd)],
      );
    },
    status: async (): Promise<BudgetStatus> => {
      const day = today();
      const { rows } = await getPool().query<{ reserved_usd: string }>(
        'select reserved_usd from stackd.payout_budget where cluster = $1 and day = $2',
        [this.cluster, day],
      );
      const usedUsd = rows[0] ? Number(rows[0].reserved_usd) : 0;
      return {
        day,
        capUsd: limits.dailyPayoutCapUsd,
        usedUsd,
        remainingUsd: Math.max(0, cents(limits.dailyPayoutCapUsd - usedUsd)),
      };
    },
  };
}

let guards: Guards | null = null;

/** Process-wide guards: Postgres when DATABASE_URL is set, memory otherwise. */
export function getGuards(): Guards {
  guards ??= hasDatabase() ? new PgGuards() : new MemoryGuards();
  return guards;
}
