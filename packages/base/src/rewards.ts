/**
 * The Base payout: one B20 stock transfer, with a memo, per verified receipt.
 * SERVER ONLY.
 *
 * Same contract as the Solana xStock leg (packages/solana/src/rewards.ts):
 * idempotent on the receipt, one claim per leg, the daily budget reserved
 * before sending and released only when nothing can have landed.
 *
 * Order of checks, before anything is signed:
 *   1. the issuer has not paused transfers, and no multiplier change is near;
 *   2. the issuer's policies let the treasury send and the recipient receive;
 *   3. two price sources agree (prices.ts);
 *   4. the treasury holds enough, and today's budget has room.
 * Then simulate, sign, record the hash, broadcast, and wait for the receipt.
 */

import {
  BaseError,
  concatHex,
  encodeFunctionData,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';

import { b20Abi } from './abi';
import { parseBaseAddress } from './address';
import { computeB20Reward } from './amount';
import { builderCodeSuffix } from './attribution';
import { readTokenState, type TokenState } from './chain';
import { B20PayoutPausedError, B20PayoutUnconfirmedError, B20RewardError } from './errors';
import { receiptMemo } from './memo';
import type { BaseNetwork } from './network';
import {
  corporateActionNear,
  feedPriceUsd,
  guardedPriceUsd,
  readFeedRound,
  tokenPriceFromUnderlying,
  type FeedRound,
} from './prices';
import { baseStock, tokenAddressFor, type BaseStock } from './stocks';
import { getBaseClients, getBasePriceClient, getBaseTreasury, requireBaseNetwork } from './treasury';

/**
 * Reserved against the daily cap for gas. Base gas for a token transfer costs
 * well under a cent; this is deliberately generous, since it sizes a safety
 * budget.
 */
export const GAS_ALLOWANCE_USD = 0.02;

/** Longest a payout waits on the second price source. */
const PRICE_TIMEOUT_MS = 10_000;

/** Longest a payout waits for its transaction receipt before calling it unconfirmed. */
const RECEIPT_TIMEOUT_MS = 60_000;

/** Daily payout circuit breaker, shared with the Solana leg. */
export interface PayoutBudget {
  /** Reserve `usd` against today's cap. False when it would exceed the cap. */
  reserve(usd: number): Promise<boolean>;
  release(usd: number): Promise<void>;
}

/**
 * The receipt-store calls a payout makes. The Solana ReceiptStore fits this
 * shape: the stock leg is the 'xstock' leg on either chain.
 */
export interface B20RewardStore {
  get(receiptId: string): Promise<{ txSignature: string | null } | null>;
  claimLeg(receiptId: string, leg: 'xstock'): Promise<boolean>;
  /** Must also clear any hash stored by recordSentTx. */
  releaseLeg(receiptId: string, leg: 'xstock'): Promise<void>;
  recordPayout(receiptId: string, leg: 'xstock', signature: string): Promise<void>;
  /** The share quantity, once pricing is known. */
  recordXStockAmount(receiptId: string, amount: number): Promise<void>;
  /**
   * Optional: persist the hash of the signed transaction before it is
   * broadcast, so a crash between broadcast and confirmation leaves a hash to
   * reconcile from instead of a claim with no trace.
   */
  recordSentTx?(receiptId: string, txHash: string): Promise<void>;
}

export interface SendB20RewardParams {
  /** Idempotency key. */
  receiptId: string;
  recipientWallet: string;
  /** Brand slug or ticker of a stock in stocks.ts. */
  stock: string;
  spendUsd: number;
  pctBack: number;
  /** The receipt's primary fingerprint, hashed into the transfer memo. */
  fingerprint: string;
}

export interface SubmitB20Args {
  token: Address;
  recipient: Address;
  rawAmount: bigint;
  memo: Hex;
  /** ERC-8021 Builder Code suffix, appended to the calldata. */
  dataSuffix?: Hex;
}

export type TxOutcome = 'success' | 'reverted' | 'timeout';

export interface B20RewardDeps {
  store: B20RewardStore;
  /** Optional daily cap. Null means uncapped (tests, scripts). */
  budget: PayoutBudget | null;
  network: BaseNetwork;
  treasuryAddress: Address;
  readTokenState: (token: Address, treasury: Address, recipient: Address) => Promise<TokenState>;
  readFeedRound: (feed: Address) => Promise<FeedRound | null>;
  /** Second price source: the underlying share price in USD, or null when unavailable. */
  fetchUnderlyingUsd: (stock: BaseStock, signal: AbortSignal) => Promise<number | null>;
  /** Simulate, sign, call onSigned with the hash, broadcast. Injected so tests never touch a chain. */
  submit: (args: SubmitB20Args, onSigned: (hash: Hex) => Promise<void>) => Promise<Hex>;
  waitForReceipt: (hash: Hex) => Promise<TxOutcome>;
  memoSecret: string;
  builderSuffix: Hex | undefined;
  /**
   * Serialises signing, so two payouts never take the same nonce. The default
   * covers one process; the API can supply a database lock to cover several.
   */
  withSendLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Unix seconds. */
  now: () => number;
}

let sendQueue: Promise<unknown> = Promise.resolve();

/** One-at-a-time within this process. */
function inProcessLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sendQueue.then(fn, fn);
  sendQueue = run.catch(() => undefined);
  return run;
}

