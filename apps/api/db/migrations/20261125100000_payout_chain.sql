-- Payouts on Base as well as Solana. A receipt is paid on one chain, and only
-- once across both: the duplicate scope stays `cluster` ('mainnet' for real
-- money on either chain, 'devnet' for any test network, Base Sepolia
-- included), and `chain` records which chain pays.
--
-- Safe to apply while the previous API version is still serving: every new
-- column has a default, and payout_budget keeps its old primary key until
-- 20261125100100 replaces it.

alter table stackd.receipts
  add column chain text not null default 'solana' check (chain in ('solana', 'base'));

-- The hash of a signed Base transfer, stored before it is broadcast. Non-null
-- with a null tx_signature means the outcome is unknown: reconcile on chain.
alter table stackd.receipts add column pending_tx_hash text;

-- Each chain pays from its own treasury, so each has its own daily cap.
alter table stackd.payout_budget
  add column chain text not null default 'solana' check (chain in ('solana', 'base'));
create unique index payout_budget_chain_cluster_day_key
  on stackd.payout_budget (chain, cluster, day);
