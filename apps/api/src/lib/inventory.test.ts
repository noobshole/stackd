/**
 * Treasury stock check tests. No chain access: balances and prices are injected.
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRAND_BY_TICKER } from '@stackd/solana';

import { STOCK_HEADROOM, checkPayoutStock, type StockDeps } from './inventory.js';

const MCD = BRAND_BY_TICKER.MCDx;

function deps(held: number, price: number | null): StockDeps {
  return { heldShares: async () => held, priceUsd: async () => price };
}

describe('test_payout_stock', () => {
  it('accepts when the treasury holds enough, with headroom', async () => {
    // $0.14 at $250/share = 0.00056 shares; with headroom ~0.000616.
    const result = await checkPayoutStock(MCD, 0.14, deps(0.001, 250));
    assert.equal(result.ok, true);
  });

  it('refuses a brand the treasury holds none of', async () => {
    const result = await checkPayoutStock(MCD, 0.14, deps(0, 250));
    assert.equal(result.ok, false);
  });

  it('refuses when stock covers the payout but not the headroom', async () => {
    const exact = 0.14 / 250;
    const result = await checkPayoutStock(MCD, 0.14, deps(exact, 250));
    assert.equal(result.ok, false);
    assert.equal(STOCK_HEADROOM > 1, true);
  });

  it('cannot tell without a price, and says so rather than guessing', async () => {
    const result = await checkPayoutStock(MCD, 0.14, deps(10, null));
    assert.equal(result.ok, null);
  });

  it('cannot tell when the chain read fails', async () => {
    const failing: StockDeps = {
      heldShares: async () => {
        throw new Error('RPC down');
      },
      priceUsd: async () => 250,
    };
    const result = await checkPayoutStock(MCD, 0.14, failing);
    assert.equal(result.ok, null);
    assert.match(result.ok === null ? result.reason : '', /RPC down/);
  });
});
