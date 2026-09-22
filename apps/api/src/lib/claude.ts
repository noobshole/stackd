/**
 * Receipt extraction via Claude vision.
 *
 * Claude reports through a single strict tool, `record_receipt`, rather than
 * structured outputs (`output_config.format`). Both are schema-enforced on the
 * Claude API, but relays differ: OpenRouter passes tools through and silently
 * drops `output_config.format`, which left Claude answering in free-form
 * markdown (checked 2026-09-22). A tool call arrives as structured input on
 * either route, and it is validated against the zod schema regardless, so a
 * relay that skips `strict` still cannot hand back a malformed result.
 * (Assistant prefill, the old way to force JSON, is a 400 on current models.)
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
const MODEL = 'claude-sonnet-5';

/**
 * Claude is reached either directly or through OpenRouter's Anthropic-compatible
 * endpoint, for accounts that can't top up the Anthropic Console. Chosen purely
 * by env, and the SDK reads all of it itself:
 *   direct:     ANTHROPIC_API_KEY=sk-ant-...
 *   OpenRouter: ANTHROPIC_BASE_URL=https://openrouter.ai/api
 *               ANTHROPIC_AUTH_TOKEN=sk-or-...   (sent as a Bearer token)
 *               ANTHROPIC_API_KEY left empty — the SDK treats "" as unset
 * The request body is identical; OpenRouter only wants its provider prefix on
 * the model id.
 */
export const VIA_OPENROUTER = /openrouter\.ai/i.test(process.env.ANTHROPIC_BASE_URL ?? '');
export const RECEIPT_MODEL = VIA_OPENROUTER ? `anthropic/${MODEL}` : MODEL;

export function claudeConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim(),
  );
}

