/**
 * Reward engine tests.
 *
 * Run: npm test --workspace=@stackd/solana
 *
 * None of these touch the chain. The transfer submitters are injected, so a
 * test that "sends" is really asserting against a spy — which is also how
 * test_vault_pause can prove no transaction was even attempted.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { PublicKey, type Connection, type Keypair } from '@solana/web3.js';

import { BRAND_BY_TICKER } from './brands';
import { fetchXStockPrices } from './prices';
import { InMemoryReceiptStore } from './receipt-store';
import { computeRewardAmount, sendStackdBonus, sendXStockReward } from './rewards';
import type { StackdConfig } from './stackd';
import { NO_SCALING, type ScaledUiAmountState } from './scaled-amount';

const NFLX = BRAND_BY_TICKER.NFLXx;
const THIN = BRAND_BY_TICKER.AMZNx; // 8dp, multiplier 1.0
const RECIPIENT = 'So11111111111111111111111111111111111111112';

/** A submitter that records calls instead of sending anything. */
function spySubmitter(signature = 'sig-xstock-1') {
  const calls: Array<{ rawAmount: bigint; decimals: number }> = [];
  const fn = async (args: { rawAmount: bigint; decimals: number }) => {
    calls.push({ rawAmount: args.rawAmount, decimals: args.decimals });
    return signature;
  };
  return { fn: fn as never, calls };
}

function scaledState(multiplier: number): ScaledUiAmountState {
  return { ...NO_SCALING, multiplier };
}

async function seedReceipt(store: InMemoryReceiptStore, id: string) {
  await store.create({
    id,
    walletAddress: RECIPIENT,
    brandName: NFLX.name,
    brandTicker: NFLX.ticker,
    amountUsd: 100,
    xstockAmount: null,
    imageUrl: null,
    claudeConfidence: 0.95,
  });
}

// ---------------------------------------------------------------------------

describe('test_multiplier_correctness', () => {
  /**
   * The exact bug class the README warns about. NFLXx runs at multiplier 10, so
   * a displayed balance of 1.0 share is 10_000_000 base units, not 100_000_000.
   * Skipping the division overpays by 10x — this is the test that catches it.
   */
  it('divides by the scaled-UI multiplier instead of multiplying through', () => {
    const { tokenAmount, rawAmount } = computeRewardAmount({
      spendUsd: 100,
      pctBack: 10, // $10 reward
      price: 10, // -> exactly 1.0 NFLXx displayed
      decimals: NFLX.decimals, // 8
      multiplier: 10, // NFLXx live multiplier
    });

    assert.equal(tokenAmount, 1, 'user should see 1.0 NFLXx');
    assert.equal(rawAmount, 10_000_000n, 'raw = uiAmount / multiplier * 10^decimals');

    // The naive calculation, spelled out so a regression is unmistakable.
    const naive = BigInt(Math.round(tokenAmount * 10 ** NFLX.decimals));
    assert.equal(naive, 100_000_000n);
    assert.notEqual(rawAmount, naive, 'must not send the un-divided amount (10x overpay)');
    assert.equal(naive / rawAmount, 10n, 'the mistake is exactly 10x on NFLXx');
  });

  it('is a no-op for an unscaled mint', () => {
    const { rawAmount } = computeRewardAmount({
      spendUsd: 100,
      pctBack: 10,
      price: 10,
      decimals: 8,
      multiplier: 1,
    });
    assert.equal(rawAmount, 100_000_000n);
  });

  it('round-trips a realistic NFLXx reward', () => {
    // $50 Netflix receipt at 3% = $1.50, at ~$77.82/share.
    const { tokenAmount, rawAmount } = computeRewardAmount({
      spendUsd: 50,
      pctBack: NFLX.pctBack,
      price: 77.82,
      decimals: NFLX.decimals,
      multiplier: 10,
    });

    const displayedAgain = (Number(rawAmount) / 10 ** NFLX.decimals) * 10;
    assert.ok(
      Math.abs(displayedAgain - tokenAmount) < 1e-7,
      `round-trip drifted: ${displayedAgain} vs ${tokenAmount}`,
    );
  });
});

// ---------------------------------------------------------------------------

