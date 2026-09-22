/**
 * Shared setup for the DBC scripts.
 *
 * These scripts create a token with a permanently immutable supply and a live
 * trading pool. On mainnet that is irreversible — there is no "undo genesis".
 * So mainnet is refused unless explicitly unlocked, and every script prints the
 * network and the addresses it is about to touch before doing anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// The secrets live with the API in apps/api/.env, but `npm run` starts these
// scripts at the repo root. `dotenv/config` only reads ./.env, which does not
// exist there, so every variable silently came back unset.
export const API_ENV_PATH = path.resolve(__dirname, '../../apps/api/.env');
loadEnv({ path: API_ENV_PATH });

/**
 * Set variables in apps/api/.env in place (and in process.env). Existing keys
 * are replaced, new ones appended. Values are never logged — this is how a
 * script stores a generated secret without it ever reaching a terminal.
 */
export function writeEnvVars(values: Record<string, string>): void {
  let text = fs.readFileSync(API_ENV_PATH, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    // Function replacer: a `$` in the value must not be read as a pattern.
    text = pattern.test(text)
      ? text.replace(pattern, () => line)
      : `${text.replace(/\s*$/, '')}\n${line}\n`;
    process.env[key] = value;
  }
  fs.writeFileSync(API_ENV_PATH, text);
}

export type Cluster = 'devnet' | 'mainnet';

/** What genesis writes into the token, permanently (TokenAuthorityOption.Immutable). */
export const STACKD_TOKEN = {
  name: 'Stackd',
  symbol: 'STACKD',
  metadataUri:
    process.env.STACKD_METADATA_URI ?? 'https://stackd-web-eosin.vercel.app/token.json',
} as const;

/**
 * The metadata URI is written into the token at genesis, and with
 * TokenAuthorityOption.Immutable nobody holds update authority — it can never
 * be changed. A URI that 404s means a permanently nameless, logo-less token in
 * every wallet and on Meteora. So prove it resolves first: the JSON parses,
 * its name and symbol match what we mint, and its image loads.
 * Returns the problems found; empty means ready.
 */
export async function checkMetadata(): Promise<string[]> {
  const { name, symbol, metadataUri } = STACKD_TOKEN;
  const problems: string[] = [];
  let json: { name?: unknown; symbol?: unknown; image?: unknown };
  try {
    const res = await fetch(metadataUri, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [`${metadataUri} returned HTTP ${res.status}.`];
    json = (await res.json()) as typeof json;
  } catch (error) {
    return [`${metadataUri} could not be fetched as JSON: ${(error as Error).message}`];
  }

  if (json.name !== name) problems.push(`metadata name is "${json.name}", expected "${name}".`);
  if (json.symbol !== symbol) problems.push(`metadata symbol is "${json.symbol}", expected "${symbol}".`);

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

/**
 * Public keys whose secrets are known to have been exposed (pasted into chat,
 * a ticket, a screenshot). Safe on devnet, where the funds are worthless.
 * Refused on mainnet — anyone holding the secret could drain the wallet or
 * claim fees as the pool creator.
 *
 * Add to this list rather than relying on remembering.
 */
export const BURNED_PUBKEYS: ReadonlySet<string> = new Set<string>([
  // Payer secret pasted into a Claude Code session, 2026-09-17. Never funded,
  // zero transactions. Purged from .env; kept here so it can never come back.
  '8AhsYWhQpQ43xkMsNey1k3utvyCLuRyHVeDFKr8WJvab',
  // Team keypair auto-generated by a launch.ts dry run on 2026-09-17. Its
  // secret was printed to a terminal that ended up in the same transcript.
  'DnqLbDJLAhhvDLq7XmVc3jxirARcyEBsWh6aX4yF2sqQ',
]);

export function assertKeyUsableOn(key: Keypair | PublicKey, cluster: Cluster): void {
  const pubkey = (key instanceof Keypair ? key.publicKey : key).toBase58();
  if (cluster === 'mainnet' && BURNED_PUBKEYS.has(pubkey)) {
    throw new Error(
      [
        `Refusing to use ${pubkey} on mainnet.`,
        '',
        "This key's secret has been exposed in plain text, so anyone who has seen",
        'it can sign as this wallet — including claiming pool fees as the creator.',
        '',
        'Generate a fresh keypair for mainnet:  npm run dbc:keygen',
      ].join('\n'),
    );
  }
}

/** Parse an optional public address from an env var. Null when unset. */
export function optionalAddress(envVar: string): PublicKey | null {
  const raw = process.env[envVar]?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`${envVar} is not a valid Solana address.`);
  }
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

/**
 * Load a required keypair, failing with instructions rather than inventing one.
 *
 * This deliberately does NOT auto-generate. An earlier version did, and printed
 * the fresh secret on every dry run — which is exactly how a team keypair ended
 * up exposed. A script that casually prints secrets will eventually print one
 * somewhere it shouldn't; `dbc:keygen` is the one place that does it, on
 * purpose, when you ask.
 */
export function requireKeypair(envVar: string, role: string): Keypair {
  if (!process.env[envVar]?.trim()) {
    throw new Error(
      [
        `${envVar} is not set. It is the ${role}.`,
        '',
        'Create one and paste the secret into apps/api/.env:',
        `  npm run dbc:keygen -- ${envVar}`,
      ].join('\n'),
    );
  }
  return loadKeypair(envVar);
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

/**
 * Require an explicit confirmation flag for anything that spends or is permanent.
 * Returns false on a dry run; the caller returns instead of exiting.
 *
 * Never process.exit() in these scripts: on Node 24 / Windows, exiting while an
 * RPC keep-alive socket is closing trips a libuv assertion and crashes with
 * 0xC0000409 — after a perfectly good dry run.
 */
export function requireConfirm(flag: string): boolean {
  if (process.argv.includes(flag)) return true;
  console.log(`  Dry run. Re-run with ${flag} to execute.\n`);
  return false;
}

/** Report a failure and set a non-zero exit code without force-exiting. */
export function fail(error: unknown): void {
  console.error(`\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
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
