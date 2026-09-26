-- P0.02: owner invites a friend who redeems once.
-- Invite codes are generated and HMAC-digested in the Edge API; only digests are
-- stored. Redemption, throttling and cleanup are atomic database functions that
-- only the service role may execute, called by the Edge API with a verified user.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Membership deletion reason (pending cleanup now; account deletion in P0.06).
-- ---------------------------------------------------------------------------
alter table private.memberships
  add column deletion_reason text
    check (deletion_reason in ('pending_expired', 'pending_self', 'account_deleted')),
  add constraint memberships_deletion_reason check ((state = 'deleting') = (deletion_reason is not null));

-- ---------------------------------------------------------------------------
-- Invites and redemptions
-- ---------------------------------------------------------------------------
create table private.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code_digest text not null unique check (code_digest ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users (id) on delete set null,
  note text check (note is null or char_length(note) between 1 and 200),
  max_uses integer not null default 1 check (max_uses between 1 and 10),
  uses integer not null default 0,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invite_uses_within_limit check (uses between 0 and max_uses),
  constraint invite_expiry_after_creation check (expires_at > created_at)
);
revoke all on private.invite_codes from public, anon, authenticated;

create table private.invite_redemptions (
  invite_id uuid references private.invite_codes (id) on delete set null,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  unique (invite_id, user_id)
);
revoke all on private.invite_redemptions from public, anon, authenticated;

-- Atomic fixed-length windows keyed by a hashed subject (account or IP).
create table private.rate_limit_buckets (
  scope text not null check (char_length(scope) between 1 and 64),
  subject_hash text not null check (char_length(subject_hash) between 1 and 128),
  window_started_at timestamptz not null,
  count integer not null check (count >= 0),
  primary key (scope, subject_hash)
);
create index rate_limit_buckets_window on private.rate_limit_buckets (window_started_at);
revoke all on private.rate_limit_buckets from public, anon, authenticated;

-- Configured invite limits (DESIGN 6.1, ARCHITECTURE 5.2).
create function private.invite_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'account_attempts_per_hour', 5,
    'ip_attempts_per_hour', 30,
    'default_expiry_days', 7,
    'max_expiry_days', 30,
    'pending_account_hours', 24
  );
$$;
revoke all on function private.invite_limits() from public, anon, authenticated;

-- Increments a bucket under a row lock. Returns remaining seconds when the limit
-- was already reached (the attempt is not counted), or null when allowed.
create function private.consume_rate_limit(p_scope text, p_subject_hash text, p_limit integer, p_window interval)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_bucket private.rate_limit_buckets;
begin
  insert into private.rate_limit_buckets as b (scope, subject_hash, window_started_at, count)
  values (p_scope, p_subject_hash, now(), 0)
  on conflict (scope, subject_hash) do update
    set window_started_at = case when b.window_started_at + p_window <= now() then now() else b.window_started_at end,
        count = case when b.window_started_at + p_window <= now() then 0 else b.count end
  returning * into v_bucket;

  if v_bucket.count >= p_limit then
    return greatest(1, ceil(extract(epoch from (v_bucket.window_started_at + p_window - now())))::integer);
  end if;

  update private.rate_limit_buckets set count = count + 1
   where scope = p_scope and subject_hash = p_subject_hash;
  return null;
end;
$$;
revoke all on function private.consume_rate_limit(text, text, integer, interval) from public, anon, authenticated;

-- Resolves an active owner for owner-only commands.
create function private.require_owner(p_actor_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_actor_id is null or not exists (
    select 1 from private.memberships where user_id = p_actor_id and state = 'active' and role = 'owner'
  ) then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
end;
$$;
revoke all on function private.require_owner(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Service RPCs (Edge API only). The Edge verifies the caller JWT and supplies
-- that user ID; no client role can execute these functions.
-- ---------------------------------------------------------------------------

-- Owner creates an invite. Idempotent per owner/request identity; a replay returns
-- the same invite without the plaintext code, which is never stored.
create function public.svc_create_invite(
  p_actor_id uuid,
  p_request_id uuid,
  p_code_digest text,
  p_note text,
  p_expires_in_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.invite_limits();
  v_existing jsonb;
  v_invite private.invite_codes;
  v_result jsonb;
  v_days integer := coalesce(p_expires_in_days, (v_limits ->> 'default_expiry_days')::integer);
begin
  perform private.require_owner(p_actor_id);
  if v_days < 1 or v_days > (v_limits ->> 'max_expiry_days')::integer then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'expires_in_days'));
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 200 then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'note'));
  end if;

  -- The digest is excluded from the request body hash: a retry generates a new
  -- random code, but it must still resolve to the first invite.
  v_existing := private.claim_request(p_actor_id, 'create_invite', p_request_id,
    jsonb_build_object('note', nullif(btrim(p_note), ''), 'expires_in_days', v_days));
  if v_existing is not null then
    return v_existing || jsonb_build_object('replayed', true);
  end if;

  insert into private.invite_codes (code_digest, created_by, note, expires_at)
  values (p_code_digest, p_actor_id, nullif(btrim(p_note), ''), now() + make_interval(days => v_days))
  returning * into v_invite;

  insert into private.audit_events (actor_id, action, target_type, target_id)
  values (p_actor_id, 'invite_created', 'invite', v_invite.id);

  v_result := jsonb_build_object('invite_id', v_invite.id, 'expires_at', v_invite.expires_at, 'max_uses', v_invite.max_uses);
  perform private.complete_request(p_actor_id, 'create_invite', p_request_id, v_result);
  return v_result || jsonb_build_object('replayed', false);
