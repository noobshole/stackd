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
  resolveMigrationThresholdUsdc,
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
  fail,
  getConnection,
  optionalAddress,
  requireKeypair,
  requireConfirm,
  resolveCluster,
  assertKeyUsableOn,
} from './_shared.js';

const TOKEN_NAME = 'Stackd';
const TOKEN_SYMBOL = 'STACKD';
const METADATA_URI =
  process.env.STACKD_METADATA_URI ?? 'https://stackd-web-eosin.vercel.app/token.json';

/**
 * The metadata URI is written into the token at genesis, and with
 * TokenAuthorityOption.Immutable nobody holds update authority — it can never
 * be changed. A URI that 404s means a permanently nameless, logo-less token in
 * every wallet and on Meteora. So on mainnet, prove it resolves first: the
 * JSON parses, its name and symbol match what we mint, and its image loads.
 */
async function checkMetadata(): Promise<string[]> {
  const problems: string[] = [];
  let json: { name?: unknown; symbol?: unknown; image?: unknown };
  try {
    const res = await fetch(METADATA_URI, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [`${METADATA_URI} returned HTTP ${res.status}.`];
    json = (await res.json()) as typeof json;
  } catch (error) {
    return [`${METADATA_URI} could not be fetched as JSON: ${(error as Error).message}`];
  }

  if (json.name !== TOKEN_NAME) problems.push(`metadata name is "${json.name}", expected "${TOKEN_NAME}".`);
  if (json.symbol !== TOKEN_SYMBOL) problems.push(`metadata symbol is "${json.symbol}", expected "${TOKEN_SYMBOL}".`);

  if (typeof json.image !== 'string' || !json.image) {
    problems.push('metadata has no image URL.');
  } else {
    try {
      const img = await fetch(json.image, { signal: AbortSignal.timeout(10_000) });
      const type = img.headers.get('content-type') ?? '';
      if (!img.ok) problems.push(`image ${json.image} returned HTTP ${img.status}.`);
      else if (!type.startsWith('image/')) problems.push(`image ${json.image} is "${type}", not an image.`);
    } catch (error) {
      problems.push(`image ${json.image} could not be fetched: ${(error as Error).message}`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const cluster = resolveCluster();
  const connection = getConnection(cluster);

  // The payer creates the config and the pool, and pays for both.
  const payer = requireKeypair('DBC_PAYER_PRIVATE_KEY', 'config owner and pool creator');
  assertKeyUsableOn(payer, cluster);

  // Both receivers are fixed in the config forever. Neither ever signs —
  // withdraw_leftover is permissionless and partner fees are claimed by the
  // claimer — so a plain address is enough, which is what lets them be a
  // Squads multisig vault (a PDA with no private key).
  const team =
    optionalAddress('STACKD_TEAM_ADDRESS') ??
    requireKeypair(
      'STACKD_TEAM_PRIVATE_KEY',
      'team wallet that receives the 15% leftover after migration (or set STACKD_TEAM_ADDRESS)',
    ).publicKey;
  assertKeyUsableOn(team, cluster);
  const feeClaimer = optionalAddress('DBC_FEE_CLAIMER_ADDRESS') ?? payer.publicKey;
  assertKeyUsableOn(feeClaimer, cluster);

  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const quoteMint = USDC_MINT[cluster];

  const threshold = resolveMigrationThresholdUsdc(cluster);

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
    'team/leftover': team.toBase58(),
    'fee claimer': feeClaimer.toBase58(),
    'metadata': METADATA_URI,
    'total supply': STACKD_TOTAL_SUPPLY.toLocaleString('en-US'),
    'leftover': `${TEAM_LEFTOVER_PERCENTAGE}%`,
    'on migration': `${PERCENTAGE_SUPPLY_ON_MIGRATION}%`,
    'graduates at': `${threshold} USDC${threshold !== 750 ? '  (devnet override)' : ''}`,
    'mint authority': 'Immutable (no future minting, ever)',
  });

  const metadataProblems = await checkMetadata();
  if (metadataProblems.length > 0) {
    const list = metadataProblems.map((p) => `    - ${p}`).join('\n');
    if (cluster === 'mainnet') {
      throw new Error(
        `Refusing mainnet genesis: token metadata is not ready.\n${list}\n\n` +
          '  The URI is permanent once minted. Deploy token.json and its image first.',
      );
    }
    console.warn(`  WARNING (devnet, continuing): token metadata is not ready.\n${list}\n`);
  } else {
    console.log('  metadata       : ok (JSON, name, symbol and image all resolve)\n');
  }

  await assertFunded(connection, payer.publicKey);
  if (!requireConfirm('--execute')) return;

  const client = getDbcClient(connection);
  const curveConfig = buildStackdCurveConfig(cluster);

  // --- 1. Config -----------------------------------------------------------
  console.log('  creating config…');
  const configTx = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer,
    leftoverReceiver: team,
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
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: METADATA_URI,
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

main().catch(fail);
