-- Apply once the API that writes payout_budget.chain is live. Until then the
-- old (cluster, day) key stays, because the previous version upserts on it.
-- After this, Solana and Base each hold their own row for a day.

alter table stackd.payout_budget drop constraint payout_budget_pkey;
alter table stackd.payout_budget
  add constraint payout_budget_pkey primary key using index payout_budget_chain_cluster_day_key;
