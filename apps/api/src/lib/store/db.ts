/**
 * Postgres connection (Supabase). Server-only.
 *
 * DATABASE_URL should be Supabase's **Session pooler** URI (Connect → Session
 * pooler). The direct `db.<ref>.supabase.co` host is IPv6-only on the free
 * plan and fails on most IPv4 hosts.
 *
 * TLS: Supabase serves its own CA, so the connection is encrypted but the
 * certificate is not verified against the system store. To pin it, download the
 * CA from the dashboard and pass it as `ssl.ca` — worth doing before this holds
 * anything larger than a hackathon treasury.
 */

import pg from 'pg';

// Return SQL `date` as the 'YYYY-MM-DD' string it is. The default parser makes
// a Date at LOCAL midnight, so on a UTC+7 machine toISOString() reads it back
// as the previous day — every receipt date would shift by one.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

let pool: pg.Pool | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });

  // An idle client erroring (e.g. the pooler recycling it) must not crash the
  // process; the next query simply gets a fresh connection.
  pool.on('error', (error) => {
    console.error('[stackd-api] postgres idle client error:', error.message);
  });

  return pool;
}

/** Postgres unique-violation code, and the index that fired. */
export function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' ? (e.constraint ?? '') : null;
}
