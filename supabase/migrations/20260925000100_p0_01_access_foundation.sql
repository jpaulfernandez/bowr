-- P0.01-T2: identity is not membership.
-- Profiles hold editable settings; private.memberships holds admission and role.
-- Grants are explicit: Supabase's default "grant everything to anon/authenticated"
-- privileges are revoked for objects created by this migration role.

-- ---------------------------------------------------------------------------
-- Default privileges: nothing is exposed unless a migration grants it.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges revoke execute on functions from public;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- RLS policies call private helpers as the querying role, so authenticated needs
-- USAGE on the schema. No private table is granted; the schema is not exposed by
-- the Data API.
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Error helper. PostgREST maps SQLSTATE PTxyz to HTTP status xyz; the message is
-- the stable application code and DETAIL carries safe JSON details.
-- ---------------------------------------------------------------------------
create function private.raise_app_error(p_code text, p_http integer, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'PT' || p_http::text,
    message = p_code,
    detail = coalesce(p_details, '{}'::jsonb)::text;
end;
$$;
revoke all on function private.raise_app_error(text, integer, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Profiles: editable settings only. No authority fields.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 80),
  city text check (city is null or char_length(city) between 1 and 80),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  locale text not null default 'en' check (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  temperature_unit text not null default 'celsius' check (temperature_unit in ('celsius', 'fahrenheit')),
  measurement_unit text not null default 'metric' check (measurement_unit in ('metric', 'imperial')),
  onboarding_completed_at timestamptz,
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'Member-editable settings. Membership, role and admission live in private.memberships.';

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
-- Column-level projection: authenticated may select only these settings columns.
grant select (id, display_name, city, timezone, locale, temperature_unit, measurement_unit,
  onboarding_completed_at, revision, created_at, updated_at) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Memberships: admission and role. Never client-writable.
-- ---------------------------------------------------------------------------
create table private.memberships (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'active', 'suspended', 'deleting')),
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_by uuid references auth.users (id) on delete set null,
  joined_at timestamptz,
  suspended_at timestamptz,
  deleting_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_joined_when_admitted check (state in ('pending', 'deleting') or joined_at is not null),
  constraint memberships_suspended_at check ((state = 'suspended') = (suspended_at is not null)),
  constraint memberships_owner_state check (role = 'member' or state in ('active', 'deleting'))
);
-- Exactly one owner for the installation (MVP). Transfer demotes before promoting
-- within one transaction.
create unique index memberships_single_owner on private.memberships (role) where role = 'owner';
create index memberships_pending_created on private.memberships (created_at) where state = 'pending';
revoke all on private.memberships from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Operational records used by this slice.
-- ---------------------------------------------------------------------------
create table private.mutation_requests (
  user_id uuid not null references auth.users (id) on delete cascade,
  operation text not null check (char_length(operation) between 1 and 64),
  idempotency_key uuid not null,
  body_hash text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, operation, idempotency_key)
);
create index mutation_requests_created on private.mutation_requests (created_at);
revoke all on private.mutation_requests from public, anon, authenticated;

create table private.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null check (char_length(action) between 1 and 64),
  target_type text not null check (char_length(target_type) between 1 and 64),
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_created on private.audit_events (created_at);
revoke all on private.audit_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Membership helper used by RLS. Reads membership without recursive RLS.
-- ---------------------------------------------------------------------------
create function private.is_active_member(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.memberships m
    where m.user_id = p_user_id and m.state = 'active'
  );
$$;
revoke all on function private.is_active_member(uuid) from public, anon, authenticated;
grant execute on function private.is_active_member(uuid) to authenticated;

create policy profiles_read_own on public.profiles
for select to authenticated
using (
  id = (select auth.uid())
  and (select private.is_active_member((select auth.uid())))
);

