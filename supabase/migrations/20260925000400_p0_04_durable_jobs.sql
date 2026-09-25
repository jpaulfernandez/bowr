-- P0.04: leave an upload and recover processing after failure.
-- Completes the job registry: states, dependencies, payloads, heartbeats,
-- bounded retries, dispatch/reconciliation and manual retry.

-- ---------------------------------------------------------------------------
-- Job registry
-- ---------------------------------------------------------------------------
alter table private.jobs drop constraint jobs_state_check;
alter table private.jobs
  add constraint jobs_state_check
    check (state in ('queued', 'running', 'retry_wait', 'blocked_budget', 'awaiting_review', 'succeeded', 'failed', 'canceled')),
  add column stage text not null default 'validate' check (stage in ('validate')),
  add column depends_on uuid references private.jobs (id) on delete set null,
  add column input_schema_version integer not null default 1,
  add column output_schema_version integer not null default 1,
  add column next_run_at timestamptz not null default now(),
  add column claimed_at timestamptz,
  add column heartbeat_at timestamptz,
  add column last_dispatched_at timestamptz,
  add column manual_retries integer not null default 0 check (manual_retries between 0 and 2),
  add constraint jobs_attempts_bounded check (attempt_count between 0 and 3);

drop index private.jobs_queued;
create index jobs_runnable on private.jobs (next_run_at) where state in ('queued', 'retry_wait');
create index jobs_running_lease on private.jobs (lease_expires_at) where state = 'running';
create index jobs_user_running on private.jobs (user_id) where state = 'running';

-- Bounded typed input/output; no photo bytes and no signed URLs.
create table private.job_payloads (
  job_id uuid primary key references private.jobs (id) on delete cascade,
  input jsonb not null check (octet_length(input::text) <= 4096),
  output jsonb check (output is null or octet_length(output::text) <= 4096),
  expires_at timestamptz not null default now() + interval '7 days'
);
revoke all on private.job_payloads from public, anon, authenticated;

-- Processing failures are distinct from unusable files.
alter table public.upload_entries drop constraint upload_entries_state_check;
alter table public.upload_entries drop constraint entry_failure_code;
alter table public.upload_entries
  add constraint upload_entries_state_check
    check (state in ('awaiting_upload', 'uploaded', 'validating', 'ready', 'rejected', 'failed', 'canceled')),
  add constraint entry_failure_code check ((state in ('rejected', 'failed')) = (failure_code is not null));

create function private.job_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'max_attempts', 3,
    'max_running_global', 2,
    'max_running_per_member', 1,
    'lease_seconds', 120,
    'stage_deadline_seconds', 300,
    'job_deadline_seconds', 600,
    'dispatch_retry_seconds', 60,
    'backoff_base_seconds', 10
  );
$$;
revoke all on function private.job_limits() from public, anon, authenticated;

