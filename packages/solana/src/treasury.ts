/**
 * Treasury signing and the Helius connection. BACKEND ONLY.
 *
 * Nothing in apps/web may import this module. TREASURY_PRIVATE_KEY is read with
 * no NEXT_PUBLIC_ prefix, so Next would inline `undefined` rather than the key,
 * but the guard below makes the mistake loud instead of mysterious.
 */

import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

function assertServer(what: string): void {
  // `'window' in globalThis` rather than `typeof window` so this compiles under
  // the API's DOM-free lib as well as the browser-targeted web app.
  if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
    throw new Error(
      `${what} was reached from browser code. The treasury signer is backend-only.`,
    );
  }
}

let connection: Connection | null = null;

/** Helius mainnet connection. Never a public endpoint. */
export function getConnection(): Connection {
  assertServer('getConnection');
  if (connection) return connection;

  const url = process.env.HELIUS_RPC_URL;
  if (!url) {
    throw new Error('HELIUS_RPC_URL is not set. Refusing to fall back to a public endpoint.');
  }

  connection = new Connection(url, { commitment: 'confirmed' });
  return connection;
}

let treasury: Keypair | null = null;

/** Treasury signer, decoded from the base58 secret. */
export function getTreasuryKeypair(): Keypair {
  assertServer('getTreasuryKeypair');
  if (treasury) return treasury;

  const secret = process.env.TREASURY_PRIVATE_KEY;
  if (!secret) throw new Error('TREASURY_PRIVATE_KEY is not set.');

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secret.trim());
  } catch {
    throw new Error('TREASURY_PRIVATE_KEY is not valid base58.');
  }

  if (decoded.length !== 64) {
    throw new Error(
      `TREASURY_PRIVATE_KEY decoded to ${decoded.length} bytes; expected a 64-byte secret key.`,
    );
  }

  treasury = Keypair.fromSecretKey(decoded);

  // Catch a mismatched pair early rather than at signing time.
  const expected = process.env.TREASURY_PUBLIC_KEY?.trim();
  if (expected && treasury.publicKey.toBase58() !== expected) {
    throw new Error(
      'TREASURY_PRIVATE_KEY does not correspond to TREASURY_PUBLIC_KEY. Check the env pair.',
    );
  }

  return treasury;
}

/** Test seam — drops the memoised client and signer. */
export function __resetTreasury(): void {
  connection = null;
  treasury = null;
}
