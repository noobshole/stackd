import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';

import { WAD } from './amount';
import type { TokenState } from './chain';
import { B20PayoutPausedError, B20PayoutUnconfirmedError, B20RewardError } from './errors';
import { receiptMemo } from './memo';
import type { FeedRound } from './prices';
import {
  GAS_ALLOWANCE_USD,
  sendB20Reward,
  type B20RewardDeps,
  type B20RewardStore,
  type PayoutBudget,
  type SubmitB20Args,
  type TxOutcome,
} from './rewards';
import { baseStock } from './stocks';

const NOW = 1_800_000_000;
const SECRET = 'f'.repeat(64);
const RECIPIENT = '0x52908400098527886E0F7030069857D2E4169EE7';
const TREASURY = '0x000000000000000000000000000000000000dEaD' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const GOOGL = baseStock('google')!;

const PARAMS = {
  receiptId: 'r1',
  recipientWallet: RECIPIENT,
  stock: 'google',
  spendUsd: 20,
  pctBack: 2,
  fingerprint: 'google|2026-11-24|20.00|GPA.1234',
};

function healthyState(over: Partial<TokenState> = {}): TokenState {
  return {
    decimals: 18,
    multiplierWad: WAD,
    transfersPaused: false,
    treasuryAllowed: true,
    recipientAllowed: true,
    treasuryBalance: 100n * WAD,
    multiplierChangeAt: null,
    ...over,
  };
}

const feedAt = (usd: number, ageS = 3600): FeedRound => ({
  answer: BigInt(Math.round(usd * 1e8)),
  decimals: 8,
  updatedAt: BigInt(NOW - ageS),
});

function harness(opts: {
  paid?: string | null;
  claimable?: boolean;
  state?: Partial<TokenState>;
  feed?: FeedRound | null;
  underlying?: number | null;
  outcome?: TxOutcome;
  submitError?: Error;
  budgetRoom?: boolean;
  memoSecret?: string;
} = {}) {
  const events: string[] = [];
  let txSignature: string | null = opts.paid ?? null;
  let claimed = opts.claimable === false;

  const store: B20RewardStore = {
    async get() {
      return { txSignature };
    },
    async claimLeg() {
      events.push('claim');
      if (claimed || txSignature) return false;
      claimed = true;
      return true;
    },
    async releaseLeg() {
      events.push('release');
      claimed = false;
    },
    async recordPayout(_id, _leg, signature) {
      events.push(`payout:${signature}`);
      txSignature = signature;
    },
    async recordXStockAmount(_id, amount) {
      events.push(`amount:${amount}`);
    },
    async recordSentTx(_id, hash) {
      events.push(`sent:${hash}`);
    },
  };

  const budgetCalls: string[] = [];
  const budget: PayoutBudget = {
    async reserve(usd) {
      budgetCalls.push(`reserve:${usd}`);
      return opts.budgetRoom ?? true;
    },
    async release(usd) {
      budgetCalls.push(`release:${usd}`);
    },
  };

  const submitted: SubmitB20Args[] = [];
  let locks = 0;

  const deps: Partial<B20RewardDeps> & { store: B20RewardStore } = {
    store,
    budget,
    network: 'mainnet',
    treasuryAddress: TREASURY,
    readTokenState: async () => {
      events.push('state');
      return healthyState(opts.state);
    },
    readFeedRound: async () => ('feed' in opts ? opts.feed! : feedAt(200)),
    fetchUnderlyingUsd: async () => ('underlying' in opts ? opts.underlying! : null),
    submit: async (args, onSigned) => {
      events.push('submit');
      if (opts.submitError) throw opts.submitError;
      submitted.push(args);
      await onSigned(HASH);
      return HASH;
    },
    waitForReceipt: async () => {
      events.push('wait');
      return opts.outcome ?? 'success';
    },
    memoSecret: opts.memoSecret ?? SECRET,
    builderSuffix: '0x1234',
    withSendLock: async (fn) => {
      locks++;
      return fn();
    },
    now: () => NOW,
  };

  return { deps, events, budgetCalls, submitted, locks: () => locks };
}