export const ExtractionSchema = z.object({
  merchant_name: z
    .string()
    .describe('The store or brand name exactly as printed on the receipt.'),
  total_amount: z
    .number()
    .describe(
      'The final total actually paid, as a plain number in the receipt currency. ' +
        'Read separators by locale: "Rp 50.000" is 50000, "€1.234,50" is 1234.5.',
    ),
  currency: z
    .string()
    .describe(
      'ISO 4217 three-letter code of the currency actually paid, e.g. USD, IDR, EUR. ' +
        'Decided from where the store is, not from the symbol alone.',
    ),
  date: z
    .string()
    .describe('Transaction date as YYYY-MM-DD. Empty string if no date is printed.'),
  time: z
    .string()
    .describe('Time of purchase as printed, e.g. "14:32" or "2:32 PM". Empty string if none.'),
  receipt_number: z
    .string()
    .describe(
      'The number that identifies this transaction, exactly as printed. Prefer one labelled ' +
        'receipt, transaction, trans, order, invoice or check/cheque number; otherwise the ' +
        'most transaction-specific number on the receipt. Never a phone number, store ' +
        'number, tax ID or card digits. Empty string if none.',
    ),
  document_type: z
    .enum(['paper_receipt_photo', 'digital_receipt', 'other'])
    .describe(
      'paper_receipt_photo: a photo or scan of a printed paper receipt. digital_receipt: a ' +
        'screenshot, email, PDF, app screen or web order page. other: not a receipt.',
    ),
  totals_reconcile: z
    .boolean()
    .describe(
      'True when the printed amounts agree with each other: line items add up to the ' +
        'subtotal; subtotal with tax, service charge, shipping, discounts and rounding equals ' +
        'the total; payment or tender lines match the total. Also true when too few amounts ' +
        'are printed to check. False when any printed amounts contradict each other.',
    ),
  // Before looks_authentic on purpose: the evidence is written down before the verdict.
  fraud_signals: z
    .array(z.string())
    .describe(
      'Each concrete sign of fabrication, editing or AI generation you found, one short ' +
        'phrase each. Only suspicious findings, not neutral observations. Empty if none.',
    ),
  looks_authentic: z
    .boolean()
    .describe('False if this looks AI-generated, edited, or otherwise not a real receipt.'),
  confidence: z.number().describe('Confidence in this extraction, 0.0 to 1.0.'),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM = `You verify retail receipts for a cashback product. You are the only
check standing between a user and a payout of real tokenized equity, so both
false accepts and false rejects cost real money.

First decide what you are looking at (document_type): a photo or scan of a
printed paper receipt, or a digital receipt — a screenshot, email, PDF, app
screen or web order page. Then weigh the signs that apply.

For every receipt:
- Internal arithmetic, reported in totals_reconcile: line items should sum to
  the subtotal, subtotal plus tax, shipping and discounts should equal the
  total, and payment lines should match it. A total that the other printed
  amounts contradict is the classic edit — the one number that decides the
  payout was changed — so it is decisive even when everything else looks real.
- Plausibility: item names, prices, tax rate, store address and time of day
  should be consistent with the named merchant and its country.
- Placeholder data: 555 phone numbers, names like John Doe, addresses that do
  not exist, IDs made of repeated or sequential digits.
- Generation artifacts: garbled or misspelled words, letters that change shape
  mid-word, warped or wrong logos, text that does not sit on a consistent grid.
  AI image tools leave these.
- Tampering: mismatched fonts, spacing or sharpness around the total, the date
  or the order number — the fields worth altering.

Paper receipts:
- Real ones are photographed or scanned: paper texture, curl, folds, glare,
  uneven thermal ink. A perfectly clean, flat, pixel-aligned render of what
  claims to be a till receipt suggests a generated image. A flatbed scan can
  also look clean, so treat this as a signal to weigh with others, not proof.
- Thermal receipts use monospace fonts with uneven ink. Crisp proportional
  fonts or inconsistent baselines suggest editing.

Digital receipts are the easiest to fake — receipt-generator websites and AI
image tools produce a convincing online order in minutes, and fake online-
shopping receipts are the most common fraud here. Hold them to a higher bar:
- Layout, header, footer, wording and order-number format must match what this
  merchant actually issues. Amazon order numbers, for example, are three groups
  of 3, 7 and 7 digits (123-1234567-1234567; digital orders may start D01). A
  number in the wrong format for the merchant is strong evidence.
- Generator tells: watermarks, a receipt-maker's name or URL, template
  placeholder text, a generic layout no real merchant uses.
- A browser address bar, email sender or app frame around the receipt should
  belong to the merchant's real domain or app.

List every concrete sign you find in fraud_signals. Set looks_authentic false
when you see real evidence of fabrication, not merely because an image is low
quality — a blurry phone photo of a genuine receipt is still genuine. Let
confidence carry legibility problems instead.

Currency decides how much is paid out, so never infer it from the symbol alone.
"$" is used by USD, CAD, AUD, NZD, SGD, HKD, MXN, TWD and others, and "¥" by both
JPY and CNY. Decide from the store's address, country, language, phone format and
tax lines (GST, HST, PPN, VAT, IVA). Report USD only when the store is in the
United States or the receipt explicitly says USD. If "$" is the only clue and
nothing indicates the country, do not default to USD — lower confidence instead.

Set confidence to how sure you are of the extracted fields overall. If the total
is unreadable, that is low confidence, not a guess.

Report by calling record_receipt exactly once. That call is the only output read.`;

const RECORD_TOOL = {
  name: 'record_receipt',
  description: 'Record the fields read from the receipt and whether it looks genuine.',
  // The schema the SDK derives for structured outputs — already in the strict
  // subset (additionalProperties: false, every field required).
  input_schema: { ...zodOutputFormat(ExtractionSchema).schema, type: 'object' },
  strict: true,
} satisfies Anthropic.Tool;

/**
 * Today's date goes in because Claude has no clock: without it a receipt from
 * this week read as "a future date" and was judged fabricated. The date window
 * itself is enforced server-side (checkReceiptDate), not by Claude.
 */
function userPrompt(today: string): string {
  return (
    `Extract the fields from this receipt and judge whether it is genuine.\n\n` +
    `Today is ${today} (UTC). The server checks how recent the receipt is, so a date ` +
    `from the last few days is expected and is not a sign of fabrication. Judge ` +
    `authenticity from the image itself.`
  );
}

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
    message = await getClient().messages.create({
      model: RECEIPT_MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      // Adaptive is the only on-mode on current models; budget_tokens is a 400.
      thinking: { type: 'adaptive' },
      output_config: {
        // Fraud judgement benefits from some deliberation, but a user is
        // watching a spinner. Raise to 'high' if fakes start getting through.
        effort: 'medium',
      },
      tools: [RECORD_TOOL],
      // Not forced: forcing a tool alongside thinking is rejected on Bedrock,
      // one of the backends OpenRouter may route to. With a single tool and an
      // explicit instruction, "auto" calls it; if it ever doesn't, the check
      // below fails closed.
      tool_choice: { type: 'auto' },
      messages: [
        {
          role: 'user',
          // The document/image block must precede the text block.
          content: [
            sourceBlock(file, mimeType),
            { type: 'text', text: userPrompt(new Date().toISOString().slice(0, 10)) },
          ],
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
        'Receipt verification is not configured on the server (no Claude credentials).',
      );
    }
    throw new ClaudeUnavailableError('Could not reach the verification service.');
  }

  // A safety decline returns HTTP 200 — check before reading content.
  if (message.stop_reason === 'refusal') {
    throw new ClaudeUnavailableError('Claude declined to process this image.');
  }

  const call = message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === RECORD_TOOL.name,
  );
  if (!call) {
    // Truncation (max_tokens), or an answer in prose instead of the tool call.
    console.error(`[stackd-api] no ${RECORD_TOOL.name} call; stop_reason: ${message.stop_reason}`);
    throw new ClaudeUnavailableError('Claude returned no parsable result.');
  }

  const parsed = ExtractionSchema.safeParse(call.input);
  if (!parsed.success) {
    console.error(`[stackd-api] ${RECORD_TOOL.name} input failed validation:`, parsed.error.issues);
    throw new ClaudeUnavailableError('Claude returned no parsable result.');
  }

  return parsed.data;
}
