import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAddress, keccak256, toHex } from 'viem';
import { Attribution } from 'ox/erc8021';

import {
  TRANSFER_EXECUTOR_POLICY,
  TRANSFER_RECEIVER_POLICY,
  TRANSFER_SENDER_POLICY,
} from './abi';
import { parseBaseAddress } from './address';
import { computeB20Reward, rawToShares, tokensToRaw, WAD } from './amount';
import { builderCodeSuffix } from './attribution';
import { B20RewardError } from './errors';
import { receiptMemo } from './memo';
import { getBaseNetwork } from './network';
import {
  CORPORATE_ACTION_WINDOW_S,
  corporateActionNear,
  feedPriceUsd,
  guardedPriceUsd,
  MAX_FEED_AGE_S,
  tokenPriceFromUnderlying,
} from './prices';
import { BASE_STOCKS, baseStock, tokenAddressFor } from './stocks';

const NOW = 1_800_000_000;

describe('test_policy_scopes', () => {
  it('match keccak256 of their names, as B20Constants defines them', () => {
    assert.equal(TRANSFER_SENDER_POLICY, keccak256(toHex('TRANSFER_SENDER_POLICY')));
    assert.equal(TRANSFER_RECEIVER_POLICY, keccak256(toHex('TRANSFER_RECEIVER_POLICY')));
    assert.equal(TRANSFER_EXECUTOR_POLICY, keccak256(toHex('TRANSFER_EXECUTOR_POLICY')));
  });
});

describe('test_base_stocks', () => {
  it('lists only valid, checksummed B20 token and feed addresses', () => {
    for (const s of BASE_STOCKS) {
      assert.ok(isAddress(s.token, { strict: true }), `${s.ticker} token checksum`);
      assert.ok(isAddress(s.feed, { strict: true }), `${s.ticker} feed checksum`);
      assert.match(s.token.toLowerCase(), /^0xb2/, `${s.ticker} is a B20 precompile address`);
      assert.notEqual(s.token.toLowerCase(), s.feed.toLowerCase());
    }
  });

  it('has unique slugs and tickers, found case-insensitively', () => {
    assert.equal(new Set(BASE_STOCKS.map((s) => s.slug)).size, BASE_STOCKS.length);
    assert.equal(new Set(BASE_STOCKS.map((s) => s.ticker)).size, BASE_STOCKS.length);
    assert.equal(baseStock('GOOGLc')?.slug, 'google');
    assert.equal(baseStock('googlc')?.slug, 'google');
    assert.equal(baseStock(' Google ')?.ticker, 'GOOGLc');
    assert.equal(baseStock('nope'), undefined);
  });

  it('pays the real token on mainnet and refuses Sepolia without a stand-in', () => {
    const apple = baseStock('apple')!;
    assert.equal(tokenAddressFor(apple, 'mainnet'), apple.token);
    assert.throws(() => tokenAddressFor(apple, 'sepolia'), /No Base Sepolia stand-in/);
  });
});

describe('test_parse_base_address', () => {
  const checksummed = '0x52908400098527886E0F7030069857D2E4169EE7';

  it('accepts a valid checksum and lowercase, returning the checksummed form', () => {
    assert.equal(parseBaseAddress(checksummed), checksummed);
    assert.equal(parseBaseAddress(checksummed.toLowerCase()), checksummed);
    assert.equal(parseBaseAddress(`  ${checksummed}  `), checksummed);
  });

  it('refuses a mixed-case address whose checksum fails', () => {
    const broken = checksummed.slice(0, -1) + 'e'; // flips the case of the last character
    assert.equal(parseBaseAddress(broken), null);
  });

  it('refuses sinks: zero, precompiles, and the stock tokens themselves', () => {
    assert.equal(parseBaseAddress('0x0000000000000000000000000000000000000000'), null);
    assert.equal(parseBaseAddress('0x8453000000000000000000000000000000000002'), null);
    assert.equal(parseBaseAddress(BASE_STOCKS[0].token), null);
    assert.equal(parseBaseAddress(BASE_STOCKS[0].feed), null);
  });

  it('refuses anything that is not a 20-byte hex address', () => {
    for (const v of [undefined, null, 42, '', '0x123', 'So11111111111111111111111111111111111111112']) {
      assert.equal(parseBaseAddress(v), null);
    }
  });
});

