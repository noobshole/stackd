/**
 * The receipt store for each chain.
 *
 * Solana uses the process-wide store index.ts installs. Base gets its own
 * Postgres store only because its duplicate scope can differ: Base Sepolia is
 * a test network while Solana may be on mainnet, and a receipt used in a test
 * run must stay claimable for real. On the same scope, both stores check the
 * same rows, so a receipt paid on one chain is a duplicate on the other.
 *
 * Without a database both chains share the one in-memory store.
 */

import { defaultReceiptStore, type ReceiptStore } from '@stackd/solana/server';
import { scopeFor, type PayoutChain } from '../chains.js';
import { hasDatabase } from './db.js';
import { PgReceiptStore } from './pg-receipt-store.js';

let baseStore: ReceiptStore | null = null;

export function receiptStoreFor(chain: PayoutChain): ReceiptStore {
  if (chain === 'solana' || !hasDatabase()) return defaultReceiptStore;
  baseStore ??= new PgReceiptStore(scopeFor('base'));
  return baseStore;
}
