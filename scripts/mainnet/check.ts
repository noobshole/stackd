/**
 * Mainnet readiness — read-only. Run it before anything irreversible:
 *
 *   npm run mainnet:check                              # keys, funding, stock, $STACKD, web
 *   npm run mainnet:check -- --api https://<railway>   # + the deployed API, end to end
 *
 * Reads apps/api/.env and mainnet state. Signs nothing, sends nothing, prints
 * addresses and balances but never a secret. Exits non-zero while any blocker
 * remains, so it can gate the launch.
 */

import fs from 'node:fs';
import { parse as parseEnv } from 'dotenv';
import { Connection, PublicKey, type Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import pg from 'pg';
import {
  API_ENV_PATH,
  BURNED_PUBKEYS,
  STACKD_TOKEN,
  checkMetadata,
  fail,
  getConnection,
  loadKeypair,
} from '../dbc/_shared.js';
import { BRANDS } from '../../packages/solana/src/brands.js';
import { fetchXStockBalances } from '../../packages/solana/src/balances.js';
import { fetchXStockPrices } from '../../packages/solana/src/prices.js';
import { USDC_MINT } from '../../packages/solana/src/dbc.js';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
/** Squads multisig programs. A team address they own is the multisig account, not its vault. */
const SQUADS_PROGRAMS = new Set([
  'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', // v4
  'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu', // v3
]);
/** Rent for a recipient's Token-2022 xStock account plus its $STACKD account, plus fees. */
const SOL_PER_NEW_WALLET = 0.0045;
/** A typical payout, for turning stock into "about N receipts". */
const TYPICAL_PAYOUT_USD = 0.25;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const API_URL = arg('--api')?.replace(/\/+$/, '');
const WEB_URL = (arg('--web', 'https://stackd-web-eosin.vercel.app') as string).replace(/\/+$/, '');

// --- reporting ---------------------------------------------------------------

type Level = 'ok' | 'warn' | 'fail' | 'info';
const ICON: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };
const tally = { ok: 0, warn: 0, fail: 0, info: 0 };

