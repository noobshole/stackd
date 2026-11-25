/**
 * The receipt store as both chains use it: one receipt pays once across
 * chains, and the Base payout's bookkeeping lands on the real store shape.
 * (The Postgres store runs the same rules in SQL and is checked live.)
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Hex } from 'viem';
import { WAD } from '@stackd/base';
import { B20PayoutUnconfirmedError, sendB20Reward, type TxOutcome } from '@stackd/base/server';
import { DuplicateReceiptError, InMemoryReceiptStore } from '@stackd/solana/server';

const HASH = `0x${'cd'.repeat(32)}` as Hex;
const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const NOW = 1_800_000_000;

function receipt(id: string, chain: 'solana' | 'base', fingerprint: string) {
  return {
    id,
    chain,
    walletAddress: chain === 'base' ? WALLET : 'So11111111111111111111111111111111111111112',
    brandName: 'Apple',
    brandTicker: chain === 'base' ? 'AAPLc' : 'AAPLx',
    amountUsd: 50,
    xstockAmount: null,
    imageUrl: null,
    claudeConfidence: 0.9,
    fingerprint,
    fingerprints: [fingerprint],
  };
}

function pay(store: InMemoryReceiptStore, outcome: TxOutcome, seen: { sentBeforeBroadcast?: string | null }) {
  return sendB20Reward(
    { receiptId: 'b1', recipientWallet: WALLET, stock: 'AAPLc', spendUsd: 50, pctBack: 1, fingerprint: 'apple|x' },
    {
      store,
      budget: null,
      network: 'mainnet',
      readTokenState: async () => ({
        decimals: 8,
        multiplierWad: WAD,
        transfersPaused: false,
        treasuryAllowed: true,
        recipientAllowed: true,
        treasuryBalance: 10n ** 12n,
        multiplierChangeAt: null,
      }),
      readFeedRound: async () => ({ answer: 200n * 10n ** 8n, decimals: 8, updatedAt: BigInt(NOW - 60) }),
      fetchUnderlyingUsd: async () => 200,
      submit: async (_args, onSigned) => {
        await onSigned(HASH);
        seen.sentBeforeBroadcast = (await store.get('b1'))?.pendingTxHash ?? null;
        return HASH;
      },
      waitForReceipt: async () => outcome,
      memoSecret: 'm'.repeat(64),
      builderSuffix: undefined,
      now: () => NOW,
    },
  );
}

describe('test_receipts_across_chains', () => {
  let store: InMemoryReceiptStore;
  beforeEach(() => {
    store = new InMemoryReceiptStore();
  });

  it('refuses a receipt on Base that was already claimed on Solana', async () => {
    await store.create(receipt('s1', 'solana', 'apple|2026-11-25|50.00|R1'));
    assert.equal(await store.findDuplicate({ fingerprints: ['apple|2026-11-25|50.00|R1'] }), 'fingerprint');
    await assert.rejects(
      store.create(receipt('b1', 'base', 'apple|2026-11-25|50.00|R1')),
      DuplicateReceiptError,
    );
  });

  it('keeps the chain on the record', async () => {
    await store.create(receipt('b1', 'base', 'apple|x'));
    assert.equal((await store.get('b1'))?.chain, 'base');
  });
});

describe('test_base_payout_bookkeeping', () => {
  let store: InMemoryReceiptStore;
  beforeEach(async () => {
    store = new InMemoryReceiptStore();
    await store.create(receipt('b1', 'base', 'apple|x'));
  });

  it('stores the hash before broadcast, then records the payout and clears it', async () => {
    const seen: { sentBeforeBroadcast?: string | null } = {};
    assert.equal(await pay(store, 'success', seen), HASH);
    assert.equal(seen.sentBeforeBroadcast, HASH);
    const row = await store.get('b1');
    assert.equal(row?.txSignature, HASH);
    assert.equal(row?.pendingTxHash, null);
    assert.equal(row?.status, 'confirmed');
    assert.ok(row?.xstockAmount && row.xstockAmount > 0, 'shares recorded');
  });

  it('keeps the claim and the hash when the outcome is unknown, so a retry cannot pay twice', async () => {
    await assert.rejects(pay(store, 'timeout', {}), B20PayoutUnconfirmedError);
    assert.equal((await store.get('b1'))?.pendingTxHash, HASH);
    assert.equal(await store.claimLeg('b1', 'xstock'), false, 'still claimed');
  });

  it('clears the hash and frees the claim when the transfer provably failed', async () => {
    await assert.rejects(pay(store, 'reverted', {}), /reverted/);
    assert.equal((await store.get('b1'))?.pendingTxHash, null);
    assert.equal(await store.claimLeg('b1', 'xstock'), true, 'claimable again');
  });
});
