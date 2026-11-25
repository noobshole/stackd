/**
 * Which chain pays, and the scope its duplicates and budget are counted in.
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { baseEnabled, parseChain, scopeFor } from './chains.js';

const KEYS = ['BASE_NETWORK', 'NEXT_PUBLIC_BASE_NETWORK', 'SOLANA_CLUSTER', 'NEXT_PUBLIC_SOLANA_CLUSTER'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function env(values: Record<string, string | undefined>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('test_parse_chain', () => {
  it('defaults to Solana when the field is missing or empty', () => {
    assert.equal(parseChain(undefined), 'solana');
    assert.equal(parseChain(''), 'solana');
    assert.equal(parseChain(' Solana '), 'solana');
  });

  it('accepts base in any case', () => {
    assert.equal(parseChain('base'), 'base');
    assert.equal(parseChain('BASE'), 'base');
  });

  it('refuses anything else rather than guessing', () => {
    assert.equal(parseChain('ethereum'), null);
    assert.equal(parseChain(['base']), null);
    assert.equal(parseChain(1), null);
  });
});

describe('test_payout_scope', () => {
  it('keeps Base off until BASE_NETWORK names a network', () => {
    env({});
    assert.equal(baseEnabled(), false);
    env({ BASE_NETWORK: 'sepolia' });
    assert.equal(baseEnabled(), true);
  });

  it('puts Base mainnet in the same scope as Solana mainnet, so a receipt pays once across both', () => {
    env({ SOLANA_CLUSTER: 'mainnet', BASE_NETWORK: 'mainnet' });
    assert.equal(scopeFor('solana'), 'mainnet');
    assert.equal(scopeFor('base'), 'mainnet');
  });

  it('keeps a Base Sepolia test run out of the real-money scope', () => {
    env({ SOLANA_CLUSTER: 'mainnet', BASE_NETWORK: 'sepolia' });
    assert.equal(scopeFor('solana'), 'mainnet');
    assert.equal(scopeFor('base'), 'devnet');
  });

  it('throws on a mistyped network instead of defaulting', () => {
    env({ BASE_NETWORK: 'mainet' });
    assert.throws(() => scopeFor('base'), /BASE_NETWORK/);
  });
});
