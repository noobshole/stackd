import './env.js';
import express from 'express';
import cors from 'cors';
import { BRANDS, getCluster } from '@stackd/solana';
import { useReceiptStore } from '@stackd/solana/server';
import { verifyReceiptRouter } from './routes/verify-receipt.js';
import { confirmReceiptRouter } from './routes/confirm-receipt.js';
import { healthTreasuryRouter } from './routes/health-treasury.js';
import { stackdRouter } from './routes/stackd.js';
import { claudeConfigured, RECEIPT_MODEL, VIA_OPENROUTER } from './lib/claude.js';
import { getPool, hasDatabase } from './lib/store/db.js';
import { getGuards, limits } from './lib/store/guards.js';
import { PgReceiptStore } from './lib/store/pg-receipt-store.js';

// Throws on a mistyped SOLANA_CLUSTER, which is the point: fail at boot.
const cluster = getCluster();

/**
 * Storage. In-memory state loses the duplicate history, the rate limits, the
 * payout budget and every payout record on restart — survivable on devnet,
 * not with real money. So mainnet refuses to start without a database.
 */
if (hasDatabase()) {
  useReceiptStore(new PgReceiptStore());
} else if (cluster === 'mainnet') {
  console.error(
    '[stackd-api] Refusing to start: SOLANA_CLUSTER is mainnet but DATABASE_URL is not set.\n' +
      '  In-memory storage forgets paid receipts on restart, which lets them be claimed again.',
  );
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

/**
 * Behind a hosting proxy (Railway, Render, Fly…) every request arrives from the
 * proxy's IP, which would put all users in one per-IP bucket. TRUST_PROXY=1
 * trusts one hop of X-Forwarded-For. Leave it unset when nothing sits in
 * front of the server: trusting the header then would let clients spoof it.
 */
const trustProxy = process.env.TRUST_PROXY?.trim();
if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

/**
 * The web app is the only intended caller. WEB_ORIGIN pins it in production;
 * without it we fall back to localhost so `npm run dev` works out of the box.
 */
const allowedOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  // Browsers send the Origin header with no trailing slash, and cors compares
  // exact strings, so "https://site.app/" would silently block every request.
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));

// Only the multipart route needs a body, and Multer parses that itself.
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    cluster,
    model: RECEIPT_MODEL,
    claudeVia: VIA_OPENROUTER ? 'openrouter' : 'anthropic',
    // Surfaced so a misconfigured deploy is obvious without reading logs.
    anthropicKeyConfigured: claudeConfigured(),
    storage: getGuards().backend,
    brands: BRANDS.map((b) => b.ticker),
    rateLimitPerDay: limits.walletPerDay,
  });
});

app.use(verifyReceiptRouter);
app.use(confirmReceiptRouter);
app.use(healthTreasuryRouter);
app.use(stackdRouter);

app.use((_req, res) => {
  res.status(404).json({ flagged: true, reason: 'Not found.' });
});

app.listen(PORT, async () => {
  console.log(`[stackd-api] listening on http://localhost:${PORT}`);
  console.log(`[stackd-api] cluster: ${cluster.toUpperCase()}`);
  console.log(
    `[stackd-api] model: ${RECEIPT_MODEL} via ${VIA_OPENROUTER ? 'OpenRouter' : 'Anthropic'}`,
  );
  console.log(`[stackd-api] cors origins: ${allowedOrigins.join(', ')}`);
  console.log(
    `[stackd-api] limits: ${limits.walletPerDay}/wallet/day, ${limits.ipPerHour}/IP/hour, ` +
      `${limits.globalPerHour}/hour total, payouts capped at $${limits.dailyPayoutCapUsd}/day`,
  );

  if (hasDatabase()) {
    try {
      await getPool().query('select 1 from stackd.receipts limit 1');
      console.log('[stackd-api] storage: postgres (connected)');
    } catch (error) {
      // Loud, not fatal: /health still answers, and every DB-backed route
      // fails closed with a 500 rather than paying on missing state.
      console.error(
        '[stackd-api] storage: postgres UNREACHABLE —',
        error instanceof Error ? error.message : error,
      );
    }
  } else {
    console.warn('[stackd-api] storage: MEMORY — receipts, limits and payouts are lost on restart.');
  }

  if (!claudeConfigured()) {
    console.warn(
      '[stackd-api] WARNING: no Claude credentials (ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN ' +
        'for OpenRouter) — /verify-receipt will 502.',
    );
  } else if (VIA_OPENROUTER && process.env.ANTHROPIC_API_KEY?.trim()) {
    // The SDK would send it as x-api-key alongside the Bearer token.
    console.warn(
      '[stackd-api] WARNING: ANTHROPIC_BASE_URL points at OpenRouter but ANTHROPIC_API_KEY is ' +
        'set. Put the sk-or- key in ANTHROPIC_AUTH_TOKEN and leave ANTHROPIC_API_KEY empty.',
    );
  }
});
