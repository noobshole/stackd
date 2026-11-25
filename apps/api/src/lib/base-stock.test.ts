/**
 * Base treasury stock at verify time: pay, pause, or let the payout decide.
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WAD, baseStock } from '@stackd/base';
import { checkBaseStock, type BaseStockDeps } from './base-stock.js';
import { STOCK_HEADROOM } from './inventory.js';

const AAPL = baseStock('apple')!;
const M = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

function deps(over: Partial<{ shares: number; multiplier: bigint; feed: number | null; underlying: number | null; fail: boolean }> = {}): BaseStockDeps {
  return {
    async holding() {
      if (over.fail) throw new Error('rpc down');
      return { shares: over.shares ?? 10, multiplierWad: over.multiplier ?? WAD };
    },
    feedUsd: async () => ('feed' in over ? over.feed! : 200),
    underlyingUsd: async () => ('underlying' in over ? over.underlying! : 200),
  };
}

describe('test_base_stock_check', () => {
  it('passes when the treasury holds enough, with headroom', async () => {
    const check = await checkBaseStock(AAPL, 2, deps({ shares: 1 }));
    assert.equal(check.ok, true);
    if (check.ok !== null) assert.ok(Math.abs(check.neededShares - (2 / 200) * STOCK_HEADROOM) < 1e-12);
  });

  it('pauses the brand when the treasury is short', async () => {
    const check = await checkBaseStock(AAPL, 2, deps({ shares: 0.005 }));
    assert.equal(check.ok, false);
  });

  it('counts in shares, not tokens, when a dividend has lifted the multiplier', async () => {
    // Feed price is per token (underlying x multiplier); one share costs the underlying price.
    const check = await checkBaseStock(AAPL, 2, deps({ shares: 0.0105, multiplier: M(1.1), feed: 220, underlying: 200 }));
    assert.equal(check.ok, false, '2 USD at 200/share x 1.1 headroom needs 0.011 shares');
    if (check.ok !== null) assert.ok(Math.abs(check.neededShares - 0.011) < 1e-9);
  });

  it('prices by the payout rule: the higher of two sources that agree', async () => {
    const check = await checkBaseStock(AAPL, 2, deps({ feed: 190, underlying: 200 }));
    assert.equal(check.ok, true);
    if (check.ok !== null) assert.ok(Math.abs(check.neededShares - (2 / 200) * STOCK_HEADROOM) < 1e-12);
  });

  it('lets the payout decide when the sources disagree or the chain cannot be read', async () => {
    assert.equal((await checkBaseStock(AAPL, 2, deps({ feed: 100, underlying: 200 }))).ok, null);
    assert.equal((await checkBaseStock(AAPL, 2, deps({ feed: null, underlying: null }))).ok, null);
    assert.equal((await checkBaseStock(AAPL, 2, deps({ fail: true }))).ok, null);
  });
});
