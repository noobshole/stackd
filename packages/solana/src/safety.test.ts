/**
 * Fraud and payout-safety tests.
 *
 * Run: npm test --workspace=@stackd/solana
 *
 * Covers the controls added before mainnet: duplicate receipts across wallets,
 * the daily payout circuit breaker, and establishing a transfer's real outcome
 * instead of assuming it. No chain access: everything is injected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

import { BRAND_BY_TICKER } from './brands';
import { DuplicateReceiptError, InMemoryReceiptStore } from './receipt-store';
import {
  PayoutPausedError,
  RewardError,
  sendAndConfirm,
  sendXStockReward,
  type PayoutBudget,
} from './rewards';
import { NO_SCALING } from './scaled-amount';

const MCD = BRAND_BY_TICKER.MCDx;
const ALICE = 'So11111111111111111111111111111111111111112';
const MALLORY = 'SysvarRent111111111111111111111111111111111';

function receipt(
  id: string,
  wallet: string,
  keys: { imageSha256?: string; fingerprint?: string; fingerprints?: string[] },
) {
  return {
    id,
    walletAddress: wallet,
    brandName: MCD.name,
    brandTicker: MCD.ticker,
    amountUsd: 100,
    xstockAmount: null,
    imageUrl: null,
    claudeConfidence: 0.95,
    ...keys,
  };
}

// ---------------------------------------------------------------------------

describe('test_duplicate_receipts', () => {
  it('refuses the same image from a different wallet', async () => {
    const store = new InMemoryReceiptStore();
    await store.create(receipt('r1', ALICE, { imageSha256: 'img-A', fingerprint: 'fp-A' }));

    await assert.rejects(
      store.create(receipt('r2', MALLORY, { imageSha256: 'img-A', fingerprint: 'fp-B' })),
      (e: unknown) => e instanceof DuplicateReceiptError && e.kind === 'image',
    );
  });

  it('refuses a re-photographed copy (same fingerprint, new image) from any wallet', async () => {
    const store = new InMemoryReceiptStore();
    await store.create(receipt('r1', ALICE, { imageSha256: 'img-A', fingerprint: 'fp-A' }));

    await assert.rejects(
      store.create(receipt('r2', MALLORY, { imageSha256: 'img-B', fingerprint: 'fp-A' })),
      (e: unknown) => e instanceof DuplicateReceiptError && e.kind === 'fingerprint',
    );
    assert.equal(await store.findDuplicate({ fingerprints: ['fp-A'] }), 'fingerprint');
  });

  it('refuses a copy that matches on only one of its keys', async () => {
    // The real case: one photo read the number as "ORD #34 -CSO #30", the
    // other as "34" — different number keys, same time-of-purchase key.
    const store = new InMemoryReceiptStore();
    await store.create(
      receipt('r1', ALICE, { imageSha256: 'img-A', fingerprints: ['n:ORD34CSO30', 't:15:11'] }),
    );

    await assert.rejects(
      store.create(
        receipt('r2', MALLORY, { imageSha256: 'img-B', fingerprints: ['n:34', 't:15:11'] }),
      ),
      (e: unknown) => e instanceof DuplicateReceiptError && e.kind === 'fingerprint',
    );
    assert.equal(await store.findDuplicate({ fingerprints: ['n:other', 't:15:11'] }), 'fingerprint');
    assert.equal(await store.findDuplicate({ fingerprints: ['n:other', 't:09:00'] }), null);
  });

  it('never expires: the old 24h per-wallet window let receipts repeat daily', async () => {
    const store = new InMemoryReceiptStore();
    await store.create(receipt('r1', ALICE, { imageSha256: 'img-A', fingerprint: 'fp-A' }));
    // Same wallet, "tomorrow" — nothing time-based about the check any more.
    await assert.rejects(
      store.create(receipt('r2', ALICE, { imageSha256: 'img-A2', fingerprint: 'fp-A' })),
      DuplicateReceiptError,
    );
  });

  it('accepts a genuinely different receipt', async () => {
    const store = new InMemoryReceiptStore();
    await store.create(receipt('r1', ALICE, { imageSha256: 'img-A', fingerprint: 'fp-A' }));
    await store.create(receipt('r2', ALICE, { imageSha256: 'img-B', fingerprint: 'fp-B' }));
    assert.ok(await store.get('r2'));
  });
});

// ---------------------------------------------------------------------------

function fakeBudget(capUsd: number) {
  let used = 0;
  const log: string[] = [];
  const budget: PayoutBudget = {
    reserve: async (usd) => {
      if (used + usd > capUsd + 1e-9) {
        log.push(`refused ${usd}`);
        return false;
      }
      used += usd;
      log.push(`reserved ${usd}`);
      return true;
    },
    release: async (usd) => {
      used -= usd;
      log.push(`released ${usd}`);
    },
  };
  return { budget, log, used: () => used };
}

function xstockDeps(store: InMemoryReceiptStore, submit: () => Promise<string>, budget: PayoutBudget) {
  return {
    store,
    connection: null as unknown as Connection,
    treasury: null as unknown as Keypair,
    fetchPrices: async () => ({
      [MCD.mint]: { mint: MCD.mint, usd: 250, source: 'market' as const, change24hPct: null },
    }),
    fetchScaledState: async () => NO_SCALING,
    submit: submit as never,
    budget,
  };
}

const params = (receiptId: string) => ({
  recipientWallet: ALICE,
  xstockMint: MCD.mint,
  spendUsd: 100, // x 4% = $4 cashback
  pctBack: MCD.pctBack,
  receiptId,
});

describe('test_payout_budget', () => {
  it('pauses payouts over the daily cap and sends nothing', async () => {
    const store = new InMemoryReceiptStore();
    await store.create(receipt('r1', ALICE, {}));
    let sent = 0;
    const { budget } = fakeBudget(3); // $3 cap, receipt is worth $4

    await assert.rejects(
      sendXStockReward(params('r1'), xstockDeps(store, async () => `sig-${++sent}`, budget)),
      PayoutPausedError,
    );
    assert.equal(sent, 0, 'no transfer may be attempted once the cap is hit');

    // The claim was released: the same receipt pays once the budget allows.
    const roomy = fakeBudget(10).budget;
    assert.equal(
      await sendXStockReward(params('r1'), xstockDeps(store, async () => 'sig-late', roomy)),
      'sig-late',
    );
  });

  it('gives the budget back when the transfer fails', async () => {
    const store = new InMemoryReceiptStore();
    await store.create(receipt('r1', ALICE, {}));
    const b = fakeBudget(10);

    await assert.rejects(
      sendXStockReward(
        params('r1'),
        xstockDeps(store, async () => {
          throw new Error('rpc down');
        }, b.budget),
      ),
      /rpc down/,
    );
    assert.equal(b.used(), 0, 'a failed send must not consume the day\'s budget');
  });

  it('reserves once per payout, not once per click', async () => {
    const store = new InMemoryReceiptStore();
    await store.create(receipt('r1', ALICE, {}));
    const b = fakeBudget(10);
    const deps = xstockDeps(store, async () => 'sig-once', b.budget);

    await sendXStockReward(params('r1'), deps);
    await sendXStockReward(params('r1'), deps); // replay: already paid

    assert.equal(b.used(), 4);
    assert.deepEqual(b.log, ['reserved 4']);
  });
});

// ---------------------------------------------------------------------------

function fakeConnection(opts: {
  confirm: () => Promise<{ value: { err: unknown } }>;
  status?: { err: unknown; confirmationStatus?: string } | null;
  blockHeight?: number;
}): Connection {
  return {
    sendTransaction: async () => 'sig-1',
    confirmTransaction: opts.confirm,
    getSignatureStatuses: async () => ({ value: [opts.status ?? null] }),
    getBlockHeight: async () => opts.blockHeight ?? 0,
  } as unknown as Connection;
}

const TX = {} as VersionedTransaction;

describe('test_transfer_outcome', () => {
  it('treats a transaction that landed but FAILED as failed, not paid', async () => {
    // confirmTransaction resolves with value.err set; it does not throw.
    // Unchecked, the old code recorded this as a successful payout.
    const connection = fakeConnection({
      confirm: async () => ({ value: { err: { InstructionError: [1, 'InsufficientFunds'] } } }),
    });
    await assert.rejects(sendAndConfirm(connection, TX, 'hash', 100), RewardError);
  });

  it('recovers a transfer that landed even though confirmation threw', async () => {
    // Confirmation errored (RPC hiccup) but the chain has it. Reporting failure
    // here frees the claim, and the retry would pay the user twice.
    const connection = fakeConnection({
      confirm: async () => {
        throw new Error('socket hang up');
      },
      status: { err: null, confirmationStatus: 'confirmed' },
    });
    assert.equal(await sendAndConfirm(connection, TX, 'hash', 100), 'sig-1');
  });

  it('reports a retryable failure once the blockhash has provably expired', async () => {
    const connection = fakeConnection({
      confirm: async () => {
        throw new Error('block height exceeded');
      },
      status: null,
      blockHeight: 101, // past lastValidBlockHeight: it can never land now
    });
    await assert.rejects(sendAndConfirm(connection, TX, 'hash', 100), /block height exceeded/);
  });
});
