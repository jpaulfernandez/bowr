-- P0.03: upload and retrieve a private validated photo.
-- Clients supply file descriptors and asset IDs, never object keys. Uploaded bytes
-- land under a writable quarantine key; the worker writes a validated derivative
-- under a server-controlled key, and only that object can be signed for viewing.

-- ---------------------------------------------------------------------------
-- Member-visible records (read through RLS; writes through service functions)
-- ---------------------------------------------------------------------------
create table public.upload_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null default 'gather' check (source in ('gather')),
  entry_count integer not null check (entry_count between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);
create index upload_batches_owner_created on public.upload_batches (user_id, created_at desc, id);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null check (purpose in ('gather_original', 'care_label')),
  state text not null default 'awaiting_upload'
    check (state in ('awaiting_upload', 'uploaded', 'validating', 'ready', 'rejected', 'deletion_pending', 'deleted')),
  retention text not null default 'temporary' check (retention in ('temporary', 'retained')),
  media_revision integer not null default 1 check (media_revision >= 1),
  width integer check (width > 0),
  height integer check (height > 0),
  content_type text check (content_type in ('image/webp')),
  byte_size bigint check (byte_size > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Temporary assets cannot be signed past this instant.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, id),
  constraint media_ready_has_metadata check (
    state <> 'ready' or (width is not null and height is not null and content_type is not null and byte_size is not null and sha256 is not null)
  )
);

create table public.upload_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  batch_id uuid not null,
  client_file_id uuid not null,
  purpose text not null check (purpose in ('garment')),
  rotation smallint not null default 0 check (rotation in (0, 90, 180, 270)),
  declared_content_type text not null
    check (declared_content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')),
  declared_byte_size bigint not null check (declared_byte_size > 0),
  asset_id uuid not null,
  state text not null default 'awaiting_upload'
    check (state in ('awaiting_upload', 'uploaded', 'validating', 'ready', 'rejected', 'canceled')),
  failure_code text check (failure_code ~ '^[A-Z_]{3,40}$'),
  upload_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, batch_id, client_file_id),
  unique (asset_id),
  foreign key (user_id, batch_id) references public.upload_batches (user_id, id) on delete cascade,
  foreign key (user_id, asset_id) references public.media_assets (user_id, id) on delete cascade,
  constraint entry_failure_code check ((state = 'rejected') = (failure_code is not null))
);
create index upload_entries_batch on public.upload_entries (user_id, batch_id, created_at);

do $$
declare
  v_table text;
