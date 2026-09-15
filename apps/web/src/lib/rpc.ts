/**
 * Where the browser sends Solana RPC.
 *
 * Preference order:
 *   1. NEXT_PUBLIC_RPC_URL, when explicitly set. Direct to Helius, but the key
 *      is visible in the client bundle.
 *   2. /api/rpc — the server-side proxy. Keeps HELIUS_RPC_URL private.
 *
 * Either way the traffic terminates at Helius. Nothing in this app talks to a
 * public endpoint.
 */

export function resolveRpcEndpoint(): string {
  const explicit = process.env.NEXT_PUBLIC_RPC_URL?.trim();
  if (explicit) return explicit;

  // web3.js needs an absolute URL, so the same-origin proxy has to be expanded.
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? 'http://localhost:3000');

  return `${origin}/api/rpc`;
}

/** True when the browser is hitting Helius directly with a public key. */
export function isDirectRpc(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_RPC_URL?.trim());
}
