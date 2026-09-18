/**
 * Withdraw the 15% leftover bucket to the team wallet after migration.
 *
 * This is how Part 2.2's team/liquidity allocation actually arrives: DBC holds
 * the leftover in the pool's base vault until the curve has migrated, then
 * releases it — once — to the leftoverReceiver fixed in the config at launch.
 *
 * The instruction is permissionless. The payer only covers fees; the tokens
 * can only go to leftoverReceiver, so the team key never has to sign or hold
 * SOL. Safe to re-run: it stops if the leftover was already withdrawn.
 *
 *   npm run dbc:withdraw-leftover
 *   npm run dbc:withdraw-leftover -- --execute
 */

import { PublicKey, sendAndConfirmTransaction, type Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { STACKD_DECIMALS, getDbcClient } from '../../packages/solana/src/dbc.js';
import {
  banner,
  fail,
  getConnection,
  requireKeypair,
  requireConfirm,
  resolveCluster,
} from './_shared.js';

async function tokenBalance(connection: Connection, account: PublicKey): Promise<number> {
  const info = await connection.getTokenAccountBalance(account).catch(() => null);
  return info ? Number(info.value.amount) / 10 ** STACKD_DECIMALS : 0;
}

async function main(): Promise<void> {
  const cluster = resolveCluster();
  const connection = getConnection(cluster);
  const payer = requireKeypair('DBC_PAYER_PRIVATE_KEY', 'fee payer for the withdrawal');

  const poolAddress = process.env.DBC_POOL_ADDRESS?.trim();
  if (!poolAddress) throw new Error('DBC_POOL_ADDRESS is not set. Run dbc:launch first.');
  const pool = new PublicKey(poolAddress);

  const client = getDbcClient(connection);
  const virtualPool = await client.state.getPool(pool);
  if (!virtualPool) throw new Error(`Pool ${pool.toBase58()} not found.`);
  const config = await client.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error('Pool config not found.');

  const { baseMint, baseVault } = virtualPool.poolState;
  const receiver = config.leftoverReceiver;
  const receiverAta = getAssociatedTokenAddressSync(baseMint, receiver, true);

  const vaultBefore = await tokenBalance(connection, baseVault);
  const receiverBefore = await tokenBalance(connection, receiverAta);

  banner('Withdraw leftover -> team wallet', cluster, {
    'pool': pool.toBase58(),
    'receiver': receiver.toBase58(),
    'receiver ata': receiverAta.toBase58(),
    'vault holds': `${vaultBefore.toLocaleString('en-US')} STACKD`,
    'receiver has': `${receiverBefore.toLocaleString('en-US')} STACKD`,
  });

  if (!virtualPool.poolState.isMigrated) {
    throw new Error('Pool has not migrated yet. Leftover is only claimable after migration.');
  }
  if (virtualPool.poolState.isWithdrawLeftover) {
    console.log('  Leftover already withdrawn. Nothing to do.\n');
    return;
  }

  if (!requireConfirm('--execute')) return;

  const tx = await client.migration.withdrawLeftover({ payer: payer.publicKey, pool });
  tx.feePayer = payer.publicKey;

  const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
  });

  // Verify against chain state, not the signature.
  const after = await client.state.getPool(pool);
  const receiverAfter = await tokenBalance(connection, receiverAta);
  const received = receiverAfter - receiverBefore;

  console.log(`  signature      : ${signature}`);
  console.log(`  received       : ${received.toLocaleString('en-US')} STACKD`);
  console.log(`  receiver now   : ${receiverAfter.toLocaleString('en-US')} STACKD`);
  console.log(`  flag set       : ${Boolean(after?.poolState.isWithdrawLeftover)}\n`);

  if (!after?.poolState.isWithdrawLeftover || received <= 0) {
    console.log('  Withdrawal confirmed but chain state does not reflect it.\n');
    process.exitCode = 1;
  }
}

main().catch(fail);