describe('test_b20_amounts', () => {
  const base = { spendUsd: 20, pctBack: 2, tokenPriceUsd: 200, decimals: 18, multiplierWad: WAD };

  it('sends reward / token price, in raw units', () => {
    const r = computeB20Reward(base);
    assert.equal(r.rewardUsd, 0.4);
    assert.equal(r.rawAmount, 2_000_000_000_000_000n); // 0.002 tokens at 18 decimals
    assert.equal(r.tokenAmount, 0.002);
    assert.equal(r.shares, 0.002);
  });

  it('applies the multiplier to shares, never to the raw amount', () => {
    const r = computeB20Reward({ ...base, multiplierWad: (WAD * 102n) / 100n });
    assert.equal(r.rawAmount, 2_000_000_000_000_000n);
    assert.ok(Math.abs(r.shares - 0.00204) < 1e-15);
  });

  it('works at 6 decimals', () => {
    const r = computeB20Reward({ ...base, decimals: 6 });
    assert.equal(r.rawAmount, 2_000n);
  });

  it('works at the live tokens’ 8 decimals (GOOGLc on 25 Nov 2026)', () => {
    const multiplierWad = 1_000_377_000_000_000_000n;
    const r = computeB20Reward({ ...base, tokenPriceUsd: 277.52, decimals: 8, multiplierWad });
    assert.equal(r.rawAmount, 144_133n); // floor(0.40 / 277.52 × 1e8)
    assert.ok((Number(r.rawAmount) / 1e8) * 277.52 <= 0.4);
    assert.ok(r.shares > r.tokenAmount, 'dividends make one token worth more than one share');
  });

  it('never overpays: raw × price ≤ reward, across awkward values', () => {
    for (const [spend, pct, price] of [
      [3.37, 3, 187.13],
      [12.99, 2, 431.7],
      [0.99, 4, 0.333],
      [999.99, 1, 1234.5678],
    ]) {
      const r = computeB20Reward({ ...base, spendUsd: spend, pctBack: pct, tokenPriceUsd: price });
      const paidUsd = (Number(r.rawAmount) / 1e18) * price;
      assert.ok(paidUsd <= r.rewardUsd + 1e-12, `${spend}/${pct}/${price}: paid ${paidUsd} > ${r.rewardUsd}`);
    }
  });

  it('floors token units to raw', () => {
    assert.equal(tokensToRaw(0.1, 18), 100_000_000_000_000_000n);
    assert.equal(tokensToRaw(1.9999999, 6), 1_999_999n);
    assert.throws(() => tokensToRaw(-1, 18), B20RewardError);
    assert.throws(() => tokensToRaw(Number.NaN, 18), B20RewardError);
  });

  it('derives shares as toUIAmount would', () => {
    assert.equal(rawToShares(1_000_000n, (WAD * 3n) / 2n, 6), 1.5);
  });

  it('refuses inputs that cannot produce a correct transfer', () => {
    assert.throws(() => computeB20Reward({ ...base, spendUsd: 0 }), B20RewardError);
    assert.throws(() => computeB20Reward({ ...base, pctBack: 0 }), B20RewardError);
    assert.throws(() => computeB20Reward({ ...base, pctBack: 101 }), B20RewardError);
    assert.throws(() => computeB20Reward({ ...base, tokenPriceUsd: 0 }), B20RewardError);
    assert.throws(() => computeB20Reward({ ...base, decimals: 5 }), /decimals/);
    assert.throws(() => computeB20Reward({ ...base, decimals: 19 }), /decimals/);
    assert.throws(() => computeB20Reward({ ...base, multiplierWad: 0n }), /multiplier/);
  });

  it('refuses a reward that rounds to zero', () => {
    assert.throws(
      () => computeB20Reward({ ...base, spendUsd: 0.01, pctBack: 1, tokenPriceUsd: 1e9, decimals: 6 }),
      /rounds to zero/,
    );
  });
});

