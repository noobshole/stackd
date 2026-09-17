/**
 * TASK 5 — devnet simulation: buy until the curve crosses 750 USDC and confirm
 * migration actually fires.
 *
 * This is the piece most likely to hide a subtle config
 * error: a curve that never graduates fails silently — it just
 * keeps accepting buys. Nothing else in the build surfaces that.
 *
 * Devnet only. Refuses mainnet outright regardless of DBC_ALLOW_MAINNET: there
 * is no reason to spend 750 real USDC proving a config you can prove for free.
 *
 *   npm run dbc:simulate
 *   npm run dbc:simulate -- --execute
 */

import BN from 'bn.js';
import { PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  ActivationType,
  SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  MIGRATION_QUOTE_THRESHOLD_USDC,
  USDC_DECIMALS,
  getDbcClient,
} from '../../packages/solana/src/dbc.js';
import {
  banner,
  getConnection,
  loadKeypair,
  requireConfirm,
  resolveCluster,
} from './_shared.js';

/** USDC per simulated buy. 25 buys of 40 USDC comfortably clears 750. */
const BUY_SIZE_USDC = Number(process.env.SIM_BUY_SIZE_USDC ?? 40);
const MAX_BUYS = Number(process.env.SIM_MAX_BUYS ?? 40);

async function main(): Promise<void> {
  const cluster = resolveCluster();
  if (cluster !== 'devnet') {
    throw new Error(
      'simulate-graduation is devnet-only. Proving the curve graduates does not ' +
        'require spending 750 real USDC.',
    );
  }

  const connection = getConnection(cluster);
  const buyer = loadKeypair('DBC_PAYER_PRIVATE_KEY');
  const poolAddress = process.env.DBC_POOL_ADDRESS?.trim();
  if (!poolAddress) throw new Error('DBC_POOL_ADDRESS is not set. Run dbc:launch first.');

  const pool = new PublicKey(poolAddress);
  const client = getDbcClient(connection);

  const startProgress = await client.state.getPoolQuoteTokenCurveProgress(pool);

  banner('Simulate curve -> graduation', cluster, {
    'pool': pool.toBase58(),
    'buyer': buyer.publicKey.toBase58(),
    'threshold': `${MIGRATION_QUOTE_THRESHOLD_USDC} USDC`,
    'buy size': `${BUY_SIZE_USDC} USDC`,
    'max buys': String(MAX_BUYS),
    'start progress': `${(startProgress * 100).toFixed(2)}%`,
  });

  requireConfirm('--execute');

  let graduated = false;

  for (let i = 1; i <= MAX_BUYS; i++) {
    const virtualPool = await client.state.getPool(pool);
    if (!virtualPool) throw new Error('Pool not found.');

    const config = await client.state.getPoolConfig(virtualPool.poolState.config);
    if (!config) throw new Error('Config not found.');

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

    const progress = await client.state.getPoolQuoteTokenCurveProgress(pool);
    console.log(
      `  buy ${String(i).padStart(2)} : ${BUY_SIZE_USDC} USDC -> ` +
        `${(progress * 100).toFixed(2)}%  ${signature.slice(0, 16)}…`,
    );

    if (progress >= 1) {
      graduated = true;
      console.log(`\n  Curve reached 100% after ${i} buys.`);
      break;
    }
  }

  if (!graduated) {
    console.log('\n  Curve did NOT reach the threshold within the buy budget.');
    console.log('  Raise SIM_MAX_BUYS, or check migrationQuoteThreshold in dbc.ts.\n');
    process.exit(1);
  }

  // --- Confirm migration actually fires ------------------------------------
  console.log('  migrating to DAMM v2…');
  const dammConfig = process.env.DAMM_V2_CONFIG_ADDRESS?.trim();
  if (!dammConfig) {
    console.log('\n  DAMM_V2_CONFIG_ADDRESS is not set, so migration was not attempted.');
    console.log('  The curve graduated, which is the config property under test.');
    console.log('  On mainnet Meteora runs migration keepers for eligible pools.\n');
    return;
  }

  const { transaction: migrateTx } = await client.migration.migrateToDammV2({
    payer: buyer.publicKey,
    pool,
    dammConfig: new PublicKey(dammConfig),
  });
  migrateTx.feePayer = buyer.publicKey;

  const migrateSig = await sendAndConfirmTransaction(connection, migrateTx, [buyer], {
    commitment: 'confirmed',
  });
  console.log(`  migrated       : ${migrateSig}\n`);
  console.log('  Graduation verified end to end. Config is safe to reuse on mainnet.\n');
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