describe('test_send_b20_reward', () => {
  it('pays once: memo, builder suffix, hash recorded before confirming, then the payout', async () => {
    const h = harness();
    const hash = await sendB20Reward(PARAMS, h.deps);

    assert.equal(hash, HASH);
    assert.equal(h.submitted.length, 1);
    const [args] = h.submitted;
    assert.equal(args.token, GOOGL.token);
    assert.equal(args.recipient, RECIPIENT);
    assert.equal(args.rawAmount, 2_000_000_000_000_000n); // $0.40 at $200 a token
    assert.equal(args.memo, receiptMemo(PARAMS.fingerprint, SECRET));
    assert.equal(args.dataSuffix, '0x1234');
    assert.equal(h.locks(), 1);

    assert.ok(h.events.indexOf(`sent:${HASH}`) < h.events.indexOf('wait'), 'hash stored before waiting');
    assert.ok(h.events.includes(`payout:${HASH}`));
    assert.ok(!h.events.includes('release'));
    assert.deepEqual(h.budgetCalls, [`reserve:${0.4 + GAS_ALLOWANCE_USD}`]);
  });

  it('is idempotent: a paid receipt returns its hash and sends nothing', async () => {
    const h = harness({ paid: HASH });
    assert.equal(await sendB20Reward(PARAMS, h.deps), HASH);
    assert.equal(h.submitted.length, 0);
    assert.ok(!h.events.includes('claim'));
  });

  it('refuses while another payout of the same receipt is in flight', async () => {
    const h = harness({ claimable: false });
    await assert.rejects(sendB20Reward(PARAMS, h.deps), /already in flight/);
    assert.equal(h.submitted.length, 0);
  });

  it('refuses an unknown stock or a bad address before claiming anything', async () => {
    const a = harness();
    await assert.rejects(sendB20Reward({ ...PARAMS, stock: 'costco' }, a.deps), /not a Base stock/);
    const b = harness();
    await assert.rejects(sendB20Reward({ ...PARAMS, recipientWallet: 'nope' }, b.deps), /not a Base address/);
    assert.ok(!a.events.includes('claim') && !b.events.includes('claim'));
  });

  it('pays at the higher of feed and underlying × multiplier', async () => {
    const h = harness({ feed: feedAt(200), underlying: 210 });
    await sendB20Reward(PARAMS, h.deps);
    const expected = BigInt(Math.floor((0.4 / 210) * 1e12)) * 1_000_000n;
    assert.equal(h.submitted[0].rawAmount, expected);
  });

  it('falls back to the underlying price when the feed is stale', async () => {
    const h = harness({ feed: feedAt(200, 10 * 24 * 3600), underlying: 250 });
    await sendB20Reward(PARAMS, h.deps);
    assert.equal(h.submitted[0].rawAmount, 1_600_000_000_000_000n); // $0.40 at $250
  });

  const refusals: Array<[string, Parameters<typeof harness>[0], RegExp]> = [
    ['transfers paused', { state: { transfersPaused: true } }, /paused by the issuer/],
    ['corporate action near', { state: { multiplierChangeAt: BigInt(NOW + 3600) } }, /corporate action/],
    ['recipient blocked by policy', { state: { recipientAllowed: false } }, /transfer rules/],
    ['treasury blocked by policy', { state: { treasuryAllowed: false } }, /treasury can't send/],
    ['sources disagree', { feed: feedAt(200), underlying: 300 }, /No trustworthy price/],
    ['no price at all', { feed: null, underlying: null }, /No trustworthy price/],
    ['treasury out of stock', { state: { treasuryBalance: 1n } }, /out of GOOGLc/],
  ];

  for (const [name, opts, message] of refusals) {
    it(`refuses and frees the claim when ${name}, with nothing reserved or sent`, async () => {
      const h = harness(opts);
      await assert.rejects(sendB20Reward(PARAMS, h.deps), message);
      assert.equal(h.submitted.length, 0);
      assert.ok(h.events.includes('release'));
      assert.deepEqual(h.budgetCalls, []);
    });
  }

  it("pauses at the daily cap, releasing the claim (nothing was reserved)", async () => {
    const h = harness({ budgetRoom: false });
    await assert.rejects(sendB20Reward(PARAMS, h.deps), B20PayoutPausedError);
    assert.equal(h.submitted.length, 0);
    assert.ok(h.events.includes('release'));
    assert.deepEqual(h.budgetCalls, [`reserve:${0.4 + GAS_ALLOWANCE_USD}`]);
  });

  it('frees claim and budget when the transfer reverts', async () => {
    const h = harness({ outcome: 'reverted' });
    await assert.rejects(sendB20Reward(PARAMS, h.deps), /reverted/);
    assert.ok(h.events.includes('release'));
    assert.ok(h.budgetCalls.some((c) => c.startsWith('release:')));
  });

  it('frees claim and budget when submit fails before broadcast', async () => {
    const h = harness({ submitError: new B20RewardError('simulation failed: PolicyForbids') });
    await assert.rejects(sendB20Reward(PARAMS, h.deps), /simulation failed/);
    assert.ok(h.events.includes('release'));
    assert.ok(h.budgetCalls.some((c) => c.startsWith('release:')));
  });

  it('keeps claim and budget when the outcome is unknown, so a retry cannot pay twice', async () => {
    const h = harness({ outcome: 'timeout' });
    await assert.rejects(sendB20Reward(PARAMS, h.deps), B20PayoutUnconfirmedError);
    assert.ok(!h.events.includes('release'));
    assert.ok(!h.budgetCalls.some((c) => c.startsWith('release:')));
    assert.ok(h.events.includes(`sent:${HASH}`), 'the hash is there to reconcile from');
  });

  it('keeps claim and budget when submit reports an unconfirmed broadcast', async () => {
    const h = harness({ submitError: new B20PayoutUnconfirmedError(HASH) });
    await assert.rejects(sendB20Reward(PARAMS, h.deps), B20PayoutUnconfirmedError);
    assert.ok(!h.events.includes('release'));
  });

  it('fails before touching the chain when the memo secret is missing', async () => {
    const h = harness({ memoSecret: '' });
    await assert.rejects(sendB20Reward(PARAMS, h.deps), /BASE_MEMO_SECRET/);
    assert.ok(!h.events.includes('state'));
    assert.ok(h.events.includes('release'));
  });
});
