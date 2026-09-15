/**
 * Token-2022 "Scaled UI Amount" handling.
 *
 * Every xStock in the MVP set carries the ScaledUiAmount extension. Backed
 * Finance uses the multiplier to apply corporate actions — stock splits,
 * dividend reinvestment — without minting or burning anything. It means:
 *
 *     displayed balance = rawAmount / 10^decimals * effectiveMultiplier
 *
 * This is NOT cosmetic. As of 2026-09-15 the effective multiplier on NFLXx is
 * 10, so dividing the raw amount by 10^8 alone reports a tenth of what the
 * holder actually owns. Always route balances through this module.
 */

import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import {
  getMint,
  getScaledUiAmountConfig,
  unpackMint,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

/** Resolved multiplier state for one mint. */
export interface ScaledUiAmountState {
  /** The multiplier in force right now. 1 when the mint has no extension. */
  multiplier: number;
  /** A queued multiplier that has not taken effect yet, if any. */
  pendingMultiplier: number | null;
  /** When `pendingMultiplier` takes over (unix seconds). */
  pendingEffectiveAt: number | null;
}

export const NO_SCALING: ScaledUiAmountState = {
  multiplier: 1,
  pendingMultiplier: null,
  pendingEffectiveAt: null,
};

/**
 * Pick the multiplier that applies at `atUnixSeconds`.
 *
 * The extension stores the current multiplier plus a future one and the
 * timestamp it activates at. Once that timestamp passes, `newMultiplier` is
 * authoritative and `multiplier` is stale — the on-chain account is not
 * rewritten, so reading `multiplier` alone silently goes wrong after the
 * switchover date.
 */
export function resolveMultiplier(
  multiplier: number,
  newMultiplier: number,
  newMultiplierEffectiveTimestamp: number,
  atUnixSeconds: number = Math.floor(Date.now() / 1000),
): ScaledUiAmountState {
  const active = atUnixSeconds >= newMultiplierEffectiveTimestamp;
  return {
    multiplier: active ? newMultiplier : multiplier,
    pendingMultiplier: active ? null : newMultiplier,
    pendingEffectiveAt: active ? null : newMultiplierEffectiveTimestamp,
  };
}

/** Read the live scaled-UI state for a set of Token-2022 mints in one RPC call. */
export async function fetchScaledUiAmountStates(
  connection: Connection,
  mints: PublicKey[],
): Promise<Map<string, ScaledUiAmountState>> {
  const out = new Map<string, ScaledUiAmountState>();
  if (mints.length === 0) return out;

  const infos = await connection.getMultipleAccountsInfo(mints, 'confirmed');

  mints.forEach((mint, i) => {
    const key = mint.toBase58();
    const info = infos[i];
    if (!info) {
      out.set(key, NO_SCALING);
      return;
    }

    try {
      // getMint wants the raw account; re-wrap what getMultipleAccountsInfo gave us.
      const mintState = unpackMintFromAccountInfo(mint, info);
      const config = getScaledUiAmountConfig(mintState);
      if (!config) {
        out.set(key, NO_SCALING);
        return;
      }
      out.set(
        key,
        resolveMultiplier(
          config.multiplier,
          config.newMultiplier,
          Number(config.newMultiplierEffectiveTimestamp),
        ),
      );
    } catch {
      // A mint we cannot parse is treated as unscaled rather than failing the
      // whole portfolio read. Worst case the balance renders un-multiplied.
      out.set(key, NO_SCALING);
    }
  });

  return out;
}

/** Single-mint convenience wrapper around {@link fetchScaledUiAmountStates}. */
export async function fetchScaledUiAmountState(
  connection: Connection,
  mint: PublicKey,
): Promise<ScaledUiAmountState> {
  const mintState = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const config = getScaledUiAmountConfig(mintState);
  if (!config) return NO_SCALING;
  return resolveMultiplier(
    config.multiplier,
    config.newMultiplier,
    Number(config.newMultiplierEffectiveTimestamp),
  );
}

/**
 * Convert a raw base-unit amount into the number a holder should see.
 *
 * `raw` is the u64 straight off the token account — it is never pre-scaled,
 * regardless of what the RPC reports in `uiAmount`.
 */
export function toUiAmount(raw: bigint | string, decimals: number, multiplier: number): number {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw);
  // Go through Number only after dividing, so large balances keep precision.
  const whole = value / BigInt(10) ** BigInt(decimals);
  const frac = value % BigInt(10) ** BigInt(decimals);
  const base = Number(whole) + Number(frac) / 10 ** decimals;
  return base * multiplier;
}

/**
 * Inverse of {@link toUiAmount} — what raw amount to move to deliver a given
 * displayed quantity. Day 2's transfer path needs this: the treasury must send
 * `uiAmount / multiplier * 10^decimals` base units, not `uiAmount * 10^decimals`.
 */
export function toRawAmount(uiAmount: number, decimals: number, multiplier: number): bigint {
  const prescaled = uiAmount / multiplier;
  return BigInt(Math.round(prescaled * 10 ** decimals));
}

// --- internal ---------------------------------------------------------------

/** `unpackMint` is the non-network half of `getMint`. */
function unpackMintFromAccountInfo(address: PublicKey, info: AccountInfo<Buffer>) {
  return unpackMint(address, info, TOKEN_2022_PROGRAM_ID);
}
