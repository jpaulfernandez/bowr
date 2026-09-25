-- P0.06: manage account access and delete your own data.

-- ---------------------------------------------------------------------------
-- Fresh authentication: action-bound, ten-minute challenges and single-use proofs.
-- A challenge is verified only by a session that authenticated after the
-- challenge was created; refreshing an older session keeps its original
-- authentication time and cannot satisfy it.
-- ---------------------------------------------------------------------------
create table private.reauth_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null check (action in ('delete_account', 'transfer_ownership')),
  requesting_session_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  verified_at timestamptz,
  verified_session_id uuid,
  proof_hash text unique check (proof_hash ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz,
  constraint reauth_verified_has_proof check ((verified_at is null) = (proof_hash is null))
);
create index reauth_challenges_user on private.reauth_challenges (user_id, created_at desc);
revoke all on private.reauth_challenges from public, anon, authenticated;

create function public.svc_create_reauth_challenge(p_user_id uuid, p_action text, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge private.reauth_challenges;
begin
  perform private.require_active_member_id(p_user_id);
  if p_action not in ('delete_account', 'transfer_ownership') then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'action'));
  end if;
  -- Bounded: at most five open challenges per account.
  if (select count(*) from private.reauth_challenges
       where user_id = p_user_id and consumed_at is null and expires_at > now()) >= 5 then
    perform private.raise_app_error('RATE_LIMITED', 429, jsonb_build_object('retry_after_seconds', 600));
  end if;
  insert into private.reauth_challenges (user_id, action, requesting_session_id)
  values (p_user_id, p_action, p_session_id)
  returning * into v_challenge;
  return jsonb_build_object('challenge_id', v_challenge.id, 'action', v_challenge.action, 'expires_at', v_challenge.expires_at);
end;
$$;