describe('test_idempotent_replay', () => {
  let store: InMemoryReceiptStore;

  beforeEach(() => {
    store = new InMemoryReceiptStore();
  });

  it('sends once and returns the stored signature on replay', async () => {
    await seedReceipt(store, 'receipt-idem-1');
    const spy = spySubmitter('sig-abc');

    const params = {
      recipientWallet: RECIPIENT,
      xstockMint: NFLX.mint,
      spendUsd: 100,
      pctBack: NFLX.pctBack,
      receiptId: 'receipt-idem-1',
    };
    const deps = {
      store,
      connection: null as unknown as Connection,
      treasury: null as unknown as Keypair,
      fetchPrices: async () => ({
        [NFLX.mint]: { mint: NFLX.mint, usd: 50, source: 'market' as const, change24hPct: null },
      }),
      fetchScaledState: async () => scaledState(10),
      submit: spy.fn,
    };

    const first = await sendXStockReward(params, deps);
    const second = await sendXStockReward(params, deps);

    assert.equal(first, 'sig-abc');
    assert.equal(second, 'sig-abc', 'replay must return the original signature');
    assert.equal(spy.calls.length, 1, 'only one transfer may be submitted');

    const row = await store.get('receipt-idem-1');
    assert.equal(row?.txSignature, 'sig-abc');
    assert.equal(row?.status, 'confirmed');
  });

  it('releases the claim when the transfer fails, so a retry can succeed', async () => {
    await seedReceipt(store, 'receipt-retry');
    let attempts = 0;

    const deps = {
      store,
      connection: null as unknown as Connection,
      treasury: null as unknown as Keypair,
      fetchPrices: async () => ({
        [NFLX.mint]: { mint: NFLX.mint, usd: 50, source: 'market' as const, change24hPct: null },
      }),
      fetchScaledState: async () => scaledState(10),
      submit: (async () => {
        attempts++;
        if (attempts === 1) throw new Error('blockhash expired');
        return 'sig-retry';
      }) as never,
    };
    const params = {
      recipientWallet: RECIPIENT,
      xstockMint: NFLX.mint,
      spendUsd: 100,
      pctBack: NFLX.pctBack,
      receiptId: 'receipt-retry',
    };

    await assert.rejects(() => sendXStockReward(params, deps));
    const signature = await sendXStockReward(params, deps);

    assert.equal(signature, 'sig-retry');
    assert.equal(attempts, 2);
  });
});

// ---------------------------------------------------------------------------

describe('test_price_resolution_fallback', () => {
  const realFetch = globalThis.fetch;

  after(() => {
    globalThis.fetch = realFetch;
  });

  it('falls back to stockData.price when Jupiter returns no usdPrice', async () => {
    // Simulate a mint with a pool but no routable depth: Jupiter omits usdPrice.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          [THIN.mint]: {
            decimals: 8,
            stockData: { price: 99.269 },
            // no usdPrice
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const prices = await fetchXStockPrices([THIN.mint]);

    assert.equal(prices[THIN.mint].usd, 99.269);
    assert.equal(prices[THIN.mint].source, 'underlying');
    assert.equal(prices[THIN.mint].change24hPct, null);
  });

  it('prefers the routed market price when both are present', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          [THIN.mint]: {
            usdPrice: 77.82,
            priceChange24h: 0.8,
            stockData: { price: 80.06 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const prices = await fetchXStockPrices([THIN.mint]);
    assert.equal(prices[THIN.mint].usd, 77.82);
    assert.equal(prices[THIN.mint].source, 'market');
  });

  it('pays out using the fallback price end to end', async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-fallback');
    const spy = spySubmitter('sig-fallback');

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          [THIN.mint]: { decimals: 8, stockData: { price: 100 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const signature = await sendXStockReward(
      {
        recipientWallet: RECIPIENT,
        xstockMint: THIN.mint,
        spendUsd: 100,
        pctBack: 4, // $4 reward at $100/share -> 0.04 tokens
        receiptId: 'receipt-fallback',
      },
      {
        store,
        connection: null as unknown as Connection,
        treasury: null as unknown as Keypair,
        fetchScaledState: async () => scaledState(1),
        submit: spy.fn,
      },
    );

    assert.equal(signature, 'sig-fallback');
    // 0.04 tokens at 8dp, multiplier 1.
    assert.equal(spy.calls[0].rawAmount, 4_000_000n);
  });
});

// ---------------------------------------------------------------------------

describe('test_vault_pause', () => {
  const config: StackdConfig = {
    mint: new PublicKey('So11111111111111111111111111111111111111112'),
    decimals: 9,
    minVaultBalance: 1000,
  };

  it('returns null and attempts no transaction when the vault is low', async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-vault-low');

    let submitCalled = false;

    const signature = await sendStackdBonus(
      {
        recipientWallet: RECIPIENT,
        spendUsd: 100,
        bonusRate: 0.02,
        receiptId: 'receipt-vault-low',
      },
      {
        store,
        connection: null as unknown as Connection,
        treasury: { publicKey: new PublicKey(RECIPIENT) } as unknown as Keypair,
        config,
        quotePrice: async () => 0.01,
        vaultBalance: async () => 10, // far below minVaultBalance
        submit: (async () => {
          submitCalled = true;
          return 'should-never-happen';
        }) as never,
      },
    );

    assert.equal(signature, null, 'a paused vault returns null, not an error');
    assert.equal(submitCalled, false, 'no transaction may be attempted');

    const row = await store.get('receipt-vault-low');
    assert.equal(row?.bonusTxSignature, null);
  });

  it('pauses when the vault cannot cover this specific bonus', async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-vault-thin');
    let submitCalled = false;

    // $100 * 2% = $2 at $0.01 => 200 STACKD needed, but only 1500 held with a
    // 1000 floor, leaving 500 spendable... still short? No: 1500 >= 1000 and
    // 1500 >= 200, so this one must succeed. Use a balance that clears the
    // floor but not the bonus.
    const signature = await sendStackdBonus(
      {
        recipientWallet: RECIPIENT,
        spendUsd: 100_000, // $2000 bonus => 200_000 STACKD
        bonusRate: 0.02,
        receiptId: 'receipt-vault-thin',
      },
      {
        store,
        connection: null as unknown as Connection,
        treasury: { publicKey: new PublicKey(RECIPIENT) } as unknown as Keypair,
        config,
        quotePrice: async () => 0.01,
        vaultBalance: async () => 5000, // clears the floor, cannot cover 200k
        submit: (async () => {
          submitCalled = true;
          return 'nope';
        }) as never,
      },
    );

    assert.equal(signature, null);
    assert.equal(submitCalled, false);
  });

  it('pays the bonus when the vault is healthy', async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-vault-ok');
    const calls: bigint[] = [];

    const signature = await sendStackdBonus(
      {
        recipientWallet: RECIPIENT,
        spendUsd: 100,
        bonusRate: 0.02, // $2 at $0.01 => 200 STACKD
        receiptId: 'receipt-vault-ok',
      },
      {
        store,
        connection: null as unknown as Connection,
        treasury: { publicKey: new PublicKey(RECIPIENT) } as unknown as Keypair,
        config,
        quotePrice: async () => 0.01,
        vaultBalance: async () => 50_000,
        submit: (async (args: { rawAmount: bigint }) => {
          calls.push(args.rawAmount);
          return 'sig-bonus';
        }) as never,
      },
    );

    assert.equal(signature, 'sig-bonus');
    assert.equal(calls[0], 200_000_000_000n, '200 STACKD at 9dp');

    const row = await store.get('receipt-vault-ok');
    assert.equal(row?.bonusTxSignature, 'sig-bonus');
  });

  it('returns null when STACKD is not configured at all', async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-no-stackd');

    const signature = await sendStackdBonus(
      {
        recipientWallet: RECIPIENT,
        spendUsd: 100,
        bonusRate: 0.02,
        receiptId: 'receipt-no-stackd',
      },
      { store, config: null, submit: (async () => 'nope') as never },
    );

    assert.equal(signature, null);
  });
});

