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
  LAMPORTS_PER_SOL,
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

import { brandForMint } from './brands';
import { fetchXStockPrices } from './prices';
import { fetchScaledUiAmountState, toRawAmount } from './scaled-amount';
import { getConnection, getTreasuryKeypair } from './treasury';
import { getDbcQuotePrice } from './dbc';
import {
  getStackdConfig,
  getVaultBalance,
  type StackdConfig,
} from './stackd';
import { defaultReceiptStore, type ReceiptStore } from './receipt-store';

/** Priority fee, per the project spec. */
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000;

export class RewardError extends Error {}

/** Today's payout budget is spent. Nothing was sent; the receipt stays claimable. */
export class PayoutPausedError extends RewardError {}

/**
 * The transfer was sent but its outcome could not be established before we
 * gave up waiting. It may still land, so the claim is deliberately NOT released
 * — releasing it would let a retry send a second transfer. Reconcile manually
 * from the signature.
 */
export class PayoutUnconfirmedError extends RewardError {
  constructor(readonly signature: string) {
    super(`Transfer ${signature} was sent but not confirmed. Not retrying automatically.`);
  }
}

/**
 * Daily payout circuit breaker. Reserve before sending, release if the send
 * fails. Bounds the damage from anything that slips past verification — a
 * forged receipt, or a maths bug — to one day's cap.
 */
export interface PayoutBudget {
  /** Reserve `usd` against today's cap. False when it would exceed the cap. */
  reserve(usd: number): Promise<boolean>;
  release(usd: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Account rent — counted against the daily cap
// ---------------------------------------------------------------------------

/** Wrapped SOL; Jupiter prices it as SOL. */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Used only when SOL cannot be priced. Deliberately high: it sizes a safety
 * budget, so overstating it pauses payouts early rather than letting rent run
 * past the cap unseen.
 */
const SOL_USD_FALLBACK = 500;

/** A plain SPL token account, for when the treasury's own cannot be read. */
const FALLBACK_ACCOUNT_BYTES = 165;

const rentLamportsByBytes = new Map<number, number>();

/**
 * USD cost of opening the recipient's token account for `mint`, or 0 when it
 * already exists.
 *
 * The treasury pays that rent and never gets it back, and on a small receipt
 * it is more than the reward. So it counts against the daily cap: a cap that
 * measured only the cashback would miss the larger cost.
 *
 * An account's size depends on the extensions its mint requires, and every
 * associated token account for one mint is the same size — so the treasury's
 * own account for the mint gives the exact size on any cluster.
 */
export async function accountOpeningCostUsd(args: {
  connection: Connection;
  treasury: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  programId: PublicKey;
  fetchPrices?: typeof fetchXStockPrices;
}): Promise<number> {
  const { connection, treasury, recipient, mint, programId } = args;
  const ata = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);

  const [destination, source] = await connection.getMultipleAccountsInfo(
    [ata(recipient), ata(treasury)],
    'confirmed',
  );
  if (destination) return 0;

  const bytes = source?.data.length ?? FALLBACK_ACCOUNT_BYTES;
  let lamports = rentLamportsByBytes.get(bytes);
  if (lamports == null) {
    lamports = await connection.getMinimumBalanceForRentExemption(bytes);
    rentLamportsByBytes.set(bytes, lamports);
  }

  let solUsd: number | null = null;
  try {
    const prices = await (args.fetchPrices ?? fetchXStockPrices)([SOL_MINT]);
    solUsd = prices[SOL_MINT]?.usd ?? null;
  } catch {
    // Priced conservatively below: a price outage must not stop payouts.
  }
  if (solUsd == null || !Number.isFinite(solUsd) || solUsd <= 0) solUsd = SOL_USD_FALLBACK;

  return (lamports / LAMPORTS_PER_SOL) * solUsd;
}

/** Rent for a new account of `mint` owned by `recipient`; 0 when it exists. */
export type OpeningCost = (recipient: PublicKey, mint: PublicKey) => Promise<number>;

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
  /** Optional daily cap. Absent means uncapped (tests, scripts). */
  budget: PayoutBudget | null;
  /** New-account rent, reserved against the cap alongside the reward. */
  openingCostUsd: OpeningCost;
}