end;
$$;

-- Owner revokes remaining capacity. Existing members are unaffected.
create function public.svc_revoke_invite(p_actor_id uuid, p_request_id uuid, p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_invite private.invite_codes;
  v_result jsonb;
begin
  perform private.require_owner(p_actor_id);
  v_existing := private.claim_request(p_actor_id, 'revoke_invite', p_request_id,
    jsonb_build_object('invite_id', p_invite_id));
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_invite from private.invite_codes where id = p_invite_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_invite.revoked_at is null then
    update private.invite_codes set revoked_at = now() where id = p_invite_id returning * into v_invite;
    insert into private.audit_events (actor_id, action, target_type, target_id)
    values (p_actor_id, 'invite_revoked', 'invite', p_invite_id);
  end if;

  v_result := jsonb_build_object('invite_id', v_invite.id, 'revoked_at', v_invite.revoked_at, 'uses', v_invite.uses);
  return private.complete_request(p_actor_id, 'revoke_invite', p_request_id, v_result);
end;
$$;

-- Redeems a code for a pending identity. Returns an outcome instead of raising for
-- unavailable codes and throttling, so the attempt counters always commit.
create function public.svc_redeem_invite(p_user_id uuid, p_code_digest text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.invite_limits();
  v_membership private.memberships;
  v_invite private.invite_codes;
  v_retry integer;
begin
  select * into v_membership from private.memberships where user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('AUTH_REQUIRED', 401);
  end if;
  -- The winner's retry returns the existing membership without another use.
  if v_membership.state = 'active' then
    return jsonb_build_object('outcome', 'admitted', 'state', 'active', 'joined_at', v_membership.joined_at);
  end if;
  if v_membership.state <> 'pending' then
    perform private.raise_app_error('MEMBERSHIP_INACTIVE', 403, jsonb_build_object('state', v_membership.state));
  end if;

  v_retry := private.consume_rate_limit('invite_redeem_account', p_user_id::text,
    (v_limits ->> 'account_attempts_per_hour')::integer, interval '1 hour');
  if v_retry is null and p_ip_hash is not null then
    v_retry := private.consume_rate_limit('invite_redeem_ip', p_ip_hash,
      (v_limits ->> 'ip_attempts_per_hour')::integer, interval '1 hour');
  end if;
  if v_retry is not null then
    return jsonb_build_object('outcome', 'rate_limited', 'retry_after_seconds', v_retry);
  end if;

  select * into v_invite from private.invite_codes where code_digest = p_code_digest for update;
  if not found or v_invite.revoked_at is not null or v_invite.expires_at <= now() or v_invite.uses >= v_invite.max_uses then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  insert into private.invite_redemptions (invite_id, user_id) values (v_invite.id, p_user_id);
  update private.invite_codes set uses = uses + 1 where id = v_invite.id;
  update private.memberships
     set state = 'active', role = 'member', invited_by = v_invite.created_by, joined_at = now(), updated_at = now()
   where user_id = p_user_id
  returning * into v_membership;

  insert into private.audit_events (actor_id, action, target_type, target_id, details)
  values (p_user_id, 'invite_redeemed', 'invite', v_invite.id, '{}'::jsonb);

  return jsonb_build_object('outcome', 'admitted', 'state', 'active', 'joined_at', v_membership.joined_at);
end;
$$;

-- Owner-only safe administration view: memberships and invites, no wardrobe data.
create function public.svc_admin_overview(p_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_owner(p_actor_id);
  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', m.user_id,
        'display_name', p.display_name,
        'role', m.role,
        'state', m.state,
        'joined_at', m.joined_at,
        'invited_by_name', ip.display_name,
        'last_sign_in_at', u.last_sign_in_at
      ) order by m.joined_at nulls last, m.user_id)
      from private.memberships m
      join auth.users u on u.id = m.user_id
      left join public.profiles p on p.id = m.user_id
      left join public.profiles ip on ip.id = m.invited_by
      where m.state in ('active', 'suspended')
    ), '[]'::jsonb),
    'pending_count', (select count(*) from private.memberships where state = 'pending'),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'note', i.note,
        'created_at', i.created_at,
        'expires_at', i.expires_at,
        'uses', i.uses,
        'max_uses', i.max_uses,
        'status', case
          when i.revoked_at is not null then 'revoked'
          when i.uses >= i.max_uses then 'used'
          when i.expires_at <= now() then 'expired'
          else 'active' end,
        'redeemed_by_name', (
          select string_agg(coalesce(rp.display_name, 'Unnamed member'), ', ')
          from private.invite_redemptions r left join public.profiles rp on rp.id = r.user_id
          where r.invite_id = i.id)
      ) order by i.created_at desc)
      from private.invite_codes i
      where i.created_at > now() - interval '90 days'
    ), '[]'::jsonb)
  );
