/**
 * Dual-leg reward engine.
 *
 *   Leg 1 — xStock (Token-2022, scaled-UI multiplier). Always attempted.
 *   Leg 2 — STACKD bonus (legacy SPL, no multiplier). Best effort; a paused
 *           vault returns null and is NOT an error.
 *
 * The two legs are deliberately separate code paths. They use different token
 * programs, and the moment you share a "generic transfer" helper between them
 * someone passes TOKEN_PROGRAM_ID to an xStock ATA derivation and the payout
 * lands at an address the user's wallet never reads.
 *
 * All Token-2022 amount handling routes through resolveMultiplier/toRawAmount
 * in scaled-amount.ts. Do not recompute raw amounts here.
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { BRAND_BY_MINT } from './brands';
import { fetchXStockPrices } from './prices';
import { fetchScaledUiAmountState, toRawAmount } from './scaled-amount';
import { getConnection, getTreasuryKeypair } from './treasury';
import {
  getDbcQuotePrice,
  getStackdConfig,
  getVaultBalance,
  type StackdConfig,
} from './stackd';
import { defaultReceiptStore, type ReceiptStore } from './receipt-store';

/** Priority fee, per the project spec. */
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000;

export class RewardError extends Error {}

// ---------------------------------------------------------------------------
// Pure amount math — no network, no mocks needed to test.
// ---------------------------------------------------------------------------

export interface RewardAmount {
  /** Cashback in USD. */
  rewardUsd: number;
  /** Displayed share quantity the user should see. */
  tokenAmount: number;
  /** Base units actually moved on chain. */
  rawAmount: bigint;
}

/**
 * Turn a spend into an on-chain amount.
 *
 * The multiplier step is the one that bites: a scaled-UI mint shows
 * `raw / 10^decimals * multiplier`, so delivering `tokenAmount` means sending
 * `tokenAmount / multiplier * 10^decimals` base units. NFLXx sits at multiplier
 * 10, where skipping the division overpays by exactly 10x.
 */
export function computeRewardAmount(opts: {
  spendUsd: number;
  pctBack: number;
  price: number;
  decimals: number;
  multiplier: number;
}): RewardAmount {
  const { spendUsd, pctBack, price, decimals, multiplier } = opts;

  if (!Number.isFinite(spendUsd) || spendUsd <= 0) {
    throw new RewardError(`Invalid spendUsd: ${spendUsd}`);
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new RewardError(`Invalid price: ${price}`);
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RewardError(`Invalid multiplier: ${multiplier}`);
  }

  const rewardUsd = (spendUsd * pctBack) / 100;
  const tokenAmount = rewardUsd / price;
  const rawAmount = toRawAmount(tokenAmount, decimals, multiplier);

  if (rawAmount <= BigInt(0)) {
    throw new RewardError(
      `Reward rounds to zero base units (${rewardUsd} USD at ${price}/share).`,
    );
  }

  return { rewardUsd, tokenAmount, rawAmount };
}

// ---------------------------------------------------------------------------
// Leg 1 — xStock (Token-2022)
// ---------------------------------------------------------------------------

export interface SendXStockRewardParams {
  recipientWallet: string;
  /** Must be one of the configured brand mints. */
  xstockMint: string;
  spendUsd: number;
  pctBack: number;
  /** Idempotency key. */
  receiptId: string;
}

export interface XStockRewardDeps {
  store: ReceiptStore;
  connection: Connection;
  treasury: Keypair;
  /** Same dual-source resolution the portfolio page uses. */
  fetchPrices: typeof fetchXStockPrices;
  fetchScaledState: typeof fetchScaledUiAmountState;
  /** Injected so tests never touch the chain. */
  submit: typeof submitToken2022Transfer;
}

function xstockDeps(overrides?: Partial<XStockRewardDeps>): XStockRewardDeps {
  return {
    store: overrides?.store ?? defaultReceiptStore,
    connection: overrides?.connection ?? (overrides?.submit ? (null as never) : getConnection()),
    treasury: overrides?.treasury ?? (overrides?.submit ? (null as never) : getTreasuryKeypair()),
    fetchPrices: overrides?.fetchPrices ?? fetchXStockPrices,
    fetchScaledState: overrides?.fetchScaledState ?? fetchScaledUiAmountState,
    submit: overrides?.submit ?? submitToken2022Transfer,
  };
}

/**
 * Pay the xStock leg. Returns the transaction signature.
 *
 * Idempotent on `receiptId`: a receipt that already carries a signature returns
 * that signature without sending anything.
 */
