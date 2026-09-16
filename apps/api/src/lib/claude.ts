/**
 * Receipt extraction via Claude vision.
 *
 * Uses structured outputs (`output_config.format` + `messages.parse`) rather
 * than asking for "JSON only" in the prompt. The schema is enforced server-side,
 * so there is no markdown fence to strip and no half-JSON to repair — which
 * matters because assistant prefill (the old way to force a leading `{`) returns
 * a 400 on current models.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's zod helper is built against Zod 4 internals and imports `zod/v4`.
// Importing plain `zod` here gives a Zod 3 schema object that `zodOutputFormat`
// rejects at the type level, so use the same subpath it does.
import * as z from 'zod/v4';

/**
 * Current Claude Sonnet. Verified against the SDK/docs rather than carried over
 * from the original spec, which named `claude-sonnet-4-20250514` — a retired id.
 * Model ids for this generation carry no date suffix.
 */
export const RECEIPT_MODEL = 'claude-sonnet-5';

export const ExtractionSchema = z.object({
  merchant_name: z
    .string()
    .describe('The store or brand name exactly as printed on the receipt.'),
  total_amount: z
    .number()
    .describe('The final total actually paid, as a number. No currency symbol.'),
  currency: z.string().describe('ISO 4217 three-letter code, e.g. USD, IDR, EUR.'),
  date: z.string().describe('Transaction date as YYYY-MM-DD.'),
  looks_authentic: z
    .boolean()
    .describe('False if this looks AI-generated, edited, or otherwise not a real receipt.'),
  confidence: z.number().describe('Confidence in this extraction, 0.0 to 1.0.'),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You verify retail receipts for a cashback product. You are the only
check standing between a user and a payout of real tokenized equity, so both
false accepts and false rejects cost real money.

Judging authenticity, weigh:
- Rendering: real receipts are photographed or scanned. Perfectly clean, evenly
  lit, pixel-aligned text with no paper texture, glare, fold or curl suggests a
  generated image.
- Typography: thermal receipts use monospace fonts with uneven ink. Crisp
  proportional fonts or inconsistent baselines suggest editing.
- Internal arithmetic: line items should sum to the subtotal, and subtotal plus
  tax should equal the total. Numbers that do not reconcile are a strong signal.
- Plausibility: item names, prices, tax rate, store address and time of day
  should be consistent with the named merchant.
- Tampering: mismatched fonts or spacing around the total specifically, which is
  the field worth altering.

Set looks_authentic false when you see real evidence of fabrication, not merely
because an image is low quality — a blurry phone photo of a genuine receipt is
still genuine. Let confidence carry legibility problems instead.

Set confidence to how sure you are of the extracted fields overall. If the total
is unreadable, that is low confidence, not a guess.`;

const USER_PROMPT = `Extract the fields from this receipt and judge whether it is genuine.`;

type ImageMedia = 'image/jpeg' | 'image/png';

/** Build the content block for the upload. PDFs are documents, not images. */
function sourceBlock(file: Buffer, mimeType: string): Anthropic.ContentBlockParam {
  const data = file.toString('base64');

  if (mimeType === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data },
    };
  }

  return {
    type: 'image',
    source: { type: 'base64', media_type: mimeType as ImageMedia, data },
  };
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export class ClaudeUnavailableError extends Error {}

/**
 * Send the receipt to Claude and return the parsed extraction.
 *
 * Throws {@link ClaudeUnavailableError} for infrastructure failures so the
 * caller can distinguish "we could not check" (don't charge the user a
 * submission) from "we checked and it failed" (do).
 */
export async function extractReceipt(file: Buffer, mimeType: string): Promise<Extraction> {
  let message;

  try {
    message = await getClient().messages.parse({
      model: RECEIPT_MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      // Adaptive is the only on-mode on current models; budget_tokens is a 400.
      thinking: { type: 'adaptive' },
      output_config: {
        // Fraud judgement benefits from some deliberation, but a user is
        // watching a spinner. Raise to 'high' if fakes start getting through.
        effort: 'medium',
        format: zodOutputFormat(ExtractionSchema),
      },
      messages: [
        {
          role: 'user',
          // The document/image block must precede the text block.
          content: [sourceBlock(file, mimeType), { type: 'text', text: USER_PROMPT }],
        },
      ],
    });
  } catch (error) {
    // Always log the real cause — the client only ever sees a sanitised string.
    console.error('[stackd-api] receipt extraction failed:', error);

    if (error instanceof Anthropic.AuthenticationError) {
      throw new ClaudeUnavailableError('Receipt verification is misconfigured (bad credentials).');
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new ClaudeUnavailableError('Verification is busy right now. Try again in a moment.');
    }
    if (error instanceof Anthropic.APIError) {
      throw new ClaudeUnavailableError(`Verification service error (${error.status ?? 'unknown'}).`);
    }
    // No credentials at all throws a plain Error, not a typed one, so the
    // message is the only signal available. Checked narrowly on purpose.
    if (error instanceof Error && error.message.includes('Could not resolve authentication')) {
      throw new ClaudeUnavailableError(
        'Receipt verification is not configured on the server (no ANTHROPIC_API_KEY).',
      );
    }
    throw new ClaudeUnavailableError('Could not reach the verification service.');
  }

  // A safety decline returns HTTP 200 — check before reading content.
  if (message.stop_reason === 'refusal') {
    throw new ClaudeUnavailableError('Claude declined to process this image.');
  }

  if (!message.parsed_output) {
    // Schema-constrained, so this means truncation (max_tokens) far more often
    // than malformed output.
    throw new ClaudeUnavailableError('Claude returned no parsable result.');
  }

  return message.parsed_output;
}