function heading(title: string): void {
  console.log(`\n  ${title}\n  ${'-'.repeat(title.length)}`);
}
function report(level: Level, text: string): void {
  tally[level]++;
  console.log(`  ${ICON[level]} ${text}`);
}
/** Run one check; an unexpected throw becomes a failure line, not a crash. */
async function check(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    report('fail', `${label}: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
}
function redact(message: string): string {
  return message.replace(/api-key=[^&\s"']+/gi, 'api-key=***').replace(/:\/\/[^@\s]+@/g, '://***@');
}
const short = (key: PublicKey | string) => {
  const s = key.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
/**
 * The API treats apps/api/.env as authoritative over inherited variables
 * (apps/api/src/env.ts) — tools like the Claude desktop app export
 * ANTHROPIC_BASE_URL into everything they launch. Check what the API will
 * actually see: the file first, the environment only for keys it lacks.
 */
const fileEnv = fs.existsSync(API_ENV_PATH) ? parseEnv(fs.readFileSync(API_ENV_PATH)) : {};
const env = (name: string) => (fileEnv[name] ?? process.env[name] ?? '').trim();

// --- checks --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n  Stackd mainnet readiness${API_URL ? ` (API: ${API_URL})` : ''}`);

  // Filled in by the checks below; a failed check leaves its entry unset.
  const ctx: { mainnet?: Connection; treasury?: Keypair; payer?: Keypair } = {};

  heading('Configuration');
  await check('SOLANA_CLUSTER', async () => {
    const cluster = env('SOLANA_CLUSTER') || 'mainnet';
    if (cluster === 'mainnet') report('ok', 'apps/api/.env is on mainnet');
    else report('fail', `apps/api/.env is on ${cluster}: back it up, then switch to mainnet with fresh keys`);
  });
  await check('Helius mainnet', async () => {
    const conn = getConnection('mainnet');
    const genesis = await conn.getGenesisHash();
    if (genesis !== MAINNET_GENESIS) throw new Error(`HELIUS_RPC_URL is not mainnet (genesis ${genesis})`);
    ctx.mainnet = conn;
    report('ok', `Helius mainnet RPC answers (slot ${await conn.getSlot()})`);
  });
  await check('Database', async () => {
    if (!env('DATABASE_URL')) throw new Error('DATABASE_URL is not set: the API refuses to start on mainnet without it');
    const client = new pg.Client({ connectionString: env('DATABASE_URL'), ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const tables = ['receipts', 'receipt_fingerprints', 'submission_attempts', 'payout_budget'];
      const { rows } = await client.query<{ t: string; ok: boolean }>(
        `select t, to_regclass('stackd.' || t) is not null as ok from unnest($1::text[]) as t`,
        [tables],
      );
      const missing = rows.filter((r) => !r.ok).map((r) => r.t);
      if (missing.length) throw new Error(`missing tables: ${missing.join(', ')} (apply apps/api/db/migrations)`);
      report('ok', 'Postgres reachable, all 4 stackd tables present');
    } finally {
      await client.end();
    }
  });
  await check('Claude', async () => {
    const viaOpenRouter = /openrouter\.ai/i.test(env('ANTHROPIC_BASE_URL'));
    if (viaOpenRouter) {
      if (env('ANTHROPIC_API_KEY')) report('warn', 'ANTHROPIC_API_KEY is set alongside OpenRouter: leave it empty');
      const res = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { authorization: `Bearer ${env('ANTHROPIC_AUTH_TOKEN')}` },
      });
      if (res.status === 401 || res.status === 403) throw new Error('OpenRouter rejects ANTHROPIC_AUTH_TOKEN');
      if (!res.ok) throw new Error(`OpenRouter credits lookup failed (${res.status})`);
      const { data } = (await res.json()) as { data: { total_credits: number; total_usage: number } };
      const left = data.total_credits - data.total_usage;
      const receipts = Math.floor(left / 0.01);
      report(left < 2 ? 'warn' : 'ok', `Claude via OpenRouter: $${left.toFixed(2)} credit left (~${receipts} receipts)`);
    } else if (env('ANTHROPIC_API_KEY')) {
      report('ok', 'Claude via Anthropic direct (key set; not verified online)');
    } else {
      throw new Error('no Claude credentials: set ANTHROPIC_AUTH_TOKEN (OpenRouter) or ANTHROPIC_API_KEY');
    }
  });
  await check('HEALTH_SECRET', async () => {
    if (env('HEALTH_SECRET').length >= 16) report('ok', 'HEALTH_SECRET set (16+ chars)');
    else report('warn', 'HEALTH_SECRET missing or short: /health/treasury stays disabled');
  });
  report('info', `daily payout cap: $${env('DAILY_PAYOUT_CAP_USD') || '25'} (0 pauses all payouts)`);

  heading('Keys');
  await check('Treasury key', async () => {
    const treasury = loadKeypair('TREASURY_PRIVATE_KEY');
    const pub = treasury.publicKey.toBase58();
    if (BURNED_PUBKEYS.has(pub)) throw new Error(`treasury ${pub} is a burned key`);
    const expected = env('TREASURY_PUBLIC_KEY');
    if (expected && expected !== pub) throw new Error('TREASURY_PRIVATE_KEY does not match TREASURY_PUBLIC_KEY');
    ctx.treasury = treasury;
    report('ok', `treasury ${pub}`);
  });
  await check('Payer key', async () => {
    const payer = loadKeypair('DBC_PAYER_PRIVATE_KEY');
    const pub = payer.publicKey.toBase58();
    if (BURNED_PUBKEYS.has(pub)) throw new Error(`payer ${pub} is a burned key: npm run dbc:keygen`);
    ctx.payer = payer;
    report('ok', `launch payer ${pub} (creates the pool, claims its fees)`);
    if (ctx.treasury && pub === ctx.treasury.publicKey.toBase58()) {
      report('warn', 'payer and treasury are the same key: it works, but separate keys keep launch and payouts apart');
    }
  });
  await check('Devnet reuse', async () => {
    if (!env('HELIUS_DEVNET_RPC_URL')) return;
    const devnet = getConnection('devnet');
    for (const [role, kp] of [['treasury', ctx.treasury], ['payer', ctx.payer]] as const) {
      if (!kp) continue;
      const used = await devnet.getSignaturesForAddress(kp.publicKey, { limit: 1 });
      if (used.length) report('warn', `${role} key has devnet history: a fresh mainnet key keeps test and real funds apart`);
    }
  });
  await check('Team address', async () => {
    const raw = env('STACKD_TEAM_ADDRESS');
    if (!raw) {
      if (env('STACKD_TEAM_PRIVATE_KEY')) {
        report('warn', 'team is a hot key in .env: set STACKD_TEAM_ADDRESS to your Phantom or Squads vault address');
        return;
      }
      throw new Error('STACKD_TEAM_ADDRESS is not set: the 15% leftover is fixed to it forever at launch');
    }
    const team = new PublicKey(raw);
    if (BURNED_PUBKEYS.has(team.toBase58())) throw new Error(`team ${team.toBase58()} is a burned key`);
    const mine = [ctx.treasury, ctx.payer].flatMap((k) => (k ? [k.publicKey.toBase58()] : []));
    if (mine.includes(team.toBase58())) {
      report('warn', 'team address is the payer or treasury: the 15% should sit in a wallet the app never signs with');
    }
    if (ctx.mainnet) {
      const info = await ctx.mainnet.getAccountInfo(team);
      if (info && SQUADS_PROGRAMS.has(info.owner.toBase58())) {
        throw new Error(
          `${team.toBase58()} is a Squads multisig ACCOUNT. Use its Vault address (Squads → Vault → copy address)`,
        );
      }
    }
    report('ok', `team ${team.toBase58()} (receives 15% after graduation)`);
  });
  report('info', `fee claimer: ${env('DBC_FEE_CLAIMER_ADDRESS') || 'the payer (default)'}`);

  heading('Funding (mainnet)');
  await check('Balances', async () => {
    const conn = ctx.mainnet;
    if (!conn) throw new Error('no mainnet connection');
    if (ctx.payer) {
      const sol = (await conn.getBalance(ctx.payer.publicKey)) / 1e9;
      report(sol < 0.05 ? 'fail' : sol < 0.1 ? 'warn' : 'ok', `payer ${sol.toFixed(4)} SOL (launch needs ≥ 0.05; 0.1 recommended)`);
    }
    if (!ctx.treasury) return;
    const owner = ctx.treasury.publicKey;
    const sol = (await conn.getBalance(owner)) / 1e9;
    const wallets = Math.max(0, Math.floor((sol - 0.01) / SOL_PER_NEW_WALLET));
    report(sol < 0.02 ? 'fail' : sol < 0.1 ? 'warn' : 'ok', `treasury ${sol.toFixed(4)} SOL (~${wallets} first-time wallets of account rent)`);

    const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT.mainnet), owner, true);
    const usdc = await conn.getTokenAccountBalance(usdcAta).catch(() => null);
    report('info', `treasury ${usdc?.value.uiAmountString ?? '0'} USDC (only needed to buy $STACKD for the bonus)`);

    const [balances, prices] = await Promise.all([
      fetchXStockBalances(conn, owner, 'mainnet'),
      fetchXStockPrices(BRANDS.map((b) => b.mint)),
    ]);
    let stocked = 0;
    for (const b of balances) {
      const price = prices[b.brand.mint]?.usd ?? null;
      const value = price != null ? b.uiAmount * price : null;
      const label = `${b.brand.ticker.padEnd(6)} ${b.uiAmount.toFixed(6)} shares`;
      if (b.uiAmount <= 0) {
        report('warn', `${label} — ${b.brand.name} receipts are refused until stocked`);
      } else {
        stocked++;
        const receipts = value != null ? Math.floor(value / TYPICAL_PAYOUT_USD) : null;
        report('ok', `${label} ($${value?.toFixed(2) ?? '?'}, ~${receipts ?? '?'} receipts)`);
      }
    }
    if (stocked === 0) report('fail', 'no xStock in the treasury: every receipt would be refused');
  });

  heading('$STACKD');
  await check('Token metadata', async () => {
    const problems = await checkMetadata();
    if (problems.length) throw new Error(`not ready — permanent once minted: ${problems.join(' ')}`);
    report('ok', `${STACKD_TOKEN.metadataUri} resolves (name, symbol, image)`);
  });
  await check('Launch state', async () => {
    const conn = ctx.mainnet ?? null;
    const mint = env('STACKD_MINT');
    const mintInfo = mint && conn ? await conn.getAccountInfo(new PublicKey(mint)) : null;
    if (!mintInfo) {
      report('info', 'not launched on mainnet yet (launch: DBC_CLUSTER=mainnet + DBC_ALLOW_MAINNET, then npm run dbc:launch)');
      return;
    }
    report('ok', `$STACKD mint ${short(mint)} exists on mainnet`);
    const pool = env('DBC_POOL_ADDRESS');
    if (!pool || !(await conn!.getAccountInfo(new PublicKey(pool)))) {
      report('fail', 'DBC_POOL_ADDRESS is unset or not on mainnet: no $STACKD price, bonus paused');
    } else {
      report('ok', `pool ${short(pool)} exists on mainnet`);
    }
    if (ctx.treasury) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), ctx.treasury.publicKey, true, TOKEN_PROGRAM_ID);
      const bal = await conn!.getTokenAccountBalance(ata).catch(() => null);
      const held = Number(bal?.value.uiAmount ?? 0);
      if (held > 0) report('ok', `bonus vault holds ${held.toLocaleString('en-US')} $STACKD`);
      else report('warn', 'bonus vault is empty: the $STACKD bonus stays paused until you buy some into the treasury');
    }
  });

  heading('Web app');
  await check('Live site RPC', async () => {
    const res = await fetch(`${WEB_URL}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: number; error?: { message?: string } };
    if (!res.ok || typeof body.result !== 'number') {
      throw new Error(`${WEB_URL}/api/rpc → ${res.status} ${body.error?.message ?? ''}`.trim());
    }
    const ours = ctx.mainnet ? await ctx.mainnet.getSlot() : null;
    const onMainnet = ours == null || Math.abs(ours - body.result) < 5_000;
    report(onMainnet ? 'ok' : 'fail', `${WEB_URL} reads ${onMainnet ? 'mainnet' : 'a different cluster'} (slot ${body.result})`);
  });

  if (API_URL) {
    heading('Deployed API');
    await check('API /health', async () => {
      const res = await fetch(`${API_URL}/health`, { headers: { origin: WEB_URL } });
      if (!res.ok) throw new Error(`${API_URL}/health → ${res.status}`);
      const h = (await res.json()) as Record<string, unknown>;
      report(h.cluster === 'mainnet' ? 'ok' : 'fail', `cluster: ${h.cluster}`);
      report(h.storage === 'postgres' ? 'ok' : 'fail', `storage: ${h.storage}`);
      report(h.anthropicKeyConfigured ? 'ok' : 'fail', `Claude credentials: ${h.anthropicKeyConfigured ? `set (${h.claudeVia})` : 'missing'}`);
      const cors = res.headers.get('access-control-allow-origin');
      report(cors === WEB_URL ? 'ok' : 'fail', cors === WEB_URL ? `CORS allows ${WEB_URL}` : `CORS does not allow ${WEB_URL}: set WEB_ORIGIN on Railway`);
    });
    await check('API /health/treasury', async () => {
      if (env('HEALTH_SECRET').length < 16) {
        report('info', 'skipped: no local HEALTH_SECRET to call it with');
        return;
      }
      const res = await fetch(`${API_URL}/health/treasury`, { headers: { 'x-health-secret': env('HEALTH_SECRET') } });
      if (res.status === 404) throw new Error('404: HEALTH_SECRET on Railway differs from the local one (or is unset)');
      const t = (await res.json()) as { ok?: boolean; treasury?: { address?: string }; warnings?: string[] };
      if (ctx.treasury && t.treasury?.address !== ctx.treasury.publicKey.toBase58()) {
        report('fail', `Railway pays from ${t.treasury?.address ?? '?'}, not the local treasury`);
      } else {
        report('ok', 'Railway uses the same treasury as this .env');
      }
      for (const w of t.warnings ?? []) report('warn', `API reports: ${w}`);
      if (!t.warnings?.length) report('ok', 'API treasury report has no warnings');
    });
  }

  console.log(`\n  ${tally.fail} blocker(s), ${tally.warn} warning(s), ${tally.ok} passed\n`);
  if (tally.fail > 0) process.exitCode = 1;
}

main().catch(fail);
