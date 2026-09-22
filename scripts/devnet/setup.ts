/**
 * Devnet setup for the end-to-end run. Devnet only, idempotent, dry run unless
 * --execute is passed.
 *
 *   1. Treasury keypair. Generated and written straight into apps/api/.env if
 *      TREASURY_PRIVATE_KEY is empty — the secret is never printed.
 *   2. SOL for the treasury (fees + recipient ATA rent), from the DBC payer.
 *   3. One Token-2022 stand-in per xStock. Backed and Backpack only deploy on
 *      mainnet, so each stand-in mirrors the real mint's decimals and live
 *      Scaled UI multiplier (read from mainnet), and the treasury is stocked
 *      with inventory. NFLXx's 10x multiplier makes this a real on-chain test
 *      of the raw-amount maths, not just a transfer.
 *   4. $STACKD into the treasury, which is what the bonus leg pays from.
 *   5. A little devnet USDC into the treasury, for the health check.
 *
 * Writes packages/solana/src/devnet-mints.ts.
 *
 *   npm run devnet:setup
 *   npm run devnet:setup -- --execute
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
} from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { BRANDS } from '../../packages/solana/src/brands.js';
import { DEVNET_MINTS } from '../../packages/solana/src/devnet-mints.js';
import { USDC_MINT } from '../../packages/solana/src/dbc.js';
import { fetchScaledUiAmountStates, toRawAmount } from '../../packages/solana/src/scaled-amount.js';
import {
  banner,
  fail,
  getConnection,
  loadKeypair,
  requireConfirm,
  requireKeypair,
  writeEnvVars,
} from '../dbc/_shared.js';

/** Treasury targets. Topped up to these, never beyond. */
const TREASURY_SOL = 0.5;
const INVENTORY_SHARES = 10; // displayed shares per xStock
const TREASURY_STACKD = 50_000_000;
const TREASURY_USDC = 5;
const STACKD_DECIMALS = 6;
const USDC_DECIMALS = 6;

const MINTS_FILE = path.resolve(__dirname, '../../packages/solana/src/devnet-mints.ts');

const explorer = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

async function rawBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  const info = await connection.getTokenAccountBalance(account).catch(() => null);
  return info ? BigInt(info.value.amount) : 0n;
}

async function send(connection: Connection, tx: Transaction, signers: Keypair[]) {
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
}

/** Top up a legacy-SPL balance from the payer to `target` whole tokens. */
async function topUpLegacy(opts: {
  connection: Connection;
  payer: Keypair;
  owner: PublicKey;
  mint: PublicKey;
  decimals: number;
  target: number;
  label: string;
}): Promise<void> {
  const { connection, payer, owner, mint, decimals, target, label } = opts;
  const unit = 10n ** BigInt(decimals);
  const from = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const to = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

  const have = await rawBalance(connection, to);
  const want = BigInt(target) * unit;
  if (have >= want) {
    console.log(`  ${label.padEnd(14)} ok (${Number(have / unit).toLocaleString('en-US')})`);
    return;
  }

  const need = want - have;
  const available = await rawBalance(connection, from);
  if (available < need) {
    throw new Error(
      `Payer has ${Number(available / unit)} ${label}, needs ${Number(need / unit)} to top up the treasury.`,
    );
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, owner, mint, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(from, mint, to, payer.publicKey, need, decimals, [], TOKEN_PROGRAM_ID),
  );
  const sig = await send(connection, tx, [payer]);
  console.log(`  ${label.padEnd(14)} +${Number(need / unit).toLocaleString('en-US')}  ${sig.slice(0, 16)}…`);
}