export async function sendXStockReward(
  params: SendXStockRewardParams,
  overrides?: Partial<XStockRewardDeps>,
): Promise<string> {
  const deps = xstockDeps(overrides);
  const { receiptId, xstockMint, recipientWallet, spendUsd, pctBack } = params;

  // 1. Idempotency — already paid?
  const existing = await deps.store.get(receiptId);
  if (!existing) throw new RewardError(`No receipt found with id ${receiptId}`);
  if (existing.txSignature) return existing.txSignature;

  const brand = BRAND_BY_MINT[xstockMint];
  if (!brand) throw new RewardError(`${xstockMint} is not a configured xStock mint.`);

  const claimed = await deps.store.claimLeg(receiptId, 'xstock');
  if (!claimed) {
    // Another caller either finished or is mid-flight. Re-read rather than send.
    const current = await deps.store.get(receiptId);
    if (current?.txSignature) return current.txSignature;
    throw new RewardError(`A payout for receipt ${receiptId} is already in flight.`);
  }

  try {
    // 2-3. Price via the shared dual-source path (Jupiter, then underlying).
    const prices = await deps.fetchPrices([xstockMint]);
    const price = prices[xstockMint]?.usd;
    if (price == null) {
      throw new RewardError(`No price available for ${brand.ticker}; refusing to guess.`);
    }

    // 4-5. Amount, via the shared multiplier helpers.
    const mint = new PublicKey(xstockMint);
    const { multiplier } = await deps.fetchScaledState(deps.connection, mint);
    const { tokenAmount, rawAmount } = computeRewardAmount({
      spendUsd,
      pctBack,
      price,
      decimals: brand.decimals,
      multiplier,
    });

    await deps.store.recordXStockAmount(receiptId, tokenAmount);

    // 6-7. ATA, transfer, confirm.
    const signature = await deps.submit({
      connection: deps.connection,
      treasury: deps.treasury,
      mint,
      recipient: new PublicKey(recipientWallet),
      rawAmount,
      decimals: brand.decimals,
    });

    await deps.store.recordPayout(receiptId, 'xstock', signature);
    return signature;
  } catch (error) {
    // Free the claim so the user can retry.
    await deps.store.releaseLeg(receiptId, 'xstock');
    throw error;
  }
}

/**
 * Token-2022 transfer, creating the recipient ATA in the same transaction when
 * it does not exist yet.
 */
