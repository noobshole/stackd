/**
 * Stackd brand → xStock mapping (MVP set).
 *
 * Mint addresses were pulled from the Jupiter token API and cross-checked
 * against Backed Finance's `xstocks` tag on 2026-09-15. Every one of them is:
 *   - tokenProgram: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb  (Token-2022)
 *   - decimals: 8
 *   - tagged ["verified", "token-2022", "stocks", "rwa", "xstocks"]
 *
 * ⚠️ These are Token-2022 mints, NOT legacy SPL Token mints. Every ATA
 * derivation and transfer instruction must pass TOKEN_2022_PROGRAM_ID.
 * See ./token-program.ts.
 */

export interface Brand {
  /** Stable slug used in URLs and the DB. */
  slug: string;
  /** Display name shown in the UI and matched against Claude's merchant_name. */
  name: string;
  /** xStock ticker, e.g. "SBUXx". */
  ticker: string;
  /** Token-2022 mint address on Solana mainnet. */
  mint: string;
  /** Mint decimals. All xStocks are 8. */
  decimals: number;
  /** Cashback percentage of the receipt total, paid in the xStock. */
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
    slug: 'starbucks',
    name: 'Starbucks',
    ticker: 'SBUXx',
    mint: 'Xs9gd8SGbYQn9kkUYQayn46BdqQbvvUshEF6ZpRAzM7',
    decimals: 8,
    pctBack: 4,
    underlying: 'Starbucks Corporation (NASDAQ: SBUX)',
    category: 'Coffee & food',
    aliases: ['starbucks coffee', 'starbucks corp', 'sbux', 'starbucks reserve'],
    accent: '#00704A',
  },
  {
    slug: 'nike',
    name: 'Nike',
    ticker: 'NKEx',
    mint: 'XsGYpMvKbVt6ViHqRd7cF3s746dAMFBQWcC49hB9VVP',
    decimals: 8,
    pctBack: 3,
    underlying: 'NIKE, Inc. (NYSE: NKE)',
    category: 'Apparel',
    aliases: ['nike store', 'nike inc', 'niketown', 'nike factory store'],
    accent: '#111111',
  },
  {
    slug: 'netflix',
    name: 'Netflix',
    ticker: 'NFLXx',
    mint: 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL',
    decimals: 8,
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
    pctBack: 2,
    underlying: 'Walmart Inc. (NYSE: WMT)',
    category: 'Groceries & retail',
    aliases: ['walmart supercenter', 'wal-mart', 'walmart.com', 'wmt', 'walmart neighborhood market'],
    accent: '#0071CE',
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

export const ALL_MINTS: string[] = BRANDS.map((b) => b.mint);

/** Highest cashback rate in the MVP set, for landing-page copy. */
export const MAX_PCT_BACK: number = Math.max(...BRANDS.map((b) => b.pctBack));
