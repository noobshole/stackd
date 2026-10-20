/**
 * Demand while paused (in-memory backend; the Postgres backend runs the same
 * logic in SQL and is checked live).
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../receipt-checks.js';
import { MemoryDemand, demandKeyHash } from './demand.js';

const DAY = 24 * 60 * 60 * 1000;

function clock(start = Date.parse('2026-10-20T08:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('test_paused_demand', () => {
  it('totals receipts and their cashback per brand', async () => {
    const d = new MemoryDemand(clock().now);
    assert.equal(await d.record({ ticker: 'MCDx', cashbackUsd: 0.14, keys: ['mcd-1'] }), true);
    assert.equal(await d.record({ ticker: 'MCDx', cashbackUsd: 0.2, keys: ['mcd-2'] }), true);
    assert.equal(await d.record({ ticker: 'NKE', cashbackUsd: 3, keys: ['nke-1'] }), true);

    assert.deepEqual(await d.totals(), [
      { ticker: 'MCDx', receipts: 2, cashbackUsd: 0.34, since: '2026-10-20T08:00:00.000Z' },
      { ticker: 'NKE', receipts: 1, cashbackUsd: 3, since: '2026-10-20T08:00:00.000Z' },
    ]);
  });

  it('counts the same receipt once, however often it is sent', async () => {
    // A paused brand hands the attempt back, so retrying costs the user
    // nothing. The count must not grow with every retry.
    const c = clock();
    const d = new MemoryDemand(c.now);
    assert.equal(await d.record({ ticker: 'MCDx', cashbackUsd: 0.14, keys: ['number-34', 'time-12:41'] }), true);
    c.advance(DAY);
    assert.equal(await d.record({ ticker: 'MCDx', cashbackUsd: 0.14, keys: ['number-34', 'time-12:41'] }), false);

    const [mcd] = await d.totals();
    assert.equal(mcd.receipts, 1);
    assert.equal(mcd.since, '2026-10-20T08:00:00.000Z');
  });

  it('counts a re-photographed receipt once when any one key matches', async () => {
    // Two photos of one receipt can read different numbers but the same time
    // of purchase; the duplicate check treats a shared key as the same receipt.
    const d = new MemoryDemand(clock().now);
    await d.record({ ticker: 'MCDx', cashbackUsd: 0.14, keys: ['ORD #34 -CSO #30', 'time-12:41'] });
    assert.equal(await d.record({ ticker: 'MCDx', cashbackUsd: 0.14, keys: ['34', 'time-12:41'] }), false);
    assert.equal((await d.totals())[0].receipts, 1);
  });

  it('records nothing for a receipt with no keys', async () => {
    const d = new MemoryDemand(clock().now);
    assert.equal(await d.record({ ticker: 'MCDx', cashbackUsd: 0.14, keys: [] }), false);
    assert.deepEqual(await d.totals(), []);
  });

  it('keeps only a one-way hash of each key', () => {
    const key = 'mcdonalds|2026-10-20|3.44|USD|34';
    const hash = demandKeyHash(key);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(!hash.includes('mcdonalds'));
    // Domain-separated: never equal to a plain hash of the same key.
    assert.notEqual(hash, sha256Hex(key));
  });
});
