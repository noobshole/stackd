/**
 * Shared setup for the DBC scripts.
 *
 * These scripts create a token with a permanently immutable supply and a live
 * trading pool. On mainnet that is irreversible — there is no "undo genesis".
 * So mainnet is refused unless explicitly unlocked, and every script prints the
 * network and the addresses it is about to touch before doing anything.
 */

import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export type Cluster = 'devnet' | 'mainnet';

export function resolveCluster(): Cluster {
  const raw = (process.env.DBC_CLUSTER ?? 'devnet').trim().toLowerCase();
  if (raw !== 'devnet' && raw !== 'mainnet') {
    throw new Error(`DBC_CLUSTER must be "devnet" or "mainnet", got "${raw}".`);
  }

  if (raw === 'mainnet' && process.env.DBC_ALLOW_MAINNET !== 'I_UNDERSTAND_THIS_IS_PERMANENT') {
    throw new Error(
      [
        'Refusing to run against mainnet.',
        '',
        'Genesis mints an immutable fixed supply and creates a real trading pool.',
        'It cannot be undone, re-split, or re-minted.',
        '',
        'Validate the full flow on devnet first (including graduation), then set:',
        '  DBC_ALLOW_MAINNET=I_UNDERSTAND_THIS_IS_PERMANENT',
      ].join('\n'),
    );
  }

  return raw;
}

export function getRpcUrl(cluster: Cluster): string {
  const url =
    cluster === 'devnet'
      ? process.env.HELIUS_DEVNET_RPC_URL
      : process.env.HELIUS_RPC_URL;

  if (!url) {
    throw new Error(
      `${cluster === 'devnet' ? 'HELIUS_DEVNET_RPC_URL' : 'HELIUS_RPC_URL'} is not set. ` +
        'Refusing to fall back to a public endpoint.',
    );
  }
  return url;
}

export function getConnection(cluster: Cluster): Connection {
  return new Connection(getRpcUrl(cluster), 'confirmed');
}

/** Load a base58 secret key from an env var. */
export function loadKeypair(envVar: string): Keypair {
  const secret = process.env[envVar]?.trim();
  if (!secret) throw new Error(`${envVar} is not set.`);

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secret);
  } catch {
    throw new Error(`${envVar} is not valid base58.`);
  }
  if (decoded.length !== 64) {
    throw new Error(`${envVar} decoded to ${decoded.length} bytes; expected 64.`);
  }
  return Keypair.fromSecretKey(decoded);
}

/** Load a keypair, or generate and print one if the env var is unset. */
export function loadOrCreateKeypair(envVar: string, label: string): Keypair {
  if (process.env[envVar]?.trim()) return loadKeypair(envVar);

  const kp = Keypair.generate();
  console.log(`\n  ⚠️  ${envVar} was not set. Generated a new ${label}:`);
  console.log(`      public  : ${kp.publicKey.toBase58()}`);
  console.log(`      secret  : ${bs58.encode(kp.secretKey)}`);
  console.log(`      Save BOTH to apps/api/.env as ${envVar} before continuing.\n`);
  return kp;
}

export function banner(title: string, cluster: Cluster, rows: Record<string, string>): void {
  console.log('');
  console.log(`  ${title}`);
  console.log(`  ${'='.repeat(title.length)}`);
  console.log(`  network        : ${cluster.toUpperCase()}`);
  for (const [k, v] of Object.entries(rows)) {
    console.log(`  ${k.padEnd(15)}: ${v}`);
  }
  console.log('');
}

/** Require an explicit confirmation flag for anything that spends or is permanent. */
export function requireConfirm(flag: string): void {
  if (!process.argv.includes(flag)) {
    console.log(`  Dry run. Re-run with ${flag} to execute.\n`);
    process.exit(0);
  }
}

export async function assertFunded(
  connection: Connection,
  payer: PublicKey,
  minSol = 0.05,
): Promise<void> {
  const lamports = await connection.getBalance(payer);
  const sol = lamports / 1e9;
  if (sol < minSol) {
    throw new Error(
      `Payer ${payer.toBase58()} holds ${sol.toFixed(4)} SOL; needs at least ${minSol}. ` +
        'Fund it before running.',
    );
  }
  console.log(`  payer balance  : ${sol.toFixed(4)} SOL\n`);
}