create function public.svc_verify_reauth_challenge(
  p_user_id uuid,
  p_challenge_id uuid,
  p_session_id uuid,
  p_authenticated_at timestamptz,
  p_proof_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge private.reauth_challenges;
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_challenge from private.reauth_challenges where id = p_challenge_id for update;
  if not found or v_challenge.user_id <> p_user_id or v_challenge.expires_at <= now()
     or v_challenge.verified_at is not null
     or p_authenticated_at is null or p_authenticated_at < v_challenge.created_at
     or p_session_id is null or p_session_id is not distinct from v_challenge.requesting_session_id then
    perform private.raise_app_error('REAUTH_REQUIRED', 403);
  end if;
  update private.reauth_challenges
     set verified_at = now(), verified_session_id = p_session_id, proof_hash = p_proof_hash
   where id = p_challenge_id;
  return jsonb_build_object('challenge_id', p_challenge_id, 'action', v_challenge.action, 'expires_at', v_challenge.expires_at);
end;
$$;

-- Consumes a proof for one action by one user. Callers hold their own locks.
create function private.consume_reauth_proof(p_user_id uuid, p_action text, p_proof_hash text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_challenge private.reauth_challenges;
begin
  select * into v_challenge from private.reauth_challenges where proof_hash = p_proof_hash for update;
  if not found or v_challenge.user_id <> p_user_id or v_challenge.action <> p_action
     or v_challenge.consumed_at is not null or v_challenge.expires_at <= now() then
    perform private.raise_app_error('REAUTH_REQUIRED', 403);
  end if;
  update private.reauth_challenges set consumed_at = now() where id = v_challenge.id;
end;
$$;
revoke all on function private.consume_reauth_proof(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Owner suspension and ownership transfer
-- ---------------------------------------------------------------------------
create function public.svc_admin_set_suspension(p_actor_id uuid, p_member_id uuid, p_suspend boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member private.memberships;
begin
  perform private.require_owner(p_actor_id);
  select * into v_member from private.memberships where user_id = p_member_id for update;
  if not found or v_member.state not in ('active', 'suspended') then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_member.role = 'owner' then
    perform private.raise_app_error('CANNOT_SUSPEND_OWNER', 409);
  end if;
  if p_suspend and v_member.state = 'active' then
    update private.memberships set state = 'suspended', suspended_at = now(), updated_at = now() where user_id = p_member_id;
    -- Running work for the member is fenced; new work is refused by membership checks.
    update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
     where user_id = p_member_id and state in ('queued', 'running', 'retry_wait');
    update public.upload_entries set state = 'uploaded', updated_at = now()
     where user_id = p_member_id and state = 'validating';
    insert into private.audit_events (actor_id, action, target_type, target_id)
    values (p_actor_id, 'member_suspended', 'membership', p_member_id);
  elsif not p_suspend and v_member.state = 'suspended' then
    update private.memberships set state = 'active', suspended_at = null, updated_at = now() where user_id = p_member_id;
    -- Uploads interrupted by the suspension can be processed again.
    update private.jobs set state = 'queued', attempt_count = 0, next_run_at = now(), completed_at = null, updated_at = now()
     where user_id = p_member_id and state = 'canceled' and kind = 'validate_upload'
       and target_id in (select asset_id from public.upload_entries where user_id = p_member_id and state = 'uploaded');
    insert into private.audit_events (actor_id, action, target_type, target_id)
    values (p_actor_id, 'member_restored', 'membership', p_member_id);
  end if;
  select * into v_member from private.memberships where user_id = p_member_id;
  return jsonb_build_object('user_id', p_member_id, 'state', v_member.state);
end;
$$;

create function public.svc_transfer_ownership(p_actor_id uuid, p_recipient_id uuid, p_proof_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient private.memberships;
begin
  -- Lock both rows in a fixed order so concurrent transfers serialize.
  perform 1 from private.memberships where user_id in (p_actor_id, p_recipient_id) order by user_id for update;
  perform private.require_owner(p_actor_id);
  select * into v_recipient from private.memberships where user_id = p_recipient_id;
  if not found or v_recipient.state <> 'active' or p_recipient_id = p_actor_id then
    perform private.raise_app_error('INVALID_RECIPIENT', 422);
  end if;
  perform private.consume_reauth_proof(p_actor_id, 'transfer_ownership', p_proof_hash);
  update private.memberships set role = 'member', updated_at = now() where user_id = p_actor_id;
  update private.memberships set role = 'owner', updated_at = now() where user_id = p_recipient_id;
  insert into private.audit_events (actor_id, action, target_type, target_id)
  values (p_actor_id, 'ownership_transferred', 'membership', p_recipient_id);
  return jsonb_build_object('owner_id', p_recipient_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recoverable account deletion
-- ---------------------------------------------------------------------------
alter table private.deletion_tasks drop constraint deletion_tasks_reason_check;
alter table private.deletion_tasks add constraint deletion_tasks_reason_check check (reason in (
  'quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload', 'account_deleted'));

-- The workflow record outlives the Auth user; it holds no identity or content.
create table private.account_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status_token_hash text not null unique check (status_token_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'objects_pending' check (state in ('objects_pending', 'auth_pending', 'complete')),
  last_error text check (last_error is null or char_length(last_error) <= 80),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  -- A processor claims a ready deletion briefly, so two runs do not race on it.
  claimed_until timestamptz,
  status_expires_at timestamptz not null default now() + interval '7 days'
);
create index account_deletions_open on private.account_deletions (started_at) where state <> 'complete';
revoke all on private.account_deletions from public, anon, authenticated;

-- Extension point: each later phase adds its own domain cleanup here (items,
-- outfits, logs, profiles...) with `create or replace`, keeping its media in the
-- deletion manifest. Runs inside the deletion transaction.
create function private.scrub_account_domain(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.profiles set display_name = null, city = null, revision = revision + 1, updated_at = now()
   where id = p_user_id;
  delete from public.upload_batches where user_id = p_user_id;
  delete from public.media_assets where user_id = p_user_id;
  delete from private.job_payloads where job_id in (select id from private.jobs where user_id = p_user_id);
  delete from private.mutation_requests where user_id = p_user_id;
  delete from private.reauth_challenges where user_id = p_user_id and consumed_at is null;
  -- Accounting stays for the shared ledger, detached from the person.
  update private.ai_usage set user_id = null where user_id = p_user_id;
end;
$$;
revoke all on function private.scrub_account_domain(uuid) from public, anon, authenticated;

create function public.svc_start_account_deletion(p_user_id uuid, p_proof_hash text, p_status_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership private.memberships;
  v_deletion_id uuid;
begin
  select * into v_membership from private.memberships where user_id = p_user_id for update;
  if not found or v_membership.state <> 'active' then
    perform private.raise_app_error('MEMBERSHIP_INACTIVE', 403);
  end if;
  perform private.consume_reauth_proof(p_user_id, 'delete_account', p_proof_hash);

  if v_membership.role = 'owner' and exists (
    select 1 from private.memberships where state = 'active' and user_id <> p_user_id
  ) then
    perform private.raise_app_error('OWNER_TRANSFER_REQUIRED', 409);
  end if;

  -- 1. Deny access: membership, signing, jobs and sessions.
  update private.memberships
     set state = 'deleting', deletion_reason = 'account_deleted', deleting_at = now(), updated_at = now()
   where user_id = p_user_id;
  update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
   where user_id = p_user_id and state not in ('succeeded', 'failed', 'canceled');
  delete from auth.sessions where user_id = p_user_id;

  -- 2. Manifest: every stored object of the account is queued for deletion.
  insert into private.deletion_tasks (user_id, bucket, object_key, reason)
  select p_user_id, o.bucket, o.object_key, 'account_deleted'
    from private.media_objects o
   where o.user_id = p_user_id and o.deleted_at is null;

  -- 3. Domain data is removed now; the Auth identity is removed after the objects.
  perform private.scrub_account_domain(p_user_id);

  insert into private.account_deletions (user_id, status_token_hash)
  values (p_user_id, p_status_token_hash)
  returning id into v_deletion_id;
  insert into private.audit_events (actor_id, action, target_type, target_id)
  values (null, 'account_deletion_started', 'account_deletion', v_deletion_id);
  return jsonb_build_object('deletion_id', v_deletion_id, 'state', 'objects_pending');
end;
$$;

-- Deletions whose objects are all confirmed absent are ready for Auth removal.
create function public.svc_account_deletions_ready(p_limit integer default 20)
returns table (deletion_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.account_deletions d set state = 'auth_pending', updated_at = now()
   where d.state = 'objects_pending'
     and not exists (select 1 from private.deletion_tasks t where t.user_id = d.user_id and t.state = 'pending');
  return query
  with ready as (
    select d.id from private.account_deletions d
     where d.state = 'auth_pending' and (d.claimed_until is null or d.claimed_until <= now())
     order by d.started_at limit p_limit
     for update skip locked
  )
  update private.account_deletions d set claimed_until = now() + interval '2 minutes'
    from ready where d.id = ready.id
  returning d.id, d.user_id;
end;
$$;

create function public.svc_complete_account_deletion(p_deletion_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_error is null then
    update private.account_deletions
       set state = 'complete', completed_at = now(), updated_at = now(), last_error = null
     where id = p_deletion_id and state = 'auth_pending';
    insert into private.audit_events (actor_id, action, target_type, target_id)
    values (null, 'account_deletion_completed', 'account_deletion', p_deletion_id);
  else
    update private.account_deletions set last_error = left(p_error, 80), claimed_until = null, updated_at = now()
     where id = p_deletion_id;
  end if;
end;
$$;

-- Restricted status: progress only, for the bearer of the status capability.
create function public.svc_account_deletion_status(p_status_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_deletion private.account_deletions;
begin
  select * into v_deletion from private.account_deletions
   where status_token_hash = p_status_token_hash and status_expires_at > now();
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  return jsonb_build_object(
    'state', v_deletion.state,
    'started_at', v_deletion.started_at,
    'completed_at', v_deletion.completed_at,
    'objects_remaining', (select count(*) from private.deletion_tasks t
                           where t.user_id = v_deletion.user_id and t.state = 'pending')
  );
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_create_reauth_challenge(uuid, text, uuid)',
    'public.svc_verify_reauth_challenge(uuid, uuid, uuid, timestamptz, text)',
    'public.svc_admin_set_suspension(uuid, uuid, boolean)',
    'public.svc_transfer_ownership(uuid, uuid, text)',
    'public.svc_start_account_deletion(uuid, text, text)',
    'public.svc_account_deletions_ready(integer)',
    'public.svc_complete_account_deletion(uuid, text)',
    'public.svc_account_deletion_status(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- Admin overview includes suspended members' state (already) and nothing else.
select cron.schedule('bowr-account-deletion', '*/5 * * * *', $$select private.invoke_maintenance('account_deletion')$$);