-- ---------------------------------------------------------------------------
-- Auth trigger: default profile + pending membership. Never grants admission
-- from user-supplied metadata.
-- ---------------------------------------------------------------------------
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  insert into private.memberships (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Owner bootstrap: operator-only, one-time while no owner exists.
-- Not granted to any API role; run through `pnpm ops:bootstrap-owner`.
-- ---------------------------------------------------------------------------
create function private.bootstrap_owner(p_user_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_membership private.memberships;
begin
  -- Serialize concurrent bootstrap attempts.
  lock table private.memberships in share row exclusive mode;

  if exists (select 1 from private.memberships where role = 'owner') then
    perform private.raise_app_error('OWNER_ALREADY_EXISTS', 409);
  end if;

  select * into v_membership from private.memberships where user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_membership.state not in ('pending', 'active') then
    perform private.raise_app_error('MEMBERSHIP_INACTIVE', 409, jsonb_build_object('state', v_membership.state));
  end if;

  update private.memberships
     set state = 'active', role = 'owner', joined_at = coalesce(joined_at, now()), updated_at = now()
   where user_id = p_user_id;

  insert into private.audit_events (actor_id, action, target_type, target_id, details)
  values (null, 'owner_bootstrapped', 'membership', p_user_id, jsonb_build_object('source', 'operator'));

  return jsonb_build_object('user_id', p_user_id, 'role', 'owner', 'state', 'active');
end;
$$;
revoke all on function private.bootstrap_owner(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Idempotency helpers for member RPCs.
-- ---------------------------------------------------------------------------
create function private.body_hash(p_body jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(p_body::text, 'UTF8')), 'hex');
$$;
revoke all on function private.body_hash(jsonb) from public, anon, authenticated;

-- Claims a request identity. Returns the stored result when the same key/body was
-- already committed, raises IDEMPOTENCY_CONFLICT for a changed body, or returns
-- null when the caller now owns the key and must perform the operation.
create function private.claim_request(p_user_id uuid, p_operation text, p_key uuid, p_body jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_hash text := private.body_hash(p_body);
  v_existing private.mutation_requests;
begin
  if p_key is null then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'request_id'));
  end if;

  insert into private.mutation_requests (user_id, operation, idempotency_key, body_hash)
  values (p_user_id, p_operation, p_key, v_hash)
  on conflict do nothing;

  if found then
    return null;
  end if;

  select * into v_existing from private.mutation_requests
   where user_id = p_user_id and operation = p_operation and idempotency_key = p_key;

  if v_existing.body_hash <> v_hash then
    perform private.raise_app_error('IDEMPOTENCY_CONFLICT', 409);
  end if;
  return v_existing.result;
end;
$$;
revoke all on function private.claim_request(uuid, text, uuid, jsonb) from public, anon, authenticated;

create function private.complete_request(p_user_id uuid, p_operation text, p_key uuid, p_result jsonb)
returns jsonb
language sql
set search_path = ''
as $$
  update private.mutation_requests set result = p_result
   where user_id = p_user_id and operation = p_operation and idempotency_key = p_key;
  select p_result;
$$;
revoke all on function private.complete_request(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Resolves the caller and requires active membership.
create function private.require_active_member()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform private.raise_app_error('AUTH_REQUIRED', 401);
  end if;
  if not private.is_active_member(v_uid) then
    perform private.raise_app_error('MEMBERSHIP_INACTIVE', 403);
  end if;
  return v_uid;
end;
$$;
revoke all on function private.require_active_member() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- update_profile: revisioned, idempotent, allowlisted settings.
-- ---------------------------------------------------------------------------
create function public.update_profile(p_request_id uuid, p_expected_revision bigint, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_member();
  v_allowed constant text[] := array['display_name', 'city', 'timezone', 'locale',
    'temperature_unit', 'measurement_unit', 'onboarding_completed'];
  v_unknown text[];
  v_existing jsonb;
  v_profile public.profiles;
  v_result jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'patch'));
  end if;

  select array_agg(k) into v_unknown from jsonb_object_keys(p_patch) k where k <> all (v_allowed);
  if v_unknown is not null then
    perform private.raise_app_error('VALIDATION_FAILED', 422,
      jsonb_build_object('reason', 'unexpected_fields', 'fields', to_jsonb(v_unknown)));
  end if;

  v_existing := private.claim_request(v_uid, 'update_profile', p_request_id,
    jsonb_build_object('expected_revision', p_expected_revision, 'patch', p_patch));
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_profile from public.profiles where id = v_uid for update;
  if v_profile.revision <> p_expected_revision then
    perform private.raise_app_error('REVISION_CONFLICT', 409,
      jsonb_build_object('current_revision', v_profile.revision));
  end if;

  if p_patch ? 'timezone' and not exists (
    select 1 from pg_catalog.pg_timezone_names where name = p_patch ->> 'timezone'
  ) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'timezone'));
  end if;
  if p_patch ? 'onboarding_completed' and jsonb_typeof(p_patch -> 'onboarding_completed') <> 'boolean' then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'onboarding_completed'));
  end if;

  begin
    update public.profiles set
      display_name = case when p_patch ? 'display_name' then nullif(btrim(p_patch ->> 'display_name'), '') else display_name end,
      city = case when p_patch ? 'city' then nullif(btrim(p_patch ->> 'city'), '') else city end,
      timezone = case when p_patch ? 'timezone' then p_patch ->> 'timezone' else timezone end,
      locale = case when p_patch ? 'locale' then p_patch ->> 'locale' else locale end,
      temperature_unit = case when p_patch ? 'temperature_unit' then p_patch ->> 'temperature_unit' else temperature_unit end,
      measurement_unit = case when p_patch ? 'measurement_unit' then p_patch ->> 'measurement_unit' else measurement_unit end,
      onboarding_completed_at = case
        when not p_patch ? 'onboarding_completed' then onboarding_completed_at
        when (p_patch ->> 'onboarding_completed')::boolean then coalesce(onboarding_completed_at, now())
        else null end,
      revision = revision + 1,
      updated_at = now()
    where id = v_uid
    returning * into v_profile;
  exception
    when check_violation or not_null_violation then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'invalid_value'));
  end;

  v_result := jsonb_build_object(
    'id', v_profile.id,
    'display_name', v_profile.display_name,
    'city', v_profile.city,
    'timezone', v_profile.timezone,
    'locale', v_profile.locale,
    'temperature_unit', v_profile.temperature_unit,
    'measurement_unit', v_profile.measurement_unit,
    'onboarding_completed_at', v_profile.onboarding_completed_at,
    'revision', v_profile.revision,
    'updated_at', v_profile.updated_at
  );
  return private.complete_request(v_uid, 'update_profile', p_request_id, v_result);