async function main(): Promise<void> {
  const devnet = getConnection('devnet');
  const mainnet = getConnection('mainnet'); // read-only: real decimals and multipliers
  const payer = requireKeypair('DBC_PAYER_PRIVATE_KEY', 'devnet funder for the setup');

  const stackdMint = process.env.STACKD_MINT?.trim();
  if (!stackdMint) throw new Error('STACKD_MINT is not set. Run dbc:launch first.');

  const hasTreasury = Boolean(process.env.TREASURY_PRIVATE_KEY?.trim());
  const existingTreasury = hasTreasury ? loadKeypair('TREASURY_PRIVATE_KEY') : null;

  // Real mint state, read once from mainnet.
  const realMints = BRANDS.map((b) => new PublicKey(b.mint));
  const multipliers = await fetchScaledUiAmountStates(mainnet, realMints);
  const real = await Promise.all(
    BRANDS.map(async (b) => {
      const info = await getMint(mainnet, new PublicKey(b.mint), 'confirmed', TOKEN_2022_PROGRAM_ID);
      if (info.decimals !== b.decimals) {
        throw new Error(`${b.ticker}: brands.ts says ${b.decimals} decimals, mainnet says ${info.decimals}.`);
      }
      return { brand: b, multiplier: multipliers.get(b.mint)?.multiplier ?? 1 };
    }),
  );

  banner('Devnet setup for the E2E run', 'devnet', {
    'payer': payer.publicKey.toBase58(),
    'treasury': existingTreasury?.publicKey.toBase58() ?? '(will be generated into .env)',
    'stand-ins': real.map((r) => `${r.brand.ticker}×${r.multiplier}`).join(' '),
    'targets': `${TREASURY_SOL} SOL, ${INVENTORY_SHARES} shares each, ${TREASURY_STACKD.toLocaleString('en-US')} STACKD, ${TREASURY_USDC} USDC`,
  });

  if (!requireConfirm('--execute')) return;

  // --- 1. Treasury ------------------------------------------------------------
  let treasury = existingTreasury;
  if (!treasury) {
    treasury = Keypair.generate();
    writeEnvVars({
      TREASURY_PRIVATE_KEY: bs58.encode(treasury.secretKey),
      TREASURY_PUBLIC_KEY: treasury.publicKey.toBase58(),
    });
    console.log(`  treasury       generated -> apps/api/.env (secret not printed)`);
  }
  console.log(`  treasury       ${treasury.publicKey.toBase58()}`);

  // --- 2. SOL -------------------------------------------------------------------
  const lamports = await devnet.getBalance(treasury.publicKey);
  const wantLamports = Math.round(TREASURY_SOL * 1e9);
  if (lamports < wantLamports * 0.8) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: treasury.publicKey,
        lamports: wantLamports - lamports,
      }),
    );
    await send(devnet, tx, [payer]);
  }
  console.log(`  SOL            ${(await devnet.getBalance(treasury.publicKey)) / 1e9}`);

  // --- 3. xStock stand-ins --------------------------------------------------
  const mints: Record<string, string> = {};
  for (const { brand, multiplier } of real) {
    let mintKey: PublicKey | null = null;
    const known = DEVNET_MINTS[brand.ticker];
    if (known && (await devnet.getAccountInfo(new PublicKey(known)))) {
      mintKey = new PublicKey(known);
    }

    if (!mintKey) {
      const mint = Keypair.generate();
      const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
      const rent = await devnet.getMinimumBalanceForRentExemption(space);
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: rent,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        // The extension must be initialised before the mint itself.
        createInitializeScaledUiAmountConfigInstruction(
          mint.publicKey,
          payer.publicKey,
          multiplier,
          TOKEN_2022_PROGRAM_ID,
        ),
        createInitializeMint2Instruction(
          mint.publicKey,
          brand.decimals,
          payer.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID,
        ),
      );
      await send(devnet, tx, [payer, mint]);
      mintKey = mint.publicKey;
    }
    mints[brand.ticker] = mintKey.toBase58();

    // Inventory, in displayed shares — so the raw amount goes through the
    // same toRawAmount the payout uses.
    const ata = getAssociatedTokenAddressSync(mintKey, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const have = await rawBalance(devnet, ata);
    const want = toRawAmount(INVENTORY_SHARES, brand.decimals, multiplier);
    if (have < want) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ata,
          treasury.publicKey,
          mintKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        createMintToCheckedInstruction(
          mintKey,
          ata,
          payer.publicKey,
          want - have,
          brand.decimals,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      );
      await send(devnet, tx, [payer]);
    }
    console.log(`  ${brand.ticker.padEnd(14)} ${mintKey.toBase58()}  ×${multiplier}`);
  }

  // Written before the token top-ups, so a later failure keeps the mints.
  const body = BRANDS.map((b) => `  ${b.ticker}: '${mints[b.ticker]}',`).join('\n');
  const source = fs.readFileSync(MINTS_FILE, 'utf8');
  fs.writeFileSync(
    MINTS_FILE,
    source.replace(
      /export const DEVNET_MINTS: Record<string, string> = \{[\s\S]*?\};/,
      `export const DEVNET_MINTS: Record<string, string> = {\n${body}\n};`,
    ),
  );
  console.log(`  wrote          packages/solana/src/devnet-mints.ts`);

  // --- 4-5. STACKD and USDC --------------------------------------------------
  await topUpLegacy({
    connection: devnet,
    payer,
    owner: treasury.publicKey,
    mint: new PublicKey(stackdMint),
    decimals: STACKD_DECIMALS,
    target: TREASURY_STACKD,
    label: 'STACKD',
  });
  await topUpLegacy({
    connection: devnet,
    payer,
    owner: treasury.publicKey,
    mint: new PublicKey(USDC_MINT.devnet),
    decimals: USDC_DECIMALS,
    target: TREASURY_USDC,
    label: 'USDC',
  });

  console.log(`\n  Treasury: ${explorer(treasury.publicKey.toBase58())}\n`);
}

main().catch(fail);
