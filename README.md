# Stackd

Upload a retail receipt, get real tokenized equity back.

Claude Vision verifies the receipt. xStock tokens — actual tokenized shares issued by
Backed Finance — transfer from a treasury wallet to the user's Solana address. No manual
review, no custom token, no Anchor program.

| Brand     | xStock  | Back |
| --------- | ------- | ---- |
| Starbucks | `SBUXx` | 4%   |
| Nike      | `NKEx`  | 3%   |
| Netflix   | `NFLXx` | 3%   |
| Walmart   | `WMTx`  | 2%   |

---

## Repo layout

```
apps/web          Next.js 14 frontend  (App Router)
apps/api          Express backend — POST /verify-receipt
packages/solana   Shared: brand config, Token-2022 balance reads, price lookups
```

npm workspaces. `packages/solana` ships raw TypeScript and is compiled by Next via
`transpilePackages`.

## Running it

```bash
npm install
cp .env.example apps/web/.env.local   # HELIUS_RPC_URL
cp .env.example apps/api/.env         # ANTHROPIC_API_KEY
npm run dev                           # web on :3000
npm run dev --workspace=@stackd/api   # api on :4000
```

Other scripts: `npm run build`, `npm run lint`, `npm run typecheck`.

---

## POST /verify-receipt

Multipart: `receipt` (JPG/PNG/PDF, ≤10 MB) and `walletAddress`. Verifies only —
it never moves tokens. The frontend shows the estimate, the user confirms, and
the transfer is a separate endpoint (Day 3).

Claude reads the image via **structured outputs** (`output_config.format` +
`messages.parse`) rather than being asked for "JSON only" in the prompt. The
schema is enforced server-side, so there is no markdown fence to strip — which
matters because assistant prefill, the old way to force a leading `{`, returns a
400 on current models.

Model: **`claude-sonnet-5`**. The original spec named `claude-sonnet-4-20250514`,
a retired id; this generation carries no date suffix.

Every outcome returns the same JSON shape, on 2xx and 4xx alike, so the client
has one parsing path:

```jsonc
{ "flagged": false, "brand": "Starbucks", "ticker": "SBUXx",
  "amountUsd": 12.40, "confidence": 0.94,
  "pctBack": 4, "cashbackUsd": 0.496,           // extras
  "merchantName": "STARBUCKS #04821", "date": "2026-09-16",
  "currency": "USD", "submissionsRemaining": 2 }
```

| Status | Meaning |
| ------ | ------------------------------------------------------- |
| 200    | Verified. `flagged` says whether it's eligible           |
| 400    | Missing/invalid wallet, or no file                       |
| 409    | Duplicate — same wallet + brand + amount within 24h      |
| 413    | Over 10 MB                                               |
| 415    | Not a JPG, PNG or PDF                                    |
| 429    | Over 3 submissions for this wallet in 24h                |
| 502    | Claude unreachable — quota slot is refunded              |

Rejection reasons a 200 can carry: not authentic, confidence below 0.7,
non-USD currency, unreadable total, over `MAX_RECEIPT_USD`, or no brand match.

### Three things worth knowing

**Non-USD receipts are refused, not converted.** `total_amount` is in whatever
currency the receipt used and there is no FX source wired up. Treating a
50,000 IDR receipt as $50,000 would pay out ~$2,000 of stock for a coffee.
ROADMAP: add an FX lookup and convert.

**Quota is spent on attempts, not successes.** The slot is taken before the
Claude call so concurrent uploads can't all bill the API, and refunded only when
*we* fail (unreachable, rate limited, bad credentials). A receipt that was
checked and found fake keeps its slot — otherwise fakes could be brute-forced
for free.

**Brand matching is on whole tokens, not substrings.** `"Nikon Camera Store"`
must not match Nike and pay out shares for a camera shop. Covered by the cases
in `matchBrand`.

### ROADMAP: rate limiting is in-memory

`apps/api/src/lib/submissions.ts` holds limits and duplicate history in a
process-local `Map`. Limits reset on deploy and are not shared across
instances — three replicas means an effective 3n per wallet. Fine for a single
demo process; move to Redis before the treasury holds anything worth stealing.
The function signatures are shaped so that's a body change, not an interface
change.

---

## Two things about xStocks that shape the whole codebase

### 1. They are Token-2022, not legacy SPL Token