end;
$$;
revoke all on function public.update_profile(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.update_profile(uuid, bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Bootstrap read: the caller's own gate-safe state. Pending/suspended/deleting
-- identities receive no profile fields.
-- ---------------------------------------------------------------------------
create function public.get_bootstrap()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_membership private.memberships;
  v_profile public.profiles;
begin
  if v_uid is null then
    perform private.raise_app_error('AUTH_REQUIRED', 401);
  end if;

  select * into v_membership from private.memberships where user_id = v_uid;
  if not found then
    perform private.raise_app_error('AUTH_REQUIRED', 401);
  end if;

  if v_membership.state <> 'active' then
    return jsonb_build_object(
      'user_id', v_uid,
      'membership', jsonb_build_object('state', v_membership.state, 'role', null),
      'profile', null
    );
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  return jsonb_build_object(
    'user_id', v_uid,
    'membership', jsonb_build_object('state', v_membership.state, 'role', v_membership.role),
    'profile', jsonb_build_object(
      'display_name', v_profile.display_name,
      'city', v_profile.city,
      'timezone', v_profile.timezone,
      'locale', v_profile.locale,
      'temperature_unit', v_profile.temperature_unit,
      'measurement_unit', v_profile.measurement_unit,
      'onboarding_completed_at', v_profile.onboarding_completed_at,
      'revision', v_profile.revision
    )
  );
end;
$$;
revoke all on function public.get_bootstrap() from public, anon, authenticated;
grant execute on function public.get_bootstrap() to authenticated;
