/**
 * POST /confirm-receipt
 *
 * Called after the user accepts the estimate from /verify-receipt. Pays both
 * legs and reports what landed.
 *
 * The two legs are not equal citizens: the xStock payout is the product, and a
 * failure there is a real error. The STACKD bonus is best effort — a null
 * signature means the vault is paused, which is a normal operating state and
 * must never surface as a failure.
 *
 * A receipt verified for Base is paid in its Base stock instead, by one B20
 * transfer with a memo (packages/base). There is no $STACKD bonus on Base.
 */

import { Router, type Request, type Response } from 'express';
import {
  B20PayoutPausedError,
  B20PayoutUnconfirmedError,
  B20RewardError,
  baseStock,
  basescanTx,
  requireBaseNetwork,
  sendB20Reward,
} from '@stackd/base/server';
import { BRAND_BY_SLUG } from '@stackd/solana';
import {
  PayoutPausedError,
  PayoutUnconfirmedError,
  RewardError,
  getStackdConfig,
  sendStackdBonus,
  sendXStockReward,
  solscanTx,
  defaultReceiptStore,
  type ReceiptRecord,
} from '@stackd/solana/server';
import { BRAND_BY_TICKER, mintFor } from '@stackd/solana';
import { underlyingUsd } from '../lib/base-stock.js';
import type { PayoutChain } from '../lib/chains.js';
import { getGuards } from '../lib/store/guards.js';
import { receiptStoreFor } from '../lib/store/stores.js';

/** Fractional, not a percentage — 0.02 is 2%. */
const BONUS_RATE = Number(process.env.STACKD_BONUS_RATE ?? 0.02);

export interface ConfirmResponse {
  receiptId: string;
  chain: PayoutChain;
  xstock: {
    /** The Solana signature, or the transaction hash on Base. */
    signature: string;
    /** Solana only. */
    solscan?: string;
    /** The transaction on the chain's explorer: Solscan or Basescan. */
    explorer: string;
    ticker: string;
    /** Shares sent. */
    amount: number | null;
  };
  bonus: {
    signature: string;
    solscan: string;
  } | null;
  /** True when the bonus leg deliberately did not pay. Not an error. */
  bonusPaused: boolean;
  /**
   * True when the bonus was held because this is the wallet's first paid
   * receipt. It starts from the second.
   */
  bonusFirstClaim: boolean;
  error?: string;
}

export const confirmReceiptRouter = Router();

confirmReceiptRouter.post('/confirm-receipt', async (req: Request, res: Response) => {
  try {
    await handleConfirm(req, res);
  } catch (error) {
    // Express 4 does not catch async errors: without this, a storage outage
    // leaves the request hanging.
    console.error('[stackd-api] confirm-receipt failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'The payout could not be completed. Try again.' });
    }
  }
});

async function handleConfirm(req: Request, res: Response): Promise<void> {
  const receiptId = typeof req.body?.receiptId === 'string' ? req.body.receiptId.trim() : '';

  if (!receiptId) {
    res.status(400).json({ error: 'receiptId is required.' });
    return;
  }

  const receipt = await defaultReceiptStore.get(receiptId);
  if (!receipt) {
    res.status(404).json({ error: 'That receipt was not found. Verify it again.' });
    return;
  }

  if (receipt.chain === 'base') {
    await confirmOnBase(receipt, res);
    return;
  }

  const brand = BRAND_BY_TICKER[receipt.brandTicker];
  if (!brand) {
    res.status(422).json({ error: `Receipt references unknown brand ${receipt.brandTicker}.` });
    return;
  }

  // --- Leg 1: xStock. Always attempted; failure is a real failure. ----------
  let xstockSignature: string;
  try {
    xstockSignature = await sendXStockReward(
      {
        recipientWallet: receipt.walletAddress,
        // The stand-in on devnet, the real mint on mainnet.
        xstockMint: mintFor(brand),
        spendUsd: receipt.amountUsd,
        pctBack: brand.pctBack,
        receiptId,
      },
      // The daily circuit breaker. Reserved only by the call that wins the
      // payout claim, so a double-click cannot count one payout twice.
      { budget: getGuards().budget },
    );
  } catch (error) {
    if (error instanceof PayoutPausedError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof PayoutUnconfirmedError) {
      // Sent, outcome unknown. Telling the user to retry would be wrong — the
      // claim stays held so a retry cannot send twice.
      console.error('[stackd-api] xStock payout unconfirmed:', error.signature);
      res.status(202).json({
        error:
          "Your payout was sent but hasn't confirmed yet. Check your wallet in a few minutes — " +
          "there's no need to claim again.",
        signature: error.signature,
        solscan: solscanTx(error.signature),
      });
      return;
    }
    console.error('[stackd-api] xStock payout failed:', error);
    const message =
      error instanceof RewardError
        ? error.message
        : 'The payout could not be completed. Nothing was sent — try again.';
    res.status(502).json({ error: message });
    return;
  }

  // --- Leg 2: STACKD bonus. Best effort; null is expected. -----------------
  // Held back on a wallet's first paid receipt. The bonus needs a second token
  // account in the user's wallet, and its rent (~0.0015 SOL, paid by the
  // treasury and never recovered) is more than the reward on a small receipt.
  // From the second receipt on, that rent is spent only on people who came
  // back.
  let bonusFirstClaim = false;
  let holdBonus = false;
  if (getStackdConfig()) {
    try {
      bonusFirstClaim = !(await defaultReceiptStore.hasPriorPayout(receipt.walletAddress, receiptId));
      holdBonus = bonusFirstClaim;
    } catch (error) {
      // History unreadable: hold the bonus rather than spend rent on a guess,
      // and report an ordinary pause — we do not know it is a first claim.
      console.warn('[stackd-api] could not read payout history; holding the bonus:', error);
      holdBonus = true;
    }
  }

  let bonusSignature: string | null = null;
  if (!holdBonus) {
    try {
      bonusSignature = await sendStackdBonus(
        {
          recipientWallet: receipt.walletAddress,
          spendUsd: receipt.amountUsd,
          bonusRate: BONUS_RATE,
          receiptId,
        },
        // The same daily cap as the xStock leg: a new $STACKD account's rent
        // is spend like any other.
        { budget: getGuards().budget },
      );
    } catch (error) {
      // sendStackdBonus swallows its own failures, so reaching here is unusual.
      // Still not fatal: the xStock leg has already landed.
      console.warn('[stackd-api] bonus leg threw unexpectedly:', error);
      bonusSignature = null;
    }
  }

  const updated = await defaultReceiptStore.get(receiptId);

  const payload: ConfirmResponse = {
    receiptId,
    chain: 'solana',
    xstock: {
      signature: xstockSignature,
      solscan: solscanTx(xstockSignature),
      explorer: solscanTx(xstockSignature),
      ticker: brand.ticker,
      amount: updated?.xstockAmount ?? null,
    },
    bonus: bonusSignature
      ? { signature: bonusSignature, solscan: solscanTx(bonusSignature) }
      : null,
    bonusPaused: bonusSignature === null,
    bonusFirstClaim,
  };

  res.status(200).json(payload);
}

