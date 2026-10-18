-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- Result: the public (anon) key can ONLY insert a consented screening row. Reading, editing and deleting
-- patient records is possible only for signed-in users listed in public.owners.

create extension if not exists pgcrypto;

create table if not exists public.patients_screening (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  patient_name text, age int, acoustic_score int, clinical_score int,
  triage_result text, screener_notes text default ''
);
-- (If your table already exists, the statements below just add what is missing.)
alter table public.patients_screening add column if not exists consent_given boolean not null default false;

-- Input validation enforced by the database itself (NOT VALID = applies to new rows, won't fail on old test rows)
alter table public.patients_screening drop constraint if exists ps_valid;
alter table public.patients_screening add constraint ps_valid check (
  char_length(patient_name) between 1 and 80 and age between 1 and 120
  and (acoustic_score is null or acoustic_score between 0 and 100)
  and clinical_score between 0 and 10 and triage_result in ('low','med','high')
  and char_length(coalesce(screener_notes,'')) <= 2000
) not valid;

create table if not exists public.owners (user_id uuid primary key references auth.users(id) on delete cascade);

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.owners where user_id = auth.uid()) $$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

alter table public.patients_screening enable row level security;
alter table public.owners enable row level security;       -- no policies => nobody can read it through the API

-- Table privileges: start from nothing, grant the minimum
revoke all on public.patients_screening from anon, authenticated;
revoke all on public.owners from anon, authenticated;
grant insert on public.patients_screening to anon, authenticated;
grant select, delete on public.patients_screening to authenticated;
grant update (screener_notes) on public.patients_screening to authenticated;   -- owners can only change notes

drop policy if exists ps_insert on public.patients_screening;
drop policy if exists ps_select on public.patients_screening;
drop policy if exists ps_update on public.patients_screening;
drop policy if exists ps_delete on public.patients_screening;
create policy ps_insert on public.patients_screening for insert to anon, authenticated with check (consent_given = true);
create policy ps_select on public.patients_screening for select to authenticated using (public.is_owner());
create policy ps_update on public.patients_screening for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy ps_delete on public.patients_screening for delete to authenticated using (public.is_owner());

-- AFTER creating your owner login (Authentication -> Users -> Add user), register it:
--   insert into public.owners (user_id) select id from auth.users where email = 'YOUR-OWNER-EMAIL';