All four mints run on `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. Every ATA derivation
and every transfer instruction must pass `TOKEN_2022_PROGRAM_ID`. Using the legacy program
id derives a different — and wrong — associated token account.

### 2. They use the Scaled UI Amount extension

Backed Finance applies corporate actions (splits, dividend reinvestment) by moving a
multiplier on the mint rather than minting or burning. So:

```
displayed balance = rawAmount / 10^decimals * effectiveMultiplier
```

This is not cosmetic. As of 2026-09-15 every brand in the MVP set has a multiplier ≠ 1:

| xStock  | Effective multiplier |
| ------- | -------------------- |
| `SBUXx` | 1.003998157531       |
| `NKEx`  | 1.007347670251       |
| `NFLXx` | **10**               |
| `WMTx`  | 1.0071845610241497   |

A naive `raw / 10^8` reports a **tenth** of a holder's real NFLXx position.

The extension stores a current multiplier plus a queued one and the timestamp it activates
at. Once that timestamp passes the queued value is authoritative and the old field is
stale — the account is never rewritten. `resolveMultiplier()` in
[`packages/solana/src/scaled-amount.ts`](packages/solana/src/scaled-amount.ts) handles
this; everything else goes through `toUiAmount()`.

**For the Day 2 transfer path:** the treasury must send `uiAmount / multiplier * 10^decimals`
base units, not `uiAmount * 10^decimals`. `toRawAmount()` is the helper. Getting this
backwards overpays NFLXx by 10×.

---

## RPC

`HELIUS_RPC_URL` is server-side only and never reaches the browser. The client posts to
`/api/rpc`, a proxy that forwards to Helius with a **read-method allowlist** — an
unrestricted public proxy would let anyone relay transactions on the project's paid plan.

Setting `NEXT_PUBLIC_RPC_URL` bypasses the proxy and talks to Helius directly. It works,
but the key then ships in the client bundle where anyone can read it. Leave it blank.

No public endpoints are used anywhere.

## Pricing

Jupiter Price API v3. It only returns `usdPrice` for mints with routable DEX liquidity;
SBUXx and NKEx are too new to have depth, so those fall back to `stockData.price` — the
underlying listed share price — and the UI marks them with a `†` rather than passing a
different kind of number off as the same thing.

---

## Design system

Reference: `crumbs-dapp.jsx`. **That file was not in the repo when this was built**, so the
tokens below came from the written spec. Worth a diff against the original.

| Token          | Value     | Use                                          |
| -------------- | --------- | -------------------------------------------- |
| canvas         | `#F7F5F0` | page background                              |
| sidebar        | `#1A1A2E` | left nav                                     |
| primary        | `#4F46E5` | actions, rates, any non-gain accent          |
| gain           | `#16A34A` | **gains only** — never success, never status |
| loss           | `#DC2626` | negative change                              |

Fraunces 300 italic appears in the logo and the landing hero and nowhere else. Everything
else is Inter 300–600. Numbers use tabular figures via `.num`.

## Wallets

Phantom and Solflare are registered explicitly, which also gives them an install row when
absent. Backpack is picked up automatically through Wallet Standard, so it needs no adapter
entry. The default wallet-adapter modal is restyled to the brokerage palette in
`globals.css` rather than shipping the stock purple sheet.

## Reward engine

`packages/solana/src/rewards.ts`. Two legs, deliberately separate code paths:

| Leg | Token program | Multiplier | Failure mode |
| --- | --- | --- | --- |
| xStock | **Token-2022** | scaled-UI, must be inverted | hard error |
| STACKD bonus | **legacy SPL** | none | returns `null`, not an error |

They are not merged behind a generic helper on purpose. The moment one function
serves both, someone passes `TOKEN_PROGRAM_ID` to an xStock ATA derivation and
the payout lands at an address the user's wallet never reads.

All Token-2022 amount maths routes through `resolveMultiplier` / `toRawAmount`
in `scaled-amount.ts`. `computeRewardAmount()` is pure and directly tested.

**Idempotency** is keyed on `receiptId`. `/verify-receipt` creates the record
and returns the id; `/confirm-receipt` pays against it. A receipt that already
carries a signature returns that signature without sending. Legs are also
*claimed* before sending, so a double-click cannot produce two transfers.

```bash
npm test --workspace=@stackd/solana
```

Covers `test_idempotent_replay`, `test_price_resolution_fallback`,
`test_vault_pause`, `test_multiplier_correctness` — the last is the regression
test for the 10× NFLXx overpay this README warns about.

### ⚠️ STACKD contradicts a project rule

The brief says **"No custom token. Only xStocks from Backed Finance"**, and the
live landing page tells users *"Not points. Not a token we invented"* and
*"Stackd does not mint anything."* The STACKD bonus leg contradicts all three.

The code ships disabled: leave `STACKD_MINT` blank and only the xStock leg runs,
which the UI already handles as a normal outcome. Reconcile the rule and the
copy before enabling it.

### ⚠️ Persistence is in-memory

`receipt-store.ts` ships `InMemoryReceiptStore` because the project still has no
`DATABASE_URL`. For a payout system that is genuinely unsafe: process memory
dies on deploy, so a paid receipt looks unpaid afterwards **and can be paid
twice**. Swap in a Prisma implementation of `ReceiptStore` before real money
moves, and implement `claimLeg` as a conditional `UPDATE ... WHERE txSignature
IS NULL` rather than read-then-write.

## Status

Frontend and receipt verification are live. `/app/submit` uploads to the real endpoint and
shows what Claude read.

Still to build: the treasury transfer that actually pays a verified receipt out. The Claim
button is present and disabled until that lands — see the Token-2022 and scaled-multiplier
notes above before writing it.

## Dependency note

React is pinned to 18.3.1 in the root `package.json`. `@solana/wallet-adapter-react` pulls
in `@solana-mobile/wallet-adapter-mobile` → `react-native`, whose strict `react@19` peer
npm honours over `overrides`. It hoists React 19 to the root while `react-dom` stays at 18,
and the build dies on `ReactCurrentDispatcher`. Declaring react/react-dom at the root forces
18 into the hoisted position. `next` is declared at the root for a related reason — see the
comments in `package.json`.

---

xStocks are issued by Backed Finance. Stackd is not a broker-dealer and does not provide
investment advice.
