/**
 * GET /stackd — public, read-only $STACKD market state for the portfolio page.
 *
 * Lives on the API rather than in the web app because pricing needs the
 * Meteora SDK (and Anchor), which was deliberately kept out of the browser
 * bundle. Nothing here is secret: mint, pool, price and progress are all
 * on-chain facts.
 *
 * Cached for 30s: every portfolio visit hits this, and the curve does not move
 * fast enough to justify an RPC round-trip per viewer.
 */

import { Router, type Request, type Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import {
  USDC_DECIMALS,
  getCluster,
  getConnection,
  getDbcClient,
  getDbcQuotePrice,
  getGraduationProgress,
  getStackdConfig,
} from '@stackd/solana/server';

const CACHE_MS = 30_000;

export interface StackdState {
  configured: boolean;
  cluster: 'mainnet' | 'devnet';
  mint: string | null;
  decimals: number | null;
  pool: string | null;
  /** USD per STACKD, from the curve before graduation and DAMM v2 after. */
  priceUsd: number | null;
  /** 0-100. */
  progressPct: number | null;
  /** USDC the curve must raise to graduate, read from the on-chain config. */
  thresholdUsdc: number | null;
  migrated: boolean | null;
  updatedAt: string;
}

let cache: { at: number; state: StackdState } | null = null;

async function readState(): Promise<StackdState> {
  const cluster = getCluster();
  const config = getStackdConfig();
  const pool = process.env.DBC_POOL_ADDRESS?.trim() || null;
  const base: StackdState = {
    configured: Boolean(config && pool),
    cluster,
    mint: config?.mint.toBase58() ?? null,
    decimals: config?.decimals ?? null,
    pool,
    priceUsd: null,
    progressPct: null,
    thresholdUsdc: null,
    migrated: null,
    updatedAt: new Date().toISOString(),
  };
  if (!config || !pool) return base;

  const connection = getConnection();
  const [priceUsd, progressPct, onChain] = await Promise.all([
    getDbcQuotePrice(connection, pool),
    getGraduationProgress(connection, pool),
    (async () => {
      const client = getDbcClient(connection);
      const virtualPool = await client.state.getPool(new PublicKey(pool));
      if (!virtualPool) return null;
      const poolConfig = await client.state.getPoolConfig(virtualPool.poolState.config);
      return {
        migrated: Boolean(virtualPool.poolState.isMigrated),
        thresholdUsdc: poolConfig
          ? Number(poolConfig.migrationQuoteThreshold.toString()) / 10 ** USDC_DECIMALS
          : null,
      };
    })().catch(() => null),
  ]);

  return {
    ...base,
    priceUsd,
    progressPct,
    thresholdUsdc: onChain?.thresholdUsdc ?? null,
    migrated: onChain?.migrated ?? null,
  };
}

export const stackdRouter = Router();

stackdRouter.get('/stackd', async (_req: Request, res: Response) => {
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), state: await readState() };
    }
    res.set('cache-control', 'public, max-age=30');
    res.json(cache.state);
  } catch (error) {
    console.error('[stackd-api] /stackd failed:', error instanceof Error ? error.message : error);
    res.status(503).json({ configured: false, error: 'Could not read $STACKD state.' });
  }
});
