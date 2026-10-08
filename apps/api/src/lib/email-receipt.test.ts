/**
 * Receipt email tests: real DKIM signatures, made with a throwaway key and
 * checked against a stub DNS, then forged every way the checks exist to stop.
 *
 * Run: npm test --workspace=@stackd/api
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { dkimSign, type DNSResolver } from 'mailauth';

import {
  brandForSenderDomain,
  emailIdentityKeys,
  isEmailUpload,
  verifyReceiptEmail,
  type EmailVerdict,
} from './email-receipt.js';

const SELECTOR = 's2026';
const SIGNED_AT = new Date('2026-10-07T10:15:00Z');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** DNS with one key per domain under SELECTOR, as the brand would publish it. */
function dns(domains: string[], flags = ''): DNSResolver {
  const records = new Map(
    domains.map((d) => [`${SELECTOR}._domainkey.${d}`, `v=DKIM1; k=rsa; ${flags}p=${PUBLIC_B64}`]),
  );
  return async (name) => {
    const record = records.get(name);
    if (!record) {
      const error = new Error(`no record for ${name}`) as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      throw error;
    }
    return [[record]];
  };
}

const BRAND_DNS = dns(['amazon.com', 'apple.com', 'evil.example']);

const AMAZON_BODY = [
  'Hello,',
  '',
  'Thank you for shopping with us. Your order has been placed.',
  '',
  'Order #112-1234567-1234567',
  'Placed on October 7, 2026',
  '',
  'Echo Dot (5th Gen)      $49.99',
  'Order Total:            $53.86',
  '',
].join('\r\n');

function email({
  from = 'Amazon.com <auto-confirm@amazon.com>',
  body = AMAZON_BODY,
  contentType = 'text/plain; charset=utf-8',
} = {}): string {
  return [
    `From: ${from}`,
    'To: buyer@example.com',
    'Subject: Your Amazon.com order #112-1234567-1234567',
    'Date: Wed, 07 Oct 2026 10:15:00 +0000',
    'Message-ID: <0100abc123@email.amazonses.com>',
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
    '',
    body,
  ].join('\r\n');
}

async function sign(
  raw: string,
  domain = 'amazon.com',
  extra: { maxBodyLength?: number } = {},
): Promise<string> {
  const signature = { signingDomain: domain, selector: SELECTOR, privateKey: PRIVATE_PEM, ...extra };
  const { signatures, errors } = await dkimSign(raw, {
    ...signature,
    signTime: SIGNED_AT,
    signatureData: [signature],
  });
  assert.deepEqual(errors, []);
  assert.ok(signatures, 'no signature was made');
  return signatures + raw;
}

async function verify(raw: string, resolver: DNSResolver = BRAND_DNS): Promise<EmailVerdict> {
  return verifyReceiptEmail(Buffer.from(raw), { resolver, now: SIGNED_AT });
}

function refusal(verdict: EmailVerdict): string {
  assert.equal(verdict.ok, false, 'expected a refusal');
  return verdict.ok ? '' : verdict.kind;
}

describe('test_email_receipt_genuine', () => {
  it('accepts a receipt signed by the brand it comes from', async () => {
    const verdict = await verify(await sign(email()));
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.brand.slug, 'amazon');
    assert.equal(verdict.senderDomain, 'amazon.com');
    assert.equal(verdict.signingDomain, 'amazon.com');
    assert.equal(verdict.signatureIds.length, 1);
    assert.equal(verdict.messageId, '<0100abc123@email.amazonses.com>');
    assert.equal(verdict.signedAt?.toISOString(), SIGNED_AT.toISOString());
    assert.match(verdict.text, /Order Total:\s+\$53\.86/);
  });

  it('accepts a subdomain sender signed by the parent domain', async () => {
    const raw = email({ from: 'Apple <no_reply@email.apple.com>' });
    const verdict = await verify(await sign(raw, 'apple.com'));
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.brand.slug, 'apple');
  });

  it('reads the text of an HTML-only receipt', async () => {
    const html = '<html><body><h1>Receipt</h1><table><tr><td>Total</td><td>$12.40</td></tr></table></body></html>';
    const raw = email({ body: html, contentType: 'text/html; charset=utf-8' });
    const verdict = await verify(await sign(raw));
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.match(verdict.text, /\$12\.40/);
  });
});

