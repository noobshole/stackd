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
 * Payout budget, per chain, since each pays from its own treasury:
 *   Solana  DAILY_PAYOUT_CAP_USD      (default 25) of xStock cashback per UTC day
 *   Base    BASE_DAILY_PAYOUT_CAP_USD (default 25) of Base stock cashback per UTC day
 * Set one to 0 to pause that chain's payouts instantly: a kill switch.
 *
 * Two backends with identical behaviour: Postgres when DATABASE_URL is set
 * (survives restarts, shared across instances), memory otherwise.
 */

import { randomUUID } from 'node:crypto';
import { getCluster, type Cluster, type PayoutBudget } from '@stackd/solana/server';
import { scopeFor, type PayoutChain } from '../chains.js';
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
  baseDailyPayoutCapUsd: envNumber('BASE_DAILY_PAYOUT_CAP_USD', 25),
};

/** The daily cap for one chain's payouts. */
export function payoutCapUsd(chain: PayoutChain): number {
  return chain === 'base' ? limits.baseDailyPayoutCapUsd : limits.dailyPayoutCapUsd;
}

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

export type ChainBudget = PayoutBudget & { status(): Promise<BudgetStatus> };

export interface Guards {
  readonly backend: 'postgres' | 'memory';
  tryAttempt(wallet: string, ip: string): Promise<AttemptDecision>;
  releaseAttempt(token: string): Promise<void>;
  walletRemaining(wallet: string): Promise<number>;
  /** The Solana budget. Same as budgetFor('solana'). */
  budget: ChainBudget;
  budgetFor(chain: PayoutChain): ChainBudget;
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

  budgetFor(chain: PayoutChain): ChainBudget {
    const key = () => `${chain}:${today(this.now())}`;
    return {
      reserve: async (usd: number): Promise<boolean> => {
        const used = this.spent.get(key()) ?? 0;
        if (cents(used + usd) > payoutCapUsd(chain)) return false;
        this.spent.set(key(), cents(used + usd));
        return true;
      },
      release: async (usd: number): Promise<void> => {
        this.spent.set(key(), Math.max(0, cents((this.spent.get(key()) ?? 0) - usd)));
      },
      status: async (): Promise<BudgetStatus> => {
        const usedUsd = this.spent.get(key()) ?? 0;
        const capUsd = payoutCapUsd(chain);
        return {
          day: today(this.now()),
          capUsd,
          usedUsd,
          remainingUsd: Math.max(0, cents(capUsd - usedUsd)),
        };
      },
    };
  }

  budget = this.budgetFor('solana');
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export class PgGuards implements Guards {
  readonly backend = 'postgres' as const;

  /**
   * The payout budget is per chain and per cluster: devnet test payouts must
   * not eat mainnet's cap, and each chain spends its own treasury. Submission
   * limits are deliberately NOT per cluster or chain — they bound Claude
   * spend, which is the same money either way.
   *
   * `cluster` is the Solana scope; Base's comes from BASE_NETWORK.
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

  budgetFor(chain: PayoutChain): ChainBudget {
    const scope = () => (chain === 'solana' ? this.cluster : scopeFor(chain));
    return {
      reserve: async (usd: number): Promise<boolean> => {
        const pool = getPool();
        const day = today();
        await pool.query(
          `insert into stackd.payout_budget (chain, cluster, day) values ($1, $2, $3)
           on conflict (chain, cluster, day) do nothing`,
          [chain, scope(), day],
        );
        // One conditional UPDATE: Postgres re-checks the WHERE after taking the
        // row lock, so concurrent reservations cannot jointly exceed the cap.
        const { rowCount } = await pool.query(
          `update stackd.payout_budget
              set reserved_usd = reserved_usd + $4
            where chain = $1 and cluster = $2 and day = $3 and reserved_usd + $4 <= $5`,
          [chain, scope(), day, cents(usd), payoutCapUsd(chain)],
        );
        return Boolean(rowCount);
      },
      release: async (usd: number): Promise<void> => {
        await getPool().query(
          `update stackd.payout_budget
              set reserved_usd = greatest(reserved_usd - $4, 0)
            where chain = $1 and cluster = $2 and day = $3`,
          [chain, scope(), today(), cents(usd)],
        );
      },
      status: async (): Promise<BudgetStatus> => {
        const day = today();
        const { rows } = await getPool().query<{ reserved_usd: string }>(
          'select reserved_usd from stackd.payout_budget where chain = $1 and cluster = $2 and day = $3',
          [chain, scope(), day],
        );
        const usedUsd = rows[0] ? Number(rows[0].reserved_usd) : 0;
        const capUsd = payoutCapUsd(chain);
        return {
          day,
          capUsd,
          usedUsd,
          remainingUsd: Math.max(0, cents(capUsd - usedUsd)),
        };
      },
    };
  }

  budget = this.budgetFor('solana');
}

let guards: Guards | null = null;

/** Process-wide guards: Postgres when DATABASE_URL is set, memory otherwise. */
export function getGuards(): Guards {
  guards ??= hasDatabase() ? new PgGuards() : new MemoryGuards();
  return guards;
}
