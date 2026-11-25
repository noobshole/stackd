/**
 * Base Sepolia stand-ins for the stocks in stocks.ts, keyed by ticker.
 *
 * Coinbase deploys its stocks on Base mainnet only, so a test run pays out a
 * test token instead, priced at the real stock's mainnet price. Public
 * addresses, safe to commit. Empty until stand-ins are deployed: until then a
 * Sepolia payout refuses with a clear error rather than guessing.
 */

import type { Address } from 'viem';

export const SEPOLIA_TOKENS: Readonly<Record<string, Address>> = {};
