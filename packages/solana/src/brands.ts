/**
 * Stackd brand → tokenized-equity mapping.
 *
 * Selection rule: a brand earns a slot only if BOTH are true —
 *   1. ordinary people hold receipts from it, and
 *   2. its token has real DEX liquidity, so the treasury can actually be
 *      stocked with it.
 *
 * Rule 2 is why Starbucks is absent. SBUXx exists but has no routable market
 * on any Solana DEX, so there is no way to buy inventory to pay anyone with.
 * Listing a brand we cannot pay out would be a lie on the brands page.
 *
 * TWO ISSUERS, DIFFERENT MECHANICS — verified on-chain 2026-09-17:
 *   Backed Finance  (`xstocks` tag)  — 8 decimals, live scaled-UI multipliers
 *   Backpack Securities (`backpack`) — 6 decimals, multiplier 1.0
 *
 * Both are Token-2022, neither is frozen-by-default, neither has a transfer
 * hook, so both airdrop to a fresh wallet. Both retain a permanent delegate —
 * standard for regulated RWAs, worth knowing when describing custody.
 *
 * Never assume decimals or multiplier per issuer. Read them per mint and route
 * every amount through toRawAmount() in scaled-amount.ts.
 */

import { getCluster, type Cluster } from './cluster';
import { DEVNET_MINTS } from './devnet-mints';

export type Issuer = 'Backed Finance' | 'Backpack Securities';

export interface Brand {
  /** Stable slug used in URLs and the DB. */
  slug: string;
  /** Display name shown in the UI and matched against Claude's merchant_name. */
  name: string;
  /** Token ticker as it trades, e.g. "MCDx" or "NKE". */
  ticker: string;
  /** Token-2022 mint address on Solana mainnet. */
  mint: string;
  /** Mint decimals. Backed is 8, Backpack is 6 — never assume. */
  decimals: number;
  /** Who issues and collateralises the token. */
  issuer: Issuer;
  /** Cashback percentage of the receipt total, paid in the token. */
  pctBack: number;
  /** Underlying listed equity, for the "what you actually own" copy. */
  underlying: string;
  /** Retail category, used for the brands grid grouping. */
  category: string;
  /** Alternate merchant spellings for fuzzy receipt matching. */
  aliases: string[];
  /** Brand mark colour, used only for the monogram tile. */
  accent: string;
}

