-- Receipts that verified while their brand's payouts were paused for
-- restocking. Not a claim: nothing is owed, and the receipt can be sent again
-- once the brand is restocked. It is the demand a sponsor asks about: how many
-- receipts, at which brand, would have paid how much.
--
-- Totals only: no wallet address, IP, image or receipt detail. Each row is a
-- one-way hash of one of a receipt's duplicate keys, so the same receipt sent
-- twice, or photographed twice, is counted once. demand_id groups one
-- receipt's keys.
create table stackd.paused_demand (
  cluster      text not null check (cluster in ('devnet', 'mainnet')),
  key_hash     text not null,
  demand_id    uuid not null,
  ticker       text not null,
  cashback_usd numeric(12, 6) not null check (cashback_usd >= 0),
  seen_at      timestamptz not null default now(),
  primary key (cluster, key_hash)
);
create index paused_demand_demand_id_idx on stackd.paused_demand (demand_id);

-- Defence in depth, as for the other tables: RLS on, no policies.
alter table stackd.paused_demand enable row level security;
