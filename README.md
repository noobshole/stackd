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
packages/solana   Shared: brand config, Token-2022 balance reads, price lookups
apps/api          Express backend — Day 2
```

npm workspaces. `packages/solana` ships raw TypeScript and is compiled by Next via
`transpilePackages`.

## Running it

```bash
npm install
cp .env.example apps/web/.env.local   # fill in HELIUS_RPC_URL
npm run dev
```

Other scripts: `npm run build`, `npm run lint`, `npm run typecheck`.

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

## Status

Day 1 is the frontend. `/app/submit` is a **mock** — nothing uploads, nothing transfers,
and the UI says so on screen. Day 2 is `POST /verify-receipt`, the Claude Vision call, and
the SPL transfer.

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
