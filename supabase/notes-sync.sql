-- Deskmates notes sync, for the Supabase project used as the phone relay.
-- Applied as the migration "deskmates_notes_sync". Records arrive already encrypted on the device;
-- the server only stores them. Tables are closed to direct access (RLS on, no policies); devices go
-- through the functions below, which check the library's secret token (sent by the PC in pairing).

create table if not exists public.notes_libraries (
  library text primary key check (length(library) between 16 and 64),
  token_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.notes_records (
  library text not null references public.notes_libraries(library) on delete cascade,
  store text not null check (length(store) <= 32),
  id text not null check (length(id) <= 80),
  updated bigint not null,
  body text not null,
  seq bigint not null,
  primary key (library, store, id)
);
create index if not exists notes_records_seq on public.notes_records (library, seq);

create table if not exists public.notes_asset_parts (
  library text not null references public.notes_libraries(library) on delete cascade,
  id text not null check (length(id) <= 80),
  part int not null check (part >= 0 and part < 4096),
  data text not null,
  primary key (library, id, part)
);

create sequence if not exists public.notes_seq;

alter table public.notes_libraries enable row level security;
alter table public.notes_records enable row level security;
alter table public.notes_asset_parts enable row level security;
revoke all on public.notes_libraries, public.notes_records, public.notes_asset_parts from anon, authenticated;

-- The library exists and the token is its own; the first device to use a library claims it.
create or replace function public.notes_check(p_library text, p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  wanted text := encode(extensions.digest(p_token, 'sha256'), 'hex');
  stored text;
begin
  if p_library is null or p_token is null or length(p_token) < 32 then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select token_hash into stored from notes_libraries where library = p_library;
  if stored is null then
    insert into notes_libraries (library, token_hash) values (p_library, wanted)
    on conflict (library) do nothing;
    select token_hash into stored from notes_libraries where library = p_library;
  end if;
  if stored <> wanted then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end $$;

-- Saves records; an older copy never replaces a newer one. Returns how many were written.
create or replace function public.notes_push(p_library text, p_token text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  written int;
begin
  perform notes_check(p_library, p_token);
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'too many rows' using errcode = '54000';
  end if;
  with incoming as (
    select r->>'store' as store, r->>'id' as id, (r->>'updated')::bigint as updated, r->>'body' as body
    from jsonb_array_elements(p_rows) r
  ), saved as (
    insert into notes_records (library, store, id, updated, body, seq)
    select p_library, store, id, updated, body, nextval('notes_seq') from incoming
    on conflict (library, store, id) do update
      set updated = excluded.updated, body = excluded.body, seq = excluded.seq
      where notes_records.updated <= excluded.updated
    returning 1
  )
  select count(*) into written from saved;
  return written;
end $$;

-- Records changed after `p_since`, oldest first.
create or replace function public.notes_pull(p_library text, p_token text, p_since bigint, p_limit int default 300)
returns table (store text, id text, updated bigint, body text, seq bigint)
language plpgsql security definer set search_path = public as $$
begin
  perform notes_check(p_library, p_token);
  return query
    select r.store, r.id, r.updated, r.body, r.seq from notes_records r
    where r.library = p_library and r.seq > p_since
    order by r.seq
    limit least(greatest(p_limit, 1), 1000);
end $$;

create or replace function public.notes_put_part(p_library text, p_token text, p_id text, p_part int, p_data text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform notes_check(p_library, p_token);
  if length(p_data) > 1100000 then
    raise exception 'part too large' using errcode = '54000';
  end if;
  insert into notes_asset_parts (library, id, part, data) values (p_library, p_id, p_part, p_data)
  on conflict (library, id, part) do update set data = excluded.data;
end $$;

create or replace function public.notes_get_part(p_library text, p_token text, p_id text, p_part int) returns text
language plpgsql security definer set search_path = public as $$
declare
  found text;
begin
  perform notes_check(p_library, p_token);
  select data into found from notes_asset_parts where library = p_library and id = p_id and part = p_part;
  return found;
end $$;

revoke all on function public.notes_check(text, text) from public, anon, authenticated;
revoke all on function public.notes_push(text, text, jsonb) from public;
revoke all on function public.notes_pull(text, text, bigint, int) from public;
revoke all on function public.notes_put_part(text, text, text, int, text) from public;
revoke all on function public.notes_get_part(text, text, text, int) from public;
grant execute on function public.notes_push(text, text, jsonb) to anon, authenticated;
grant execute on function public.notes_pull(text, text, bigint, int) to anon, authenticated;
grant execute on function public.notes_put_part(text, text, text, int, text) to anon, authenticated;
grant execute on function public.notes_get_part(text, text, text, int) to anon, authenticated;
