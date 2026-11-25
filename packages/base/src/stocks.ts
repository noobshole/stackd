/**
 * Coinbase-issued tokenized stocks on Base that Stackd pays out. Browser-safe.
 *
 * Only stocks with a Chainlink feed on Base are listed: a payout needs a price
 * that does not come from a thin DEX pool. Each token is a B20 Asset precompile;
 * each feed reports the token's total-return value (underlying price × the
 * token's multiplier), 8 decimals, 24/5.
 *
 * Addresses are copied from docs.base.org ("List Tokenized Stocks", synced
 * 23 November 2026). `npm run base:check` reads symbol() at each address and
 * checks it against `ticker`, so a wrong copy shows up before any payout.
 *
 * Brand identity (receipt matching, email domains, cashback rate) lives in the
 * shared brand list. This table holds only what is specific to Base.
 */

import type { Address } from 'viem';
import type { BaseNetwork } from './network';
import { SEPOLIA_TOKENS } from './sepolia-tokens';

export interface BaseStock {
  /** The brand slug shared with the rest of the app. */
  slug: string;
  /** Token symbol on Base, e.g. "GOOGLc". */
  ticker: string;
  /** Issuer of the underlying listed equity. */
  company: string;
  /** Underlying listed ticker, e.g. "GOOGL". */
  underlying: string;
  /** B20 token on Base mainnet. Identify tokens by address, never by symbol. */
  token: Address;
  /** Chainlink feed proxy on Base mainnet. A price oracle, not a token. */
  feed: Address;
}

export const BASE_STOCKS: readonly BaseStock[] = [
  {
    slug: 'apple',
    ticker: 'AAPLc',
    company: 'Apple Inc.',
    underlying: 'AAPL',
    token: '0xb200000000000000000000C2e324d24d7eEcd1fb',
    feed: '0x787f13dEa48Db0897CbCDD985de77809D837F988',
  },
  {
    slug: 'amazon',
    ticker: 'AMZNc',
    company: 'Amazon.com Inc.',
    underlying: 'AMZN',
    token: '0xb200000000000000000000d9192b6B456483C2E8',
    feed: '0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295',
  },
  {
    slug: 'google',
    ticker: 'GOOGLc',
    company: 'Alphabet Inc.',
    underlying: 'GOOGL',
    token: '0xb2000000000000000000002D0BA3164cc74f58B7',
    feed: '0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2',
  },
  {
    slug: 'microsoft',
    ticker: 'MSFTc',
    company: 'Microsoft Corporation',
    underlying: 'MSFT',
    token: '0xB200000000000000000000Ab99cFa739E253872B',
    feed: '0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c',
  },
];

const BY_KEY: ReadonlyMap<string, BaseStock> = new Map(
  BASE_STOCKS.flatMap((s) => [
    [s.slug, s],
    [s.ticker.toLowerCase(), s],
  ]),
);

/** Look a stock up by brand slug or token ticker (case-insensitive). */
export function baseStock(slugOrTicker: string): BaseStock | undefined {
  return BY_KEY.get(slugOrTicker.trim().toLowerCase());
}

/**
 * The token to pay out on `network`. Base Sepolia has no Coinbase stocks, so a
 * test run uses a stand-in token from sepolia-tokens.ts and refuses without one.
 */
export function tokenAddressFor(stock: BaseStock, network: BaseNetwork): Address {
  if (network === 'mainnet') return stock.token;
  const standIn = SEPOLIA_TOKENS[stock.ticker];
  if (!standIn) {
    throw new Error(
      `No Base Sepolia stand-in token for ${stock.ticker}. Add one to packages/base/src/sepolia-tokens.ts.`,
    );
  }
  return standIn;
}
