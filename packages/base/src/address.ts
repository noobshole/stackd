/** Recipient address checks for Base payouts. Browser-safe. */

import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import {
  ACTIVATION_REGISTRY_ADDRESS,
  B20_FACTORY_ADDRESS,
  POLICY_REGISTRY_ADDRESS,
} from './abi';
import { BASE_STOCKS } from './stocks';

/**
 * Addresses that accept a transfer but that nobody can spend from. Shares sent
 * there are gone for good.
 */
const SINKS: ReadonlySet<string> = new Set(
  [
    zeroAddress,
    POLICY_REGISTRY_ADDRESS,
    ACTIVATION_REGISTRY_ADDRESS,
    B20_FACTORY_ADDRESS,
    ...BASE_STOCKS.flatMap((s) => [s.token, s.feed]),
  ].map((a) => a.toLowerCase()),
);

/**
 * Parse a recipient. Returns the checksummed address, or null when it is not
 * one we will pay.
 *
 * An all-lowercase address carries no checksum and is accepted. A mixed-case
 * address claims an EIP-55 checksum, and that claim must hold: a mistyped
 * character in a checksummed address is caught here instead of sending shares
 * to an address nobody controls.
 */
export function parseBaseAddress(value: unknown): Address | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) return null;
  if (!isAddress(candidate, { strict: true })) return null;
  if (SINKS.has(candidate.toLowerCase())) return null;
  return getAddress(candidate);
}
