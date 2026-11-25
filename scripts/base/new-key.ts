/**
 * Generate the Base treasury key and the receipt-memo secret.
 *
 *   npm run base:keys              # dry run: shows what it would change
 *   npm run base:keys -- --execute
 *
 * Never prints a secret. Both go straight into apps/api/.env; only the
 * treasury's public address is shown, so this is safe to run wherever terminal
 * output is logged or shared.
 *
 * A fresh EVM key, never derived from or shared with a Solana key.
 *
 * Refuses to replace either value once set:
 *   - a new treasury key over a funded one would strand whatever it holds;
 *   - a new memo secret would give the same receipt a different memo, so a
 *     repeat payout would no longer be visible onchain.
 */

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import { addressOfBaseKey, newBaseKey } from '@stackd/base/server';
import { API_ENV_PATH, fail, requireConfirm, writeEnvVars } from '../dbc/_shared.js';

const mask = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function main(): void {
  if (!fs.existsSync(API_ENV_PATH)) {
    throw new Error(`${API_ENV_PATH} does not exist. Copy .env.example to it first.`);
  }
  // The file, not process.env: the shell may export a stale value.
  const fileEnv = parseEnv(fs.readFileSync(API_ENV_PATH));
  const existingKey = fileEnv.BASE_TREASURY_PRIVATE_KEY?.trim();
  const existingSecret = fileEnv.BASE_MEMO_SECRET?.trim();

  console.log('\n  Base treasury key');
  console.log('  =================');
  console.log(`  env file       : ${API_ENV_PATH}`);

  if (existingKey) {
    console.log(`  treasury       : already set (${mask(addressOfBaseKey(existingKey))}), left as is`);
  } else {
    console.log('  treasury       : BASE_TREASURY_PRIVATE_KEY + BASE_TREASURY_ADDRESS (written, never printed)');
  }
  console.log(
    `  memo secret    : ${existingSecret ? 'already set, left as is' : 'BASE_MEMO_SECRET, 32 random bytes (written, never printed)'}`,
  );
  console.log('');

  if (existingKey && existingSecret) {
    console.log('  Nothing to do.\n');
    return;
  }
  if (!requireConfirm('--execute')) return;

  const values: Record<string, string> = {};
  let address: string | null = null;
  if (!existingKey) {
    const key = newBaseKey();
    values.BASE_TREASURY_PRIVATE_KEY = key.privateKey;
    values.BASE_TREASURY_ADDRESS = key.address;
    address = key.address;
  }
  if (!existingSecret) values.BASE_MEMO_SECRET = randomBytes(32).toString('hex');
  writeEnvVars(values);

  console.log('  Written to apps/api/.env.');
  if (address) {
    console.log(`  Treasury address: ${address}`);
    console.log('  Back up apps/api/.env before funding it: the secret exists nowhere else.');
  }
  console.log('  Payouts stay off until BASE_NETWORK is set (sepolia first).\n');
}

try {
  main();
} catch (error) {
  fail(error);
}
