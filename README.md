# Stackd

Upload a retail receipt, get real tokenized equity back.

Claude Vision verifies the receipt. Tokenized shares — issued by Backed Finance and
Backpack Securities, collateralised 1:1 by the underlying stock — transfer from a treasury
wallet to the user's Solana address. No manual review, no Anchor program, and no invented
token in the core reward.

| Brand      | Token   | Issuer              | Back |
| ---------- | ------- | ------------------- | ---- |
| McDonald's | `MCDx`  | Backed Finance      | 4%   |
| Nike       | `NKE`   | Backpack Securities | 3%   |
| Netflix    | `NFLXx` | Backed Finance      | 3%   |
| lululemon  | `LULU`  | Backpack Securities | 3%   |
| Amazon     | `AMZNx` | Backed Finance      | 2%   |
| Costco     | `COST`  | Backpack Securities | 2%   |
| Walmart    | `WMTx`  | Backed Finance      | 2%   |
| Apple      | `AAPLx` | Backed Finance      | 1%   |

A brand earns a slot only if people hold receipts from it **and** its token has
real DEX liquidity, so the treasury can actually be stocked with it. Starbucks
is absent for the second reason: SBUXx exists but has no routable market.

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
{ "flagged": false, "brand": "McDonald's", "ticker": "MCDx",
  "amountUsd": 12.40, "confidence": 0.94,
  "pctBack": 4, "cashbackUsd": 0.496,           // extras
  "merchantName": "MCDONALDS #04821", "date": "2026-09-17",
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
currency the receipt used and there is no FX source wired up. The
`MAX_RECEIPT_USD` cap doesn't cover this: a 50,000 IDR receipt misread as
$50,000 would be refused by the cap anyway, but ¥900 of coffee (roughly $6) read
as $900 slips under it and pays $36 of stock instead of about $0.24. The guard
trusts Claude's `currency` field, and `$` alone is also CAD, AUD, SGD, HKD, MXN
and TWD, so the prompt makes Claude decide from the store's country, not the
symbol. ROADMAP: add an FX lookup and convert, before the cap is applied.

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

## Two things about these tokens that shape the whole codebase

### 1. They are Token-2022, not legacy SPL Token

Every mint — both issuers — runs on `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. Every
ATA derivation and every transfer instruction must pass `TOKEN_2022_PROGRAM_ID`. Using the
legacy program id derives a different — and wrong — associated token account.

Verified on-chain 2026-09-17: no mint is frozen-by-default and none carries a transfer
hook, so all eight airdrop cleanly to a fresh wallet. All do retain a permanent delegate —
standard for regulated RWAs, and worth stating plainly when describing custody.

### 2. They use the Scaled UI Amount extension

Backed Finance applies corporate actions (splits, dividend reinvestment) by moving a
multiplier on the mint rather than minting or burning. So:

```
displayed balance = rawAmount / 10^decimals * effectiveMultiplier
```

This is not cosmetic. As of 2026-09-15 every brand in the MVP set has a multiplier ≠ 1:

| Token   | Issuer   | Decimals | Effective multiplier |
| ------- | -------- | -------- | -------------------- |
| `NFLXx` | Backed   | 8        | **10**               |
| `MCDx`  | Backed   | 8        | 1.021181             |
| `WMTx`  | Backed   | 8        | 1.007185             |
| `AAPLx` | Backed   | 8        | 1.003269             |
| `AMZNx` | Backed   | 8        | 1.000000             |
| `NKE`   | Backpack | 6        | 1.000000             |
| `COST`  | Backpack | 6        | 1.000000             |
| `LULU`  | Backpack | 6        | 1.000000             |

Backed mints are 8 decimals with live multipliers; Backpack mints are 6 decimals
at 1.0. **Never assume either per issuer** — read them per mint.

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
Thinly-traded listings can lack a routed price, so those fall back to `stockData.price` — the
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

## Meteora DBC / $STACKD

SDK signatures were read from the Meteora docs MCP and verified against the
installed `@meteora-ag/dynamic-bonding-curve-sdk@1.5.12` — not recalled.

```bash
npm run dbc:launch        # config + pool (dry run; add -- --execute)
npm run dbc:claim-fees    # creator fees -> Rewards Vault
npm run dbc:simulate      # devnet: buy to the threshold, migrate, verify
npm run dbc:withdraw-leftover  # after migration: 15% leftover -> team wallet
```

Config per Part 2.3: USDC quote, single-segment curve via `buildCurve`, 750 USDC
`migrationQuoteThreshold`, `MigrationOption.MET_DAMM_V2`,
`MigrationFeeOption.FixedBps100`, and a linear fee scheduler with identical
start/end bps — which is how the SDK expresses "fixed fee, no decay".

### ⚠️ The Part 2.2 supply split is not expressible as written

**This is permanent once run on mainnet, so read it before `dbc:launch`.**

The plan describes minting $STACKD ourselves and transferring 60% / 25% / 15%
into the curve, a Rewards Vault, and a team wallet. DBC does not work that way:

- `creator.createPool` takes a **brand new** base-mint keypair. The program
  initialises the mint and mints the whole supply into a program-owned vault.
  You cannot hand it a mint you already created and pre-split.
- `leftover_receiver` is documented as the receiver for leftover base tokens
  **after migration**. Nothing is claimable at genesis.

What ships instead:

| Part 2.2 bucket | How it is actually expressed |
| --------------- | ---------------------------- |
| 60% public curve | ~65% sells on the curve |
| 15% team | `leftover: 15%` → `leftoverReceiver` (team), after migration |
| — | `percentageSupplyOnMigration: 20%` seeds the DAMM v2 pool |
| **25% Rewards Vault** | **No genesis allocation exists.** Funded by claiming creator trading fees. |

**Consequence for Leg 2:** the vault starts empty, so `sendStackdBonus()`
returns null and the bonus pauses until fees have been claimed *and* converted
to $STACKD. Leg 1 is completely unaffected — which is the safety property
Part 2.4 was designed around, now load-bearing rather than theoretical.

No mint authority survives genesis: `tokenAuthorityOption` is
`TokenAuthorityOption.Immutable`, so Part 2.2's "no future minting, ever" is a
config property rather than a burn step someone could forget.

### Safety guards

Genesis is irreversible, so the scripts refuse to make it easy:

- Mainnet requires `DBC_ALLOW_MAINNET=I_UNDERSTAND_THIS_IS_PERMANENT`
- `dbc:simulate` refuses mainnet outright — proving graduation shouldn't cost 750 real USDC
- Every script is a dry run until `-- --execute`
- No public RPC fallback; a missing Helius URL is a hard failure

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