export const BRANDS: Brand[] = [
  {
    slug: 'mcdonalds',
    name: "McDonald's",
    ticker: 'MCDx',
    mint: 'XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2',
    decimals: 8,
    issuer: 'Backed Finance',
    pctBack: 4,
    underlying: "McDonald's Corporation (NYSE: MCD)",
    category: 'Food & drink',
    // "MCDONALD'S" tokenises to ["mcdonald","s"]; "MCDONALDS" to ["mcdonalds"].
    // Both spellings appear on real receipts, so both are listed.
    aliases: ['mcdonalds', 'mc donalds', 'mcd', "mcdonald's restaurant", 'golden arches'],
    accent: '#DA291C',
  },
  {
    slug: 'amazon',
    name: 'Amazon',
    ticker: 'AMZNx',
    mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg',
    decimals: 8,
    issuer: 'Backed Finance',
    pctBack: 2,
    underlying: 'Amazon.com, Inc. (NASDAQ: AMZN)',
    category: 'Online retail',
    aliases: ['amazon.com', 'amzn', 'amzn mktp', 'amazon marketplace', 'amazon prime'],
    accent: '#232F3E',
  },
  {
    slug: 'nike',
    name: 'Nike',
    ticker: 'NKE',
    mint: 'NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg',
    decimals: 6,
    issuer: 'Backpack Securities',
    pctBack: 3,
    underlying: 'NIKE, Inc. (NYSE: NKE)',
    category: 'Apparel',
    aliases: ['nike store', 'nike inc', 'niketown', 'nike factory store'],
    accent: '#111111',
  },
  {
    slug: 'costco',
    name: 'Costco',
    ticker: 'COST',
    mint: 'CZEB3WNZuF2Yz1z2H81RcCk8T7fsw82KB33zqamASVsg',
    decimals: 6,
    issuer: 'Backpack Securities',
    pctBack: 2,
    underlying: 'Costco Wholesale Corporation (NASDAQ: COST)',
    category: 'Groceries & retail',
    aliases: ['costco wholesale', 'costco.com', 'costco whse', 'costco gas'],
    accent: '#005DAA',
  },
  {
    slug: 'lululemon',
    name: 'lululemon',
    ticker: 'LULU',
    mint: 'LULUmT9VMttkfAJE236LXJcYJ2tTP7nunrSWR5G1BdS',
    decimals: 6,
    issuer: 'Backpack Securities',
    pctBack: 3,
    underlying: 'lululemon athletica inc. (NASDAQ: LULU)',
    category: 'Apparel',
    aliases: ['lululemon athletica', 'lulu'],
    accent: '#D31334',
  },
  {
    slug: 'netflix',
    name: 'Netflix',
    ticker: 'NFLXx',
    mint: 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL',
    decimals: 8,
    issuer: 'Backed Finance',
    pctBack: 3,
    underlying: 'Netflix, Inc. (NASDAQ: NFLX)',
    category: 'Subscriptions',
    aliases: ['netflix.com', 'netflix inc', 'nflx'],
    accent: '#E50914',
  },
  {
    slug: 'walmart',
    name: 'Walmart',
    ticker: 'WMTx',
    mint: 'Xs151QeqTCiuKtinzfRATnUESM2xTU6V9Wy8Vy538ci',
    decimals: 8,
    issuer: 'Backed Finance',
    pctBack: 2,
    underlying: 'Walmart Inc. (NYSE: WMT)',
    category: 'Groceries & retail',
    aliases: [
      'walmart supercenter',
      'wal-mart',
      'walmart.com',
      'wmt',
      'walmart neighborhood market',
    ],
    accent: '#0071CE',
  },
  {
    slug: 'apple',
    name: 'Apple',
    ticker: 'AAPLx',
    mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
    decimals: 8,
    issuer: 'Backed Finance',
    // Deliberately the lowest rate: Apple receipts are high-ticket, and at the
    // $1000 MAX_RECEIPT_USD cap this is still a $10 payout from one receipt.
    pctBack: 1,
    underlying: 'Apple Inc. (NASDAQ: AAPL)',
    category: 'Electronics',
    aliases: ['apple store', 'apple.com', 'apple inc'],
    accent: '#6E6E73',
  },
];

export const BRAND_BY_SLUG: Record<string, Brand> = Object.fromEntries(
  BRANDS.map((b) => [b.slug, b]),
);

export const BRAND_BY_MINT: Record<string, Brand> = Object.fromEntries(
  BRANDS.map((b) => [b.mint, b]),
);

export const BRAND_BY_TICKER: Record<string, Brand> = Object.fromEntries(
  BRANDS.map((b) => [b.ticker, b]),
);

/** Mainnet mints. Also the price keys: devnet stand-ins are priced as the real token. */
export const ALL_MINTS: string[] = BRANDS.map((b) => b.mint);

/**
 * The mint that holds real balances on `cluster`. On mainnet that is the brand's
 * own mint; on devnet it is the stand-in from devnet-mints.ts.
 */
export function mintFor(brand: Brand, cluster: Cluster = getCluster()): string {
  if (cluster === 'mainnet') return brand.mint;
  const mint = DEVNET_MINTS[brand.ticker];
  if (!mint) {
    throw new Error(`No devnet stand-in mint for ${brand.ticker}. Run: npm run devnet:setup`);
  }
  return mint;
}

/** Brand for a mint on either cluster. */
export function brandForMint(mint: string): Brand | undefined {
  const mainnet = BRAND_BY_MINT[mint];
  if (mainnet) return mainnet;
  const ticker = Object.keys(DEVNET_MINTS).find((t) => DEVNET_MINTS[t] === mint);
  return ticker ? BRAND_BY_TICKER[ticker] : undefined;
}

/** Highest cashback rate in the set, for landing-page copy. */
export const MAX_PCT_BACK: number = Math.max(...BRANDS.map((b) => b.pctBack));

/** Distinct issuers represented, for the "what you actually own" copy. */
export const ISSUERS: Issuer[] = Array.from(new Set(BRANDS.map((b) => b.issuer)));
