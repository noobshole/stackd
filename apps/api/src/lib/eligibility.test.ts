/**
 * Who can be paid where: sanctions on both chains, US persons refused on Base.
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DECLARATION_REASON,
  NO_COUNTRY_REASON,
  SANCTIONED_REASON,
  US_REASON,
  checkEligibility,
  countryFrom,
  declaredYes,
  regionFrom,
  type EligibilityInput,
} from './eligibility.js';

const base = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  chain: 'base',
  country: 'ID',
  region: null,
  declaredNotUsPerson: true,
  onVercel: true,
  ...over,
});

const refusal = (input: EligibilityInput) => {
  const result = checkEligibility(input);
  return result.ok ? null : result.reason;
};

describe('test_base_us_gate', () => {
  it('pays a declared non-US person outside the US', () => {
    assert.equal(refusal(base()), null);
  });

  it('refuses a US IP even with the declaration ticked', () => {
    assert.equal(refusal(base({ country: 'US' })), US_REASON);
  });

  it('treats the US territories as the US', () => {
    for (const country of ['PR', 'GU', 'VI', 'AS', 'MP', 'UM']) {
      assert.equal(refusal(base({ country })), US_REASON, country);
    }
  });

  it('requires the declaration, because an IP says nothing about who the person is', () => {
    assert.equal(refusal(base({ declaredNotUsPerson: false })), DECLARATION_REASON);
  });

  it('refuses on Vercel when the country is unknown, rather than guessing', () => {
    assert.equal(refusal(base({ country: null })), NO_COUNTRY_REASON);
  });

  it('lets a local run with no header through, declaration still required', () => {
    assert.equal(refusal(base({ country: null, onVercel: false })), null);
    assert.equal(
      refusal(base({ country: null, onVercel: false, declaredNotUsPerson: false })),
      DECLARATION_REASON,
    );
  });
});

describe('test_sanctions_gate', () => {
  it('refuses sanctioned countries on both chains', () => {
    for (const chain of ['solana', 'base'] as const) {
      for (const country of ['CU', 'IR', 'KP', 'SY']) {
        assert.equal(refusal(base({ chain, country })), SANCTIONED_REASON, `${chain} ${country}`);
      }
    }
  });

  it('refuses sanctioned regions of an otherwise open country', () => {
    assert.equal(refusal(base({ chain: 'solana', country: 'UA', region: '43' })), SANCTIONED_REASON);
    assert.equal(refusal(base({ country: 'UA', region: '14' })), SANCTIONED_REASON);
    assert.equal(refusal(base({ country: 'UA', region: '30' })), null, 'Kyiv is open');
  });

  it('leaves Solana unchanged for everyone else, the US included', () => {
    assert.equal(refusal({ ...base(), chain: 'solana', country: 'US', declaredNotUsPerson: false }), null);
    assert.equal(refusal({ ...base(), chain: 'solana', country: null }), null);
  });
});

describe('test_eligibility_inputs', () => {
  it('normalises the headers and ignores junk', () => {
    assert.equal(countryFrom(' id '), 'ID');
    assert.equal(countryFrom('USA'), null);
    assert.equal(countryFrom(undefined), null);
    assert.equal(regionFrom('43'), '43');
    assert.equal(regionFrom(['43']), null);
  });

  it('counts only an explicit yes as the declaration', () => {
    for (const yes of ['true', 'TRUE', '1', 'yes', 'on', true]) assert.equal(declaredYes(yes), true);
    for (const no of ['false', '', '0', undefined, null, 'no']) assert.equal(declaredYes(no), false);
  });
});
