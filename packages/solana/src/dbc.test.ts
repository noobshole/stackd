/**
 * Curve config unit tests.
 *
 * Run: npm test --workspace=@stackd/solana
 *
 * buildCurve takes human units and scales them itself. Passing base units makes
 * a pool that looks fine, trades fine, and can never graduate — and the
 * threshold is immutable once the config is on chain. The first devnet launch
 * shipped at 20,000,000 USDC this way. These pin the units so it cannot recur.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  MIGRATION_QUOTE_THRESHOLD_USDC,
  STACKD_TOTAL_SUPPLY,
  USDC_DECIMALS,
  buildStackdCurveConfig,
} from './dbc';

const SAVED_OVERRIDE = process.env.SIM_THRESHOLD_OVERRIDE_USDC;

describe('test_curve_config_units', () => {
  afterEach(() => {
    if (SAVED_OVERRIDE === undefined) delete process.env.SIM_THRESHOLD_OVERRIDE_USDC;
    else process.env.SIM_THRESHOLD_OVERRIDE_USDC = SAVED_OVERRIDE;
  });

  it('mainnet graduates at exactly 750 USDC, scaled once', () => {
    const config = buildStackdCurveConfig('mainnet');
    assert.equal(
      config.migrationQuoteThreshold.toString(),
      String(MIGRATION_QUOTE_THRESHOLD_USDC * 10 ** USDC_DECIMALS),
    );
  });

  it('devnet override is scaled once, not twice', () => {
    process.env.SIM_THRESHOLD_OVERRIDE_USDC = '20';
    const config = buildStackdCurveConfig('devnet');
    assert.equal(config.migrationQuoteThreshold.toString(), '20000000');
  });

  it('mainnet ignores the devnet override', () => {
    process.env.SIM_THRESHOLD_OVERRIDE_USDC = '20';
    const config = buildStackdCurveConfig('mainnet');
    assert.equal(config.migrationQuoteThreshold.toString(), '750000000');
  });

  it('mints exactly 1B $STACKD in base units', () => {
    const config = buildStackdCurveConfig('mainnet');
    const expected = BigInt(STACKD_TOTAL_SUPPLY) * 10n ** 6n;
    assert.equal(config.tokenSupply?.preMigrationTokenSupply.toString(), expected.toString());
  });
});