/**
 * Pay a Base receipt: one B20 transfer of the brand's Base stock, carrying the
 * receipt's memo and Builder Code. Same outcomes as the Solana leg: paused (the
 * daily cap), unconfirmed (sent, outcome unknown: the claim stays held), or a
 * refusal with nothing sent.
 */
async function confirmOnBase(receipt: ReceiptRecord, res: Response): Promise<void> {
  const stock = baseStock(receipt.brandTicker);
  const brand = stock ? BRAND_BY_SLUG[stock.slug] : undefined;
  if (!stock || !brand) {
    res.status(422).json({ error: `Receipt references unknown Base stock ${receipt.brandTicker}.` });
    return;
  }
  if (!receipt.fingerprint) {
    // Every receipt verified for Base has one; the memo is derived from it.
    res.status(422).json({ error: 'That receipt cannot be paid on Base. Verify it again.' });
    return;
  }

  let network;
  try {
    network = requireBaseNetwork();
  } catch {
    res.status(503).json({ error: 'Payouts on Base are switched off right now. Your receipt is saved.' });
    return;
  }

  let hash: string;
  try {
    hash = await sendB20Reward(
      {
        receiptId: receipt.id,
        recipientWallet: receipt.walletAddress,
        stock: stock.ticker,
        spendUsd: receipt.amountUsd,
        pctBack: brand.pctBack,
        fingerprint: receipt.fingerprint,
      },
      {
        store: receiptStoreFor('base'),
        budget: getGuards().budgetFor('base'),
        fetchUnderlyingUsd: underlyingUsd,
      },
    );
  } catch (error) {
    if (error instanceof B20PayoutPausedError) {
      res.status(503).json({ error: error.message });
      return;
    }
    if (error instanceof B20PayoutUnconfirmedError) {
      console.error('[stackd-api] Base payout unconfirmed:', error.txHash);
      res.status(202).json({
        error:
          "Your payout was sent but hasn't confirmed yet. Check your wallet in a few minutes — " +
          "there's no need to claim again.",
        signature: error.txHash,
        explorer: basescanTx(error.txHash, network),
      });
      return;
    }
    console.error('[stackd-api] Base payout failed:', error);
    const message =
      error instanceof B20RewardError
        ? error.message
        : 'The payout could not be completed. Nothing was sent — try again.';
    res.status(502).json({ error: message });
    return;
  }

  const updated = await defaultReceiptStore.get(receipt.id);
  const payload: ConfirmResponse = {
    receiptId: receipt.id,
    chain: 'base',
    xstock: {
      signature: hash,
      explorer: basescanTx(hash, network),
      ticker: stock.ticker,
      amount: updated?.xstockAmount ?? null,
    },
    bonus: null,
    bonusPaused: false,
    bonusFirstClaim: false,
  };
  res.status(200).json(payload);
}
