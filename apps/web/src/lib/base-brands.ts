import { BRANDS, type Brand } from '@stackd/solana';
import { baseStock } from '@stackd/base/web';

/**
 * Brands that pay on Base: the shared brand list, where a Base stock exists.
 * The API applies the same rule (routes/verify-receipt.ts), so the two agree.
 */
export const BASE_BRANDS: ReadonlyArray<{ brand: Brand; ticker: string }> = BRANDS.flatMap((brand) => {
  const stock = baseStock(brand.slug);
  return stock ? [{ brand, ticker: stock.ticker }] : [];
});

/** "Apple and Amazon", in brand-list order. */
export const BASE_BRAND_NAMES = (() => {
  const names = BASE_BRANDS.map((b) => b.brand.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
})();
