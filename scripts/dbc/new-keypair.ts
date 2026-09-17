/**
 * Generate a Solana keypair for the DBC scripts.
 *
 * Exists so you don't need the Solana CLI installed. Prints the public key and
 * the base58 secret — paste the secret into apps/api/.env, fund the public key.
 *
 *   npm run dbc:keygen
 *   npm run dbc:keygen -- DBC_PAYER_PRIVATE_KEY
 *
 * The secret is printed to your terminal and nowhere else. Nothing is written
 * to disk, nothing is sent anywhere. If this is for mainnet, treat the output
 * like cash: don't paste it into chat, a ticket, or a screenshot.
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const envVar = process.argv[2] ?? 'DBC_PAYER_PRIVATE_KEY';
const kp = Keypair.generate();

console.log('');
console.log('  Generated a new Solana keypair');
console.log('  ==============================');
console.log('');
console.log(`  Public key (fund this one, safe to share):`);
console.log(`    ${kp.publicKey.toBase58()}`);
console.log('');
console.log(`  Secret (add to apps/api/.env — NEVER commit or paste anywhere):`);
console.log(`    ${envVar}=${bs58.encode(kp.secretKey)}`);
console.log('');
console.log('  Next:');
console.log('    1. Paste the line above into apps/api/.env');
console.log('    2. Fund the public key with devnet SOL:');
console.log(`       https://faucet.solana.com  (paste ${kp.publicKey.toBase58().slice(0, 8)}…)`);
console.log('    3. For the graduation sim you also need devnet USDC:');
console.log('       https://faucet.circle.com  (choose Solana Devnet)');
console.log('');
