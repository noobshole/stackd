-- Private schema: not in PostgREST's exposed schemas, so the public anon key
-- cannot reach these tables. Only the API server (DATABASE_URL) can.
create schema if not exists stackd;
revoke all on schema stackd from public, anon, authenticated;

create table stackd.receipts (
  id                 uuid primary key,
  wallet_address     text not null,
  brand_name         text not null,
  brand_ticker       text not null,
  amount_usd         numeric(12,2) not null check (amount_usd > 0),
  -- audit trail for amount_usd
  original_amount    numeric(20,4),
  original_currency  text,
  fx_rate            numeric(30,12),
  fx_rate_date       date,
  xstock_amount      double precision,
  image_url          text,
  claude_confidence  real,
  status             text not null default 'pending'
                     check (status in ('pending', 'confirmed', 'failed')),
  -- payout legs: a non-null signature means paid; in_flight is the exclusive claim
  tx_signature       text,
  bonus_tx_signature text,
  xstock_in_flight   boolean not null default false,
  bonus_in_flight    boolean not null default false,
  created_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  -- fraud controls: the unique indexes are the final arbiter, race-safe
  image_sha256       text,
  fingerprint        text,
  receipt_date       date,
  receipt_number     text
);

create unique index receipts_image_sha256_key on stackd.receipts (image_sha256);
create unique index receipts_fingerprint_key  on stackd.receipts (fingerprint);
create index receipts_wallet_created_idx       on stackd.receipts (wallet_address, created_at desc);

-- Every attempt that reaches Claude, for wallet / IP / global limits.
create table stackd.submission_attempts (
  token          uuid primary key,
  wallet_address text not null,
  ip             text not null,
  at             timestamptz not null default now()
);
create index submission_attempts_wallet_idx on stackd.submission_attempts (wallet_address, at);
create index submission_attempts_ip_idx     on stackd.submission_attempts (ip, at);
create index submission_attempts_at_idx     on stackd.submission_attempts (at);

-- Daily payout circuit breaker. One row per UTC day; reservations are a
-- conditional UPDATE on that row, so concurrent payouts cannot overshoot.
create table stackd.payout_budget (
  day          date primary key,
  reserved_usd numeric(12,2) not null default 0 check (reserved_usd >= 0)
);

-- Defence in depth: RLS on, no policies. The table owner (the API's postgres
-- role) bypasses RLS; nothing else gets rows even if the schema were exposed.
alter table stackd.receipts            enable row level security;
alter table stackd.submission_attempts enable row level security;
alter table stackd.payout_budget       enable row level security;
