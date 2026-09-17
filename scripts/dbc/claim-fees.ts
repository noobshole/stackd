/**
 * TASK 4 — claim creator trading fees into the Rewards Vault.
 *
 * This is the vault's only automatic refill source (Part 2.5 item 1), and with
 * no genesis allocation possible it is the ONLY way the bonus leg ever becomes
 * payable. Run it manually for now; cron it later.
 *
 * Fees accrue in USDC (collectFeeMode: QuoteToken), so this claims USDC to the
 * vault. Converting that USDC into $STACKD for the vault to pay out is a
 * separate buy — see the note at the end of the run.
 *
 *   npm run dbc:claim-fees
 *   npm run dbc:claim-fees -- --execute
 */

import BN from 'bn.js';
import { PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { getDbcClient, USDC_DECIMALS } from '../../packages/solana/src/dbc.js';
import {
  banner,
  getConnection,
  loadKeypair,
  requireConfirm,
  resolveCluster,
} from './_shared.js';

const U64_MAX = '18446744073709551615';

async function main(): Promise<void> {
  const cluster = resolveCluster();
  const connection = getConnection(cluster);

  const creator = loadKeypair('DBC_PAYER_PRIVATE_KEY');
  const poolAddress = process.env.DBC_POOL_ADDRESS?.trim();
  const vaultAddress = process.env.STACKD_VAULT_PUBLIC_KEY?.trim();

  if (!poolAddress) throw new Error('DBC_POOL_ADDRESS is not set. Run dbc:launch first.');
  if (!vaultAddress) throw new Error('STACKD_VAULT_PUBLIC_KEY is not set.');

  const pool = new PublicKey(poolAddress);
  const vault = new PublicKey(vaultAddress);
  const client = getDbcClient(connection);

  // Read what is actually claimable before building anything.
  const breakdown = await client.state.getPoolFeeBreakdown(pool);
  const unclaimedQuote = Number(breakdown.creator.unclaimedQuoteFee.toString());
  const unclaimedUsdc = unclaimedQuote / 10 ** USDC_DECIMALS;
  const progress = await client.state.getPoolQuoteTokenCurveProgress(pool);

  banner('Claim creator fees -> Rewards Vault', cluster, {
    'pool': pool.toBase58(),
    'vault': vault.toBase58(),
    'claimable': `${unclaimedUsdc.toFixed(6)} USDC`,
    'curve progress': `${(progress * 100).toFixed(2)}% of graduation`,
  });

  if (unclaimedQuote <= 0) {
    console.log('  Nothing to claim yet — the curve has not earned fees.\n');
    return;
  }

  requireConfirm('--execute');

  const tx = await client.creator.claimCreatorTradingFeeToReceiver({
    creator: creator.publicKey,
    payer: creator.publicKey,
    pool,
    maxBaseAmount: new BN(U64_MAX),
    maxQuoteAmount: new BN(U64_MAX),
    receiver: vault,
  });
  tx.feePayer = creator.publicKey;

  const signature = await sendAndConfirmTransaction(connection, tx, [creator], {
    commitment: 'confirmed',
  });

  // Log the claim with the resulting vault balance, per the task spec.
  const after = await client.state.getPoolFeeBreakdown(pool);
  const remaining = Number(after.creator.unclaimedQuoteFee.toString()) / 10 ** USDC_DECIMALS;

  console.log(`  claimed        : ${unclaimedUsdc.toFixed(6)} USDC`);
  console.log(`  signature      : ${signature}`);
  console.log(`  still unclaimed: ${remaining.toFixed(6)} USDC\n`);
  console.log('  NOTE: this deposits USDC, not $STACKD. The bonus leg pays in');
  console.log('  $STACKD, so this USDC still has to buy $STACKD off the curve');
  console.log('  before sendStackdBonus() can pay anything.\n');
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