// ---------------------------------------------------------------------------

describe('test_bonus_rent_budget', () => {
  const healthy = {
    connection: null as unknown as Connection,
    treasury: { publicKey: new PublicKey(RECIPIENT) } as unknown as Keypair,
    config: {
      mint: new PublicKey('So11111111111111111111111111111111111111112'),
      decimals: 9,
      minVaultBalance: 1000,
    } satisfies StackdConfig,
    quotePrice: async () => 0.01,
    vaultBalance: async () => 50_000,
  };
  const bonus = (receiptId: string) => ({
    recipientWallet: RECIPIENT,
    spendUsd: 100,
    bonusRate: 0.02,
    receiptId,
  });

  it("pauses the bonus when the day's budget cannot cover a new $STACKD account", async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-bonus-rent');
    let submitCalled = false;

    const signature = await sendStackdBonus(bonus('receipt-bonus-rent'), {
      store,
      ...healthy,
      budget: { reserve: async () => false, release: async () => {} },
      openingCostUsd: async () => 0.4,
      submit: (async () => {
        submitCalled = true;
        return 'nope';
      }) as never,
    });

    assert.equal(signature, null, 'a paused bonus returns null, not an error');
    assert.equal(submitCalled, false);
    assert.equal(await store.claimLeg('receipt-bonus-rent', 'bonus'), true, 'the claim was released');
  });

  it('returns the rent to the budget when the bonus send fails', async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-bonus-fail');
    let used = 0;

    const signature = await sendStackdBonus(bonus('receipt-bonus-fail'), {
      store,
      ...healthy,
      budget: {
        reserve: async (usd) => ((used += usd), true),
        release: async (usd) => void (used -= usd),
      },
      openingCostUsd: async () => 0.4,
      submit: (async () => {
        throw new Error('rpc down');
      }) as never,
    });

    assert.equal(signature, null);
    assert.equal(used, 0);
  });

  it('reserves nothing when the account already exists', async () => {
    const store = new InMemoryReceiptStore();
    await seedReceipt(store, 'receipt-bonus-existing');
    const reserved: number[] = [];

    const signature = await sendStackdBonus(bonus('receipt-bonus-existing'), {
      store,
      ...healthy,
      budget: { reserve: async (usd) => (reserved.push(usd), true), release: async () => {} },
      openingCostUsd: async () => 0,
      submit: (async () => 'sig-bonus') as never,
    });

    assert.equal(signature, 'sig-bonus');
    assert.deepEqual(reserved, []);
  });
});
