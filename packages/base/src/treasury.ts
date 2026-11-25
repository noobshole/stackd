/**
 * The Base treasury signer and RPC clients. BACKEND ONLY.
 *
 * Nothing in apps/web may import this module. BASE_TREASURY_PRIVATE_KEY has no
 * NEXT_PUBLIC_ prefix, so Next would inline `undefined` rather than the key,
 * but the guard below makes the mistake loud instead of mysterious.
 *
 * The Base treasury is its own EVM key. It is never derived from, or reused
 * as, any Solana key.
 */

import { createPublicClient, createWalletClient, http, type Chain, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { chainFor, getBaseNetwork, type BaseNetwork } from './network';

function assertServer(what: string): void {
  // `'window' in globalThis` rather than `typeof window`, so this compiles under
  // the API's DOM-free lib as well as the browser-targeted web app.
  if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
    throw new Error(`${what} was reached from browser code. The Base treasury signer is backend-only.`);
  }
}

/** Public endpoints: only for Sepolia sends and for read-only mainnet price reads. */
const PUBLIC_SEPOLIA_RPC = 'https://sepolia.base.org';
const PUBLIC_MAINNET_RPC = 'https://mainnet.base.org';

/** BASE_NETWORK, required: payouts must not run on a network nobody chose. */
export function requireBaseNetwork(): BaseNetwork {
  const network = getBaseNetwork();
  if (!network) throw new Error('Base payouts are off: BASE_NETWORK is not set.');
  return network;
}

function sendRpcUrl(network: BaseNetwork): string {
  const url = process.env.BASE_RPC_URL?.trim();
  if (url) return url;
  if (network === 'sepolia') return PUBLIC_SEPOLIA_RPC;
  throw new Error('BASE_RPC_URL is not set. Refusing to send mainnet payouts through a public endpoint.');
}

let treasury: PrivateKeyAccount | null = null;

/** The treasury signer, from BASE_TREASURY_PRIVATE_KEY (0x + 64 hex). */
export function getBaseTreasury(): PrivateKeyAccount {
  assertServer('getBaseTreasury');
  if (treasury) return treasury;

  const secret = process.env.BASE_TREASURY_PRIVATE_KEY?.trim();
  if (!secret) throw new Error('BASE_TREASURY_PRIVATE_KEY is not set.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error('BASE_TREASURY_PRIVATE_KEY must be 0x followed by 64 hex characters.');
  }

  const account = privateKeyToAccount(secret as Hex);
  const expected = process.env.BASE_TREASURY_ADDRESS?.trim();
  if (expected && expected.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error('BASE_TREASURY_PRIVATE_KEY does not match BASE_TREASURY_ADDRESS.');
  }

  treasury = account;
  return account;
}

function makeClients(network: BaseNetwork) {
  const chain: Chain = chainFor(network);
  const transport = http(sendRpcUrl(network));
  return {
    network,
    chain,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport }),
  };
}

let clients: ReturnType<typeof makeClients> | null = null;

/** Clients for BASE_NETWORK, over BASE_RPC_URL. */
export function getBaseClients(): ReturnType<typeof makeClients> {
  assertServer('getBaseClients');
  if (!clients) clients = makeClients(requireBaseNetwork());
  return clients;
}

function makePriceClient() {
  const network = getBaseNetwork();
  const own = network === 'mainnet' ? process.env.BASE_RPC_URL?.trim() : undefined;
  const url = own || process.env.BASE_MAINNET_RPC_URL?.trim() || PUBLIC_MAINNET_RPC;
  return createPublicClient({ chain: base, transport: http(url) });
}

let priceClient: ReturnType<typeof makePriceClient> | null = null;

/**
 * Read-only client for Base mainnet. The Chainlink stock feeds exist only on
 * mainnet, so a Sepolia run prices its stand-ins at the real stock's price.
 */
export function getBasePriceClient(): ReturnType<typeof makePriceClient> {
  if (!priceClient) priceClient = makePriceClient();
  return priceClient;
}

/** Test hook: forget cached clients and signer after changing the environment. */
export function __resetBase(): void {
  treasury = null;
  clients = null;
  priceClient = null;
}