describe('test_payout_prices', () => {
  const round = (usd: number, ageS: number) => ({
    answer: BigInt(Math.round(usd * 1e8)),
    decimals: 8,
    updatedAt: BigInt(NOW - ageS),
  });

  it('reads a fresh feed', () => {
    assert.equal(feedPriceUsd(round(212.34, 3600), NOW), 212.34);
  });

  it('refuses a stale, future, missing or non-positive feed', () => {
    assert.equal(feedPriceUsd(round(212.34, MAX_FEED_AGE_S + 1), NOW), null);
    assert.equal(feedPriceUsd(round(212.34, -3600), NOW), null);
    assert.equal(feedPriceUsd(round(0, 60), NOW), null);
    assert.equal(feedPriceUsd({ answer: -1n, decimals: 8, updatedAt: BigInt(NOW) }, NOW), null);
    assert.equal(feedPriceUsd(null, NOW), null);
  });

  it('prices one token as underlying × multiplier', () => {
    assert.ok(Math.abs(tokenPriceFromUnderlying(200, (WAD * 102n) / 100n)! - 204) < 1e-9);
    assert.equal(tokenPriceFromUnderlying(null, WAD), null);
    assert.equal(tokenPriceFromUnderlying(200, 0n), null);
    assert.equal(tokenPriceFromUnderlying(Number.NaN, WAD), null);
  });

  it('pays at the higher price, and refuses when sources disagree by more than 25%', () => {
    assert.equal(guardedPriceUsd([200, 210]), 210);
    assert.equal(guardedPriceUsd([200, null]), 200);
    assert.equal(guardedPriceUsd([200, 250]), 250); // exactly 25%: still trusted
    assert.equal(guardedPriceUsd([200, 251]), null);
    assert.equal(guardedPriceUsd([Number.NaN, -5, null, undefined]), null);
    assert.equal(guardedPriceUsd([]), null);
  });

  it('pauses near a scheduled multiplier change, either side', () => {
    assert.equal(corporateActionNear(null, NOW), false);
    assert.equal(corporateActionNear(0n, NOW), false);
    assert.equal(corporateActionNear(BigInt(NOW + 3600), NOW), true);
    assert.equal(corporateActionNear(BigInt(NOW - 3600), NOW), true);
    assert.equal(corporateActionNear(BigInt(NOW + CORPORATE_ACTION_WINDOW_S + 1), NOW), false);
    assert.equal(corporateActionNear(BigInt(NOW - CORPORATE_ACTION_WINDOW_S - 1), NOW), false);
  });
});

describe('test_receipt_memo', () => {
  const secret = 'a'.repeat(64);

  it('is a deterministic bytes32 per receipt', () => {
    const memo = receiptMemo('mcd|2026-11-20|3.44|1234', secret);
    assert.match(memo, /^0x[0-9a-f]{64}$/);
    assert.equal(receiptMemo('mcd|2026-11-20|3.44|1234', secret), memo);
    assert.notEqual(receiptMemo('mcd|2026-11-20|3.44|1235', secret), memo);
  });

  it('depends on the secret, so it cannot be confirmed by guessing the receipt', () => {
    assert.notEqual(receiptMemo('x', secret), receiptMemo('x', 'b'.repeat(64)));
  });

  it('refuses a short secret or a missing fingerprint', () => {
    assert.throws(() => receiptMemo('x', 'short'), /BASE_MEMO_SECRET/);
    assert.throws(() => receiptMemo('', secret), /fingerprint/);
  });
});

describe('test_builder_code_suffix', () => {
  it('is absent without a code', () => {
    assert.equal(builderCodeSuffix(undefined), undefined);
    assert.equal(builderCodeSuffix('  '), undefined);
  });

  it('ends with the ERC-8021 marker and round-trips the code', () => {
    const suffix = builderCodeSuffix('bc_stackd')!;
    assert.ok(suffix.endsWith(Attribution.ercSuffix.slice(2)));
    assert.deepEqual(Attribution.fromData(`0xa9059cbb${suffix.slice(2)}`)?.codes, ['bc_stackd']);
  });

  it('refuses a malformed code', () => {
    assert.throws(() => builderCodeSuffix('has space'), /BASE_BUILDER_CODE/);
  });
});

describe('test_base_network', () => {
  function withEnv(value: string | undefined, fn: () => void): void {
    const saved = process.env.BASE_NETWORK;
    const savedPublic = process.env.NEXT_PUBLIC_BASE_NETWORK;
    delete process.env.NEXT_PUBLIC_BASE_NETWORK;
    if (value === undefined) delete process.env.BASE_NETWORK;
    else process.env.BASE_NETWORK = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.BASE_NETWORK;
      else process.env.BASE_NETWORK = saved;
      if (savedPublic !== undefined) process.env.NEXT_PUBLIC_BASE_NETWORK = savedPublic;
    }
  }

  it('is off unless named, and never guesses', () => {
    withEnv(undefined, () => assert.equal(getBaseNetwork(), null));
    withEnv('off', () => assert.equal(getBaseNetwork(), null));
    withEnv('Mainnet', () => assert.equal(getBaseNetwork(), 'mainnet'));
    withEnv('sepolia', () => assert.equal(getBaseNetwork(), 'sepolia'));
    withEnv('mainet', () => assert.throws(() => getBaseNetwork(), /BASE_NETWORK/));
  });
});