-- Job creation now records its input snapshot in the same transaction.
create or replace function public.svc_complete_upload_entry(p_user_id uuid, p_request_id uuid, p_entry_id uuid, p_object_size bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.upload_limits();
  v_existing jsonb;
  v_entry public.upload_entries;
  v_job_id uuid;
  v_key text;
  v_bucket text;
begin
  perform private.require_active_member_id(p_user_id);
  v_existing := private.claim_request(p_user_id, 'complete_upload_entry', p_request_id, jsonb_build_object('entry_id', p_entry_id));
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_entry from public.upload_entries where id = p_entry_id and user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_entry.state = 'canceled' then
    perform private.raise_app_error('UPLOAD_CANCELED', 409);
  end if;

  if v_entry.state = 'awaiting_upload' then
    if p_object_size is null then
      perform private.raise_app_error('UPLOAD_MISSING', 409);
    end if;
    select object_key, bucket into v_key, v_bucket from private.media_objects
     where asset_id = v_entry.asset_id and role = 'quarantine' and deleted_at is null;
    if p_object_size > (v_limits ->> 'max_bytes')::bigint then
      update public.upload_entries set state = 'rejected', failure_code = 'FILE_TOO_LARGE', updated_at = now() where id = p_entry_id;
      update public.media_assets set state = 'rejected', updated_at = now() where id = v_entry.asset_id;
      perform private.enqueue_object_deletion(p_user_id, v_bucket, v_key, 'rejected_upload', now());
      perform private.enqueue_object_deletion(p_user_id, v_bucket, v_key, 'quarantine_recheck', v_entry.upload_expires_at + interval '1 minute');
    else
      update public.upload_entries set state = 'uploaded', updated_at = now() where id = p_entry_id;
      update public.media_assets set state = 'uploaded', updated_at = now() where id = v_entry.asset_id;
      insert into private.jobs (user_id, kind, stage, target_id, dedupe_key)
      values (p_user_id, 'validate_upload', 'validate', v_entry.asset_id, 'validate_upload:' || v_entry.asset_id || ':1')
      on conflict (dedupe_key) do nothing
      returning id into v_job_id;
      if v_job_id is not null then
        insert into private.job_payloads (job_id, input)
        values (v_job_id, jsonb_build_object('schema_version', 1, 'entry_id', v_entry.id, 'purpose', v_entry.purpose,
          'rotation', v_entry.rotation, 'declared_content_type', v_entry.declared_content_type));
      end if;
    end if;
  end if;

  select id into v_job_id from private.jobs where target_id = v_entry.asset_id and kind = 'validate_upload';
  select * into v_entry from public.upload_entries where id = p_entry_id;
  return private.complete_request(p_user_id, 'complete_upload_entry', p_request_id, jsonb_build_object(
    'entry_id', v_entry.id, 'asset_id', v_entry.asset_id, 'state', v_entry.state,
    'failure_code', v_entry.failure_code, 'job_id', v_job_id));
end;
$$;

-- Existing P0.03 jobs keep working: their dedupe keys and payloads are backfilled.
update private.jobs set dedupe_key = dedupe_key || ':1' where kind = 'validate_upload' and dedupe_key !~ ':\d+$';
insert into private.job_payloads (job_id, input)
select j.id, jsonb_build_object('schema_version', 1, 'entry_id', e.id, 'purpose', e.purpose, 'rotation', e.rotation,
  'declared_content_type', e.declared_content_type)
  from private.jobs j join public.upload_entries e on e.asset_id = j.target_id
 where not exists (select 1 from private.job_payloads p where p.job_id = j.id);

create or replace function public.svc_cancel_upload_entry(p_user_id uuid, p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
  v_object private.media_objects;
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_entry from public.upload_entries where id = p_entry_id and user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_entry.state = 'canceled' then
    return jsonb_build_object('entry_id', p_entry_id, 'state', 'canceled');
  end if;
  if v_entry.state in ('ready', 'rejected') then
    perform private.raise_app_error('UPLOAD_NOT_CANCELABLE', 409, jsonb_build_object('state', v_entry.state));
  end if;

  update public.upload_entries set state = 'canceled', failure_code = null, updated_at = now() where id = p_entry_id;
  update public.media_assets set state = 'deletion_pending', updated_at = now() where id = v_entry.asset_id;
  -- Fences every current or future callback for this target.
  update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
   where target_id = v_entry.asset_id and state not in ('succeeded', 'failed', 'canceled');

  for v_object in select * from private.media_objects where asset_id = v_entry.asset_id and deleted_at is null loop
    perform private.enqueue_object_deletion(p_user_id, v_object.bucket, v_object.object_key, 'upload_canceled', now());
    if v_object.role = 'quarantine' then
      perform private.enqueue_object_deletion(p_user_id, v_object.bucket, v_object.object_key, 'quarantine_recheck',
        v_entry.upload_expires_at + interval '1 minute');
    end if;
  end loop;
  return jsonb_build_object('entry_id', p_entry_id, 'state', 'canceled');
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim, heartbeat, failure and completion
-- ---------------------------------------------------------------------------

-- Issues a claim for a runnable job only when concurrency allows it.
create or replace function public.svc_issue_job_claim(p_job_id uuid, p_nonce_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.job_limits();
  v_job private.jobs;
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.state <> 'queued' or v_job.next_run_at > now() then
    return false;
  end if;
  if (select count(*) from private.jobs where state = 'running') >= (v_limits ->> 'max_running_global')::integer
     or (select count(*) from private.jobs where state = 'running' and user_id = v_job.user_id)
        >= (v_limits ->> 'max_running_per_member')::integer then
    return false;
  end if;
  update private.jobs
     set claim_nonce_hash = p_nonce_hash,
         claim_expires_at = now() + make_interval(secs => (private.upload_limits() ->> 'claim_seconds')::integer),
         last_dispatched_at = now(),
         updated_at = now()
   where id = p_job_id;
  return true;
end;
$$;

create or replace function public.svc_claim_job(p_job_id uuid, p_nonce_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.job_limits();
  v_job private.jobs;
  v_entry public.upload_entries;
  v_asset public.media_assets;
  v_source private.media_objects;
  v_input jsonb;
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.state <> 'queued' or v_job.claim_nonce_hash is null
     or v_job.claim_nonce_hash <> p_nonce_hash or v_job.claim_expires_at <= now() then
    perform private.raise_app_error('CLAIM_REJECTED', 403);
  end if;
  if v_job.depends_on is not null
     and not exists (select 1 from private.jobs d where d.id = v_job.depends_on and d.state = 'succeeded') then
    perform private.raise_app_error('CLAIM_REJECTED', 403, jsonb_build_object('reason', 'dependency'));
  end if;
  if v_job.attempt_count >= (v_limits ->> 'max_attempts')::integer then
    perform private.raise_app_error('CLAIM_REJECTED', 403, jsonb_build_object('reason', 'attempts'));
  end if;

  select * into v_entry from public.upload_entries where asset_id = v_job.target_id for update;
  select * into v_asset from public.media_assets where id = v_job.target_id for update;
  if v_entry.state not in ('uploaded', 'validating') or not private.is_active_member(v_job.user_id) then
    update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
     where id = p_job_id;
    perform private.raise_app_error('CLAIM_REJECTED', 403);
  end if;
  select * into v_source from private.media_objects
   where asset_id = v_asset.id and role = 'quarantine' and deleted_at is null;
  select input into v_input from private.job_payloads where job_id = p_job_id;

  update private.jobs
     set state = 'running', claim_nonce_hash = null, claim_expires_at = null,
         lease_generation = lease_generation + 1, attempt_count = attempt_count + 1,
         claimed_at = now(), heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => (v_limits ->> 'lease_seconds')::integer), updated_at = now()
   where id = p_job_id
  returning * into v_job;
  update public.upload_entries set state = 'validating', updated_at = now() where id = v_entry.id;
  update public.media_assets set state = 'validating', updated_at = now() where id = v_asset.id;

  return jsonb_build_object(
    'job_id', v_job.id,
    'kind', v_job.kind,
    'user_id', v_job.user_id,
    'asset_id', v_asset.id,
    'lease_generation', v_job.lease_generation,
    'lease_expires_at', v_job.lease_expires_at,
    'bucket', v_source.bucket,
    'source_key', v_source.object_key,
    'output_key', format('users/%s/assets/%s/%s/original-g%s.webp', v_job.user_id, v_asset.id, v_asset.media_revision,
      v_job.lease_generation),
    'input', jsonb_build_object(
      'declared_content_type', v_input ->> 'declared_content_type',
      'purpose', v_input ->> 'purpose',
      'rotation', (v_input ->> 'rotation')::integer,
      'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint,
      'max_pixels', (private.upload_limits() ->> 'max_pixels')::bigint,
      'max_edge', case when v_asset.purpose = 'care_label' then 2048 else 1024 end
    )
  );
end;
$$;

-- Renews the lease of the current attempt, within the stage deadline.
create function public.svc_heartbeat_job(p_job_id uuid, p_lease_generation integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.job_limits();
  v_job private.jobs;
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.state <> 'running' or v_job.lease_generation <> p_lease_generation
     or v_job.lease_expires_at <= now() then
    return jsonb_build_object('status', 'stale');
  end if;
  if v_job.claimed_at + make_interval(secs => (v_limits ->> 'stage_deadline_seconds')::integer) <= now() then
    return jsonb_build_object('status', 'deadline_exceeded');
  end if;
  update private.jobs
     set heartbeat_at = now(),
         lease_expires_at = least(now() + make_interval(secs => (v_limits ->> 'lease_seconds')::integer),
           v_job.claimed_at + make_interval(secs => (v_limits ->> 'stage_deadline_seconds')::integer)),
         updated_at = now()
   where id = p_job_id
  returning * into v_job;
  return jsonb_build_object('status', 'renewed', 'lease_expires_at', v_job.lease_expires_at);
end;
$$;

-- Moves a job to retry or terminal failure. Used for reported transient failures
-- and expired leases. Callers hold the job row lock.
create function private.retry_or_fail(p_job private.jobs, p_failure_code text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_limits jsonb := private.job_limits();
  v_delay integer;
begin
  if p_job.attempt_count >= (v_limits ->> 'max_attempts')::integer then
    update private.jobs set state = 'failed', failure_code = p_failure_code, claim_nonce_hash = null,
           lease_expires_at = null, updated_at = now(), completed_at = now()
     where id = p_job.id;
    update public.upload_entries set state = 'failed', failure_code = 'PROCESSING_FAILED', updated_at = now()
     where asset_id = p_job.target_id and state in ('uploaded', 'validating');
    update public.media_assets set state = 'uploaded', updated_at = now()
     where id = p_job.target_id and state = 'validating';
    return 'failed';
  end if;
  -- Exponential backoff with jitter: about 10 s, then 20 s.
  v_delay := (v_limits ->> 'backoff_base_seconds')::integer * power(2, greatest(p_job.attempt_count - 1, 0))::integer;
  update private.jobs
     set state = 'retry_wait', failure_code = p_failure_code, claim_nonce_hash = null, lease_expires_at = null,
         next_run_at = now() + make_interval(secs => v_delay + floor(random() * 5)::integer), updated_at = now()
   where id = p_job.id;
  update public.upload_entries set state = 'uploaded', updated_at = now()
   where asset_id = p_job.target_id and state = 'validating';
  update public.media_assets set state = 'uploaded', updated_at = now()
   where id = p_job.target_id and state = 'validating';
  return 'retry_wait';
end;
$$;
revoke all on function private.retry_or_fail(private.jobs, text) from public, anon, authenticated;

-- A worker reports a transient failure for its current attempt.
create function public.svc_fail_job_attempt(p_job_id uuid, p_lease_generation integer, p_failure_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.jobs;
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.state <> 'running' or v_job.lease_generation <> p_lease_generation then
    return jsonb_build_object('status', 'stale');
  end if;
  return jsonb_build_object('status', private.retry_or_fail(v_job, p_failure_code));
end;
$$;

-- Owner asks to process a failed upload again. Finite: two manual retries, each
-- with a fresh budget of three attempts.
create function public.svc_retry_upload_entry(p_user_id uuid, p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
  v_job private.jobs;
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_entry from public.upload_entries where id = p_entry_id and user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_entry.state <> 'failed' then
    perform private.raise_app_error('RETRY_NOT_AVAILABLE', 409, jsonb_build_object('state', v_entry.state));
  end if;
  select * into v_job from private.jobs where target_id = v_entry.asset_id and kind = 'validate_upload' for update;
  if v_job.manual_retries >= 2 then
    perform private.raise_app_error('RETRY_LIMIT_REACHED', 409);
  end if;
  update private.jobs
     set state = 'queued', attempt_count = 0, manual_retries = manual_retries + 1, failure_code = null,
         next_run_at = now(), completed_at = null, updated_at = now()
   where id = v_job.id;
  update public.upload_entries set state = 'uploaded', failure_code = null, updated_at = now() where id = p_entry_id;
  return jsonb_build_object('entry_id', p_entry_id, 'state', 'uploaded', 'job_id', v_job.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation for the minute scheduler
-- ---------------------------------------------------------------------------

-- Requeues due retries, recovers expired leases (the worker is presumed lost; its
-- late callbacks are fenced by the lease generation), and returns queued jobs that
-- need a (re)dispatch: never dispatched, or whose claim expired unused.
create function public.svc_reconcile_jobs(p_limit integer default 20)
returns table (job_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.jobs;
begin
  update private.jobs set state = 'queued', updated_at = now()
   where state = 'retry_wait' and next_run_at <= now();

  for v_job in
    select * from private.jobs where state = 'running' and lease_expires_at <= now()
     order by lease_expires_at limit p_limit for update skip locked
  loop
    perform private.retry_or_fail(v_job, 'LEASE_EXPIRED');
    -- A retry_wait job becomes runnable after its backoff.
  end loop;

  return query
  select j.id from private.jobs j
   where j.state = 'queued' and j.next_run_at <= now()
     and (j.claim_nonce_hash is null or j.claim_expires_at <= now())
   order by j.next_run_at, j.created_at
   limit p_limit;
end;
$$;

-- Operational view of stuck work: queued or running for longer than the job deadline.
create function public.svc_stuck_jobs()
returns table (job_id uuid, state text, age_seconds integer)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.state, extract(epoch from now() - j.created_at)::integer
    from private.jobs j
   where j.state in ('queued', 'running', 'retry_wait')
     and j.created_at <= now() - make_interval(secs => (private.job_limits() ->> 'job_deadline_seconds')::integer);
$$;

-- Owner-visible job status for an entry: state and safe failure code only.
create function public.svc_entry_job_status(p_user_id uuid, p_entry_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_active_member_id(p_user_id);
  select jsonb_build_object('entry_id', e.id, 'entry_state', e.state, 'job_state', j.state, 'attempts', j.attempt_count,
    'failure_code', coalesce(e.failure_code, j.failure_code), 'can_retry', e.state = 'failed' and j.manual_retries < 2)
    into v_result
    from public.upload_entries e left join private.jobs j on j.target_id = e.asset_id and j.kind = 'validate_upload'
   where e.id = p_entry_id and e.user_id = p_user_id;
  if v_result is null then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  return v_result;
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_heartbeat_job(uuid, integer)',
    'public.svc_fail_job_attempt(uuid, integer, text)',
    'public.svc_retry_upload_entry(uuid, uuid)',
    'public.svc_reconcile_jobs(integer)',
    'public.svc_stuck_jobs()',
    'public.svc_entry_job_status(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- Minute dispatch and reconciliation (ARCHITECTURE 9.1).
select cron.schedule('bowr-job-dispatch', '* * * * *', $$select private.invoke_maintenance('dispatch_jobs')$$);

-- A dispatch that could not reach the worker gives its claim back, so the next
-- scheduler run can dispatch again instead of waiting for the claim to expire.
create function public.svc_release_job_claim(p_job_id uuid, p_nonce_hash text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.jobs set claim_nonce_hash = null, claim_expires_at = null, updated_at = now()
   where id = p_job_id and state = 'queued' and claim_nonce_hash = p_nonce_hash;
$$;
revoke all on function public.svc_release_job_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.svc_release_job_claim(uuid, text) to service_role;

-- Completion also checks that the output key belongs to the job's own asset.
create or replace function public.svc_complete_validation(
  p_job_id uuid,
  p_lease_generation integer,
  p_outcome text,
  p_output jsonb,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.jobs;
  v_entry public.upload_entries;
  v_source private.media_objects;
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_job.state in ('succeeded', 'failed') and v_job.lease_generation = p_lease_generation then
    return jsonb_build_object('status', 'already_applied', 'state', v_job.state);
  end if;
  select * into v_entry from public.upload_entries where asset_id = v_job.target_id for update;
  if v_job.state <> 'running' or v_job.lease_generation <> p_lease_generation or v_entry.state <> 'validating' then
    return jsonb_build_object('status', 'stale');
  end if;
  select * into v_source from private.media_objects
   where asset_id = v_job.target_id and role = 'quarantine' and deleted_at is null;

  if p_outcome = 'ready' then
    -- Only a server-chosen key under this job's own asset can be published.
    if coalesce(p_output ->> 'object_key', '') not like format('users/%s/assets/%s/%%', v_job.user_id, v_job.target_id) then
      perform private.raise_app_error('OUTPUT_REJECTED', 422);
    end if;
    insert into private.media_objects (user_id, asset_id, bucket, object_key, role, byte_size, sha256)
    values (v_job.user_id, v_job.target_id, v_source.bucket, p_output ->> 'object_key', 'original',
      (p_output ->> 'byte_size')::bigint, p_output ->> 'sha256');
    update public.media_assets
       set state = 'ready', retention = 'retained', expires_at = null,
           width = (p_output ->> 'width')::integer, height = (p_output ->> 'height')::integer,
           content_type = 'image/webp', byte_size = (p_output ->> 'byte_size')::bigint, sha256 = p_output ->> 'sha256',
           updated_at = now()
     where id = v_job.target_id;
    update public.upload_entries set state = 'ready', updated_at = now() where id = v_entry.id;
    update private.jobs set state = 'succeeded', updated_at = now(), completed_at = now() where id = p_job_id;
  elsif p_outcome = 'rejected' then
    update public.media_assets set state = 'rejected', updated_at = now() where id = v_job.target_id;
    update public.upload_entries set state = 'rejected', failure_code = p_failure_code, updated_at = now() where id = v_entry.id;
    update private.jobs set state = 'failed', failure_code = p_failure_code, updated_at = now(), completed_at = now()
     where id = p_job_id;
  else
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'outcome'));
  end if;

  -- Raw upload bytes are deleted now and rechecked once the upload URL has expired.
  perform private.enqueue_object_deletion(v_job.user_id, v_source.bucket, v_source.object_key, 'quarantine_consumed', now());
  perform private.enqueue_object_deletion(v_job.user_id, v_source.bucket, v_source.object_key, 'quarantine_recheck',
    v_entry.upload_expires_at + interval '1 minute');
  return jsonb_build_object('status', 'applied', 'state', case when p_outcome = 'ready' then 'succeeded' else 'failed' end);
end;
$$;

