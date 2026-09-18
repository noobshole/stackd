/**
 * TASK 5 — devnet simulation: buy until the curve crosses its threshold and
 * confirm migration actually fires.
 *
 * This is the piece most likely to hide a subtle config
 * error: a curve that never graduates fails silently — it just
 * keeps accepting buys. Nothing else in the build surfaces that. (It did catch
 * one: the first devnet pool was built at 20,000,000 USDC instead of 20.)
 *
 * Devnet only. Refuses mainnet outright regardless of DBC_ALLOW_MAINNET: there
 * is no reason to spend 750 real USDC proving a config you can prove for free.
 *
 * Safe to re-run: it skips buying once the curve is complete and skips
 * migration once the pool has migrated.
 *
 *   npm run dbc:simulate
 *   npm run dbc:simulate -- --execute
 */

import BN from 'bn.js';
import { PublicKey, sendAndConfirmTransaction, type Connection } from '@solana/web3.js';
import {
  ActivationType,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  SwapMode,
  deriveDammV2PoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { USDC_DECIMALS, getDbcClient } from '../../packages/solana/src/dbc.js';
import {
  banner,
  fail,
  getConnection,
  requireKeypair,
  requireConfirm,
  resolveCluster,
} from './_shared.js';

/** USDC per simulated buy. Keep it below the buyer's balance. */
const BUY_SIZE_USDC = Number(process.env.SIM_BUY_SIZE_USDC ?? 5);
const MAX_BUYS = Number(process.env.SIM_MAX_BUYS ?? 40);

/**
 * The DAMM v2 config the pool must migrate into.
 *
 * Fixed-fee DBC configs can only migrate into the Meteora-owned DAMM v2 config
 * matching their migrationFeeOption (FixedBps100 -> index 2). The SDK ships the
 * list; picking by index means the key always matches the pool on chain rather
 * than whatever someone pasted into .env. DAMM_V2_CONFIG_ADDRESS still wins if
 * set, for Customizable configs.
 */
function resolveDammConfig(migrationFeeOption: number): PublicKey {
  const override = process.env.DAMM_V2_CONFIG_ADDRESS?.trim();
  if (override) return new PublicKey(override);

  const key = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (!key) {
    throw new Error(
      `No DAMM v2 config for migrationFeeOption ${migrationFeeOption}. ` +
        'Set DAMM_V2_CONFIG_ADDRESS.',
    );
  }
  return key;
}

async function assertAccountExists(connection: Connection, key: PublicKey, what: string) {
  if (!(await connection.getAccountInfo(key))) {
    throw new Error(`${what} ${key.toBase58()} does not exist on this cluster.`);
  }
}

async function main(): Promise<void> {
  const cluster = resolveCluster();
  if (cluster !== 'devnet') {
    throw new Error(
      'simulate-graduation is devnet-only. Proving the curve graduates does not ' +
        'require spending 750 real USDC.',
    );
  }

  const connection = getConnection(cluster);
  const buyer = requireKeypair('DBC_PAYER_PRIVATE_KEY', 'devnet buyer funding the simulated swaps');
  const poolAddress = process.env.DBC_POOL_ADDRESS?.trim();
  if (!poolAddress) throw new Error('DBC_POOL_ADDRESS is not set. Run dbc:launch first.');

  const pool = new PublicKey(poolAddress);
  const client = getDbcClient(connection);

  const initial = await client.state.getPool(pool);
  if (!initial) throw new Error(`Pool ${pool.toBase58()} not found.`);
  const config = await client.state.getPoolConfig(initial.poolState.config);
  if (!config) throw new Error('Pool config not found.');

  // Read the threshold off the chain, not from a constant: the whole point of
  // this script is to check what was actually deployed.
  const thresholdUsdc = Number(config.migrationQuoteThreshold.toString()) / 10 ** USDC_DECIMALS;
  const dammConfig = resolveDammConfig(config.migrationFeeOption);
  const startProgress = await client.state.getPoolQuoteTokenCurveProgress(pool);

  banner('Simulate curve -> graduation', cluster, {
    'pool': pool.toBase58(),
    'buyer': buyer.publicKey.toBase58(),
    'threshold': `${thresholdUsdc} USDC (on chain)`,
    'buy size': `${BUY_SIZE_USDC} USDC`,
    'max buys': String(MAX_BUYS),
    'start progress': `${(startProgress * 100).toFixed(2)}%`,
    'damm v2 config': dammConfig.toBase58(),
  });

  if (initial.poolState.isMigrated) {
    console.log('  Pool has already migrated. Nothing to do.\n');
    return;
  }

  if (!requireConfirm('--execute')) return;

  // --- Buy until the curve completes ---------------------------------------
  let progress = startProgress;

  for (let i = 1; progress < 1 && i <= MAX_BUYS; i++) {
    const virtualPool = await client.state.getPool(pool);
    if (!virtualPool) throw new Error('Pool not found.');

    const currentPoint =
      config.activationType === ActivationType.Slot
        ? new BN(await connection.getSlot())
        : new BN(Math.floor(Date.now() / 1000));

    const amountIn = new BN(BUY_SIZE_USDC * 10 ** USDC_DECIMALS);

    // PartialFill matters on the last buy: an ExactIn that would overshoot the
    // migration threshold fails outright, so a naive loop stalls one buy short
    // of graduating and looks like a config bug.
    const quote = client.pool.swapQuote2({
      virtualPool,
      config,
      swapBaseForQuote: false,
      swapMode: SwapMode.PartialFill,
      amountIn,
      slippageBps: 200,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
    });

    // minimumAmountOut is optional on SwapQuote2Result (ExactOut quotes return
    // maximumAmountIn instead), so fall back to 0 rather than sending undefined.
    const minimumAmountOut = quote.minimumAmountOut ?? new BN(0);

    const tx = await client.pool.swap2({
      owner: buyer.publicKey,
      payer: buyer.publicKey,
      pool,
      swapBaseForQuote: false,
      swapMode: SwapMode.PartialFill,
      amountIn,
      minimumAmountOut,
      referralTokenAccount: null,
    });
    tx.feePayer = buyer.publicKey;

    const signature = await sendAndConfirmTransaction(connection, tx, [buyer], {
      commitment: 'confirmed',
    });

    progress = await client.state.getPoolQuoteTokenCurveProgress(pool);
    console.log(
      `  buy ${String(i).padStart(2)} : ${BUY_SIZE_USDC} USDC -> ` +
        `${(progress * 100).toFixed(2)}%  ${signature.slice(0, 16)}…`,
    );
  }

  if (progress < 1) {
    console.log('\n  Curve did NOT reach the threshold within the buy budget.');
    console.log('  Raise SIM_MAX_BUYS, or check migrationQuoteThreshold in dbc.ts.\n');
    process.exitCode = 1;
    return;
  }
  console.log('\n  Curve complete.');

  // --- Migrate to DAMM v2 ----------------------------------------------------
  await assertAccountExists(connection, dammConfig, 'DAMM v2 config');

  console.log('  migrating to DAMM v2…');
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
    await client.migration.migrateToDammV2({
      payer: buyer.publicKey,
      pool,
      dammConfig,
    });
  transaction.feePayer = buyer.publicKey;

  // The migration mints two position NFTs, and each fresh mint must sign.
  const migrateSig = await sendAndConfirmTransaction(
    connection,
    transaction,
    [buyer, firstPositionNftKeypair, secondPositionNftKeypair],
    { commitment: 'confirmed' },
  );
  console.log(`  migrated       : ${migrateSig}`);

  // --- Verify on chain, don't just trust a confirmed signature --------------
  const after = await client.state.getPool(pool);
  const dammPool = deriveDammV2PoolAddress(dammConfig, after!.poolState.baseMint, config.quoteMint);
  const dammPoolExists = Boolean(await connection.getAccountInfo(dammPool));

  console.log(`  isMigrated     : ${Boolean(after?.poolState.isMigrated)}`);
  console.log(`  damm v2 pool   : ${dammPool.toBase58()} (${dammPoolExists ? 'exists' : 'MISSING'})\n`);

  if (!after?.poolState.isMigrated || !dammPoolExists) {
    console.log('  Migration transaction confirmed but the pool state does not reflect it.\n');
    process.exitCode = 1;
    return;
  }
  console.log('  Graduation verified end to end. Config is safe to reuse on mainnet.\n');
}

main().catch(fail);
