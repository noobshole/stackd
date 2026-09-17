import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { BRANDS } from '@stackd/solana';
import { verifyReceiptRouter } from './routes/verify-receipt.js';
import { confirmReceiptRouter } from './routes/confirm-receipt.js';
import { RECEIPT_MODEL } from './lib/claude.js';
import { MAX_PER_WINDOW } from './lib/submissions.js';

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

/**
 * The web app is the only intended caller. WEB_ORIGIN pins it in production;
 * without it we fall back to localhost so `npm run dev` works out of the box.
 */
const allowedOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));

// Only the multipart route needs a body, and Multer parses that itself.
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    model: RECEIPT_MODEL,
    // Surfaced so a misconfigured deploy is obvious without reading logs.
    anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    brands: BRANDS.map((b) => b.ticker),
    rateLimitPerDay: MAX_PER_WINDOW,
  });
});

app.use(verifyReceiptRouter);
app.use(confirmReceiptRouter);

app.use((_req, res) => {
  res.status(404).json({ flagged: true, reason: 'Not found.' });
});

app.listen(PORT, () => {
  console.log(`[stackd-api] listening on http://localhost:${PORT}`);
  console.log(`[stackd-api] model: ${RECEIPT_MODEL}`);
  console.log(`[stackd-api] cors origins: ${allowedOrigins.join(', ')}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[stackd-api] WARNING: ANTHROPIC_API_KEY is not set — /verify-receipt will 502.');
  }
});
