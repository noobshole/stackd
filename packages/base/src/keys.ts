/**
 * Key generation for the Base treasury. SERVER ONLY, for scripts.
 *
 * Returns the secret to the caller, which writes it straight into
 * apps/api/.env. Nothing here prints or logs it.
 */

import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export function newBaseKey(): { privateKey: Hex; address: Address } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

/** The public address of a 0x-prefixed private key. */
export function addressOfBaseKey(privateKey: string): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey.trim())) {
    throw new Error('Not a Base private key: expected 0x followed by 64 hex characters.');
  }
  return privateKeyToAccount(privateKey.trim() as Hex).address;
}
