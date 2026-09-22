/**
 * GET /health/treasury — internal treasury monitor. Not public.
 *
 * Protected by a shared secret in the `x-health-secret` header, compared in
 * constant time. A missing or wrong secret gets the same 404 as a route that
 * does not exist, so the endpoint cannot be discovered by probing. Header only:
 * a query-string secret would land in every access log on the way in.
 *
 *   curl -H "x-health-secret: $HEALTH_SECRET" http://localhost:4000/health/treasury
 *
 * Each section is read independently and reports its own error, so one failing
 * RPC call does not blank the whole dashboard mid-demo.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { PublicKey, type Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ALL_MINTS, fetchXStockBalances, fetchXStockPrices } from '@stackd/solana';
import {
  USDC_MINT,
  getCluster,
  getConnection,
  getDbcClient,
  getDbcQuotePrice,
  getGraduationProgress,
  getStackdConfig,
  getTreasuryKeypair,
  getVaultBalance,
} from '@stackd/solana/server';
import { getGuards } from '../lib/store/guards.js';

/** Shorter secrets are treated as unset — the route stays disabled. */
const MIN_SECRET_LENGTH = 16;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function authorised(req: Request): boolean {
  const expected = process.env.HEALTH_SECRET?.trim();
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;

  const given = req.get('x-health-secret');
  if (typeof given !== 'string') return false;

  // Hash both sides so the comparison is constant-time regardless of length.
  return timingSafeEqual(digest(given), digest(expected));
}

/** Strip anything that looks like an RPC credential out of an error message. */
function redact(message: string): string {
  return message.replace(/api-key=[^&\s"']+/gi, 'api-key=***');
}

type Section<T> = T | { error: string };

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return await read();
  } catch (error) {
    return { error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

async function usdcBalance(connection: Connection, owner: PublicKey, mint: string) {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);
  const info = await connection.getTokenAccountBalance(ata).catch(() => null);
  return {
    mint,
    account: ata.toBase58(),
    balance: info ? Number(info.value.amount) / 10 ** info.value.decimals : 0,
  };
}

export const healthTreasuryRouter = Router();

healthTreasuryRouter.get('/health/treasury', async (req: Request, res: Response) => {
  if (!authorised(req)) {
    res.status(404).json({ flagged: true, reason: 'Not found.' });
    return;
  }

  let cluster: ReturnType<typeof getCluster>;
  let connection: Connection;
  let treasury: PublicKey;
  try {
    cluster = getCluster();
    connection = getConnection();
    treasury = getTreasuryKeypair().publicKey;
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: redact(error instanceof Error ? error.message : String(error)),
    });
    return;
  }

  const warnings: string[] = [];
  const stackdConfig = getStackdConfig();
  const poolAddress = process.env.DBC_POOL_ADDRESS?.trim() || null;

  const [sol, usdc, xstocks, stackdPrice, dbc] = await Promise.all([
    section(async () => (await connection.getBalance(treasury)) / 1e9),

    section(() => usdcBalance(connection, treasury, USDC_MINT[cluster])),

    section(async () => {
      const [balances, prices] = await Promise.all([
        fetchXStockBalances(connection, treasury, cluster),
        // Priced by mainnet mint; a failed price read should not hide balances.
        fetchXStockPrices(ALL_MINTS).catch(() => ({}) as Awaited<ReturnType<typeof fetchXStockPrices>>),
      ]);
      return balances.map((b) => {
        const priceUsd = prices[b.brand.mint]?.usd ?? null;
        return {
          ticker: b.brand.ticker,
          account: b.tokenAccount,
          // Multiplier maths leaves float noise (10.0000000047); 6dp is plenty
          // for monitoring and matches what the portfolio shows.
          balance: Math.round(b.uiAmount * 1e6) / 1e6,
          multiplier: b.multiplier,
          priceUsd,
          valueUsd: priceUsd != null ? Math.round(b.uiAmount * priceUsd * 100) / 100 : null,
        };
      });
    }),

    section(() => getDbcQuotePrice(connection)),

    section(async () => {
      if (!poolAddress) return null;
      const state = await getDbcClient(connection).state.getPool(new PublicKey(poolAddress));
      return {
        pool: poolAddress,
        progressPct: await getGraduationProgress(connection, poolAddress),
        migrated: Boolean(state?.poolState.isMigrated),
      };
    }),
  ]);

  const priceUsd = typeof stackdPrice === 'number' ? stackdPrice : null;
  const guards = getGuards();
  const payoutBudget = await section(() => guards.budget.status());

  const stackdVault = await section(async () => {
    if (!stackdConfig) return null;
    const balance = await getVaultBalance(connection, treasury, stackdConfig);
    return {
      mint: stackdConfig.mint.toBase58(),
      // The bonus leg pays from the treasury's own STACKD account.
      owner: treasury.toBase58(),
      balance,
      minBalance: stackdConfig.minVaultBalance,
      bonusPaused: balance < stackdConfig.minVaultBalance || priceUsd == null,
      valueUsd: priceUsd != null ? Math.round(balance * priceUsd * 100) / 100 : null,
    };
  });

  if (!stackdConfig) warnings.push('STACKD_MINT is not set: the bonus leg is disabled.');
  if (!poolAddress) warnings.push('DBC_POOL_ADDRESS is not set: no $STACKD price.');
  if (poolAddress && priceUsd == null) {
    warnings.push('No $STACKD price from the pool: the bonus leg pauses until it returns.');
  }
  const vaultKey = process.env.STACKD_VAULT_PUBLIC_KEY?.trim();
  if (vaultKey && vaultKey !== treasury.toBase58()) {
    warnings.push(
      'STACKD_VAULT_PUBLIC_KEY differs from the treasury. dbc:claim-fees deposits there, ' +
        'but the bonus leg pays from the treasury.',
    );
  }
  if (typeof sol === 'number' && sol < 0.05) {
    warnings.push(`Treasury has ${sol} SOL: payouts will start failing on fees and ATA rent.`);
  }
  if (guards.backend === 'memory') {
    warnings.push('Storage is in memory: receipts, limits and the payout budget reset on restart.');
  }
  if ('remainingUsd' in payoutBudget && payoutBudget.remainingUsd <= 0) {
    warnings.push(`Today's payout cap of $${payoutBudget.capUsd} is used up: payouts are paused.`);
  }

  const sections = { sol, usdc, xstocks, stackdVault, dbc, payoutBudget };
  const ok = Object.values(sections).every(
    (s) => s === null || typeof s !== 'object' || !('error' in s),
  );

  res.status(200).json({
    ok,
    cluster,
    checkedAt: new Date().toISOString(),
    treasury: { address: treasury.toBase58(), sol },
    usdc,
    xstocks,
    stackdVault,
    dbc: dbc && typeof dbc === 'object' && !('error' in dbc) ? { ...dbc, priceUsd } : dbc,
    storage: guards.backend,
    payoutBudget,
    warnings,
  });
});