export async function submitToken2022Transfer(args: {
  connection: Connection;
  treasury: Keypair;
  mint: PublicKey;
  recipient: PublicKey;
  rawAmount: bigint;
  decimals: number;
}): Promise<string> {
  const { connection, treasury, mint, recipient, rawAmount, decimals } = args;

  const source = getAssociatedTokenAddressSync(
    mint,
    treasury.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destination = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    }),
  ];

  let destinationExists = true;
  try {
    await getAccount(connection, destination, 'confirmed', TOKEN_2022_PROGRAM_ID);
  } catch {
    destinationExists = false;
  }

  if (!destinationExists) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey, // treasury pays the rent
        destination,
        recipient,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  // transferChecked, not transfer: it validates the mint and decimals on chain,
  // which is the cheap guard against sending against the wrong mint.
  instructions.push(
    createTransferCheckedInstruction(
      source,
      mint,
      destination,
      treasury.publicKey,
      rawAmount,
      decimals,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: treasury.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([treasury]);

  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return signature;
}

// ---------------------------------------------------------------------------
// Leg 2 — STACKD bonus (legacy SPL). Optional by design.
// ---------------------------------------------------------------------------

export interface SendStackdBonusParams {
  recipientWallet: string;
  spendUsd: number;
  /** Fractional rate, e.g. 0.02 for 2%. Note: NOT a percentage like pctBack. */
  bonusRate: number;
  receiptId: string;
}

export interface StackdBonusDeps {
  store: ReceiptStore;
  connection: Connection;
  treasury: Keypair;
  config: StackdConfig | null;
  quotePrice: typeof getDbcQuotePrice;
  vaultBalance: typeof getVaultBalance;
  submit: typeof submitLegacyTransfer;
}

function bonusDeps(overrides?: Partial<StackdBonusDeps>): StackdBonusDeps {
  const offline = Boolean(overrides?.submit);
  return {
    store: overrides?.store ?? defaultReceiptStore,
    connection: overrides?.connection ?? (offline ? (null as never) : getConnection()),
    treasury: overrides?.treasury ?? (offline ? (null as never) : getTreasuryKeypair()),
    config: overrides?.config !== undefined ? overrides.config : getStackdConfig(),
    quotePrice: overrides?.quotePrice ?? getDbcQuotePrice,
    vaultBalance: overrides?.vaultBalance ?? getVaultBalance,
    submit: overrides?.submit ?? submitLegacyTransfer,
  };
}

/**
 * Pay the STACKD bonus leg.
 *
 * Returns null — not an error — when the vault is low or unconfigured. Callers
 * must treat null as an expected outcome and still report the xStock payout as
 * a success.
 */
export async function sendStackdBonus(
  params: SendStackdBonusParams,
  overrides?: Partial<StackdBonusDeps>,
): Promise<string | null> {
  const deps = bonusDeps(overrides);
  const { receiptId, recipientWallet, spendUsd, bonusRate } = params;

  // 1. Idempotency.
  const existing = await deps.store.get(receiptId);
  if (!existing) throw new RewardError(`No receipt found with id ${receiptId}`);
  if (existing.bonusTxSignature) return existing.bonusTxSignature;

  if (!deps.config) {
    console.warn('STACKD bonus vault low, pausing bonus leg (no STACKD_MINT configured)');
    return null;
  }

  const claimed = await deps.store.claimLeg(receiptId, 'bonus');
  if (!claimed) {
    const current = await deps.store.get(receiptId);
    return current?.bonusTxSignature ?? null;
  }

  try {
    // 2-4. Size the bonus. bonusRate is fractional, so no /100 here.
    const bonusUsd = spendUsd * bonusRate;
    const price = await deps.quotePrice();
    if (!Number.isFinite(price) || price <= 0) {
      console.warn('STACKD bonus vault low, pausing bonus leg (no usable price)');
      await deps.store.releaseLeg(receiptId, 'bonus');
      return null;
    }
    const bonusAmount = bonusUsd / price;

    // 5. Vault check — before any transaction is built.
    const balance = await deps.vaultBalance(
      deps.connection,
      deps.treasury.publicKey,
      deps.config,
    );
    if (balance < deps.config.minVaultBalance || balance < bonusAmount) {
      console.warn('STACKD bonus vault low, pausing bonus leg');
      await deps.store.releaseLeg(receiptId, 'bonus');
      return null;
    }

    // 6-7. Legacy SPL transfer.
    const rawAmount = BigInt(Math.round(bonusAmount * 10 ** deps.config.decimals));
    if (rawAmount <= BigInt(0)) {
      await deps.store.releaseLeg(receiptId, 'bonus');
      return null;
    }

    const signature = await deps.submit({
      connection: deps.connection,
      treasury: deps.treasury,
      mint: deps.config.mint,
      recipient: new PublicKey(recipientWallet),
      rawAmount,
      decimals: deps.config.decimals,
    });

    await deps.store.recordPayout(receiptId, 'bonus', signature);
    return signature;
  } catch (error) {
    await deps.store.releaseLeg(receiptId, 'bonus');
    // The bonus is best-effort: never let it fail the xStock payout.
    console.warn('STACKD bonus leg failed, continuing without it:', error);
    return null;
  }
}

/**
 * Legacy SPL transfer. No scaled-UI multiplier, no Token-2022 extensions.
 *
 * Kept separate from {@link submitToken2022Transfer} on purpose — see the note
 * at the top of this file.
 */
export async function submitLegacyTransfer(args: {
  connection: Connection;
  treasury: Keypair;
  mint: PublicKey;
  recipient: PublicKey;
  rawAmount: bigint;
  decimals: number;
}): Promise<string> {
  const { connection, treasury, mint, recipient, rawAmount, decimals } = args;

  const source = getAssociatedTokenAddressSync(mint, treasury.publicKey, false, TOKEN_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID);

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    }),
  ];

  let destinationExists = true;
  try {
    await getAccount(connection, destination, 'confirmed', TOKEN_PROGRAM_ID);
  } catch {
    destinationExists = false;
  }

  if (!destinationExists) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey,
        destination,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
      ),
    );
  }

  instructions.push(
    createTransferCheckedInstruction(
      source,
      mint,
      destination,
      treasury.publicKey,
      rawAmount,
      decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: treasury.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([treasury]);

  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return signature;
}

/** Solscan link for a signature, for the confirmation UI. */
export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}
