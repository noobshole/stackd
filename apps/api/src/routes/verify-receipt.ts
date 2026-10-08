/**
 * POST /verify-receipt
 *
 * Verifies a receipt and returns what the user would earn. It does NOT move
 * tokens — the frontend shows this estimate, the user confirms, and the
 * transfer happens on POST /confirm-receipt.
 *
 * A receipt arrives one of two ways, and each is read by its own lane:
 *   photo — a JPG, PNG or PDF. Claude judges whether it is genuine.
 *   email — a saved receipt email (.eml). The brand's DKIM signature proves
 *           it genuine (lib/email-receipt.ts); Claude only reads it.
 *
 * Order matters, cheapest refusal first:
 *   1. exact re-upload (file hash)        — free, before Claude
 *      photos: file provenance (AI / editor tags) — free, before Claude
 *   2. wallet / IP / global limits        — before Claude, which costs money
 *   3. read the receipt
 *      photo: Claude — authenticity, amounts that reconcile, confidence,
 *             total; stricter for digital receipts
 *      email: the DKIM signature, then Claude reads the verified text
 *   4. date window                         — no shoebox of old receipts, none from the future
 *   5. currency -> USD, then the USD caps
 *   6. brand match (an email's brand is its signature's)
 *   7. fingerprint: the same receipt re-photographed or re-sent, from any wallet
 *      stock: the treasury holds enough of the brand's xStock to pay it
 *   8. insert — the database's unique indexes are the final, race-safe check
 */

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { PublicKey } from '@solana/web3.js';
import type { Brand } from '@stackd/solana';
import { DuplicateReceiptError, defaultReceiptStore } from '@stackd/solana/server';
import { ClaudeUnavailableError, extractEmailReceipt, extractReceipt } from '../lib/claude.js';
import { emailIdentityKeys, isEmailUpload, verifyReceiptEmail } from '../lib/email-receipt.js';
import { FxUnavailableError, UnsupportedCurrencyError, toUsd } from '../lib/fx.js';
import { matchBrand } from '../lib/match-brand.js';
import { checkPayoutStock } from '../lib/inventory.js';
import { checkProvenance } from '../lib/provenance.js';
import {
  MAX_DIGITAL_RECEIPT_USD,
  checkReceiptDate,
  eligibleAmountUsd,
  normaliseReceiptNumber,
  onlineOrderKey,
  positiveNumberEnv,
  receiptFingerprint,
  sha256Hex,
} from '../lib/receipt-checks.js';
import { getGuards, limits, type LimitKind } from '../lib/store/guards.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/** Below this, we do not trust the extraction enough to pay out. */
const MIN_CONFIDENCE = 0.7;

/**
 * Largest receipt we will honour, in USD. A blunt cap on how much a single
 * bad extraction can cost the treasury. Policy knob, not a law of nature.
 */
const MAX_RECEIPT_USD = positiveNumberEnv('MAX_RECEIPT_USD', 1000);

const DUPLICATE_REASON = 'This receipt has already been claimed.';

class UnsupportedTypeError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ACCEPTED_TYPES.has(file.mimetype) && !isEmailUpload(file)) {
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
  /** eligible USD * pctBack / 100. The frontend converts to shares via Jupiter. */
  cashbackUsd?: number;
  /**
   * Present only when an online order was capped: the part of amountUsd that
   * earns cashback, and the cap that applied.
   */
  eligibleUsd?: number;
  digitalCapUsd?: number;
  /** Present when the receipt is an email whose DKIM signature verified. */
  verifiedBy?: { method: 'dkim'; domain: string };
  /** What Claude actually read, so the UI can show its working. */
  merchantName?: string;
  date?: string;
  currency?: string;
  /** The total as printed, in `currency`. amountUsd is this converted. */
  originalAmount?: number;
  /** Units of `currency` per 1 USD (ECB reference). 1 for USD receipts. */
  fxRate?: number;
  /** Publication date of fxRate. Null for USD receipts. */
  fxRateDate?: string | null;
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

function limitMessage(limit: LimitKind, retryAfterMs: number | null): string {
  const minutes = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 60_000));
  const wait = minutes >= 90 ? `about ${Math.ceil(minutes / 60)}h` : `about ${minutes} min`;
  switch (limit) {
    case 'wallet':
      return `That's ${limits.walletPerDay} receipts in 24 hours for this wallet. Try again in ${wait}.`;
    case 'ip':
      return `Too many receipts from this network. Try again in ${wait}.`;
    case 'global':
      return `Stackd is getting a lot of receipts right now. Try again in ${wait}.`;
  }
}