function xstockDeps(overrides?: Partial<XStockRewardDeps>): XStockRewardDeps {
  const offline = Boolean(overrides?.submit);
  const connection = overrides?.connection ?? (offline ? (null as never) : getConnection());
  const treasury = overrides?.treasury ?? (offline ? (null as never) : getTreasuryKeypair());
  const fetchPrices = overrides?.fetchPrices ?? fetchXStockPrices;
  return {
    store: overrides?.store ?? defaultReceiptStore,
    connection,
    treasury,
    fetchPrices,
    fetchScaledState: overrides?.fetchScaledState ?? fetchScaledUiAmountState,
    submit: overrides?.submit ?? submitToken2022Transfer,
    budget: overrides?.budget ?? null,
    // Offline (tests): no chain to ask, so no rent unless a test injects it.
    openingCostUsd:
      overrides?.openingCostUsd ??
      (offline
        ? async () => 0
        : (recipient, mint) =>
            accountOpeningCostUsd({
              connection,
              treasury: treasury.publicKey,
              recipient,
              mint,
              programId: TOKEN_2022_PROGRAM_ID,
              fetchPrices,
            })),
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

  const brand = brandForMint(xstockMint);
  if (!brand) throw new RewardError(`${xstockMint} is not a configured xStock mint.`);

  const claimed = await deps.store.claimLeg(receiptId, 'xstock');
  if (!claimed) {
    // Another caller either finished or is mid-flight. Re-read rather than send.
    const current = await deps.store.get(receiptId);
    if (current?.txSignature) return current.txSignature;
    throw new RewardError(`A payout for receipt ${receiptId} is already in flight.`);
  }

  // Budget reserved by THIS call, if any — only the caller holding the claim
  // reserves, so a double-clicked confirm cannot count one payout twice.
  let reservedUsd = 0;

  try {
    // 2-3. Price via the shared dual-source path (Jupiter, then underlying).
    // Always by the brand's mainnet mint: a devnet stand-in has no market of
    // its own, and pricing it as the real token keeps the maths identical.
    const prices = await deps.fetchPrices([brand.mint]);
    const price = prices[brand.mint]?.usd;
    if (price == null) {
      throw new RewardError(`No price available for ${brand.ticker}; refusing to guess.`);
    }

    // 4-5. Amount, via the shared multiplier helpers.
    const mint = new PublicKey(xstockMint);
    const { multiplier } = await deps.fetchScaledState(deps.connection, mint);
    const { rewardUsd, tokenAmount, rawAmount } = computeRewardAmount({
      spendUsd,
      pctBack,
      price,
      decimals: brand.decimals,
      multiplier,
    });

    // Circuit breaker, after the amount is known and before anything is sent.
    // It counts the rent for a new token account as well as the reward, since
    // on a small receipt the rent is the larger cost.
    if (deps.budget) {
      const openingUsd = await deps.openingCostUsd(new PublicKey(recipientWallet), mint);
      const costUsd = rewardUsd + openingUsd;
      if (!(await deps.budget.reserve(costUsd))) {
        throw new PayoutPausedError(
          "Stackd has reached today's payout limit. Your receipt is saved — claim it again tomorrow.",
        );
      }
      reservedUsd = costUsd;
    }

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
    // Sent but unconfirmed: it may still land. Keep both the claim and the
    // reserved budget, so a retry can neither resend nor overspend.
    if (error instanceof PayoutUnconfirmedError) throw error;

    // Otherwise nothing landed: free the budget and the claim so the user can retry.
    if (reservedUsd > 0 && deps.budget) await deps.budget.release(reservedUsd);
    await deps.store.releaseLeg(receiptId, 'xstock');
    throw error;
  }
}

/**
 * Send, then establish the outcome — never assume it.
 *
 * Two gaps this closes:
 *   - `confirmTransaction` RESOLVES (does not throw) when a transaction lands
 *     but fails on chain. Unchecked, a failed transfer was recorded as paid.
 *   - When confirmation itself throws (RPC hiccup, timeout), the transfer may
 *     still have landed. Treating that as "failed" frees the claim, and the
 *     user's retry sends a second payout. So ask the chain directly, until the
 *     blockhash expires — after which the transaction provably cannot land.
 */
export async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<string> {
  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });

  try {
    const { value } = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (value.err) {
      throw new RewardError(`Transfer ${signature} failed on chain: ${JSON.stringify(value.err)}`);
    }
    return signature;
  } catch (error) {
    if (error instanceof RewardError) throw error; // landed and failed: definitely not paid

    // Outcome unknown. Poll until it shows up or its blockhash expires.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const [status] = (
        await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      ).value;
      if (status?.err) {
        throw new RewardError(`Transfer ${signature} failed on chain: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return signature;
      }
      if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
        throw error; // expired unlanded: safe to retry
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new PayoutUnconfirmedError(signature);
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

  return sendAndConfirm(connection, tx, blockhash, lastValidBlockHeight);
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
  /** Optional daily cap, shared with the xStock leg. Absent means uncapped. */
  budget: PayoutBudget | null;
  /** New-account rent, reserved against the cap before sending. */
  openingCostUsd: OpeningCost;
}

function bonusDeps(overrides?: Partial<StackdBonusDeps>): StackdBonusDeps {
  const offline = Boolean(overrides?.submit);
  const connection = overrides?.connection ?? (offline ? (null as never) : getConnection());
  const treasury = overrides?.treasury ?? (offline ? (null as never) : getTreasuryKeypair());
  return {
    store: overrides?.store ?? defaultReceiptStore,
    connection,
    treasury,
    config: overrides?.config !== undefined ? overrides.config : getStackdConfig(),
    quotePrice: overrides?.quotePrice ?? getDbcQuotePrice,
    vaultBalance: overrides?.vaultBalance ?? getVaultBalance,
    submit: overrides?.submit ?? submitLegacyTransfer,
    budget: overrides?.budget ?? null,
    openingCostUsd:
      overrides?.openingCostUsd ??
      (offline
        ? async () => 0
        : (recipient, mint) =>
            accountOpeningCostUsd({
              connection,
              treasury: treasury.publicKey,
              recipient,
              mint,
              programId: TOKEN_PROGRAM_ID,
            })),
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

  // Rent reserved by this call, so a failed send can give it back.
  let reservedUsd = 0;

  try {
    // 2-4. Size the bonus. bonusRate is fractional, so no /100 here.
    const bonusUsd = spendUsd * bonusRate;
    // null means the curve could not be quoted (pool unset, RPC down, not yet
    // launched). Never substitute a guess — pause instead.
    // Pass the connection: left to default, the quote reads mainnet even when
    // the payout is running on devnet.
    const price = await deps.quotePrice(deps.connection);
    if (price == null || !Number.isFinite(price) || price <= 0) {
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

    // A new $STACKD account's rent counts against the daily cap, as on the
    // xStock leg. When the cap cannot cover it, the bonus pauses like any
    // other shortfall. (The bonus tokens themselves come from the vault,
    // which has its own floor in minVaultBalance.)
    if (deps.budget) {
      const openingUsd = await deps.openingCostUsd(new PublicKey(recipientWallet), deps.config.mint);
      if (openingUsd > 0) {
        if (!(await deps.budget.reserve(openingUsd))) {
          console.warn("STACKD bonus paused: today's payout budget cannot cover a new $STACKD account");
          await deps.store.releaseLeg(receiptId, 'bonus');
          return null;
        }
        reservedUsd = openingUsd;
      }
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
    // Sent but unconfirmed: keep the claim and the reserved rent, so a retry
    // can neither pay the bonus twice nor overspend.
    if (!(error instanceof PayoutUnconfirmedError)) {
      if (reservedUsd > 0 && deps.budget) await deps.budget.release(reservedUsd);
      await deps.store.releaseLeg(receiptId, 'bonus');
    }
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

  return sendAndConfirm(connection, tx, blockhash, lastValidBlockHeight);
}
