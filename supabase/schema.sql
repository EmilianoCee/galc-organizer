-- GALC Explorer group boards.
-- Paste this whole file into the Supabase SQL editor and run it. It is safe to
-- re-run: tables are created only if missing, and policies are replaced.
--
-- A static site has no server to keep a secret in, so the page carries the
-- public anon key and these policies are what actually bound what it can do.
-- They are scoped to exactly the operations the app performs, and nothing here
-- exposes anything beyond print IDs, chosen display names, and up/down votes.

create table if not exists boards (
  id          text primary key,
  name        text        not null,
  created_at  timestamptz not null default now()
);

create table if not exists nominations (
  board_id    text        not null references boards (id) on delete cascade,
  item_id     text        not null,
  added_by    text        not null default 'someone',
  created_at  timestamptz not null default now(),
  primary key (board_id, item_id)
);

create table if not exists votes (
  board_id    text        not null references boards (id) on delete cascade,
  item_id     text        not null,
  voter_id    text        not null,
  voter_name  text        not null default 'someone',
  value       smallint    not null check (value in (-1, 1)),
  created_at  timestamptz not null default now(),
  -- One vote per person per print; re-voting upserts onto this key.
  primary key (board_id, item_id, voter_id)
);

create index if not exists nominations_board_idx on nominations (board_id);
create index if not exists votes_board_idx       on votes (board_id);

alter table boards      enable row level security;
alter table nominations enable row level security;
alter table votes       enable row level security;

-- Clear anything from an earlier run of this file.
drop policy if exists anon_all     on boards;
drop policy if exists anon_all     on nominations;
drop policy if exists anon_all     on votes;
drop policy if exists anon_read    on boards;
drop policy if exists anon_create  on boards;
drop policy if exists anon_read    on nominations;
drop policy if exists anon_create  on nominations;
drop policy if exists anon_update  on nominations;
drop policy if exists anon_remove  on nominations;
drop policy if exists anon_read    on votes;
drop policy if exists anon_create  on votes;
drop policy if exists anon_update  on votes;
drop policy if exists anon_remove  on votes;

-- Boards: anyone with the link can read one and anyone can start one, but the
-- app never renames or deletes a board, so those rights are simply not granted.
-- That keeps an existing board from being wiped or retitled by a passer-by.
create policy anon_read   on boards for select to anon using (true);
create policy anon_create on boards for insert to anon with check (true);

-- Nominations: added, listed, and withdrawn from the board view. Update is
-- needed because adding a print is an upsert on (board_id, item_id).
create policy anon_read   on nominations for select to anon using (true);
create policy anon_create on nominations for insert to anon with check (true);
create policy anon_update on nominations for update to anon using (true) with check (true);
create policy anon_remove on nominations for delete to anon using (true);

-- Votes: same shape. Re-voting upserts on (board_id, item_id, voter_id), and
-- clearing your vote deletes that row.
create policy anon_read   on votes for select to anon using (true);
create policy anon_create on votes for insert to anon with check (true);
create policy anon_update on votes for update to anon using (true) with check (true);
create policy anon_remove on votes for delete to anon using (true);
