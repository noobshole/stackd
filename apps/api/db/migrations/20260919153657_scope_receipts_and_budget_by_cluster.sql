-- One database serves devnet and mainnet. Without a cluster column, the
-- receipt used in a devnet test run would be refused as a duplicate on the
-- mainnet demo, and devnet payouts would eat mainnet's daily cap.

alter table stackd.receipts
  add column cluster text not null default 'devnet' check (cluster in ('devnet', 'mainnet'));
alter table stackd.receipts alter column cluster drop default;

drop index stackd.receipts_image_sha256_key;
drop index stackd.receipts_fingerprint_key;
-- Index names keep 'image' / 'fingerprint': the API maps violations by name.
create unique index receipts_image_sha256_key on stackd.receipts (cluster, image_sha256);
create unique index receipts_fingerprint_key  on stackd.receipts (cluster, fingerprint);

alter table stackd.payout_budget
  add column cluster text not null default 'devnet' check (cluster in ('devnet', 'mainnet'));
alter table stackd.payout_budget drop constraint payout_budget_pkey;
alter table stackd.payout_budget add primary key (cluster, day);
alter table stackd.payout_budget alter column cluster drop default;
