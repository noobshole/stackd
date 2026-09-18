/**
 * Receipt currency -> USD.
 *
 * Rates are the European Central Bank reference rates, served by Frankfurter
 * (api.frankfurter.dev): free, no API key, ~30 currencies including IDR, JPY,
 * SGD, HKD and MXN, published once per working day. That cadence suits
 * cashback — a receipt is priced at the day's reference rate, not a live quote.
 *
 * Requested with base=USD on purpose. base=IDR comes back rounded to two
 * significant figures (5.6e-05, up to ~1% off); base=USD returns 17727 at full
 * precision, and one request covers every currency.
 *
 * Fails closed. If a rate cannot be fetched, is stale, or is not a positive
 * finite number, conversion throws and the receipt is never paid on a guess.
 */

const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';

/** ECB publishes once a day, so refreshing hourly is plenty. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Oldest rate date we will price with. Weekends plus a bank holiday can leave
 * the newest ECB rate 4 days old; anything past this means the source is stuck.
 */
const MAX_RATE_AGE_DAYS = 5;

const FETCH_TIMEOUT_MS = 4000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** We could not price the currency right now. Our failure, not the user's. */
export class FxUnavailableError extends Error {}

/** The currency is not one we can convert. The receipt is refused. */
export class UnsupportedCurrencyError extends Error {}

export interface UsdConversion {
  /** Unrounded USD value. The caller decides rounding. */
  amountUsd: number;
  /** Normalised ISO 4217 code. */
  currency: string;
  originalAmount: number;
  /** Units of `currency` per 1 USD. Exactly 1 for USD. */
  rate: number;
  /** Publication date of the rate (YYYY-MM-DD). Null for USD. */
  rateDate: string | null;
}

interface RateTable {
  rates: Map<string, number>;
  date: string;
  fetchedAt: number;
}

interface FxOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

function rateAgeDays(date: string, now: number): number {
  const published = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(published) ? Infinity : (now - published) / DAY_MS;
}

export function createFxConverter(options: FxOptions = {}) {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  let cache: RateTable | null = null;
  let inflight: Promise<RateTable> | null = null;

  async function load(): Promise<RateTable> {
    let body: unknown;
    try {
      const res = await doFetch(FX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (error) {
      console.error('[stackd-api] FX rate fetch failed:', error);
      throw new FxUnavailableError('Currency conversion is unavailable right now.');
    }

    const { base, date, rates } = (body ?? {}) as {
      base?: unknown;
      date?: unknown;
      rates?: unknown;
    };
    if (base !== 'USD' || typeof date !== 'string' || typeof rates !== 'object' || !rates) {
      throw new FxUnavailableError('Currency conversion returned an unexpected response.');
    }

    // Keep only usable rates. A zero, negative or non-numeric entry would
    // otherwise divide into Infinity or a negative payout; dropped, it just
    // makes that one currency unsupported.
    const table = new Map<string, number>();
    for (const [code, value] of Object.entries(rates)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        table.set(code.toUpperCase(), value);
      }
    }

    return { rates: table, date, fetchedAt: now() };
  }

  async function getTable(): Promise<RateTable> {
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) return cache;

    // One fetch for a burst of concurrent receipts, not one each.
    inflight ??= load().finally(() => {
      inflight = null;
    });

    let table: RateTable;
    try {
      table = await inflight;
    } catch (error) {
      // A failed refresh can fall back to the last good table, as long as its
      // rates are still recent enough to trust. The age check below applies.
      if (!cache) throw error;
      table = cache;
    }

    if (rateAgeDays(table.date, now()) > MAX_RATE_AGE_DAYS) {
      throw new FxUnavailableError(`Exchange rates are stale (last published ${table.date}).`);
    }

    cache = table;
    return table;
  }

  return async function toUsd(amount: number, rawCurrency: string): Promise<UsdConversion> {
    const currency = rawCurrency.trim().toUpperCase();

    // `currency` comes from Claude reading an uploaded image, so treat it as
    // untrusted input: exactly three letters or nothing.
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new UnsupportedCurrencyError(`"${rawCurrency}" is not a currency code we recognise.`);
    }

    if (currency === 'USD') {
      return { amountUsd: amount, currency, originalAmount: amount, rate: 1, rateDate: null };
    }

    const table = await getTable();
    const rate = table.rates.get(currency);
    if (rate === undefined) {
      throw new UnsupportedCurrencyError(`${currency} receipts aren't supported yet.`);
    }

    return {
      amountUsd: amount / rate,
      currency,
      originalAmount: amount,
      rate,
      rateDate: table.date,
    };
  };
}

/** Process-wide converter, sharing one rate cache across requests. */
export const toUsd = createFxConverter();
