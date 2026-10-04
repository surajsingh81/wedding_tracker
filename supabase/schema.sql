create table if not exists public.tracker_state (
  id integer primary key check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.tracker_state enable row level security;
revoke all on public.tracker_state from anon, authenticated;
grant select on public.tracker_state to anon, authenticated;

drop policy if exists "Public can read tracker state" on public.tracker_state;
create policy "Public can read tracker state"
  on public.tracker_state for select
  to anon, authenticated
  using (true);

create or replace function public.initialize_tracker_state(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tracker_state (id, data)
  values (1, p_data)
  on conflict (id) do nothing;
  return (select data from public.tracker_state where id = 1);
end;
$$;

create or replace function public.apply_tracker_patches(p_patches jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_data jsonb;
  patch jsonb;
  patch_path text[];
begin
  if jsonb_typeof(p_patches) <> 'array' or jsonb_array_length(p_patches) > 1000 then
    raise exception 'Invalid patch list';
  end if;

  select data into current_data
  from public.tracker_state
  where id = 1
  for update;
  if current_data is null then
    raise exception 'Tracker state has not been initialized';
  end if;

  for patch in select value from jsonb_array_elements(p_patches)
  loop
    if jsonb_typeof(patch->'path') <> 'array'
       or jsonb_array_length(patch->'path') = 0
       or not (patch ? 'value') then
      raise exception 'Invalid patch';
    end if;
    select array_agg(value) into patch_path
    from jsonb_array_elements_text(patch->'path');
    current_data := jsonb_set(current_data, patch_path, patch->'value', true);
  end loop;

  update public.tracker_state
  set data = current_data, updated_at = now()
  where id = 1;
  return current_data;
end;
$$;

revoke all on function public.initialize_tracker_state(jsonb) from public, anon, authenticated;
revoke all on function public.apply_tracker_patches(jsonb) from public, anon, authenticated;
grant execute on function public.initialize_tracker_state(jsonb) to service_role;
grant execute on function public.apply_tracker_patches(jsonb) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tracker_state'
  ) then
    execute 'alter publication supabase_realtime add table public.tracker_state';
  end if;
end;
$$;