/** A receipt as either lane read it, ready for the checks they share. */
interface Reading {
  documentType: 'paper_receipt_photo' | 'digital_receipt' | 'verified_email';
  merchantName: string;
  totalAmount: number;
  currency: string;
  /** The purchase date as read, YYYY-MM-DD. */
  date: string;
  time: string;
  receiptNumber: string;
  confidence: number;
  /** Emails only: the date the brand signed it, which the date window uses. */
  signedDate?: string;
  /** Emails only: the brand the signature belongs to. */
  brand?: Brand;
  /** Emails only: identity keys of the email itself. */
  identityKeys?: string[];
  verifiedBy?: VerifyResponse['verifiedBy'];
}

/**
 * What a lane hands back: a reading, or the response to send. `release` marks
 * our failure rather than the receipt's, so the user's attempt is handed back.
 */
type LaneResult =
  | { ok: true; reading: Reading }
  | { ok: false; status: number; reason: string; release?: boolean; seen?: Partial<VerifyResponse> };

export const verifyReceiptRouter = Router();

verifyReceiptRouter.post(
  '/verify-receipt',
  (req, res, next) => {
    upload.single('receipt')(req, res, (err: unknown) => {
      if (err instanceof UnsupportedTypeError) {
        res
          .status(415)
          .json(rejection('Upload a JPG, PNG or PDF receipt, or the receipt email as an .eml file.'));
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
    try {
      await handleVerify(req, res);
    } catch (error) {
      // Express 4 does not catch async errors; without this a storage outage
      // would leave the request hanging instead of failing.
      console.error('[stackd-api] verify-receipt failed:', error);
      if (!res.headersSent) {
        res.status(500).json(rejection('Something went wrong verifying that receipt.'));
      }
    }
  },
);

async function handleVerify(req: Request, res: Response): Promise<void> {
  // Taken before the Claude call, which can take several seconds: the date
  // window is measured from when the user submitted, not when we finished.
  const submittedAt = new Date();
  const walletAddress = req.body?.walletAddress;

  if (!isValidWallet(walletAddress)) {
    res.status(400).json(rejection('A valid Solana wallet address is required.'));
    return;
  }
  if (!req.file) {
    res.status(400).json(rejection('No receipt was uploaded.'));
    return;
  }

  const guards = getGuards();
  const isEmail = isEmailUpload(req.file);

  // --- 1. Exact re-upload: refuse before spending a Claude call on it ------
  const imageSha256 = sha256Hex(req.file.buffer);
  if (await defaultReceiptStore.findDuplicate({ imageSha256 })) {
    res.status(409).json(rejection(DUPLICATE_REASON));
    return;
  }

  // AI-generation labels and desktop-editor stamps in the file itself. Free,
  // so it runs before the quota and the Claude call. Images and PDFs only:
  // an email's own signature is a far stronger check.
  if (!isEmail) {
    const provenance = checkProvenance(req.file.buffer);
    if (!provenance.ok) {
      console.warn(
        `[stackd-api] provenance refusal (${provenance.kind}: ${provenance.marker}) from ${walletAddress}`,
      );
      res.status(200).json(rejection(provenance.reason));
      return;
    }
  }

  // --- 2. Limits, before spending anything on the API ---------------------
  // req.ip honours TRUST_PROXY (see index.ts), so behind a proxy this is the
  // client, not the proxy — and cannot be spoofed when TRUST_PROXY is unset.
  const ip = req.ip ?? 'unknown';
  const attempt = await guards.tryAttempt(walletAddress, ip);
  if (!attempt.allowed || !attempt.token) {
    res.status(429).json(
      rejection(limitMessage(attempt.limit ?? 'global', attempt.retryAfterMs), {
        submissionsRemaining: await guards.walletRemaining(walletAddress),
      }),
    );
    return;
  }
  const submissionsRemaining = await guards.walletRemaining(walletAddress);

  // --- 3. Read the receipt ------------------------------------------------
  const lane = isEmail
    ? await readEmail(req.file.buffer, walletAddress)
    : await readPhoto(req.file.buffer, req.file.mimetype, walletAddress);

  if (!lane.ok) {
    if (lane.release) await guards.releaseAttempt(attempt.token);
    res.status(lane.status).json(
      rejection(lane.reason, {
        ...lane.seen,
        submissionsRemaining: lane.release
          ? await guards.walletRemaining(walletAddress)
          : submissionsRemaining,
      }),
    );
    return;
  }
  const reading = lane.reading;

  const seen = {
    merchantName: reading.merchantName,
    date: reading.date,
    currency: reading.currency,
    confidence: reading.confidence,
    submissionsRemaining,
  };

  // --- 4. Date window -----------------------------------------------------
  // An email's signing date is part of what the brand signed, so it decides
  // the window rather than the date read from the text.
  const dated = checkReceiptDate(reading.signedDate ?? reading.date, submittedAt);
  if (!dated.ok) {
    res.status(200).json(rejection(dated.reason, seen));
    return;
  }

  /**
   * --- 5. Currency -> USD ---------------------------------------------------
   * `totalAmount` is in whatever currency the receipt used; every check after
   * this point, and the payout, works in dollars.
   *
   * This must run BEFORE the MAX_RECEIPT_USD cap. Skipping it is not caught
   * by the cap: ¥900 of coffee (roughly $6) read as $900 slips under $1,000
   * and pays $36 at a 4% brand instead of about $0.24.
   *
   * Conversion is only as good as the `currency` Claude reports. "$" alone is
   * also CAD, AUD, SGD, HKD, MXN, TWD and others, so the extraction prompts
   * tell Claude to decide from the store's country, not the symbol.
   */
  let conversion;
  try {
    conversion = await toUsd(reading.totalAmount, reading.currency);
  } catch (error) {
    if (error instanceof UnsupportedCurrencyError) {
      res.status(200).json(rejection(error.message, seen));
      return;
    }
    // Could not price it. Our failure, not theirs — hand the quota slot back,
    // and never fall back to treating the total as dollars.
    await guards.releaseAttempt(attempt.token);
    const reason =
      error instanceof FxUnavailableError
        ? `${error.message} Try again shortly.`
        : 'Something went wrong converting that receipt.';
    res.status(502).json(rejection(reason, seen));
    return;
  }

  const amountUsd = Math.round(conversion.amountUsd * 100) / 100;
  const fx = {
    currency: conversion.currency,
    originalAmount: conversion.originalAmount,
    fxRate: conversion.rate,
    fxRateDate: conversion.rateDate,
  };

  if (amountUsd < 0.01) {
    res.status(200).json(
      rejection('That receipt total is too small to earn cashback.', { ...seen, ...fx }),
    );
    return;
  }

  if (amountUsd > MAX_RECEIPT_USD) {
    res.status(200).json(
      rejection(`Receipts over $${MAX_RECEIPT_USD.toLocaleString('en-US')} need manual review.`, {
        ...seen,
        ...fx,
      }),
    );
    return;
  }

  // --- 6. Brand -----------------------------------------------------------
  // An email's brand is the one whose key signed it, never the text inside.
  const match = reading.brand
    ? { brand: reading.brand, matchedOn: 'DKIM signature' }
    : matchBrand(reading.merchantName);
  if (!match) {
    res.status(200).json(
      rejection(`"${reading.merchantName}" isn't one of the brands Stackd supports yet.`, {
        ...seen,
        ...fx,
      }),
    );
    return;
  }

  // --- 7. Fingerprint: same receipt, different photo or file, any wallet --
  // Keyed on the printed total, not the converted USD: the rate refreshes
  // daily, so a USD key would let the same receipt through again tomorrow.
  const identity = receiptFingerprint({
    brandSlug: match.brand.slug,
    date: dated.date,
    totalAmount: reading.totalAmount,
    currency: conversion.currency,
    receiptNumber: reading.receiptNumber,
    time: reading.time,
  });
  // A photo has to say which transaction it is. A verified email already
  // does: its signature is unique to it.
  if (!identity.ok && !reading.identityKeys?.length) {
    res.status(200).json(rejection(identity.reason, { ...seen, ...fx }));
    return;
  }
  // Online orders, by email or screenshot, also count once per order number.
  const orderKey =
    reading.documentType === 'paper_receipt_photo'
      ? null
      : onlineOrderKey(match.brand.slug, reading.receiptNumber);
  const fingerprints = [
    ...new Set([
      ...(reading.identityKeys ?? []),
      ...(orderKey ? [orderKey] : []),
      ...(identity.ok ? identity.fingerprints : []),
    ]),
  ];
  if (await defaultReceiptStore.findDuplicate({ fingerprints })) {
    res.status(409).json(rejection(DUPLICATE_REASON, { ...seen, ...fx }));
    return;
  }

  // Online orders earn on at most MAX_DIGITAL_RECEIPT_USD (see eligibleAmountUsd).
  const { eligibleUsd, capped } = eligibleAmountUsd(amountUsd, reading.documentType);
  const cashbackUsd = Math.round(((eligibleUsd * match.brand.pctBack) / 100) * 1e6) / 1e6;

  // --- 7b. Stock: can the treasury actually pay this brand? ---------------
  // Payouts send xStocks the treasury holds; nothing buys them on demand. An
  // out-of-stock brand is our shortfall, not the user's, so their attempt is
  // handed back and nothing is stored — the same receipt can be sent again
  // once restocked. When stock cannot be read, proceed: the transfer is the
  // real check and fails with nothing sent (see lib/inventory.ts).
  const stock = await checkPayoutStock(match.brand, cashbackUsd);
  if (stock.ok === false) {
    await guards.releaseAttempt(attempt.token);
    console.warn(
      `[stackd-api] ${match.brand.ticker} out of stock: treasury holds ` +
        `${stock.heldShares}, payout needs ~${stock.neededShares.toFixed(8)}`,
    );
    res.status(503).json(
      rejection(
        `Payouts in ${match.brand.ticker} are paused while we restock. Your receipt wasn't ` +
          'used up — send it again later.',
        { ...seen, ...fx, submissionsRemaining: await guards.walletRemaining(walletAddress) },
      ),
    );
    return;
  }
  if (stock.ok === null) {
    console.warn(`[stackd-api] stock check skipped for ${match.brand.ticker}: ${stock.reason}`);
  }

  // --- 8. Accepted: persist before responding -----------------------------
  // The id we hand back is the idempotency key the payout keys off, so it has
  // to exist first. The insert is also the final duplicate check: two uploads
  // of one receipt racing each other cannot both land.
  const receiptId = randomUUID();
  try {
    await defaultReceiptStore.create({
      id: receiptId,
      walletAddress,
      brandName: match.brand.name,
      brandTicker: match.brand.ticker,
      // The payout is computed from this, so it is the eligible amount; the full
      // total stays on record as originalAmount at fxRate.
      amountUsd: eligibleUsd,
      originalAmount: fx.originalAmount,
      originalCurrency: fx.currency,
      fxRate: fx.fxRate,
      fxRateDate: fx.fxRateDate,
      xstockAmount: null,
      imageUrl: null, // ROADMAP: store the image for disputes
      claudeConfidence: reading.confidence,
      imageSha256,
      fingerprint: fingerprints[0],
      fingerprints,
      receiptDate: dated.date,
      receiptNumber: identity.ok
        ? identity.receiptNumber
        : normaliseReceiptNumber(reading.receiptNumber) || null,
      receiptTime: identity.ok ? identity.receiptTime : null,
    });
  } catch (error) {
    if (error instanceof DuplicateReceiptError) {
      res.status(409).json(rejection(DUPLICATE_REASON, { ...seen, ...fx }));
      return;
    }
    throw error;
  }

  const response: VerifyResponse = {
    flagged: false,
    receiptId,
    brand: match.brand.name,
    ticker: match.brand.ticker,
    amountUsd,
    pctBack: match.brand.pctBack,
    cashbackUsd,
    ...(capped ? { eligibleUsd, digitalCapUsd: MAX_DIGITAL_RECEIPT_USD } : {}),
    ...(reading.verifiedBy ? { verifiedBy: reading.verifiedBy } : {}),
    ...seen,
    ...fx,
  };

  res.status(200).json(response);
}

// ---------------------------------------------------------------------------
// Photo lane: Claude judges the image
// ---------------------------------------------------------------------------

async function readPhoto(file: Buffer, mimeType: string, walletAddress: string): Promise<LaneResult> {
  let extraction;
  try {
    extraction = await extractReceipt(file, mimeType);
  } catch (error) {
    // Our failure, not theirs — hand the quota slot back.
    if (error instanceof ClaudeUnavailableError) {
      return { ok: false, status: 502, reason: error.message, release: true };
    }
    console.error('[stackd-api] receipt extraction threw:', error);
    return {
      ok: false,
      status: 500,
      reason: 'Something went wrong verifying that receipt.',
      release: true,
    };
  }

  const seen = {
    merchantName: extraction.merchant_name,
    date: extraction.date,
    currency: extraction.currency,
    confidence: extraction.confidence,
  };
  const refuse = (reason: string): LaneResult => ({ ok: false, status: 200, reason, seen });

  if (extraction.document_type === 'other') {
    return refuse("That doesn't look like a receipt.");
  }

  // The signals are logged, never returned: telling a forger which detail gave
  // them away is a free lesson for the next attempt.
  const signals = extraction.fraud_signals.join('; ') || 'none listed';

  if (!extraction.looks_authentic) {
    console.warn(`[stackd-api] not authentic (${extraction.document_type}) from ${walletAddress}: ${signals}`);
    return refuse('This does not look like a genuine receipt.');
  }

  /**
   * Amounts that contradict each other refuse the receipt on any document
   * type, whatever the overall verdict. Editing the total is the cheapest
   * forgery there is, and in testing Claude named exactly that mismatch
   * ("line items 61,500 vs total 161,500") yet still leaned genuine overall.
   * Worded for the honest case — a misread digit — not as an accusation.
   */
  if (!extraction.totals_reconcile) {
    console.warn(`[stackd-api] totals do not reconcile from ${walletAddress}: ${signals}`);
    return refuse(
      "The amounts on this receipt don't add up. Try a sharper photo of the whole receipt.",
    );
  }

  /**
   * Online receipts are where the fakes are: a generator site or an image model
   * makes one in minutes, and there is no paper to check it against. So on a
   * digital receipt any sign of fabrication Claude reports is a refusal, even
   * when its overall verdict leans genuine; paper photos keep that overall
   * verdict. And a real online order always has an order number — without one
   * there is nothing that stops the same order being claimed twice.
   */
  if (extraction.document_type === 'digital_receipt') {
    if (extraction.fraud_signals.length > 0) {
      console.warn(`[stackd-api] digital receipt with fraud signals from ${walletAddress}: ${signals}`);
      return refuse('This does not look like a genuine receipt.');
    }
    if (!normaliseReceiptNumber(extraction.receipt_number)) {
      return refuse('Online receipts must show the order number. Include it in the screenshot.');
    }
  }

  if (extraction.confidence < MIN_CONFIDENCE) {
    return refuse("The receipt couldn't be read clearly enough. Try a sharper, flatter photo.");
  }

  if (!Number.isFinite(extraction.total_amount) || extraction.total_amount <= 0) {
    return refuse('No valid total could be read from this receipt.');
  }

  return {
    ok: true,
    reading: {
      documentType: extraction.document_type,
      merchantName: extraction.merchant_name,
      totalAmount: extraction.total_amount,
      currency: extraction.currency,
      date: extraction.date,
      time: extraction.time,
      receiptNumber: extraction.receipt_number,
      confidence: extraction.confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Email lane: the brand's signature proves it, Claude reads it
// ---------------------------------------------------------------------------

/**
 * A failed signature is refused, never handed to Claude to judge instead: an
 * email claiming to be from amazon.com whose signature breaks was almost
 * certainly edited, and the edit is exactly what pixels cannot reveal. The
 * refusal points to the photo lane, which keeps its own stricter checks and
 * the online-order cap.
 */
async function readEmail(raw: Buffer, walletAddress: string): Promise<LaneResult> {
  const verdict = await verifyReceiptEmail(raw);
  if (!verdict.ok) {
    if (verdict.kind === 'dns') {
      return { ok: false, status: 502, reason: verdict.reason, release: true };
    }
    console.warn(`[stackd-api] email refused (${verdict.kind}) from ${walletAddress}`);
    return { ok: false, status: 200, reason: verdict.reason };
  }

  if (!verdict.text) {
    return { ok: false, status: 200, reason: "That email doesn't contain a readable receipt." };
  }

  let extraction;
  try {
    extraction = await extractEmailReceipt({
      senderDomain: verdict.senderDomain,
      subject: verdict.subject,
      text: verdict.text,
    });
  } catch (error) {
    if (error instanceof ClaudeUnavailableError) {
      return { ok: false, status: 502, reason: error.message, release: true };
    }
    console.error('[stackd-api] email extraction threw:', error);
    return {
      ok: false,
      status: 500,
      reason: 'Something went wrong verifying that receipt.',
      release: true,
    };
  }

  const seen = {
    merchantName: extraction.merchant_name || verdict.brand.name,
    date: extraction.date,
    currency: extraction.currency,
    confidence: extraction.confidence,
  };
  const refuse = (reason: string): LaneResult => ({ ok: false, status: 200, reason, seen });

  if (extraction.email_kind === 'refund_or_cancellation') {
    return refuse("Refunds and cancelled orders don't earn cashback.");
  }
  if (extraction.email_kind !== 'purchase_receipt') {
    return refuse(
      `That email from ${verdict.brand.name} isn't a receipt. Upload the order confirmation or payment receipt.`,
    );
  }
  if (extraction.confidence < MIN_CONFIDENCE) {
    return refuse("The total in this email couldn't be read clearly enough.");
  }
  if (!Number.isFinite(extraction.total_amount) || extraction.total_amount <= 0) {
    return refuse('No valid total could be read from this email.');
  }

  console.info(
    `[stackd-api] DKIM-verified ${verdict.brand.ticker} email (${verdict.signingDomain}) from ${walletAddress}`,
  );

  return {
    ok: true,
    reading: {
      documentType: 'verified_email',
      merchantName: seen.merchantName,
      totalAmount: extraction.total_amount,
      currency: extraction.currency,
      date: extraction.date,
      time: extraction.time,
      receiptNumber: extraction.receipt_number,
      confidence: extraction.confidence,
      signedDate: verdict.signedAt ? verdict.signedAt.toISOString().slice(0, 10) : undefined,
      brand: verdict.brand,
      identityKeys: emailIdentityKeys({
        brandSlug: verdict.brand.slug,
        signatureIds: verdict.signatureIds,
        messageId: verdict.messageId,
      }),
      verifiedBy: { method: 'dkim', domain: verdict.signingDomain },
    },
  };
}
