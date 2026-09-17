/**
 * Meteora Dynamic Bonding Curve — $STACKD pool config, pricing, and progress.
 *
 * Every SDK signature here was read from the Meteora docs MCP and verified
 * against the installed package (@meteora-ag/dynamic-bonding-curve-sdk 1.5.12),
 * not recalled. If you change a call, re-check it the same way.
 *
 * ⚠️ READ THIS BEFORE RUNNING GENESIS ON MAINNET
 *
 * An earlier design described minting $STACKD ourselves and then
 * transferring 60% / 25% / 15% into the curve, a Rewards Vault, and a team
 * wallet. That is not how DBC works, and the difference is permanent once run:
 *
 *   - `creator.createPool` takes a BRAND NEW base-mint keypair. The DBC program
 *     initialises the mint itself and mints `totalTokenSupply` into a
 *     program-owned vault PDA. You cannot hand it a mint you already created
 *     and pre-split.
 *   - `leftover_receiver` is documented as "Receiver for leftover base tokens
 *     AFTER MIGRATION". Leftover is not claimable at genesis.
 *
 * So there is no genesis moment at which 25% can be dropped into a vault. The
 * Rewards Vault is funded by claiming creator trading fees (
 * see scripts/dbc/claim-fees.ts), or by an explicit creator buy off the curve.
 *
 * The practical consequence for Leg 2: until the vault has been funded, every
 * sendStackdBonus() call returns null and the bonus pauses. Leg 1 is unaffected,
 * which is exactly the safety property the two-leg design exists for.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

/** Same program id on mainnet and devnet, per Meteora docs. */
export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

export const USDC_MINT = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
} as const;

export const USDC_DECIMALS = 6;
export const STACKD_DECIMALS = 6;
export const STACKD_TOTAL_SUPPLY = 1_000_000_000;

/** Graduate at 750 USDC of quote raised. */
export const MIGRATION_QUOTE_THRESHOLD_USDC = 750;

/**
 * The 15% team/liquidity bucket, expressed the only way DBC supports it:
 * as `leftover`, paid to `leftoverReceiver` after migration.
 */
export const TEAM_LEFTOVER_PERCENTAGE = 15;

/** Share of supply seeded into the migrated DAMM v2 pool at graduation. */
export const PERCENTAGE_SUPPLY_ON_MIGRATION = 20;

/**
 * Share of trading fees routed to the pool creator. This is the vault's only
 * automatic refill source, so it must not be zero.
 */
export const CREATOR_TRADING_FEE_PERCENTAGE = 50;

/** Fixed trading fee in bps. No time-decay scheduler. */
export const TRADING_FEE_BPS = 100;

/**
 * Curve config for $STACKD.
 *
 * `buildCurve` produces a single-segment curve from a migration target, which
 * is the "gentle/linear" shape we want — it rewards sustained demand
 * rather than whoever buys first.
 */
export function buildStackdCurveConfig() {
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken, // legacy SPL — $STACKD is not Token-2022
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.SIX, // USDC
      // No mint authority may survive genesis. Immutable is how DBC
      // expresses that — there is no later "burn the authority" step to forget.
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: STACKD_TOTAL_SUPPLY,
      leftover: (STACKD_TOTAL_SUPPLY * TEAM_LEFTOVER_PERCENTAGE) / 100,
    },
    fee: {
      baseFeeParams: {
        // Linear scheduler with identical start and end fees == a fixed fee.
        // No anti-bot decay: the only way onto this
        // curve is meant to be real spending, so there is no sniping to defend.
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: TRADING_FEE_BPS,
          endingFeeBps: TRADING_FEE_BPS,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees accrue in USDC
      creatorTradingFeePercentage: CREATOR_TRADING_FEE_PERCENTAGE,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, // v1 is deprecated for new configs
      migrationFeeOption: MigrationFeeOption.FixedBps100, // 100 bps
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, // only read when Customizable
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: TRADING_FEE_BPS,
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: PERCENTAGE_SUPPLY_ON_MIGRATION,
    migrationQuoteThreshold: MIGRATION_QUOTE_THRESHOLD_USDC * 10 ** USDC_DECIMALS,
  });
}

export function getDbcClient(connection: Connection): DynamicBondingCurveClient {
  return DynamicBondingCurveClient.create(connection, 'confirmed');
}

export function deriveStackdPoolAddress(
  quoteMint: string,
  baseMint: string,
  config: string,
): PublicKey {
  return deriveDbcPoolAddress(
    new PublicKey(quoteMint),
    new PublicKey(baseMint),
    new PublicKey(config),
  );
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Current $STACKD price in USD.
 *
 * Quotes a small USDC-in swap and divides, which gives the effective marginal
 * price on the curve. The quote token is USDC, so the result is already
 * dollar-denominated — no second oracle hop, and it matches the dollar-based
 * reward maths used everywhere else.
 *
 * Returns null rather than throwing or guessing when the pool is unreachable or
 * unconfigured. Callers treat null exactly like a paused vault: the bonus leg
 * skips, and the xStock payout is untouched.
 */
export async function getDbcQuotePrice(
  connection?: Connection,
  poolAddress?: string,
): Promise<number | null> {
  const pool = poolAddress ?? process.env.DBC_POOL_ADDRESS?.trim();
  if (!pool) return null;

  const rpc = connection ?? new Connection(process.env.HELIUS_RPC_URL ?? '', 'confirmed');

  try {
    const client = getDbcClient(rpc);
    const poolKey = new PublicKey(pool);

    const virtualPool = await client.state.getPool(poolKey);
    if (!virtualPool) return null;

    const config = await client.state.getPoolConfig(virtualPool.poolState.config);
    if (!config) return null;

    const currentPoint =
      config.activationType === ActivationType.Slot
        ? new BN(await rpc.getSlot())
        : new BN(Math.floor(Date.now() / 1000));

    // 1 USDC in. Small enough that price impact does not distort the read.
    const probeUsdc = 10 ** USDC_DECIMALS;

    const quote = client.pool.swapQuote2({
      virtualPool,
      config,
      swapBaseForQuote: false, // USDC -> STACKD
      swapMode: SwapMode.ExactIn,
      amountIn: new BN(probeUsdc),
      slippageBps: 100,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
    });

    // IDL field is `outputAmount` on swapResult2 — not `amountOut`.
    const stackdOut = Number(quote.outputAmount.toString()) / 10 ** STACKD_DECIMALS;
    if (!Number.isFinite(stackdOut) || stackdOut <= 0) return null;

    return 1 / stackdOut; // USD per STACKD
  } catch {
    return null;
  }
}

/** Percentage progress toward the 750 USDC graduation threshold, 0-100. */
export async function getGraduationProgress(
  connection: Connection,
  poolAddress?: string,
): Promise<number | null> {
  const pool = poolAddress ?? process.env.DBC_POOL_ADDRESS?.trim();
  if (!pool) return null;

  try {
    const client = getDbcClient(connection);
    const progress = await client.state.getPoolQuoteTokenCurveProgress(new PublicKey(pool));
    return Math.max(0, Math.min(100, progress * 100));
  } catch {
    return null;
  }
}
