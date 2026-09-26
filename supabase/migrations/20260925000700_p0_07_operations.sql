-- P0.07: operate and restore the private foundation.

-- ---------------------------------------------------------------------------
-- Maintenance heartbeats. Each scheduled task records its outcome; staleness is
-- computed when the health endpoint is read, so an external checker detects a
-- stopped scheduler without relying on that scheduler.
-- ---------------------------------------------------------------------------
create table private.maintenance_heartbeats (
  task text primary key,
  expected_every interval not null,
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 80)
);
revoke all on private.maintenance_heartbeats from public, anon, authenticated;

insert into private.maintenance_heartbeats (task, expected_every) values
  ('dispatch_jobs', interval '1 minute'),
  ('temporary_cleanup', interval '5 minutes'),
  ('account_deletion', interval '5 minutes'),
  ('ai_rollover', interval '10 minutes'),
  ('pending_account_cleanup', interval '1 hour'),
  ('orphan_reconciliation', interval '1 day');

create function public.svc_record_maintenance_run(p_task text, p_started_at timestamptz, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.maintenance_heartbeats
     set last_started_at = p_started_at,
         last_succeeded_at = case when p_error is null then now() else last_succeeded_at end,
         last_failed_at = case when p_error is null then last_failed_at else now() end,
         last_error = left(p_error, 80)
   where task = p_task;
$$;

-- ---------------------------------------------------------------------------
-- Deletion deadlines: temporary objects within one hour of becoming due,
-- retained objects within 24 hours (ARCHITECTURE 12.1 targets).
-- ---------------------------------------------------------------------------
alter table private.deletion_tasks drop constraint deletion_tasks_reason_check;
alter table private.deletion_tasks
  add constraint deletion_tasks_reason_check check (reason in (
    'quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload',
    'account_deleted', 'upload_expired', 'orphan')),
  add column deadline timestamptz;

create function private.deletion_task_deadline(p_reason text, p_not_before timestamptz, p_created_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case when p_reason = 'account_deleted' then p_created_at + interval '24 hours'
              else p_not_before + interval '1 hour' end;
$$;

update private.deletion_tasks set deadline = private.deletion_task_deadline(reason, not_before, created_at);
alter table private.deletion_tasks alter column deadline set not null;

create function private.set_deletion_deadline()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.deadline := coalesce(new.deadline, private.deletion_task_deadline(new.reason, new.not_before, new.created_at));
  return new;
end;
$$;
create trigger deletion_tasks_deadline before insert on private.deletion_tasks
  for each row execute function private.set_deletion_deadline();

-- ---------------------------------------------------------------------------
-- Temporary cleanup (every five minutes)
-- ---------------------------------------------------------------------------
create function public.svc_temporary_cleanup(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
  v_object private.media_objects;
  v_expired integer := 0;
  v_purged integer;
  v_total_purged integer := 0;
begin
  -- Abandoned slots (their signed PUT has expired) and failed uploads whose
  -- temporary asset expired: fence jobs, hide the asset, delete the bytes.
  for v_entry in
    select e.* from public.upload_entries e join public.media_assets a on a.id = e.asset_id
     where (e.state = 'awaiting_upload' and e.upload_expires_at + interval '1 minute' <= now())
        or (e.state = 'failed' and a.expires_at <= now())
     order by e.upload_expires_at
     limit p_limit
     for update of e skip locked
  loop
    update public.upload_entries set state = 'canceled', failure_code = null, updated_at = now() where id = v_entry.id;
    update public.media_assets set state = 'deletion_pending', updated_at = now()
     where id = v_entry.asset_id and state not in ('deleted', 'deletion_pending');
    update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
     where target_id = v_entry.asset_id and state not in ('succeeded', 'failed', 'canceled');
    for v_object in select * from private.media_objects where asset_id = v_entry.asset_id and deleted_at is null loop
      perform private.enqueue_object_deletion(v_entry.user_id, v_object.bucket, v_object.object_key, 'upload_expired', now());
    end loop;
    v_expired := v_expired + 1;
  end loop;

  -- Expired bounded records.
  delete from private.job_payloads where expires_at <= now();
  get diagnostics v_purged = row_count;
  v_total_purged := v_total_purged + v_purged;
  delete from private.reauth_challenges where expires_at <= now() - interval '1 day';
  get diagnostics v_purged = row_count;
  v_total_purged := v_total_purged + v_purged;
  delete from private.rate_limit_buckets where window_started_at <= now() - interval '2 days';
  get diagnostics v_purged = row_count;
  v_total_purged := v_total_purged + v_purged;
  -- Manifests are kept until completion plus the seven-day backup window.
  delete from private.account_deletions where state = 'complete' and status_expires_at <= now();
  get diagnostics v_purged = row_count;
  v_total_purged := v_total_purged + v_purged;
  delete from private.deletion_tasks where state = 'done' and completed_at <= now() - interval '7 days';
  get diagnostics v_purged = row_count;
  v_total_purged := v_total_purged + v_purged;

  return jsonb_build_object('uploads_expired', v_expired, 'records_purged', v_total_purged);
end;
$$;

-- Expiry is checked at signing too, not only by cleanup: a slot cannot be renewed
-- past its temporary asset's deadline.
create or replace function public.svc_renew_upload_entry(p_user_id uuid, p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
  v_asset_expires timestamptz;
  v_key text;
  v_expires timestamptz;
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_entry from public.upload_entries where id = p_entry_id and user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_entry.state <> 'awaiting_upload' then
    perform private.raise_app_error('UPLOAD_NOT_RENEWABLE', 409, jsonb_build_object('state', v_entry.state));
  end if;
  select expires_at into v_asset_expires from public.media_assets where id = v_entry.asset_id;
  if v_asset_expires <= now() then
    perform private.raise_app_error('UPLOAD_NOT_RENEWABLE', 409, jsonb_build_object('state', 'expired'));
  end if;
  v_expires := least(now() + make_interval(secs => (private.upload_limits() ->> 'upload_url_seconds')::integer), v_asset_expires);
  update public.upload_entries set upload_expires_at = v_expires, updated_at = now() where id = p_entry_id;
  select object_key into v_key from private.media_objects
   where asset_id = v_entry.asset_id and role = 'quarantine' and deleted_at is null;
  return jsonb_build_object('entry_id', p_entry_id, 'object_key', v_key, 'content_type', v_entry.declared_content_type,
    'upload_expires_at', v_expires);
end;
$$;

-- ---------------------------------------------------------------------------
-- Daily orphan reconciliation. The Edge lists the bucket; this compares the
-- listing with the object registry. Keys younger than the caller's grace period
-- are left out of p_orphan_candidates so in-flight worker output is not touched.
-- ---------------------------------------------------------------------------
create function public.svc_reconcile_storage(
  p_bucket text,
  p_listed_keys text[],
  p_orphan_candidates text[],
  p_listing_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_orphans integer;
  v_missing integer;
begin
  with orphans as (
    select k from unnest(p_orphan_candidates) k
     where not exists (select 1 from private.media_objects o where o.object_key = k and o.deleted_at is null)
       and not exists (select 1 from private.deletion_tasks t where t.object_key = k and t.state = 'pending')
  )
  insert into private.deletion_tasks (user_id, bucket, object_key, reason)
  select null, p_bucket, k, 'orphan' from orphans;
  get diagnostics v_orphans = row_count;

  -- Retained originals the registry says exist but storage no longer has.
  select count(*) into v_missing
    from private.media_objects o
   where o.bucket = p_bucket and o.role = 'original' and o.deleted_at is null
     and o.created_at < p_listing_started_at - interval '1 hour'
     and not (o.object_key = any (p_listed_keys));

  return jsonb_build_object('orphans_queued', v_orphans, 'originals_missing', v_missing);
end;
$$;

-- ---------------------------------------------------------------------------
-- External deletion journal. Rows are written in the deleting transaction and
-- exported to storage outside the database, so a restored backup can replay
-- deletions that happened after it was taken.
-- ---------------------------------------------------------------------------
create table private.deletion_journal (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('account_deleted')),
  subject_id uuid not null,
  recorded_at timestamptz not null default now(),
  exported_at timestamptz
);
create index deletion_journal_unexported on private.deletion_journal (id) where exported_at is null;
revoke all on private.deletion_journal from public, anon, authenticated;

create function private.journal_account_deletion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into private.deletion_journal (kind, subject_id) values ('account_deleted', new.user_id);
  return new;
end;
$$;
create trigger account_deletions_journal after insert on private.account_deletions
  for each row execute function private.journal_account_deletion();

create function public.svc_unexported_journal(p_limit integer default 100)
returns table (id bigint, kind text, subject_id uuid, recorded_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.kind, j.subject_id, j.recorded_at from private.deletion_journal j
   where j.exported_at is null order by j.id limit p_limit;
$$;

create function public.svc_mark_journal_exported(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  update private.deletion_journal set exported_at = now() where id = any (p_ids) and exported_at is null;
  delete from private.deletion_journal where exported_at <= now() - interval '30 days';
$$;

-- ---------------------------------------------------------------------------
-- Account deletion: the shared start, so a restore can replay a journaled deletion.
-- ---------------------------------------------------------------------------
create function private.begin_account_deletion(p_user_id uuid, p_status_token_hash text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_deletion_id uuid;
begin
  update private.memberships
     set state = 'deleting', deletion_reason = 'account_deleted', deleting_at = now(), updated_at = now()
   where user_id = p_user_id;
  update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
   where user_id = p_user_id and state not in ('succeeded', 'failed', 'canceled');
  delete from auth.sessions where user_id = p_user_id;

  insert into private.deletion_tasks (user_id, bucket, object_key, reason)
  select p_user_id, o.bucket, o.object_key, 'account_deleted'
    from private.media_objects o
   where o.user_id = p_user_id and o.deleted_at is null;

  perform private.scrub_account_domain(p_user_id);

  insert into private.account_deletions (user_id, status_token_hash)
  values (p_user_id, p_status_token_hash)
  returning id into v_deletion_id;
  insert into private.audit_events (actor_id, action, target_type, target_id)
  values (null, 'account_deletion_started', 'account_deletion', v_deletion_id);
  return v_deletion_id;
end;
$$;
revoke all on function private.begin_account_deletion(uuid, text) from public, anon, authenticated;

create or replace function public.svc_start_account_deletion(p_user_id uuid, p_proof_hash text, p_status_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership private.memberships;
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

  return jsonb_build_object('deletion_id', private.begin_account_deletion(p_user_id, p_status_token_hash),
    'state', 'objects_pending');
end;
$$;

-- ---------------------------------------------------------------------------
-- Restore preparation. Run in the isolated restored database before it serves
-- traffic: old sessions, claims and paid work from the backup's timeline must
-- not resume.
-- ---------------------------------------------------------------------------
alter table private.budget_settings drop constraint budget_settings_paused_reason_check;
alter table private.budget_settings
  add constraint budget_settings_paused_reason_check check (paused_reason in ('over_reservation', 'operator', 'restore'));

create function private.prepare_restored_database()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_sessions integer;
  v_jobs integer;
  v_ai integer;
begin
  -- Every member signs in again.
  delete from auth.sessions;
  get diagnostics v_sessions = row_count;
  delete from auth.refresh_tokens;
  delete from auth.flow_state;
  delete from auth.one_time_tokens;
  delete from private.reauth_challenges where consumed_at is null;

  -- Unfinished work fails visibly; members can retry uploads deliberately.
  update private.jobs set state = 'failed', failure_code = 'RESTORED', claim_nonce_hash = null, claim_expires_at = null,
         completed_at = now(), updated_at = now()
   where state in ('queued', 'running', 'retry_wait', 'blocked_budget');
  get diagnostics v_jobs = row_count;
  update public.upload_entries set state = 'failed', failure_code = 'RESTORED', updated_at = now()
   where state in ('uploaded', 'validating');

  -- AI attempts that may have reached the provider stay counted and are never resent.
  update private.ai_usage set state = 'unknown' where state in ('reserved', 'dispatching');
  get diagnostics v_ai = row_count;
  update private.budget_settings set paused_reason = 'restore', updated_at = now() where id;

  return jsonb_build_object('sessions_revoked', v_sessions, 'jobs_failed', v_jobs, 'ai_attempts_unknown', v_ai);
end;
$$;
revoke all on function private.prepare_restored_database() from public, anon, authenticated;

-- Replays one journaled account deletion into a restored database.
create function private.replay_account_deletion(p_user_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_membership private.memberships;
begin
  select * into v_membership from private.memberships where user_id = p_user_id for update;
  if not found then
    return 'absent';
  end if;
  if v_membership.state = 'deleting' and v_membership.deletion_reason = 'account_deleted' then
    return 'already_deleting';
  end if;
  perform private.begin_account_deletion(p_user_id, encode(extensions.digest(extensions.gen_random_bytes(32), 'sha256'), 'hex'));
  return 'replayed';
end;
$$;
revoke all on function private.replay_account_deletion(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Health and redacted operational summary
-- ---------------------------------------------------------------------------
create function private.operations_health()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with beats as (
    select task, last_succeeded_at, last_failed_at,
           coalesce(last_succeeded_at, '-infinity'::timestamptz) < now() - (expected_every * 2 + interval '2 minutes') as stale
      from private.maintenance_heartbeats
  ),
  facts as (
    select
      (select count(*) from private.deletion_tasks where state = 'pending')::int as deletions_pending,
      (select count(*) from private.deletion_tasks where state = 'pending' and deadline < now())::int as deletions_overdue,
      (select count(*) from private.account_deletions where state <> 'complete')::int as accounts_deleting,
      (select count(*) from private.account_deletions
        where state <> 'complete' and started_at < now() - interval '24 hours')::int as accounts_overdue,
      (select count(*) from public.svc_stuck_jobs())::int as jobs_stuck,
      (select coalesce(extract(epoch from now() - min(created_at))::int, 0) from private.jobs
        where state in ('queued', 'retry_wait')) as oldest_queued_seconds,
      (select count(*) from private.ai_usage where state = 'unknown')::int as ai_unknown_attempts,
      (select count(*) from private.deletion_journal where exported_at is null and recorded_at < now() - interval '15 minutes')::int
        as journal_unexported
  )
  select jsonb_build_object(
    'status', case when exists (select 1 from beats where stale)
                     or f.deletions_overdue > 0 or f.accounts_overdue > 0 or f.jobs_stuck > 0 or f.journal_unexported > 0
                   then 'degraded' else 'ok' end,
    'checked_at', now(),
    'stale_tasks', coalesce((select jsonb_agg(task order by task) from beats where stale), '[]'::jsonb),
    'heartbeats', coalesce((select jsonb_agg(jsonb_build_object('task', task, 'last_succeeded_at', last_succeeded_at,
      'last_failed_at', last_failed_at, 'stale', stale) order by task) from beats), '[]'::jsonb),
    'deletions_pending', f.deletions_pending,
    'deletions_overdue', f.deletions_overdue,
    'accounts_deleting', f.accounts_deleting,
    'accounts_overdue', f.accounts_overdue,
    'jobs_stuck', f.jobs_stuck,
    'oldest_queued_seconds', f.oldest_queued_seconds,
    'ai_unknown_attempts', f.ai_unknown_attempts,
    'journal_unexported', f.journal_unexported
  ) from facts f;
$$;
revoke all on function private.operations_health() from public, anon, authenticated;

create function public.svc_operations_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.operations_health();
$$;

create function public.svc_admin_operations(p_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_owner(p_actor_id);
  return private.operations_health();
end;
$$;

-- ---------------------------------------------------------------------------
-- Budget-mode analytics through an outbox: one event per observed transition.
-- ---------------------------------------------------------------------------
alter table private.budget_periods
  add column reported_mode text check (reported_mode in ('normal', 'lighter', 'paused')),
  add column mode_transitions integer not null default 0;

create table private.analytics_outbox (
  id bigint generated always as identity primary key,
  event text not null check (event in ('budget_mode_changed')),
  properties jsonb not null check (octet_length(properties::text) <= 512),
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
revoke all on private.analytics_outbox from public, anon, authenticated;

create function public.svc_observe_budget_mode()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period private.budget_periods;
  v_settings private.budget_settings;
  v_mode text;
begin
  select * into v_settings from private.budget_settings;
  select * into v_period from private.budget_periods
   where period_start <= now() and period_end > now() for update;
  if not found then
    return jsonb_build_object('changed', false);
  end if;
  v_mode := private.budget_mode(private.budget_committed(v_period), v_settings);
  if v_period.reported_mode is not distinct from v_mode then
    return jsonb_build_object('changed', false, 'mode', v_mode);
  end if;
  update private.budget_periods set reported_mode = v_mode, mode_transitions = mode_transitions + 1 where id = v_period.id;
  -- A new period starting in normal mode is not a transition.
  if v_period.reported_mode is not null or v_mode <> 'normal' then
    insert into private.analytics_outbox (event, properties, dedupe_key)
    values ('budget_mode_changed', jsonb_build_object('mode', v_mode),
      format('budget_mode:%s:%s', v_period.id, v_period.mode_transitions + 1))
    on conflict (dedupe_key) do nothing;
  end if;
  return jsonb_build_object('changed', true, 'mode', v_mode);
end;
$$;

create function public.svc_unsent_analytics(p_limit integer default 50)
returns table (id bigint, event text, properties jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.event, o.properties, o.created_at from private.analytics_outbox o
   where o.sent_at is null and o.created_at > now() - interval '7 days'
   order by o.id limit p_limit;
$$;

create function public.svc_mark_analytics_sent(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  update private.analytics_outbox set sent_at = now() where id = any (p_ids) and sent_at is null;
  delete from private.analytics_outbox where created_at <= now() - interval '30 days';
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_record_maintenance_run(text, timestamptz, text)',
    'public.svc_temporary_cleanup(integer)',
    'public.svc_reconcile_storage(text, text[], text[], timestamptz)',
    'public.svc_unexported_journal(integer)',
    'public.svc_mark_journal_exported(bigint[])',
    'public.svc_operations_health()',
    'public.svc_admin_operations(uuid)',
    'public.svc_observe_budget_mode()',
    'public.svc_unsent_analytics(integer)',
    'public.svc_mark_analytics_sent(bigint[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- The five-minute temporary cleanup replaces the P0.03 media-deletion schedule
-- (it expires abandoned uploads, then deletes every due object).
select cron.unschedule('bowr-media-deletion');
select cron.schedule('bowr-temporary-cleanup', '*/5 * * * *', $$select private.invoke_maintenance('temporary_cleanup')$$);
select cron.schedule('bowr-orphan-reconciliation', '17 3 * * *', $$select private.invoke_maintenance('orphan_reconciliation')$$);