begin
  foreach v_table in array array['upload_batches', 'upload_entries', 'media_assets'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from anon, authenticated', v_table);
    execute format('grant select on public.%I to authenticated', v_table);
    execute format($p$create policy %I on public.%I for select to authenticated
      using (user_id = (select auth.uid()) and (select private.is_active_member((select auth.uid()))))$p$,
      v_table || '_read_own', v_table);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Private records: object keys, job identity and deletion tasks
-- ---------------------------------------------------------------------------
create table private.media_objects (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  asset_id uuid references public.media_assets (id) on delete set null,
  bucket text not null,
  object_key text not null unique check (char_length(object_key) between 10 and 300),
  role text not null check (role in ('quarantine', 'original')),
  byte_size bigint,
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index media_objects_asset on private.media_objects (asset_id, role) where deleted_at is null;
revoke all on private.media_objects from public, anon, authenticated;

-- Minimal persisted job identity for validation; P0.04 completes leases,
-- heartbeats, retries and reconciliation.
create table private.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('validate_upload')),
  target_id uuid not null,
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  dedupe_key text not null unique,
  claim_nonce_hash text check (claim_nonce_hash ~ '^[0-9a-f]{64}$'),
  claim_expires_at timestamptz,
  lease_generation integer not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  failure_code text check (failure_code ~ '^[A-Z_]{3,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index jobs_queued on private.jobs (created_at) where state = 'queued';
revoke all on private.jobs from public, anon, authenticated;

create table private.deletion_tasks (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  bucket text not null,
  object_key text not null,
  reason text not null check (reason in ('quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload')),
  state text not null default 'pending' check (state in ('pending', 'done')),
  attempts integer not null default 0,
  not_before timestamptz not null default now(),
  last_error text check (last_error is null or char_length(last_error) <= 80),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index deletion_tasks_due on private.deletion_tasks (not_before) where state = 'pending';
revoke all on private.deletion_tasks from public, anon, authenticated;

create function private.require_active_member_id(p_user_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_user_id is null or not private.is_active_member(p_user_id) then
    perform private.raise_app_error('MEMBERSHIP_INACTIVE', 403);
  end if;
end;
$$;
revoke all on function private.require_active_member_id(uuid) from public, anon, authenticated;

create function private.upload_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'max_bytes', 20 * 1024 * 1024,
    'max_pixels', 40000000,
    'max_files_per_batch', 20,
    'concurrent_uploads', 3,
    'upload_url_seconds', 600,
    'view_url_seconds', 300,
    'claim_seconds', 300,
    'lease_seconds', 120,
    'temporary_asset_hours', 4
  );
$$;
revoke all on function private.upload_limits() from public, anon, authenticated;

create function private.enqueue_object_deletion(p_user_id uuid, p_bucket text, p_key text, p_reason text, p_not_before timestamptz)
returns void
language sql
set search_path = ''
as $$
  insert into private.deletion_tasks (user_id, bucket, object_key, reason, not_before)
  values (p_user_id, p_bucket, p_key, p_reason, p_not_before);
$$;
revoke all on function private.enqueue_object_deletion(uuid, text, text, text, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Upload commands (Edge API with a verified caller)
-- ---------------------------------------------------------------------------

-- Creates a batch of upload slots. p_files: [{client_file_id, purpose, content_type,
-- byte_size, rotation?}]. Returns entries with their quarantine keys for signing;
-- the Edge API never returns keys to the client. Idempotent per request identity.
create function public.svc_create_upload_batch(p_user_id uuid, p_request_id uuid, p_bucket text, p_files jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.upload_limits();
  v_existing jsonb;
  v_batch_id uuid;
  v_file jsonb;
  v_asset_id uuid;
  v_entry_id uuid;
  v_key text;
  v_entries jsonb := '[]'::jsonb;
  v_expires timestamptz := now() + make_interval(secs => (v_limits ->> 'upload_url_seconds')::integer);
begin
  perform private.require_active_member_id(p_user_id);

  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) < 1
     or jsonb_array_length(p_files) > (v_limits ->> 'max_files_per_batch')::integer then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'files'));
  end if;
  if (select count(distinct f ->> 'client_file_id') from jsonb_array_elements(p_files) f) <> jsonb_array_length(p_files) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'duplicate_client_file_id'));
  end if;

  v_existing := private.claim_request(p_user_id, 'create_upload_batch', p_request_id, jsonb_build_object('files', p_files));
  if v_existing is not null then
    -- Replay: return the same batch; the Edge API re-signs slots still awaiting upload.
    return (
      select jsonb_build_object('batch_id', b.id, 'replayed', true, 'entries', coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', e.id, 'client_file_id', e.client_file_id, 'asset_id', e.asset_id, 'state', e.state,
        'content_type', e.declared_content_type, 'upload_expires_at', e.upload_expires_at,
        'object_key', case when e.state = 'awaiting_upload' then o.object_key end
      ) order by e.created_at), '[]'::jsonb))
      from public.upload_batches b
      join public.upload_entries e on e.batch_id = b.id and e.user_id = b.user_id
      left join private.media_objects o on o.asset_id = e.asset_id and o.role = 'quarantine' and o.deleted_at is null
      where b.id = (v_existing ->> 'batch_id')::uuid and b.user_id = p_user_id
      group by b.id
    );
  end if;

  insert into public.upload_batches (user_id, entry_count) values (p_user_id, jsonb_array_length(p_files))
  returning id into v_batch_id;

  for v_file in select * from jsonb_array_elements(p_files) loop
    if coalesce(v_file ->> 'purpose', '') <> 'garment'
       or coalesce(v_file ->> 'content_type', '') not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
       or jsonb_typeof(v_file -> 'byte_size') <> 'number'
       or (v_file ->> 'client_file_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce((v_file ->> 'rotation')::integer, 0) not in (0, 90, 180, 270) then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'files', 'client_file_id', v_file ->> 'client_file_id'));
    end if;
    if (v_file ->> 'byte_size')::bigint < 1 or (v_file ->> 'byte_size')::bigint > (v_limits ->> 'max_bytes')::bigint then
      perform private.raise_app_error('FILE_TOO_LARGE', 413, jsonb_build_object('client_file_id', v_file ->> 'client_file_id',
        'max_bytes', (v_limits ->> 'max_bytes')::bigint));
    end if;

    insert into public.media_assets (user_id, purpose, expires_at)
    values (p_user_id, 'gather_original', now() + make_interval(hours => (v_limits ->> 'temporary_asset_hours')::integer))
    returning id into v_asset_id;

    insert into public.upload_entries (user_id, batch_id, client_file_id, purpose, rotation, declared_content_type,
      declared_byte_size, asset_id, upload_expires_at)
    values (p_user_id, v_batch_id, (v_file ->> 'client_file_id')::uuid, 'garment', coalesce((v_file ->> 'rotation')::smallint, 0),
      v_file ->> 'content_type', (v_file ->> 'byte_size')::bigint, v_asset_id, v_expires)
    returning id into v_entry_id;

    v_key := format('uploads/%s/%s/%s', p_user_id, v_entry_id, encode(extensions.gen_random_bytes(16), 'hex'));
    insert into private.media_objects (user_id, asset_id, bucket, object_key, role)
    values (p_user_id, v_asset_id, p_bucket, v_key, 'quarantine');

    v_entries := v_entries || jsonb_build_object('entry_id', v_entry_id, 'client_file_id', v_file ->> 'client_file_id',
      'asset_id', v_asset_id, 'state', 'awaiting_upload', 'content_type', v_file ->> 'content_type',
      'upload_expires_at', v_expires, 'object_key', v_key);
  end loop;

  perform private.complete_request(p_user_id, 'create_upload_batch', p_request_id, jsonb_build_object('batch_id', v_batch_id));
  return jsonb_build_object('batch_id', v_batch_id, 'replayed', false, 'entries', v_entries);
end;
$$;

-- Issues a fresh upload window for the same slot (same key) while awaiting upload.
create function public.svc_renew_upload_entry(p_user_id uuid, p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
  v_key text;
  v_expires timestamptz := now() + make_interval(secs => (private.upload_limits() ->> 'upload_url_seconds')::integer);
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_entry from public.upload_entries where id = p_entry_id and user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_entry.state <> 'awaiting_upload' then
    perform private.raise_app_error('UPLOAD_NOT_RENEWABLE', 409, jsonb_build_object('state', v_entry.state));
  end if;
  update public.upload_entries set upload_expires_at = v_expires, updated_at = now() where id = p_entry_id;
  select object_key into v_key from private.media_objects
   where asset_id = v_entry.asset_id and role = 'quarantine' and deleted_at is null;
  return jsonb_build_object('entry_id', p_entry_id, 'object_key', v_key, 'content_type', v_entry.declared_content_type,
    'upload_expires_at', v_expires);
end;
$$;

-- Returns the entry's quarantine object for the Edge API to inspect before completing.
create function public.svc_upload_entry_object(p_user_id uuid, p_entry_id uuid)
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
  select jsonb_build_object('entry_id', e.id, 'state', e.state, 'bucket', o.bucket, 'object_key', o.object_key)
    into v_result
    from public.upload_entries e
    left join private.media_objects o on o.asset_id = e.asset_id and o.role = 'quarantine' and o.deleted_at is null
   where e.id = p_entry_id and e.user_id = p_user_id;
  if v_result is null then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  return v_result;
end;
$$;

-- Marks an uploaded entry and commits its validation job in the same transaction.
-- Repeating the call returns the same entry and job.
create function public.svc_complete_upload_entry(p_user_id uuid, p_request_id uuid, p_entry_id uuid, p_object_size bigint)
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
      insert into private.jobs (user_id, kind, target_id, dedupe_key)
      values (p_user_id, 'validate_upload', v_entry.asset_id, 'validate_upload:' || v_entry.asset_id)
      on conflict (dedupe_key) do nothing;
    end if;
  end if;

  select id into v_job_id from private.jobs where dedupe_key = 'validate_upload:' || v_entry.asset_id;
  select * into v_entry from public.upload_entries where id = p_entry_id;
  return private.complete_request(p_user_id, 'complete_upload_entry', p_request_id, jsonb_build_object(
    'entry_id', v_entry.id, 'asset_id', v_entry.asset_id, 'state', v_entry.state,
    'failure_code', v_entry.failure_code, 'job_id', v_job_id));
end;
$$;

-- Cancels an entry that has not become ready. Access is refused immediately; the
-- quarantine key is deleted now and rechecked after its upload URL expires.
create function public.svc_cancel_upload_entry(p_user_id uuid, p_entry_id uuid)
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

  update public.upload_entries set state = 'canceled', updated_at = now() where id = p_entry_id;
  update public.media_assets set state = 'deletion_pending', updated_at = now() where id = v_entry.asset_id;
  update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
   where dedupe_key = 'validate_upload:' || v_entry.asset_id and state in ('queued', 'running');

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

-- Authorizes signed viewing. Requests for absent, foreign, unready or unknown
-- variants all come back as not_found. Temporary assets are clipped to expiry.
create function public.svc_authorize_media_access(p_user_id uuid, p_requests jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.upload_limits();
begin
  perform private.require_active_member_id(p_user_id);
  if jsonb_typeof(p_requests) <> 'array' or jsonb_array_length(p_requests) > 50 then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'requests'));
  end if;
  return coalesce((
    select jsonb_agg(
      case when o.object_key is null then
        jsonb_build_object('asset_id', r ->> 'asset_id', 'variant', r ->> 'variant', 'status', 'not_found')
      else
        jsonb_build_object('asset_id', a.id, 'variant', r ->> 'variant', 'status', 'ok', 'bucket', o.bucket,
          'object_key', o.object_key, 'content_type', a.content_type, 'width', a.width, 'height', a.height,
          'expires_at', least(now() + make_interval(secs => (v_limits ->> 'view_url_seconds')::integer),
            case when a.retention = 'temporary' then a.expires_at end))
      end order by ord)
    from jsonb_array_elements(p_requests) with ordinality as req(r, ord)
    left join public.media_assets a
      on a.id::text = r ->> 'asset_id' and a.user_id = p_user_id and a.state = 'ready' and a.deleted_at is null
     and (a.retention = 'retained' or a.expires_at > now())
    left join private.media_objects o
      on o.asset_id = a.id and o.deleted_at is null and o.role = 'original' and r ->> 'variant' = 'original'
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker-facing job functions (internal Edge API only)
-- ---------------------------------------------------------------------------

-- Stores the hash of a single-use claim nonce for a queued job.
create function public.svc_issue_job_claim(p_job_id uuid, p_nonce_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.jobs
     set claim_nonce_hash = p_nonce_hash,
         claim_expires_at = now() + make_interval(secs => (private.upload_limits() ->> 'claim_seconds')::integer),
         updated_at = now()
   where id = p_job_id and state = 'queued';
  return found;
end;
$$;

-- Consumes a claim nonce and starts a lease. Returns the job's typed input and
-- the object keys the Edge API signs for this job only.
create function public.svc_claim_job(p_job_id uuid, p_nonce_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.upload_limits();
  v_job private.jobs;
  v_entry public.upload_entries;
  v_asset public.media_assets;
  v_source private.media_objects;
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.state <> 'queued' or v_job.claim_nonce_hash is null
     or v_job.claim_nonce_hash <> p_nonce_hash or v_job.claim_expires_at <= now() then
    perform private.raise_app_error('CLAIM_REJECTED', 403);
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

  update private.jobs
     set state = 'running', claim_nonce_hash = null, claim_expires_at = null,
         lease_generation = lease_generation + 1, attempt_count = attempt_count + 1,
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
      'declared_content_type', v_entry.declared_content_type,
      'purpose', v_entry.purpose,
      'rotation', v_entry.rotation,
      'max_bytes', (v_limits ->> 'max_bytes')::bigint,
      'max_pixels', (v_limits ->> 'max_pixels')::bigint,
      'max_edge', case when v_asset.purpose = 'care_label' then 2048 else 1024 end
    )
  );
end;
$$;

-- Applies a worker result only if the job and lease generation are still current
-- and the target was not canceled. A repeat is a no-op returning prior state.
create function public.svc_complete_validation(
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

-- Records a worker output that must not be attached (stale lease or canceled target).
create function public.svc_discard_job_output(p_job_id uuid, p_bucket text, p_object_key text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.deletion_tasks (user_id, bucket, object_key, reason)
  select j.user_id, p_bucket, p_object_key, 'stale_output' from private.jobs j where j.id = p_job_id;
$$;

-- Deletion tasks for the maintenance function: due tasks are claimed with a lock
-- and a short visibility delay, so a crashed run is retried later.
create function public.svc_claim_deletion_tasks(p_limit integer default 50)
returns table (id bigint, bucket text, object_key text)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select t.id from private.deletion_tasks t
     where t.state = 'pending' and t.not_before <= now()
     order by t.not_before
     limit p_limit
     for update skip locked
  )
  update private.deletion_tasks t
     set attempts = t.attempts + 1, not_before = now() + interval '2 minutes'
    from due where t.id = due.id
  returning t.id, t.bucket, t.object_key;
$$;

-- Completes a task after the object's absence was confirmed.
create function public.svc_complete_deletion_task(p_task_id bigint, p_confirmed_absent boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task private.deletion_tasks;
begin
  select * into v_task from private.deletion_tasks where id = p_task_id for update;
  if not found or v_task.state = 'done' then
    return;
  end if;
  if p_confirmed_absent then
    update private.deletion_tasks set state = 'done', completed_at = now(), last_error = null where id = p_task_id;
    -- Only mark the object row deleted when no later recheck is pending for it.
    if not exists (select 1 from private.deletion_tasks
                    where object_key = v_task.object_key and state = 'pending' and id <> p_task_id) then
      update private.media_objects set deleted_at = coalesce(deleted_at, now()) where object_key = v_task.object_key;
    end if;
    update public.media_assets a set state = 'deleted', deleted_at = coalesce(a.deleted_at, now()), updated_at = now()
      from private.media_objects o
     where o.object_key = v_task.object_key and a.id = o.asset_id and a.state = 'deletion_pending'
       and not exists (select 1 from private.media_objects o2 where o2.asset_id = a.id and o2.deleted_at is null);
  else
    update private.deletion_tasks
       set last_error = left(coalesce(p_error, 'unknown'), 80),
           not_before = now() + least(interval '1 hour', make_interval(mins => power(2, least(v_task.attempts, 6))::integer))
     where id = p_task_id;
  end if;
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_create_upload_batch(uuid, uuid, text, jsonb)',
    'public.svc_renew_upload_entry(uuid, uuid)',
    'public.svc_upload_entry_object(uuid, uuid)',
    'public.svc_complete_upload_entry(uuid, uuid, uuid, bigint)',
    'public.svc_cancel_upload_entry(uuid, uuid)',
    'public.svc_authorize_media_access(uuid, jsonb)',
    'public.svc_issue_job_claim(uuid, text)',
    'public.svc_claim_job(uuid, text)',
    'public.svc_complete_validation(uuid, integer, text, jsonb, text)',
    'public.svc_discard_job_output(uuid, text, text)',
    'public.svc_claim_deletion_tasks(integer)',
    'public.svc_complete_deletion_task(bigint, boolean, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- Temporary media cleanup runs every five minutes (ARCHITECTURE 12.1).
select cron.schedule('bowr-media-deletion', '*/5 * * * *', $$select private.invoke_maintenance('media_deletion')$$);

-- ---------------------------------------------------------------------------
-- Bootstrap: active members receive the enforced upload limits.
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
  v_limits jsonb := private.upload_limits();
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
      end,
      'upload_limits', null
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
    'pending_expires_at', null,
    'upload_limits', jsonb_build_object(
      'max_bytes', v_limits -> 'max_bytes',
      'max_pixels', v_limits -> 'max_pixels',
      'max_files_per_batch', v_limits -> 'max_files_per_batch',
      'concurrent_uploads', v_limits -> 'concurrent_uploads'
    )
  );
end;
$$;
