/**
 * TASK 1 + 2 — $STACKD genesis and DBC pool creation.
 *
 * These are one step, not two. The DBC program initialises the base mint and
 * mints the entire supply into its own vault when the pool is created, so there
 * is no separate genesis mint to run first. See the header of
 * packages/solana/src/dbc.ts for why a three-way pre-split is not
 * expressible here and what replaces it.
 *
 * Supply, as configured:
 *   leftover  15%  -> leftoverReceiver (team wallet), claimable AFTER migration
 *   migration 20%  -> seeded into the DAMM v2 pool at graduation
 *   curve     65%  -> sold on the bonding curve
 *
 * Mint authority: TokenAuthorityOption.Immutable. No mint instruction exists
 * after this runs, from any code path, ever — the no-minting requirement
 * expressed as config rather than as a burn step someone could forget.
 *
 *   npm run dbc:launch              # dry run, prints everything
 *   npm run dbc:launch -- --execute # actually sends
 */

import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  MIGRATION_QUOTE_THRESHOLD_USDC,
  PERCENTAGE_SUPPLY_ON_MIGRATION,
  STACKD_TOTAL_SUPPLY,
  TEAM_LEFTOVER_PERCENTAGE,
  USDC_MINT,
  buildStackdCurveConfig,
  deriveStackdPoolAddress,
  getDbcClient,
} from '../../packages/solana/src/dbc.js';
import {
  assertFunded,
  banner,
  getConnection,
  loadKeypair,
  loadOrCreateKeypair,
  requireConfirm,
  resolveCluster,
} from './_shared.js';

async function main(): Promise<void> {
  const cluster = resolveCluster();
  const connection = getConnection(cluster);

  // The payer is both partner (config owner, fee claimer) and pool creator.
  const payer = loadKeypair('DBC_PAYER_PRIVATE_KEY');
  const team = loadOrCreateKeypair('STACKD_TEAM_PRIVATE_KEY', 'team/liquidity keypair');

  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const quoteMint = USDC_MINT[cluster];

  const pool = deriveStackdPoolAddress(
    quoteMint,
    baseMint.publicKey.toBase58(),
    config.publicKey.toBase58(),
  );

  banner('$STACKD genesis + DBC pool', cluster, {
    'payer': payer.publicKey.toBase58(),
    'config': config.publicKey.toBase58(),
    'base mint': baseMint.publicKey.toBase58(),
    'quote (USDC)': quoteMint,
    'pool': pool.toBase58(),
    'team/leftover': team.publicKey.toBase58(),
    'total supply': STACKD_TOTAL_SUPPLY.toLocaleString('en-US'),
    'leftover': `${TEAM_LEFTOVER_PERCENTAGE}%`,
    'on migration': `${PERCENTAGE_SUPPLY_ON_MIGRATION}%`,
    'graduates at': `${MIGRATION_QUOTE_THRESHOLD_USDC} USDC`,
    'mint authority': 'Immutable (no future minting, ever)',
  });

  await assertFunded(connection, payer.publicKey);
  requireConfirm('--execute');

  const client = getDbcClient(connection);
  const curveConfig = buildStackdCurveConfig();

  // --- 1. Config -----------------------------------------------------------
  console.log('  creating config…');
  const configTx = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: team.publicKey,
    payer: payer.publicKey,
    quoteMint: quoteMint as unknown as never,
    ...curveConfig,
  });
  configTx.feePayer = payer.publicKey;

  const configSig = await sendAndConfirmTransaction(connection, configTx, [payer, config], {
    commitment: 'confirmed',
  });
  console.log(`  config created : ${configSig}`);

  // --- 2. Pool (this is the genesis mint) ----------------------------------
  console.log('  creating pool…');
  const poolTx = await client.creator.createPool({
    baseMint: baseMint.publicKey,
    config: config.publicKey,
    name: 'Stackd',
    symbol: 'STACKD',
    uri: process.env.STACKD_METADATA_URI ?? 'https://stackd-web-eosin.vercel.app/token.json',
    payer: payer.publicKey,
    poolCreator: payer.publicKey,
  });
  poolTx.feePayer = payer.publicKey;

  const poolSig = await sendAndConfirmTransaction(connection, poolTx, [payer, baseMint], {
    commitment: 'confirmed',
  });
  console.log(`  pool created   : ${poolSig}\n`);

  console.log('  Add these to apps/api/.env:\n');
  console.log(`    STACKD_MINT=${baseMint.publicKey.toBase58()}`);
  console.log(`    STACKD_DECIMALS=6`);
  console.log(`    DBC_CONFIG_ADDRESS=${config.publicKey.toBase58()}`);
  console.log(`    DBC_POOL_ADDRESS=${pool.toBase58()}`);
  console.log('');
  console.log('  The Rewards Vault is still EMPTY. It has no genesis allocation —');
  console.log('  fund it with scripts/dbc/claim-fees.ts once the curve has traded,');
  console.log('  or the bonus leg will keep pausing (which is safe, by design).\n');
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