function b20Deps(overrides: Partial<B20RewardDeps> & { store: B20RewardStore }): B20RewardDeps {
  const offline = Boolean(overrides.submit);
  return {
    store: overrides.store,
    budget: overrides.budget ?? null,
    network: overrides.network ?? requireBaseNetwork(),
    treasuryAddress: overrides.treasuryAddress ?? (offline ? zeroAddress : getBaseTreasury().address),
    readTokenState:
      overrides.readTokenState ??
      ((token, treasury, recipient) =>
        readTokenState(getBaseClients().publicClient, token, treasury, recipient)),
    readFeedRound: overrides.readFeedRound ?? ((feed) => readFeedRound(getBasePriceClient(), feed)),
    fetchUnderlyingUsd: overrides.fetchUnderlyingUsd ?? (async () => null),
    submit: overrides.submit ?? submitB20Transfer,
    waitForReceipt: overrides.waitForReceipt ?? waitForB20Receipt,
    memoSecret: overrides.memoSecret ?? process.env.BASE_MEMO_SECRET ?? '',
    builderSuffix:
      'builderSuffix' in overrides
        ? overrides.builderSuffix
        : builderCodeSuffix(process.env.BASE_BUILDER_CODE),
    withSendLock: overrides.withSendLock ?? inProcessLock,
    now: overrides.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}

/**
 * Pay one receipt in a B20 stock. Returns the transaction hash.
 *
 * Idempotent on `receiptId`: a receipt that already carries a hash returns it
 * without sending anything.
 */
export async function sendB20Reward(
  params: SendB20RewardParams,
  overrides: Partial<B20RewardDeps> & { store: B20RewardStore },
): Promise<Hex> {
  const deps = b20Deps(overrides);
  const { receiptId, recipientWallet, spendUsd, pctBack, fingerprint } = params;

  // 1. Already paid?
  const existing = await deps.store.get(receiptId);
  if (!existing) throw new B20RewardError(`No receipt found with id ${receiptId}`);
  if (existing.txSignature) return existing.txSignature as Hex;

  const stock = baseStock(params.stock);
  if (!stock) throw new B20RewardError(`${params.stock} is not a Base stock Stackd pays out.`);
  const recipient = parseBaseAddress(recipientWallet);
  if (!recipient) throw new B20RewardError('That is not a Base address Stackd can pay.');
  const token = tokenAddressFor(stock, deps.network);

  const claimed = await deps.store.claimLeg(receiptId, 'xstock');
  if (!claimed) {
    // Another caller either finished or is mid-flight. Re-read rather than send.
    const current = await deps.store.get(receiptId);
    if (current?.txSignature) return current.txSignature as Hex;
    throw new B20RewardError(`A payout for receipt ${receiptId} is already in flight.`);
  }

  // Budget reserved by THIS call, if any: only the caller holding the claim
  // reserves, so a double-clicked confirm cannot count one payout twice.
  let reservedUsd = 0;

  try {
    // Before any network call: a missing secret must fail with nothing held.
    const memo = receiptMemo(fingerprint, deps.memoSecret);

    // 2. What the issuer allows right now.
    const state = await deps.readTokenState(token, deps.treasuryAddress, recipient);
    const nowS = deps.now();
    if (state.transfersPaused) {
      throw new B20RewardError(
        `${stock.ticker} transfers are paused by the issuer right now; nothing was sent. Your receipt stays claimable.`,
      );
    }
    if (corporateActionNear(state.multiplierChangeAt, nowS)) {
      throw new B20RewardError(
        `${stock.ticker} is going through a corporate action, so payouts wait until it settles. Your receipt stays claimable.`,
      );
    }
    if (!state.recipientAllowed) {
      throw new B20RewardError(`The issuer's transfer rules don't allow this wallet to receive ${stock.ticker}.`);
    }
    if (!state.treasuryAllowed) {
      throw new B20RewardError(`The Stackd treasury can't send ${stock.ticker} right now; nothing was sent.`);
    }

    // 3. Two price sources. The feed is always the brand's mainnet feed: a
    // Sepolia stand-in has no market of its own and is priced as the real stock.
    const [round, underlyingUsd] = await Promise.all([
      deps.readFeedRound(stock.feed),
      deps.fetchUnderlyingUsd(stock, AbortSignal.timeout(PRICE_TIMEOUT_MS)).catch(() => null),
    ]);
    const price = guardedPriceUsd([
      feedPriceUsd(round, nowS),
      tokenPriceFromUnderlying(underlyingUsd, state.multiplierWad),
    ]);
    if (price == null) {
      throw new B20RewardError(`No trustworthy price for ${stock.ticker} right now; nothing was sent.`);
    }

    // 4. Amount, inventory, budget.
    const amount = computeB20Reward({
      spendUsd,
      pctBack,
      tokenPriceUsd: price,
      decimals: state.decimals,
      multiplierWad: state.multiplierWad,
    });
    if (state.treasuryBalance < amount.rawAmount) {
      throw new B20RewardError(
        `The treasury is out of ${stock.ticker}; nothing was sent. Your receipt stays claimable.`,
      );
    }
    if (deps.budget) {
      const costUsd = amount.rewardUsd + GAS_ALLOWANCE_USD;
      if (!(await deps.budget.reserve(costUsd))) {
        throw new B20PayoutPausedError(
          "Stackd has reached today's payout limit. Your receipt is saved — claim it again tomorrow.",
        );
      }
      reservedUsd = costUsd;
    }

    await deps.store.recordXStockAmount(receiptId, amount.shares);

    // 5. Sign, record, broadcast, confirm.
    const hash = await deps.withSendLock(() =>
      deps.submit(
        { token, recipient, rawAmount: amount.rawAmount, memo, dataSuffix: deps.builderSuffix },
        async (signedHash) => {
          await deps.store.recordSentTx?.(receiptId, signedHash);
        },
      ),
    );

    const outcome = await deps.waitForReceipt(hash);
    if (outcome === 'timeout') throw new B20PayoutUnconfirmedError(hash);
    if (outcome === 'reverted') {
      throw new B20RewardError(`Transfer ${hash} reverted on chain; nothing was sent.`);
    }

    await deps.store.recordPayout(receiptId, 'xstock', hash);
    return hash;
  } catch (error) {
    // Signed and possibly broadcast, outcome unknown: it may still land. Keep
    // both the claim and the reserved budget, so a retry can neither resend
    // nor overspend.
    if (error instanceof B20PayoutUnconfirmedError) throw error;

    // Otherwise nothing moved: free the budget and the claim so the user can retry.
    if (reservedUsd > 0 && deps.budget) await deps.budget.release(reservedUsd);
    await deps.store.releaseLeg(receiptId, 'xstock');
    throw error;
  }
}

/** Node rejections after which a transaction provably cannot land. */
const REJECTED = /insufficient funds|nonce too low|max fee per gas less than block base fee|intrinsic gas too low/i;

function rejectedOutright(error: unknown): boolean {
  const text = error instanceof BaseError ? `${error.shortMessage} ${error.details}` : String(error);
  return REJECTED.test(text);
}

/**
 * Simulate, sign locally, hand the hash to `onSigned`, then broadcast.
 *
 * The hash is known before broadcast (keccak256 of the signed transaction), so
 * it can be stored first. A broadcast error is not taken at its word: unless
 * the node says the transaction cannot land, the chain is asked whether it
 * arrived, and an unknown answer is reported as unconfirmed, never as failed.
 */
export async function submitB20Transfer(
  args: SubmitB20Args,
  onSigned: (hash: Hex) => Promise<void>,
): Promise<Hex> {
  const { publicClient, walletClient, chain } = getBaseClients();
  const account = getBaseTreasury();
  const callArgs = [args.recipient, args.rawAmount, args.memo] as const;

  // A policy refusal, a pause or a short balance surfaces here, before signing.
  await publicClient.simulateContract({
    account,
    address: args.token,
    abi: b20Abi,
    functionName: 'transferWithMemo',
    args: callArgs,
  });

  const call = encodeFunctionData({ abi: b20Abi, functionName: 'transferWithMemo', args: callArgs });
  const data = args.dataSuffix ? concatHex([call, args.dataSuffix]) : call;

  // Pending nonce, read inside the caller's send lock.
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const request = await walletClient.prepareTransactionRequest({
    account,
    chain,
    to: args.token,
    data,
    nonce,
  });
  const serializedTransaction = await walletClient.signTransaction(request);
  const hash = keccak256(serializedTransaction);
  await onSigned(hash);

  try {
    await publicClient.sendRawTransaction({ serializedTransaction });
  } catch (error) {
    if (rejectedOutright(error)) {
      throw new B20RewardError('The network rejected the transfer; nothing was sent.', { cause: error });
    }
    const arrived = await publicClient.getTransaction({ hash }).then(
      () => true,
      () => false,
    );
    if (!arrived) throw new B20PayoutUnconfirmedError(hash, { cause: error });
  }
  return hash;
}

/** Wait for the receipt. Anything short of a receipt is 'timeout': unknown, never failed. */
export async function waitForB20Receipt(hash: Hex): Promise<TxOutcome> {
  const { publicClient } = getBaseClients();
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch {
    return 'timeout';
  }
}