describe('test_email_receipt_forgeries', () => {
  it('refuses an email edited after signing', async () => {
    const signed = await sign(email());
    const edited = signed.replace('$53.86', '$953.86');
    assert.equal(refusal(await verify(edited)), 'invalid');
  });

  it("refuses the brand's From address signed by someone else's domain", async () => {
    const raw = await sign(email(), 'evil.example');
    assert.equal(refusal(await verify(raw)), 'unsigned');
  });

  it('refuses an unsigned email', async () => {
    assert.equal(refusal(await verify(email())), 'unsigned');
  });

  it('refuses a correctly signed email from a domain that is not a brand', async () => {
    const raw = await sign(email({ from: 'Shop <orders@evil.example>' }), 'evil.example');
    assert.equal(refusal(await verify(raw)), 'not_brand');
  });

  it('refuses a forwarded receipt, which comes from the user, not the brand', async () => {
    const raw = await sign(email({ from: 'Me <buyer@gmail.com>' }), 'evil.example');
    assert.equal(refusal(await verify(raw)), 'not_brand');
  });

  it('refuses lookalike domains', async () => {
    for (const from of ['x@amazon.com.evil.example', 'x@notamazon.com', 'x@amazon-com.example']) {
      assert.equal(refusal(await verify(await sign(email({ from }), 'evil.example'))), 'not_brand', from);
    }
  });

  it("refuses a brand subdomain where sellers write the message", async () => {
    const raw = await sign(email({ from: 'Seller <s@marketplace.amazon.com>' }), 'amazon.com');
    assert.equal(refusal(await verify(raw)), 'not_brand');
  });

  it('refuses a signature that leaves the end of the body open (l=)', async () => {
    const raw = email();
    const bodyLength = raw.slice(raw.indexOf('\r\n\r\n') + 4).length;
    const signed = await sign(raw, 'amazon.com', { maxBodyLength: bodyLength });
    // The signed part still verifies; the appended "receipt" is unsigned.
    const appended = `${signed}\r\nOrder Total: $999.00\r\n`;
    assert.equal(refusal(await verify(appended)), 'invalid');
  });

  it('refuses a second From header added above the signed one', async () => {
    const signed = await sign(email());
    assert.equal(refusal(await verify(`From: Evil <x@evil.example>\r\n${signed}`)), 'malformed');
  });

  it('refuses a second Content-Type header', async () => {
    const signed = await sign(email());
    const twice = `Content-Type: text/html; charset=utf-8\r\n${signed}`;
    assert.equal(refusal(await verify(twice)), 'malformed');
  });

  it('refuses a key the brand marks as testing (t=y)', async () => {
    const raw = await sign(email());
    assert.equal(refusal(await verify(raw, dns(['amazon.com'], 't=y; '))), 'invalid');
  });

  it('refuses a file that is not an email at all', async () => {
    assert.equal(refusal(await verify('\x89PNG\r\n\x1a\nnot an email')), 'malformed');
  });
});

describe('test_email_receipt_dns', () => {
  it('reports an unreachable key as our failure, not the email', async () => {
    const down: DNSResolver = async () => {
      const error = new Error('timed out') as NodeJS.ErrnoException;
      error.code = 'ETIMEOUT';
      throw error;
    };
    assert.equal(refusal(await verify(await sign(email()), down)), 'dns');
  });
});

describe('test_email_identity', () => {
  it('gives the same file the same keys, whatever its unsigned headers say', async () => {
    const signed = await sign(email());
    const a = await verify(signed);
    const b = await verify(`X-Forwarded-For: someone\r\n${signed}`);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    const keys = (v: typeof a) =>
      emailIdentityKeys({ brandSlug: v.brand.slug, signatureIds: v.signatureIds, messageId: v.messageId });
    assert.deepEqual(keys(a), keys(b));
    assert.equal(keys(a).length, 2); // signature + Message-ID
  });
});

describe('test_brand_for_sender_domain', () => {
  it('matches a brand domain and its subdomains, case-insensitively', () => {
    assert.equal(brandForSenderDomain('amazon.com')?.slug, 'amazon');
    assert.equal(brandForSenderDomain('Shipment-Tracking.AMAZON.com')?.slug, 'amazon');
    assert.equal(brandForSenderDomain('amazon.co.uk')?.slug, 'amazon');
    assert.equal(brandForSenderDomain('email.apple.com')?.slug, 'apple');
    assert.equal(brandForSenderDomain('mcdonalds.co.id')?.slug, 'mcdonalds');
  });

  it('matches nothing else', () => {
    assert.equal(brandForSenderDomain('amazon.com.evil.example'), null);
    assert.equal(brandForSenderDomain('fakeamazon.com'), null);
    assert.equal(brandForSenderDomain('com'), null);
    assert.equal(brandForSenderDomain('marketplace.amazon.com'), null);
    assert.equal(brandForSenderDomain('x.marketplace.amazon.com'), null);
  });
});

describe('test_is_email_upload', () => {
  it('recognises .eml files however the browser labels them', () => {
    assert.equal(isEmailUpload({ mimetype: 'message/rfc822', originalname: 'r.eml' }), true);
    assert.equal(isEmailUpload({ mimetype: 'application/octet-stream', originalname: 'R.EML' }), true);
    assert.equal(isEmailUpload({ mimetype: '', originalname: 'receipt.eml' }), true);
  });

  it('leaves images, PDFs and mislabelled files alone', () => {
    assert.equal(isEmailUpload({ mimetype: 'image/png', originalname: 'r.eml' }), false);
    assert.equal(isEmailUpload({ mimetype: 'application/pdf', originalname: 'r.pdf' }), false);
    assert.equal(isEmailUpload({ mimetype: 'application/octet-stream', originalname: 'r.bin' }), false);
  });
});
