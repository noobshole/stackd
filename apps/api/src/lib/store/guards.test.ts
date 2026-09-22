/**
 * Submission limits and the daily payout budget (in-memory backend; the
 * Postgres backend runs the same logic in SQL and is checked live).
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryGuards, limits } from './guards.js';

const HOUR = 60 * 60 * 1000;

function clock(start = Date.parse('2026-09-19T08:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('test_submission_limits', () => {
  it('caps a wallet at 3 per day', async () => {
    const c = clock();
    const g = new MemoryGuards(c.now);
    for (let i = 0; i < limits.walletPerDay; i++) {
      assert.equal((await g.tryAttempt('wallet-A', `10.0.0.${i}`)).allowed, true);
    }
    const refused = await g.tryAttempt('wallet-A', '10.0.0.99');
    assert.equal(refused.allowed, false);
    assert.equal(refused.limit, 'wallet');
    assert.equal(await g.walletRemaining('wallet-A'), 0);
  });

  it('caps an IP however many fresh wallets it invents', async () => {
    // The wallet address is an unsigned form field. This is the script that
    // makes a new one per request to burn Claude credits.
    const c = clock();
    const g = new MemoryGuards(c.now);
    for (let i = 0; i < limits.ipPerHour; i++) {
      assert.equal((await g.tryAttempt(`fresh-wallet-${i}`, '203.0.113.7')).allowed, true);
    }
    const refused = await g.tryAttempt('fresh-wallet-new', '203.0.113.7');
    assert.equal(refused.allowed, false);
    assert.equal(refused.limit, 'ip');
    assert.ok(refused.retryAfterMs! > 0 && refused.retryAfterMs! <= HOUR);

    c.advance(HOUR + 1);
    assert.equal((await g.tryAttempt('fresh-wallet-later', '203.0.113.7')).allowed, true);
  });

  it('caps total Claude calls across every IP and wallet', async () => {
    const c = clock();
    const g = new MemoryGuards(c.now);
    for (let i = 0; i < limits.globalPerHour; i++) {
      assert.equal((await g.tryAttempt(`w-${i}`, `ip-${i}`)).allowed, true);
    }
    const refused = await g.tryAttempt('w-last', 'ip-last');
    assert.equal(refused.limit, 'global');
  });

  it('refunds an attempt that failed on our side', async () => {
    const g = new MemoryGuards(clock().now);
    const a = await g.tryAttempt('wallet-B', '10.1.1.1');
    assert.equal(await g.walletRemaining('wallet-B'), limits.walletPerDay - 1);
    await g.releaseAttempt(a.token!);
    assert.equal(await g.walletRemaining('wallet-B'), limits.walletPerDay);
  });
});

describe('test_daily_payout_cap', () => {
  it('stops at the cap and resets the next UTC day', async () => {
    const c = clock();
    const g = new MemoryGuards(c.now);
    const cap = limits.dailyPayoutCapUsd;

    assert.equal(await g.budget.reserve(cap - 1), true);
    assert.equal(await g.budget.reserve(2), false, 'must not overshoot the cap');
    assert.equal(await g.budget.reserve(1), true, 'exactly reaching the cap is allowed');
    assert.equal((await g.budget.status()).remainingUsd, 0);

    c.advance(24 * HOUR);
    assert.equal((await g.budget.status()).usedUsd, 0);
    assert.equal(await g.budget.reserve(1), true);
  });

  it('frees budget on release', async () => {
    const g = new MemoryGuards(clock().now);
    await g.budget.reserve(4);
    await g.budget.release(4);
    assert.equal((await g.budget.status()).usedUsd, 0);
  });
});
