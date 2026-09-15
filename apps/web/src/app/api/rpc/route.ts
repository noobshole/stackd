/**
 * Server-side Helius proxy.
 *
 * Why this exists: NEXT_PUBLIC_RPC_URL is readable by anyone who opens the
 * deployed bundle, so shipping the Helius key that way hands out a paid
 * endpoint to the whole internet. Routing through here keeps HELIUS_RPC_URL on
 * the server. Setting NEXT_PUBLIC_RPC_URL still works and takes precedence —
 * see lib/rpc.ts — but leaving it blank is the safer default.
 *
 * The method allowlist matters just as much: an open proxy is still an open
 * proxy. Only the read methods this app actually issues get through, so the
 * endpoint cannot be used to relay transactions or drain the plan's credits
 * with expensive queries.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getLatestBlockhash',
  'getMultipleAccounts',
  'getParsedTokenAccountsByOwner',
  'getProgramAccounts',
  'getSlot',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getVersion',
]);

interface JsonRpcCall {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function rpcError(id: JsonRpcCall['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function POST(request: Request) {
  const upstream = process.env.HELIUS_RPC_URL;

  // Fail loudly rather than quietly falling back to a public endpoint.
  if (!upstream) {
    return NextResponse.json(
      rpcError(null, -32603, 'HELIUS_RPC_URL is not configured on the server.'),
      { status: 503 },
    );
  }

  let payload: JsonRpcCall | JsonRpcCall[];
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, 'Parse error.'), { status: 400 });
  }

  const calls = Array.isArray(payload) ? payload : [payload];

  if (calls.length === 0 || calls.length > 20) {
    return NextResponse.json(
      rpcError(null, -32600, 'Batch size must be between 1 and 20.'),
      { status: 400 },
    );
  }

  const blocked = calls.find((c) => !c.method || !ALLOWED_METHODS.has(c.method));
  if (blocked) {
    return NextResponse.json(
      rpcError(
        blocked.id,
        -32601,
        `Method "${blocked.method ?? 'unknown'}" is not permitted through this proxy.`,
      ),
      { status: 403 },
    );
  }

  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });

    const body = await res.text();

    return new NextResponse(body, {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    // Never surface the upstream URL — it contains the API key.
    return NextResponse.json(rpcError(null, -32603, 'Upstream RPC request failed.'), {
      status: 502,
    });
  }
}
