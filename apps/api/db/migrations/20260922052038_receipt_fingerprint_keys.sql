-- A receipt is identified by more than one printed detail: its transaction
-- number AND its time of purchase. Claude can read a different "number" from
-- two photos of one receipt ("ORD #34 -CSO #30" vs "34"), so a single key let a
-- re-photographed copy through. Every key goes here, and a new receipt that
-- matches ANY existing key is a duplicate. The primary key is the race-safe
-- arbiter, as the unique indexes on stackd.receipts are.
create table stackd.receipt_fingerprints (
  cluster     text not null,
  fingerprint text not null,
  receipt_id  uuid not null references stackd.receipts (id) on delete cascade,
  primary key (cluster, fingerprint)
);
create index receipt_fingerprints_receipt_id_idx on stackd.receipt_fingerprints (receipt_id);

-- Defence in depth, as for the other tables: RLS on, no policies.
alter table stackd.receipt_fingerprints enable row level security;

-- Normalised HH:MM as printed, so the time key can be re-derived later.
alter table stackd.receipts add column receipt_time text;

-- Existing receipts keep their one key.
insert into stackd.receipt_fingerprints (cluster, fingerprint, receipt_id)
select cluster, fingerprint, id from stackd.receipts where fingerprint is not null
on conflict do nothing;