end;
$$;

-- A pending identity deletes its own unredeemed account.
create function public.svc_mark_pending_self_deletion(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership private.memberships;
begin
  select * into v_membership from private.memberships where user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_membership.state = 'deleting' and v_membership.deletion_reason in ('pending_self', 'pending_expired') then
    return jsonb_build_object('state', 'deleting');
  end if;
  if v_membership.state <> 'pending' then
    perform private.raise_app_error('MEMBERSHIP_INACTIVE', 409, jsonb_build_object('state', v_membership.state));
  end if;
  update private.memberships
     set state = 'deleting', deletion_reason = 'pending_self', deleting_at = now(), updated_at = now()
   where user_id = p_user_id;
  insert into private.audit_events (actor_id, action, target_type, target_id)
  values (p_user_id, 'pending_account_deletion_requested', 'membership', p_user_id);
  return jsonb_build_object('state', 'deleting');
end;
$$;

-- Hourly cleanup: claims pending accounts older than the limit by locking and
-- rechecking each membership, marks them deleting, and returns them together with
-- earlier claims whose Auth deletion has not completed (retry).
create function public.svc_claim_pending_account_cleanup(p_limit integer default 50)
returns table (user_id uuid, deletion_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hours integer := (private.invite_limits() ->> 'pending_account_hours')::integer;
begin
  return query
  with candidates as (
    select m.user_id
      from private.memberships m
     where m.state = 'pending' and m.created_at <= now() - make_interval(hours => v_hours)
     order by m.created_at
     limit p_limit
     for update skip locked
  ), claimed as (
    update private.memberships m
       set state = 'deleting', deletion_reason = 'pending_expired', deleting_at = now(), updated_at = now()
      from candidates c
     where m.user_id = c.user_id and m.state = 'pending'
    returning m.user_id, m.deletion_reason
  ), retries as (
    select m.user_id, m.deletion_reason
      from private.memberships m
     where m.state = 'deleting'
       and m.deletion_reason in ('pending_expired', 'pending_self')
       and m.deleting_at <= now() - interval '5 minutes'
     limit p_limit
  )
  select c.user_id, c.deletion_reason from claimed c
  union
  select r.user_id, r.deletion_reason from retries r;
end;
$$;

-- Records a completed pending-account deletion. The membership row itself is
-- removed by the Auth user's cascade.
create function public.svc_record_pending_account_deleted(p_user_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.audit_events (actor_id, action, target_type, target_id, details)
  values (null, 'pending_account_deleted', 'membership', null, jsonb_build_object('reason', p_reason));
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_create_invite(uuid, uuid, text, text, integer)',
    'public.svc_revoke_invite(uuid, uuid, uuid)',
    'public.svc_redeem_invite(uuid, text, text)',
    'public.svc_admin_overview(uuid)',
    'public.svc_mark_pending_self_deletion(uuid)',
    'public.svc_claim_pending_account_cleanup(integer)',
    'public.svc_record_pending_account_deleted(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bootstrap: owners see owner navigation; pending identities see invite limits.
-- ---------------------------------------------------------------------------
create or replace function public.get_bootstrap()
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
      'profile', null,
      'pending_expires_at', case when v_membership.state = 'pending'
        then v_membership.created_at + make_interval(hours => (private.invite_limits() ->> 'pending_account_hours')::integer)
      end
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
    ),
    'pending_expires_at', null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduled maintenance: pg_cron calls the maintenance Edge function through
-- pg_net with a machine secret kept in Vault. Missing configuration is a no-op.
-- ---------------------------------------------------------------------------
create function private.invoke_maintenance(p_task text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'bowr_maintenance_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'bowr_maintenance_secret';
  if v_url is null or v_secret is null then
    raise warning 'bowr maintenance is not configured; skipped %', p_task;
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := jsonb_build_object('task', p_task),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 30000
  );
end;
$$;
revoke all on function private.invoke_maintenance(text) from public, anon, authenticated;

select cron.schedule('bowr-pending-account-cleanup', '7 * * * *',
  $$select private.invoke_maintenance('pending_account_cleanup')$$);
