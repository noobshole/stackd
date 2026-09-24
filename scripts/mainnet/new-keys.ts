/**
 * Generate the mainnet treasury and launch payer keys, and switch
 * apps/api/.env to mainnet.
 *
 *   npm run mainnet:keys              # dry run: shows what it would change
 *   npm run mainnet:keys -- --execute
 *
 * Unlike `dbc:keygen`, this never prints a secret. The secrets go straight into
 * apps/api/.env via writeEnvVars, and only the two public addresses are shown —
 * so this is safe to run in a shared terminal or an agent session, which is the
 * whole reason it exists (see BURNED_PUBKEYS for what happens otherwise).
 *
 * Devnet keys are deliberately NOT reused. A keypair works on every cluster, so
 * reuse is possible, but a devnet secret has been through faucets, test scripts
 * and terminal scrollback; the moment its address holds real money, every past
 * careless moment becomes a live drain. Fresh keys make devnet mistakes free.
 *
 * Refuses to run twice: regenerating over a funded mainnet treasury would leave
 * real funds in an address whose secret no longer exists anywhere.
 */

import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { parse as parseEnv } from 'dotenv';
import { API_ENV_PATH, banner, fail, requireConfirm, writeEnvVars } from '../dbc/_shared.js';

/**
 * Values tied to the old cluster. A devnet mint or pool address left in place
 * under SOLANA_CLUSTER=mainnet is worse than a blank one: the API would price
 * and pay the bonus leg against a token that does not exist on mainnet. Blank
 * disables the bonus leg cleanly until genesis fills these in.
 */
const CLUSTER_SCOPED = [
  'STACKD_MINT',
  'DBC_POOL_ADDRESS',
  'DBC_CONFIG_ADDRESS',
  // Only read on devnet (resolveMigrationThresholdUsdc), but leaving a 20 USDC
  // graduation threshold in a mainnet .env invites misreading it as live.
  'SIM_THRESHOLD_OVERRIDE_USDC',
] as const;

function main(): void {
  if (!fs.existsSync(API_ENV_PATH)) {
    throw new Error(`${API_ENV_PATH} does not exist. Copy .env.example to it first.`);
  }

  // Parse the file rather than trusting process.env: the shell (or a desktop
  // app that spawned us) may export SOLANA_CLUSTER, and dotenv will not
  // override it, so process.env can disagree with the file we are about to edit.
  const fileEnv = parseEnv(fs.readFileSync(API_ENV_PATH));
  const from = (fileEnv.SOLANA_CLUSTER ?? 'devnet').trim().toLowerCase();
  const force = process.argv.includes('--force');

  if (from === 'mainnet' && !force) {
    throw new Error(
      [
        'apps/api/.env is already on mainnet, so the treasury key it holds may be funded.',
        'Generating new keys would abandon whatever that address holds — the secret',
        'would be overwritten and the funds unreachable.',
        '',
        'If you are certain the current mainnet keys are empty and unused:',
        '  npm run mainnet:keys -- --execute --force',
      ].join('\n'),
    );
  }

  const backup = `${API_ENV_PATH}.${from}`;
  if (fs.existsSync(backup) && !force) {
    throw new Error(
      `${backup} already exists; refusing to overwrite a backup. ` +
        'Move it aside, or re-run with --force if it is stale.',
    );
  }

  banner('Mainnet keys', 'mainnet', {
    'env file': API_ENV_PATH,
    'backup to': backup,
    'switching': `SOLANA_CLUSTER ${from} -> mainnet, DBC_CLUSTER -> mainnet`,
    'generating': 'TREASURY_PRIVATE_KEY, DBC_PAYER_PRIVATE_KEY (written, never printed)',
    'clearing': CLUSTER_SCOPED.join(', '),
  });

  if (!requireConfirm('--execute')) return;

  fs.copyFileSync(API_ENV_PATH, backup);

  const treasury = Keypair.generate();
  const payer = Keypair.generate();

  writeEnvVars({
    SOLANA_CLUSTER: 'mainnet',
    // Arms the launch scripts for mainnet. They still refuse until
    // DBC_ALLOW_MAINNET is set, which is the deliberate gate on genesis.
    DBC_CLUSTER: 'mainnet',
    TREASURY_PRIVATE_KEY: bs58.encode(treasury.secretKey),
    TREASURY_PUBLIC_KEY: treasury.publicKey.toBase58(),
    DBC_PAYER_PRIVATE_KEY: bs58.encode(payer.secretKey),
    // The bonus leg pays from the treasury; health warns if these disagree.
    STACKD_VAULT_PUBLIC_KEY: treasury.publicKey.toBase58(),
    ...Object.fromEntries(CLUSTER_SCOPED.map((key) => [key, ''])),
  });

  const treasuryPub = treasury.publicKey.toBase58();
  const payerPub = payer.publicKey.toBase58();

  console.log(`  Wrote ${API_ENV_PATH} (devnet copy kept at ${backup}).`);
  console.log('');
  console.log('  Fund these two — public addresses, safe to share:');
  console.log('');
  console.log(`    treasury  ${treasuryPub}`);
  console.log('              ~0.15 SOL (fees + token accounts) and $5-10 of MCDx.');
  console.log('              Pays every cashback. Its secret sits on Railway, so');
  console.log('              keep only the pilot float here.');
  console.log('');
  console.log(`    payer     ${payerPub}`);
  console.log('              ~0.1 SOL. Creates the $STACKD pool at genesis and');
  console.log('              claims its trading fees. Stays local, never on Railway.');
  console.log('');
  console.log('  Then:');
  console.log('    1. Set STACKD_TEAM_ADDRESS to your own wallet address (Phantom or a');
  console.log('       Squads vault). It receives the 15% leftover and is fixed forever');
  console.log('       at genesis. The app never signs with it.');
  console.log('    2. Paste TREASURY_PRIVATE_KEY and TREASURY_PUBLIC_KEY into Railway.');
  console.log('    3. npm run mainnet:check');
  console.log('');
  console.log('  To go back to devnet: copy the backup over apps/api/.env.');
  console.log('');
}

try {
  main();
} catch (error) {
  fail(error);
}
