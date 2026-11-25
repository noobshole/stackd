/**
 * Builder Code attribution (ERC-8021). Browser-safe.
 *
 * Base credits onchain activity to an app through a suffix on the transaction
 * calldata. Contracts ignore the trailing bytes; indexers read them. A missing
 * suffix fails silently: the transaction still works and is never credited.
 */

import type { Hex } from 'viem';
import { Attribution } from 'ox/erc8021';

/** Printable ASCII, no spaces. Codes come from base.dev. */
const CODE_PATTERN = /^[\x21-\x7e]{1,32}$/;

/** The calldata suffix for a Builder Code, or undefined when no code is configured. */
export function builderCodeSuffix(code: string | null | undefined): Hex | undefined {
  const trimmed = code?.trim();
  if (!trimmed) return undefined;
  if (!CODE_PATTERN.test(trimmed)) {
    throw new Error('BASE_BUILDER_CODE must be the code from base.dev: printable ASCII, no spaces.');
  }
  return Attribution.toDataSuffix({ codes: [trimmed] });
}
