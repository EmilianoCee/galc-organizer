-- GALC Explorer group boards.
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- Security model, stated plainly: this site is static, so the only credential
-- it can hold is the public anon key. Anyone who has that key can read and
-- write these three tables. That is acceptable here because the tables hold
-- nothing sensitive -- print IDs, a first name, and a thumbs up or down -- and
-- because board IDs are random enough not to be guessed. It is NOT a model to
-- copy for anything private.

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

-- Anonymous full access, scoped to these three tables only.
do $$
declare
  t text;
begin
  foreach t in array array['boards', 'nominations', 'votes'] loop
    execute format('drop policy if exists anon_all on %I', t);
    execute format(
      'create policy anon_all on %I for all to anon using (true) with check (true)', t
    );
  end loop;
end $$;
