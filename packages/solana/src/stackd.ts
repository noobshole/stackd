/**
 * STACKD bonus token.
 *
 * ⚠️ POLICY CONFLICT — read before extending this.
 * The project's standing rules say "No custom token. Only xStocks from Backed
 * Finance", and the live landing page tells users "Not a token we invented" and
 * "Stackd does not mint anything". STACKD contradicts both. The code is here
 * because it was specified; the copy and the rule need reconciling before this
 * ships to users.
 *
 * Mechanically STACKD is a LEGACY SPL token, not Token-2022, and it carries no
 * scaled-UI multiplier. That is why this path is deliberately kept apart from
 * the xStock path — mixing them is how you end up passing the wrong program id
 * to an ATA derivation.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';

export interface StackdConfig {
  mint: PublicKey;
  decimals: number;
  /**
   * Vault balance (in whole STACKD) below which the bonus leg pauses rather
   * than draining the vault to zero mid-campaign.
   */
  minVaultBalance: number;
}

/**
 * Read STACKD config from the environment.
 *
 * Returns null when unconfigured, which callers treat exactly like a paused
 * vault — the bonus is optional by design, so a missing mint must never break
 * the xStock payout.
 */
export function getStackdConfig(): StackdConfig | null {
  const mint = process.env.STACKD_MINT?.trim();
  if (!mint) return null;

  try {
    return {
      mint: new PublicKey(mint),
      decimals: Number(process.env.STACKD_DECIMALS ?? 9),
      minVaultBalance: Number(process.env.STACKD_MIN_VAULT_BALANCE ?? 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Price of one STACKD in USD.
 *
 * STUB — Day 4 replaces this with a real Dynamic Bonding Curve quote. The fixed
 * value exists so the bonus leg is testable in isolation before that lands.
 * It is deliberately obvious rather than plausible: if this number ever reaches
 * a user-facing surface, it should look wrong.
 */
export const STACKD_PLACEHOLDER_PRICE_USD = 0.01;

export async function getDbcQuotePrice(): Promise<number> {
  // TODO(day-4): quote against the DBC pool instead of returning a constant.
  return STACKD_PLACEHOLDER_PRICE_USD;
}

/**
 * Whole-token STACKD balance held by `owner`.
 *
 * Returns 0 when the account does not exist yet — an unfunded vault reads as
 * empty, which correctly pauses the bonus rather than throwing.
 */
export async function getVaultBalance(
  connection: Connection,
  owner: PublicKey,
  config: StackdConfig,
): Promise<number> {
  const ata = getAssociatedTokenAddressSync(
    config.mint,
    owner,
    true,
    TOKEN_PROGRAM_ID, // legacy — STACKD is not Token-2022
  );

  try {
    const account = await getAccount(connection, ata, 'confirmed', TOKEN_PROGRAM_ID);
    return Number(account.amount) / 10 ** config.decimals;
  } catch {
    return 0;
  }
}
