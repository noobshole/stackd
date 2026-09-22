/**
 * Receipt check tests: date window and fingerprint.
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkReceiptDate,
  eligibleAmountUsd,
  normaliseReceiptNumber,
  normaliseTime,
  positiveNumberEnv,
  receiptFingerprint,
} from './receipt-checks.js';

const NOW = new Date('2026-09-19T12:00:00Z');

describe('test_receipt_date_window', () => {
  const at = (iso: string) => new Date(iso);

  it('accepts a receipt from today and from two weeks ago', () => {
    assert.deepEqual(checkReceiptDate('2026-09-19', NOW, 14), { ok: true, date: '2026-09-19' });
    assert.equal(checkReceiptDate('2026-09-05', NOW, 14).ok, true); // 14.5 days
  });

  it('refuses an old receipt', () => {
    const result = checkReceiptDate('2025-03-02', NOW, 14);
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /last 14 days/);
  });

  it('refuses a receipt dated in the future', () => {
    const result = checkReceiptDate('2026-09-21', NOW, 14); // 36h ahead
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /future/);
  });

  it('allows 24 hours of timezone grace ahead of submission, no more', () => {
    // Already "tomorrow" in Jakarta while it is still today in UTC.
    assert.equal(checkReceiptDate('2026-09-20', NOW, 14).ok, true); // 12h ahead
    // Printed date starts exactly 24h after submission: the edge of the grace.
    assert.equal(checkReceiptDate('2026-09-20', at('2026-09-19T00:00:00Z'), 14).ok, true);
    assert.equal(checkReceiptDate('2026-09-20', at('2026-09-18T23:59:59Z'), 14).ok, false);
  });

  it('allows 24 hours of grace past the maximum age, no more', () => {
    // 2026-09-05T00:00Z + 14 days + 24h = 2026-09-20T00:00Z.
    assert.equal(checkReceiptDate('2026-09-05', at('2026-09-20T00:00:00Z'), 14).ok, true);
    assert.equal(checkReceiptDate('2026-09-05', at('2026-09-20T00:00:01Z'), 14).ok, false);
    assert.equal(checkReceiptDate('2026-09-04', NOW, 14).ok, false); // 15.5 days
  });

  it('measures age from submission time, not the calendar day', () => {
    // Same printed date, same UTC day of submission, different verdicts.
    assert.equal(checkReceiptDate('2026-09-04', at('2026-09-19T23:59:00Z'), 14).ok, false);
    assert.equal(checkReceiptDate('2026-09-05', at('2026-09-19T23:59:00Z'), 14).ok, true);
  });

  it('refuses unreadable and impossible dates', () => {
    for (const bad of ['', '19/09/2026', '2026-02-31', '2026-13-01', 'yesterday']) {
      assert.equal(checkReceiptDate(bad, NOW, 14).ok, false, `accepted "${bad}"`);
    }
  });
});

describe('test_online_order_cap', () => {
  it('caps a large online order at the limit', () => {
    assert.deepEqual(eligibleAmountUsd(300, 'digital_receipt', 100), {
      eligibleUsd: 100,
      capped: true,
    });
  });

  it('leaves an online order under the limit alone', () => {
    assert.deepEqual(eligibleAmountUsd(66.19, 'digital_receipt', 100), {
      eligibleUsd: 66.19,
      capped: false,
    });
    assert.equal(eligibleAmountUsd(100, 'digital_receipt', 100).capped, false);
  });

  it('never caps a paper receipt', () => {
    assert.deepEqual(eligibleAmountUsd(300, 'paper_receipt_photo', 100), {
      eligibleUsd: 300,
      capped: false,
    });
  });
});

describe('test_positive_number_env', () => {
  it('uses the fallback when unset, and refuses anything but a positive number', () => {
    const name = 'STACKD_TEST_LIMIT';
    delete process.env[name];
    assert.equal(positiveNumberEnv(name, 14), 14);
    process.env[name] = ' 30 ';
    assert.equal(positiveNumberEnv(name, 14), 30);
    for (const bad of ['abc', '0', '-5', 'Infinity']) {
      process.env[name] = bad;
      assert.throws(() => positiveNumberEnv(name, 14), /positive number/, `accepted "${bad}"`);
    }
    delete process.env[name];
  });
});

describe('test_receipt_fingerprint', () => {
  const base = {
    brandSlug: 'mcdonalds',
    date: '2026-09-18',
    totalAmount: 50_000,
    currency: 'IDR',
    receiptNumber: 'TRX-0012 3456',
    time: '14:32',
  };

  it('is stable across OCR noise in the transaction number', () => {
    const a = receiptFingerprint(base);
    const b = receiptFingerprint({ ...base, receiptNumber: 'trx 00123456', currency: 'idr' });
    const c = receiptFingerprint({ ...base, receiptNumber: 'TRX-OO12 3456' }); // O read for 0
    assert.equal(a.ok && b.ok && c.ok, true);
    const fp = (r: typeof a) => (r.ok ? r.fingerprint : '');
    assert.equal(fp(a), fp(b));
    assert.equal(fp(a), fp(c));
  });

  it('separates two strangers buying the same meal on the same day', () => {
    const a = receiptFingerprint(base);
    const b = receiptFingerprint({ ...base, receiptNumber: 'TRX-00123457' });
    assert.notEqual(a.ok && a.fingerprint, b.ok && b.fingerprint);
  });

  it('treats 3.1 and 3.10 as the same total', () => {
    const a = receiptFingerprint({ ...base, totalAmount: 3.1, currency: 'USD' });
    const b = receiptFingerprint({ ...base, totalAmount: 3.1 + 1e-12, currency: 'USD' });
    assert.equal(a.ok && a.fingerprint, b.ok && b.fingerprint);
  });

  it('falls back to the time of purchase when there is no number', () => {
    const r = receiptFingerprint({ ...base, receiptNumber: '', time: '2:32 PM' });
    const r24 = receiptFingerprint({ ...base, receiptNumber: '', time: '14:32:07' });
    assert.equal(r.ok && r.fingerprint, r24.ok && r24.fingerprint);
    assert.equal(r.ok && r.fingerprints.length, 1);
  });

  it('keys a receipt on its number AND its time', () => {
    const r = receiptFingerprint(base);
    assert.equal(r.ok && r.fingerprints.length, 2);
    assert.equal(r.ok && r.fingerprint, r.ok && r.fingerprints[0]);
    assert.equal(r.ok && r.receiptTime, '14:32');
  });

  it('matches two photos of one receipt read with different numbers', () => {
    // Observed on devnet: one McDonald's receipt, photographed twice, read as
    // "ORD #34 -CSO #30" and as "34". The time key still ties them together.
    const first = receiptFingerprint({ ...base, receiptNumber: 'ORD #34 -CSO #30', time: '15:11:06' });
    const second = receiptFingerprint({ ...base, receiptNumber: '34', time: '15:11' });
    assert.ok(first.ok && second.ok);
    if (!first.ok || !second.ok) return;
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.ok(second.fingerprints.some((key) => first.fingerprints.includes(key)));
  });

  it('refuses a receipt with neither a number nor a time', () => {
    const r = receiptFingerprint({ ...base, receiptNumber: '', time: '' });
    assert.equal(r.ok, false);
  });

  it('normalises numbers and times', () => {
    assert.equal(normaliseReceiptNumber(' #000-123 '), '123');
    assert.equal(normaliseTime('9:05 pm'), '21:05');
    assert.equal(normaliseTime('12:15 AM'), '00:15');
    assert.equal(normaliseTime('25:00'), '');
  });
});
