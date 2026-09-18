/**
 * POST /verify-receipt
 *
 * Verifies a receipt and returns what the user would earn. It does NOT move
 * tokens — the frontend shows this estimate, the user confirms, and the
 * transfer happens on a separate endpoint.
 */

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { PublicKey } from '@solana/web3.js';
import { defaultReceiptStore } from '@stackd/solana/server';
import { ClaudeUnavailableError, extractReceipt } from '../lib/claude.js';
import { matchBrand } from '../lib/match-brand.js';
import {
  MAX_PER_WINDOW,
  checkRateLimit,
  isDuplicate,
  recordAccepted,
  recordAttempt,
  releaseAttempt,
} from '../lib/submissions.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/** Below this, we do not trust the extraction enough to pay out. */
const MIN_CONFIDENCE = 0.7;

/**
 * Largest receipt we will honour, in USD. A blunt cap on how much a single
 * bad extraction can cost the treasury. Policy knob, not a law of nature.
 */
const MAX_RECEIPT_USD = Number(process.env.MAX_RECEIPT_USD ?? 1000);

class UnsupportedTypeError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ACCEPTED_TYPES.has(file.mimetype)) {
      cb(new UnsupportedTypeError(`Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

/** Shape returned for every outcome, so the client has one parsing path. */
interface VerifyResponse {
  flagged: boolean;
  reason?: string;
  brand: string | null;
  ticker: string | null;
  amountUsd: number | null;
  confidence: number | null;
  /** Present only on an accepted receipt. The key POST /confirm-receipt needs. */
  receiptId?: string;
  /** Cashback rate for the matched brand, percent. */
  pctBack?: number;
  /** amountUsd * pctBack / 100. The frontend converts to shares via Jupiter. */
  cashbackUsd?: number;
  /** What Claude actually read, so the UI can show its working. */
  merchantName?: string;
  date?: string;
  currency?: string;
  submissionsRemaining?: number;
}

function rejection(reason: string, extra: Partial<VerifyResponse> = {}): VerifyResponse {
  return {
    flagged: true,
    reason,
    brand: null,
    ticker: null,
    amountUsd: null,
    confidence: null,
    ...extra,
  };
}

function isValidWallet(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export const verifyReceiptRouter = Router();

verifyReceiptRouter.post(
  '/verify-receipt',
  (req, res, next) => {
    upload.single('receipt')(req, res, (err: unknown) => {
      if (err instanceof UnsupportedTypeError) {
        res.status(415).json(rejection('Upload a JPG, PNG or PDF receipt.'));
        return;
      }
      if (err instanceof multer.MulterError) {
        const reason =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'That file is over 10 MB. Try a photo instead of a full-resolution scan.'
            : `Upload failed: ${err.message}`;
        res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json(rejection(reason));
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },

  async (req: Request, res: Response) => {
    const walletAddress = req.body?.walletAddress;

    if (!isValidWallet(walletAddress)) {
      res.status(400).json(rejection('A valid Solana wallet address is required.'));
      return;
    }
    if (!req.file) {
      res.status(400).json(rejection('No receipt image was uploaded.'));
      return;
    }

    // --- Quota, before spending anything on the API -------------------------
    const limit = checkRateLimit(walletAddress);
    if (!limit.allowed) {
      const hours = Math.ceil((limit.retryAfterMs ?? 0) / (60 * 60 * 1000));
      res.status(429).json(
        rejection(
          `That's ${MAX_PER_WINDOW} receipts in 24 hours for this wallet. Try again in about ${hours}h.`,
          { submissionsRemaining: 0 },
        ),
      );
      return;
    }

    const attemptToken = recordAttempt(walletAddress);

    // --- Extraction ---------------------------------------------------------
    let extraction;
    try {
      extraction = await extractReceipt(req.file.buffer, req.file.mimetype);
    } catch (error) {
      // Our failure, not theirs — hand the quota slot back.
      releaseAttempt(walletAddress, attemptToken);

      if (error instanceof ClaudeUnavailableError) {
        res.status(502).json(rejection(error.message));
        return;
      }
      res.status(500).json(rejection('Something went wrong verifying that receipt.'));
      return;
    }

    const remaining = checkRateLimit(walletAddress).remaining;
    const seen = {
      merchantName: extraction.merchant_name,
      date: extraction.date,
      currency: extraction.currency,
      submissionsRemaining: remaining,
    };

    // --- Verdict ------------------------------------------------------------
    if (!extraction.looks_authentic) {
      res
        .status(200)
        .json(rejection('This does not look like a genuine receipt.', {
          confidence: extraction.confidence,
          ...seen,
        }));
      return;
    }

    if (extraction.confidence < MIN_CONFIDENCE) {
      res.status(200).json(
        rejection("The receipt couldn't be read clearly enough. Try a sharper, flatter photo.", {
          confidence: extraction.confidence,
          ...seen,
        }),
      );
      return;
    }

    /**
     * Currency guard. `total_amount` is in whatever currency the receipt used,
     * and there is no FX source wired up, so anything not USD is refused rather
     * than assumed.
     *
     * The MAX_RECEIPT_USD cap below is not a substitute. A 50,000 IDR receipt
     * misread as $50,000 would hit the cap and be refused anyway. The ones that
     * slip under it are small-unit currencies: ¥900 of coffee (roughly $6) read
     * as $900 pays $36 at a 4% brand instead of about $0.24 — over 100x.
     *
     * This guard is only as good as the `currency` Claude reports. "$" alone is
     * also CAD, AUD, SGD, HKD, MXN, TWD and others, so the extraction prompt
     * tells Claude to decide from the store's country, not the symbol.
     *
     * ROADMAP: add an FX rate lookup and convert instead of rejecting. Convert
     * BEFORE the MAX_RECEIPT_USD check so the cap stays in dollars.
     */
    if (extraction.currency?.toUpperCase() !== 'USD') {
      res.status(200).json(
        rejection(
          `${extraction.currency ?? 'That currency'} receipts aren't supported yet — USD only for now.`,
          { confidence: extraction.confidence, ...seen },
        ),
      );
      return;
    }

    if (!Number.isFinite(extraction.total_amount) || extraction.total_amount <= 0) {
      res.status(200).json(
        rejection('No valid total could be read from this receipt.', {
          confidence: extraction.confidence,
          ...seen,
        }),
      );
      return;
    }

    if (extraction.total_amount > MAX_RECEIPT_USD) {
      res.status(200).json(
        rejection(`Receipts over $${MAX_RECEIPT_USD.toLocaleString('en-US')} need manual review.`, {
          confidence: extraction.confidence,
          ...seen,
        }),
      );
      return;
    }

    const match = matchBrand(extraction.merchant_name);
    if (!match) {
      res.status(200).json(
        rejection(
          `"${extraction.merchant_name}" isn't one of the brands Stackd supports yet.`,
          { confidence: extraction.confidence, ...seen },
        ),
      );
      return;
    }

    if (isDuplicate(walletAddress, match.brand.slug, extraction.total_amount)) {
      res.status(409).json(
        rejection('This receipt has already been claimed in the last 24 hours.', {
          confidence: extraction.confidence,
          ...seen,
        }),
      );
      return;
    }

    // --- Accepted -----------------------------------------------------------
    recordAccepted(walletAddress, match.brand.slug, extraction.total_amount);

    const amountUsd = Math.round(extraction.total_amount * 100) / 100;
    const cashbackUsd = Math.round(((amountUsd * match.brand.pctBack) / 100) * 1e6) / 1e6;

    // Persist before responding: the id we hand back is the idempotency key the
    // payout leg keys off, so it has to exist in the store first.
    const receiptId = randomUUID();
    await defaultReceiptStore.create({
      id: receiptId,
      walletAddress,
      brandName: match.brand.name,
      brandTicker: match.brand.ticker,
      amountUsd,
      xstockAmount: null,
      imageUrl: null, // ROADMAP: Cloudinary upload
      claudeConfidence: extraction.confidence,
    });

    const response: VerifyResponse = {
      flagged: false,
      receiptId,
      brand: match.brand.name,
      ticker: match.brand.ticker,
      amountUsd,
      confidence: extraction.confidence,
      pctBack: match.brand.pctBack,
      cashbackUsd,
      ...seen,
    };

    res.status(200).json(response);
  },
);
