/**
 * FX conversion tests.
 *
 * Run: npm test --workspace=@stackd/api
 *
 * No network: fetch is injected. Rates below are the real ECB reference rates
 * Frankfurter served for 2026-09-17.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FxUnavailableError, UnsupportedCurrencyError, createFxConverter } from './fx.js';

const RATE_DATE = '2026-09-17';
const NOW = Date.parse('2026-09-18T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const RATES = { IDR: 17727, JPY: 155.69, SGD: 1.2753, HKD: 7.8452, EUR: 0.871 };

function fakeFetch(body: unknown = { amount: 1, base: 'USD', date: RATE_DATE, rates: RATES }) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function failingFetch(status?: number) {
  return (async () => {
    if (status) return new Response('nope', { status });
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

describe('test_fx_conversion', () => {
  it('converts IDR at the USD-based rate', async () => {
    const toUsd = createFxConverter({ fetch: fakeFetch().fn, now: () => NOW });
    const result = await toUsd(50_000, 'IDR');
    assert.equal(result.currency, 'IDR');
    assert.equal(result.rate, 17727);
    assert.equal(result.rateDate, RATE_DATE);
    assert.ok(Math.abs(result.amountUsd - 2.8206) < 0.0001, `got ${result.amountUsd}`);
  });

  it('prices 900 JPY at about $5.78, not $900', async () => {
    const toUsd = createFxConverter({ fetch: fakeFetch().fn, now: () => NOW });
    const { amountUsd } = await toUsd(900, 'JPY');
    assert.ok(amountUsd > 5.7 && amountUsd < 5.9, `got ${amountUsd}`);
  });

  it('passes USD through without touching the network', async () => {
    const spy = fakeFetch();
    const toUsd = createFxConverter({ fetch: spy.fn, now: () => NOW });
    const result = await toUsd(12.5, 'usd');
    assert.deepEqual(result, {
      amountUsd: 12.5,
      currency: 'USD',
      originalAmount: 12.5,
      rate: 1,
      rateDate: null,
    });
    assert.equal(spy.calls.length, 0);
  });
});

describe('test_fx_refuses', () => {
  it('refuses a currency the source does not cover', async () => {
    const toUsd = createFxConverter({ fetch: fakeFetch().fn, now: () => NOW });
    await assert.rejects(toUsd(150, 'TWD'), UnsupportedCurrencyError);
  });

  it('refuses a malformed currency without fetching', async () => {
    const spy = fakeFetch();
    const toUsd = createFxConverter({ fetch: spy.fn, now: () => NOW });
    for (const bad of ['US$', '$', 'Rupiah', 'ID R', '', '__proto__']) {
      await assert.rejects(toUsd(10, bad), UnsupportedCurrencyError, `accepted "${bad}"`);
    }
    assert.equal(spy.calls.length, 0);
  });

  it('drops zero, negative and non-numeric rates instead of dividing by them', async () => {
    const body = { base: 'USD', date: RATE_DATE, rates: { AAA: 0, BBB: -3, CCC: 'x', IDR: 17727 } };
    const toUsd = createFxConverter({ fetch: fakeFetch(body).fn, now: () => NOW });
    for (const code of ['AAA', 'BBB', 'CCC']) {
      await assert.rejects(toUsd(10, code), UnsupportedCurrencyError);
    }
    assert.ok((await toUsd(17727, 'IDR')).amountUsd === 1);
  });
});

describe('test_fx_fails_closed', () => {
  it('throws FxUnavailable when the source is unreachable', async () => {
    const toUsd = createFxConverter({ fetch: failingFetch(), now: () => NOW });
    await assert.rejects(toUsd(50_000, 'IDR'), FxUnavailableError);
  });

  it('throws FxUnavailable on an HTTP error', async () => {
    const toUsd = createFxConverter({ fetch: failingFetch(503), now: () => NOW });
    await assert.rejects(toUsd(50_000, 'IDR'), FxUnavailableError);
  });

  it('throws FxUnavailable on an unexpected body', async () => {
    const body = { base: 'EUR', date: RATE_DATE, rates: RATES };
    const toUsd = createFxConverter({ fetch: fakeFetch(body).fn, now: () => NOW });
    await assert.rejects(toUsd(50_000, 'IDR'), FxUnavailableError);
  });

  it('refuses rates older than five days', async () => {
    const body = { base: 'USD', date: '2026-09-10', rates: RATES };
    const toUsd = createFxConverter({ fetch: fakeFetch(body).fn, now: () => NOW });
    await assert.rejects(toUsd(50_000, 'IDR'), FxUnavailableError);
  });
});

describe('test_fx_cache', () => {
  it('fetches once per hour, then refreshes', async () => {
    let now = NOW;
    const spy = fakeFetch();
    const toUsd = createFxConverter({ fetch: spy.fn, now: () => now });

    await toUsd(1, 'IDR');
    await toUsd(1, 'JPY');
    assert.equal(spy.calls.length, 1);

    now += HOUR + 1;
    await toUsd(1, 'IDR');
    assert.equal(spy.calls.length, 2);
  });

  it('shares one fetch across concurrent requests', async () => {
    const spy = fakeFetch();
    const toUsd = createFxConverter({ fetch: spy.fn, now: () => NOW });
    await Promise.all([toUsd(1, 'IDR'), toUsd(1, 'JPY'), toUsd(1, 'SGD')]);
    assert.equal(spy.calls.length, 1);
  });

  it('falls back to the last good rates when a refresh fails', async () => {
    let now = NOW;
    let healthy = true;
    const good = fakeFetch();
    const fetchFn = (async (url: string) => {
      if (!healthy) throw new TypeError('fetch failed');
      return good.fn(url);
    }) as unknown as typeof fetch;
    const toUsd = createFxConverter({ fetch: fetchFn, now: () => now });

    await toUsd(1, 'IDR');
    healthy = false;
    now += 2 * HOUR;
    assert.equal((await toUsd(17727, 'IDR')).amountUsd, 1);
  });

  it('stops falling back once the cached rates go stale', async () => {
    let now = NOW;
    let healthy = true;
    const good = fakeFetch();
    const fetchFn = (async (url: string) => {
      if (!healthy) throw new TypeError('fetch failed');
      return good.fn(url);
    }) as unknown as typeof fetch;
    const toUsd = createFxConverter({ fetch: fetchFn, now: () => now });

    await toUsd(1, 'IDR');
    healthy = false;
    now += 6 * 24 * HOUR;
    await assert.rejects(toUsd(1, 'IDR'), FxUnavailableError);
  });
});
