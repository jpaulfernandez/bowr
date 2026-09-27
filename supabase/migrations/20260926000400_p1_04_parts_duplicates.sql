-- P1.04: split accessories and resolve probable duplicates.
-- A grouped photo creates no piece until the member keeps it as one set or
-- confirms selected parts; each confirmed part gets its own cropped original and
-- the shared source stays temporary. An exact reupload is held for a decision
-- (Use existing / Add another / Decide later) before a second piece exists; a
-- near match flags the new piece. Nothing is ever merged automatically, and
-- comparisons stay inside one member's wardrobe.

-- ---------------------------------------------------------------------------
-- Entries, items, media
-- ---------------------------------------------------------------------------
alter table public.upload_entries drop constraint upload_entries_purpose_check;
alter table public.upload_entries
  add constraint upload_entries_purpose_check check (purpose in ('garment', 'care_label', 'grouped')),
  -- Suggested rectangles from validation; the member confirms, edits or ignores them.
  add column proposed_parts jsonb
    check (proposed_parts is null or (jsonb_typeof(proposed_parts) = 'array' and jsonb_array_length(proposed_parts) <= 20)),
  -- The confirmed choice: {mode: keep_one|split, parts: [{part_id, box}]}.
  add column split jsonb check (split is null or (jsonb_typeof(split) = 'object' and octet_length(split::text) <= 8192)),
  add column split_confirmed_at timestamptz,
  add constraint upload_entries_split_grouped
    check (purpose = 'grouped' or (proposed_parts is null and split is null and split_confirmed_at is null));

-- One item per ordinary entry (or kept set); one per confirmed part of a group.
alter table public.items add column source_part_id uuid;
drop index public.items_source_entry;
create unique index items_source_entry on public.items (source_entry_id)
  where source_entry_id is not null and source_part_id is null;
create unique index items_source_part on public.items (source_entry_id, source_part_id)
  where source_part_id is not null;

alter table public.media_assets drop constraint media_assets_purpose_check;
alter table public.media_assets add constraint media_assets_purpose_check
  check (purpose in ('gather_original', 'care_label', 'item_original', 'item_cutout', 'item_thumbnail', 'item_mask'));
-- Exact-reupload lookups are always scoped to one owner.
create index media_assets_owner_sha on public.media_assets (user_id, sha256) where sha256 is not null;

alter table private.deletion_tasks drop constraint deletion_tasks_reason_check;
alter table private.deletion_tasks add constraint deletion_tasks_reason_check check (reason in (
  'quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload',
  'account_deleted', 'upload_expired', 'orphan', 'superseded', 'label_removed', 'group_source_released',
  'duplicate_discarded'));

alter table private.jobs drop constraint jobs_stage_check;
alter table private.jobs add constraint jobs_stage_check
  check (stage in ('validate', 'crop', 'cutout', 'colors', 'embedding', 'tags', 'label'));
alter table public.item_stages drop constraint item_stages_stage_check;
alter table public.item_stages add constraint item_stages_stage_check
  check (stage in ('crop', 'cutout', 'colors', 'embedding', 'tags', 'label'));

-- ---------------------------------------------------------------------------
-- Duplicate reviews. The composite foreign keys keep every compared piece in
-- the reviewing member's own wardrobe.
-- ---------------------------------------------------------------------------
create table public.duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- An exact reupload is held before its piece exists (entry); a near match
  -- flags a piece that already exists (item).
  entry_id uuid,
  item_id uuid,
  existing_item_id uuid,
  basis text not null check (basis in ('hash', 'vector')),
  similarity real check (similarity between -1 and 1),
  state text not null default 'pending' check (state in ('pending', 'use_existing', 'add_another')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint duplicate_reviews_one_subject check ((entry_id is null) <> (item_id is null)),
  constraint duplicate_reviews_basis_subject check ((basis = 'hash') = (entry_id is not null)),
  foreign key (user_id, entry_id) references public.upload_entries (user_id, id) on delete cascade,
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade,
  foreign key (user_id, existing_item_id) references public.items (user_id, id) on delete set null (existing_item_id)
);
create unique index duplicate_reviews_entry on public.duplicate_reviews (entry_id) where entry_id is not null;
create unique index duplicate_reviews_item on public.duplicate_reviews (item_id) where item_id is not null;
create index duplicate_reviews_owner_pending on public.duplicate_reviews (user_id) where state = 'pending';
alter table public.duplicate_reviews enable row level security;
revoke all on public.duplicate_reviews from anon, authenticated;
grant select on public.duplicate_reviews to authenticated;
create policy duplicate_reviews_read_own on public.duplicate_reviews for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_active_member((select auth.uid()))));

-- ---------------------------------------------------------------------------
-- Batches accept grouped photos. Unchanged from P1.03 except the purposes.
-- ---------------------------------------------------------------------------
create or replace function public.svc_create_upload_batch(p_user_id uuid, p_request_id uuid, p_bucket text, p_files jsonb)
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
  v_purpose text;
  v_target uuid;
begin
  perform private.require_active_member_id(p_user_id);

  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) < 1
     or jsonb_array_length(p_files) > (v_limits ->> 'max_files_per_batch')::integer then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'files',
      'max_files_per_batch', (v_limits ->> 'max_files_per_batch')::integer));
  end if;
  if (select count(distinct f ->> 'client_file_id') from jsonb_array_elements(p_files) f) <> jsonb_array_length(p_files) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'duplicate_client_file_id'));
  end if;

  v_existing := private.claim_request(p_user_id, 'create_upload_batch', p_request_id, jsonb_build_object('files', p_files));
  if v_existing is not null then
    return (
      select jsonb_build_object('batch_id', b.id, 'replayed', true, 'entries', coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', e.id, 'client_file_id', e.client_file_id, 'asset_id', e.asset_id, 'state', e.state,
        'content_type', e.declared_content_type, 'upload_expires_at', e.upload_expires_at,
        'object_key', case when e.state = 'awaiting_upload' then o.object_key end
      ) order by e.created_at, e.id), '[]'::jsonb))
      from public.upload_batches b
      join public.upload_entries e on e.batch_id = b.id and e.user_id = b.user_id
      left join private.media_objects o on o.asset_id = e.asset_id and o.role = 'quarantine' and o.deleted_at is null
      where b.id = (v_existing ->> 'batch_id')::uuid and b.user_id = p_user_id
      group by b.id
    );
  end if;

  -- Label targets are checked before anything is created. A label belongs to one
  -- garment photo, never to a grouped photo.
  for v_file in select * from jsonb_array_elements(p_files) loop
    v_purpose := coalesce(v_file ->> 'purpose', '');
    if v_purpose = 'care_label' then
      if (v_file ? 'label_for') = (v_file ? 'target_item_id') then
        perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'label_target',
          'client_file_id', v_file ->> 'client_file_id'));
      end if;
      if v_file ? 'label_for' and not exists (
        select 1 from jsonb_array_elements(p_files) g
         where g ->> 'client_file_id' = v_file ->> 'label_for' and coalesce(g ->> 'purpose', '') = 'garment') then
        perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'label_target',
          'client_file_id', v_file ->> 'client_file_id'));
      end if;
      if v_file ? 'target_item_id' and not exists (
        select 1 from public.items i
         where i.id::text = v_file ->> 'target_item_id' and i.user_id = p_user_id and i.lifecycle <> 'deleted') then
        perform private.raise_app_error('NOT_FOUND', 404, jsonb_build_object('field', 'target_item_id'));
      end if;
    elsif v_file ? 'label_for' or v_file ? 'target_item_id' then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'label_target',
        'client_file_id', v_file ->> 'client_file_id'));
    end if;
  end loop;

  insert into public.upload_batches (user_id, entry_count) values (p_user_id, jsonb_array_length(p_files))
  returning id into v_batch_id;

  for v_file in select * from jsonb_array_elements(p_files) loop
    v_purpose := coalesce(v_file ->> 'purpose', '');
    if v_purpose not in ('garment', 'care_label', 'grouped')
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
    v_target := case when v_file ? 'target_item_id' then (v_file ->> 'target_item_id')::uuid end;

    insert into public.media_assets (user_id, purpose, expires_at)
    values (p_user_id, case when v_purpose = 'care_label' then 'care_label' else 'gather_original' end,
      now() + make_interval(hours => (v_limits ->> 'temporary_asset_hours')::integer))
    returning id into v_asset_id;

    insert into public.upload_entries (user_id, batch_id, client_file_id, purpose, rotation, declared_content_type,
      declared_byte_size, asset_id, upload_expires_at, target_item_id, created_at)
    values (p_user_id, v_batch_id, (v_file ->> 'client_file_id')::uuid, v_purpose, coalesce((v_file ->> 'rotation')::smallint, 0),
      v_file ->> 'content_type', (v_file ->> 'byte_size')::bigint, v_asset_id, v_expires, v_target,
      -- Receipts list photos in the order chosen; now() is shared by the whole batch.
      clock_timestamp())
    returning id into v_entry_id;

    v_key := format('uploads/%s/%s/%s', p_user_id, v_entry_id, encode(extensions.gen_random_bytes(16), 'hex'));
    insert into private.media_objects (user_id, asset_id, bucket, object_key, role)
    values (p_user_id, v_asset_id, p_bucket, v_key, 'quarantine');

    v_entries := v_entries || jsonb_build_object('entry_id', v_entry_id, 'client_file_id', v_file ->> 'client_file_id',
      'asset_id', v_asset_id, 'state', 'awaiting_upload', 'content_type', v_file ->> 'content_type',
      'upload_expires_at', v_expires, 'object_key', v_key);
  end loop;

  update public.upload_entries l
     set parent_entry_id = g.id
    from jsonb_array_elements(p_files) f, public.upload_entries g
   where l.batch_id = v_batch_id and g.batch_id = v_batch_id
     and l.client_file_id = (f ->> 'client_file_id')::uuid and f ? 'label_for'
     and g.client_file_id = (f ->> 'label_for')::uuid;

  perform private.complete_request(p_user_id, 'create_upload_batch', p_request_id, jsonb_build_object('batch_id', v_batch_id));
  return jsonb_build_object('batch_id', v_batch_id, 'replayed', false, 'entries', v_entries);
end;
$$;

-- Grouped photos keep the larger 2048 px edge so small pieces stay sharp when
-- cropped. Otherwise unchanged from P1.01.
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

  if v_job.kind = 'item_stage' then
    return private.claim_item_stage(v_job);
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
      'purpose', v_entry.purpose,
      'rotation', (v_input ->> 'rotation')::integer,
      'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint,
      'max_pixels', (private.upload_limits() ->> 'max_pixels')::bigint,
      'max_edge', case when v_asset.purpose = 'care_label' or v_entry.purpose = 'grouped' then 2048 else 1024 end
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Part boxes: normalized, inside the oriented original, and not tiny.
-- ---------------------------------------------------------------------------
create function private.valid_part_box(p_box jsonb, p_width integer, p_height integer)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_x numeric;
  v_y numeric;
  v_w numeric;
  v_h numeric;
begin
  if jsonb_typeof(p_box) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_box) k) is distinct from array['h', 'w', 'x', 'y']
     or exists (select 1 from jsonb_each(p_box) e where jsonb_typeof(e.value) <> 'number') then
    return false;
  end if;
  v_x := (p_box ->> 'x')::numeric;
  v_y := (p_box ->> 'y')::numeric;
  v_w := (p_box ->> 'w')::numeric;
  v_h := (p_box ->> 'h')::numeric;
  return v_x >= 0 and v_y >= 0 and v_w > 0 and v_h > 0
     and v_x + v_w <= 1.000001 and v_y + v_h <= 1.000001
     -- At least 32 px on each side of the sanitized original.
     and v_w * p_width >= 32 and v_h * p_height >= 32;
end;
$$;
revoke all on function private.valid_part_box(jsonb, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Duplicates
-- ---------------------------------------------------------------------------

-- The member's own active or archived piece whose current original has the same
-- sanitized bytes as this entry's validated original.
create function private.hash_duplicate_of(p_entry public.upload_entries)
returns uuid
language sql
stable
set search_path = ''
as $$
  select i.id
    from public.media_assets mine
    join public.media_assets a on a.user_id = mine.user_id and a.sha256 = mine.sha256 and a.id <> mine.id
    join public.item_assets ia on ia.asset_id = a.id and ia.role = 'original' and ia.detached_at is null
    join public.items i on i.id = ia.item_id and i.user_id = mine.user_id and i.lifecycle <> 'deleted'
   where mine.id = p_entry.asset_id and mine.user_id = p_entry.user_id and mine.sha256 is not null
   order by i.created_at, i.id
   limit 1;
$$;
revoke all on function private.hash_duplicate_of(public.upload_entries) from public, anon, authenticated;

-- A validated garment becomes one item unless it repeats a piece the member
-- already has; then it waits for their decision and no item exists yet.
create or replace function private.create_gather_item(p_entry public.upload_entries)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
  v_label public.upload_entries;
  v_review public.duplicate_reviews;
  v_existing uuid;
begin
  select * into v_item from public.items where source_entry_id = p_entry.id and source_part_id is null;
  if found then
    return v_item.id;
  end if;
  select * into v_review from public.duplicate_reviews where entry_id = p_entry.id;
  if v_review.id is not null and v_review.state <> 'add_another' then
    return null;
  end if;
  if v_review.id is null then
    v_existing := private.hash_duplicate_of(p_entry);
    if v_existing is not null then
      insert into public.duplicate_reviews (user_id, entry_id, existing_item_id, basis, similarity)
      values (p_entry.user_id, p_entry.id, v_existing, 'hash', 1)
      on conflict (entry_id) where entry_id is not null do nothing;
      return null;
    end if;
  end if;

  insert into public.items (user_id, source, source_entry_id)
  values (p_entry.user_id, 'gather', p_entry.id)
  on conflict (source_entry_id) where source_entry_id is not null and source_part_id is null do nothing
  returning * into v_item;
  if v_item.id is null then
    return (select id from public.items where source_entry_id = p_entry.id and source_part_id is null);
  end if;
  insert into public.item_assets (user_id, item_id, asset_id, role, media_revision)
  values (p_entry.user_id, v_item.id, p_entry.asset_id, 'original', v_item.media_revision);
  perform private.enqueue_item_stage(v_item, 'cutout', (private.cutout_models())[1]);
  perform private.enqueue_item_stage(v_item, 'tags', private.tags_task_version());
  for v_label in select * from public.upload_entries
                  where parent_entry_id = p_entry.id and purpose = 'care_label' and state = 'ready' loop
    perform private.attach_label(v_label, v_item);
  end loop;
  return v_item.id;
end;
$$;

-- A label follows its garment: to the new piece, or to the existing piece the
-- member chose instead ("Use existing").
create or replace function private.label_item(p_entry public.upload_entries)
returns public.items
language sql
stable
set search_path = ''
as $$
  select i.* from public.items i
   where i.lifecycle <> 'deleted' and i.user_id = p_entry.user_id
     and (i.id = p_entry.target_item_id
          or (p_entry.parent_entry_id is not null and i.source_entry_id = p_entry.parent_entry_id
              and i.source_part_id is null)
          or i.id = (select r.existing_item_id from public.duplicate_reviews r
                      where r.entry_id = p_entry.parent_entry_id and r.state = 'use_existing'))
   limit 1;
$$;

-- A label waiting on its garment's duplicate decision is not expired meanwhile.
create or replace function public.svc_expire_unattached_labels(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
  v_object private.media_objects;
  v_count integer := 0;
begin
  for v_entry in
    select e.* from public.upload_entries e join public.media_assets a on a.id = e.asset_id
     where e.purpose = 'care_label' and e.state = 'ready' and a.retention = 'temporary' and a.expires_at <= now()
       and a.state = 'ready'
       and not exists (select 1 from public.item_assets ia where ia.asset_id = e.asset_id)
       and not exists (select 1 from public.duplicate_reviews r where r.entry_id = e.parent_entry_id and r.state = 'pending')
     limit p_limit for update of e skip locked
  loop
    update public.upload_entries set state = 'canceled', updated_at = now() where id = v_entry.id;
    update public.media_assets set state = 'deletion_pending', updated_at = now() where id = v_entry.asset_id;
    for v_object in select * from private.media_objects where asset_id = v_entry.asset_id and deleted_at is null loop
      perform private.enqueue_object_deletion(v_entry.user_id, v_object.bucket, v_object.object_key, 'upload_expired', now());
    end loop;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Queues deletion of every object of an asset and marks it pending deletion.
create function private.delete_asset(p_asset_id uuid, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_object private.media_objects;
begin
  update public.media_assets set state = 'deletion_pending', updated_at = now()
   where id = p_asset_id and state not in ('deleted', 'deletion_pending');
  for v_object in select * from private.media_objects where asset_id = p_asset_id and deleted_at is null loop
    perform private.enqueue_object_deletion(v_object.user_id, v_object.bucket, v_object.object_key, p_reason, now());
  end loop;
end;
$$;
revoke all on function private.delete_asset(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grouped sources
-- ---------------------------------------------------------------------------

-- The shared source is deleted once every confirmed, surviving part has its own
-- original. A part still waiting (or failed) keeps it until its temporary window
-- ends, so a retry can still crop it.
create function private.release_group_source(p_entry_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
begin
  select * into v_entry from public.upload_entries where id = p_entry_id and purpose = 'grouped' for update;
  if not found or v_entry.split_confirmed_at is null then
    return;
  end if;
  if exists (select 1 from public.items i
              where i.source_entry_id = v_entry.id and i.lifecycle <> 'deleted'
                and not exists (select 1 from public.item_assets ia
                                 where ia.item_id = i.id and ia.role = 'original' and ia.detached_at is null)) then
    return;
  end if;
  perform private.delete_asset(v_entry.asset_id, 'group_source_released');
end;
$$;
revoke all on function private.release_group_source(uuid) from public, anon, authenticated;

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
  v_item public.items;
  v_width integer := (p_output ->> 'width')::integer;
  v_height integer := (p_output ->> 'height')::integer;
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'validate_upload' then
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
    if coalesce(p_output ->> 'object_key', '') not like format('users/%s/assets/%s/%%', v_job.user_id, v_job.target_id) then
      perform private.raise_app_error('OUTPUT_REJECTED', 422);
    end if;
    insert into private.media_objects (user_id, asset_id, bucket, object_key, role, byte_size, sha256)
    values (v_job.user_id, v_job.target_id, v_source.bucket, p_output ->> 'object_key', 'original',
      (p_output ->> 'byte_size')::bigint, p_output ->> 'sha256');
    -- A garment is retained now; a label once attached; a grouped source never
    -- (it stays temporary from now until its parts are confirmed and cropped).
    update public.media_assets
       set state = 'ready',
           retention = case when v_entry.purpose = 'garment' then 'retained' else retention end,
           expires_at = case when v_entry.purpose = 'garment' then null
                             when v_entry.purpose = 'grouped'
                               then now() + make_interval(hours => (private.upload_limits() ->> 'temporary_asset_hours')::integer)
                             else expires_at end,
           width = v_width, height = v_height,
           content_type = 'image/webp', byte_size = (p_output ->> 'byte_size')::bigint, sha256 = p_output ->> 'sha256',
           updated_at = now()
     where id = v_job.target_id;
    update public.upload_entries
       set state = 'ready', updated_at = now(),
           -- Only well-formed proposals are kept; they are suggestions, never pieces.
           proposed_parts = case when v_entry.purpose = 'grouped' then coalesce((
             select jsonb_agg(b order by o) from jsonb_array_elements(coalesce(p_output -> 'parts', '[]'::jsonb))
                    with ordinality as p(b, o)
              where o <= 20 and private.valid_part_box(b, v_width, v_height)), '[]'::jsonb) end
     where id = v_entry.id;
    update private.jobs set state = 'succeeded', updated_at = now(), completed_at = now() where id = p_job_id;
    select * into v_entry from public.upload_entries where id = v_entry.id;
    if v_entry.purpose = 'garment' then
      perform private.create_gather_item(v_entry);
    elsif v_entry.purpose = 'care_label' then
      v_item := private.label_item(v_entry);
      if v_item.id is not null then
        perform private.attach_label(v_entry, v_item);
      end if;
    end if;
  elsif p_outcome = 'rejected' then
    update public.media_assets set state = 'rejected', updated_at = now() where id = v_job.target_id;
    update public.upload_entries set state = 'rejected', failure_code = p_failure_code, updated_at = now() where id = v_entry.id;
    update private.jobs set state = 'failed', failure_code = p_failure_code, updated_at = now(), completed_at = now()
     where id = p_job_id;
  else
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'outcome'));
  end if;

  perform private.enqueue_object_deletion(v_job.user_id, v_source.bucket, v_source.object_key, 'quarantine_consumed', now());
  perform private.enqueue_object_deletion(v_job.user_id, v_source.bucket, v_source.object_key, 'quarantine_recheck',
    v_entry.upload_expires_at + interval '1 minute');
  return jsonb_build_object('status', 'applied', 'state', case when p_outcome = 'ready' then 'succeeded' else 'failed' end);
end;
$$;

-- Keep as one set, or confirm selected parts. One atomic step: every part gets
-- its item and crop job, or nothing is created. A group is confirmed once.
create function public.svc_confirm_parts(
  p_user_id uuid,
  p_request_id uuid,
  p_entry_id uuid,
  p_mode text,
  p_image jsonb,
  p_parts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_entry public.upload_entries;
  v_asset public.media_assets;
  v_parts jsonb;
  v_part jsonb;
  v_index integer;
  v_item public.items;
  v_job_id uuid;
  v_items jsonb := '[]'::jsonb;
begin
  perform private.require_active_member_id(p_user_id);
  if p_mode is null or p_mode not in ('keep_one', 'split') then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'mode'));
  end if;
  v_existing := private.claim_request(p_user_id, 'confirm_parts', p_request_id,
    jsonb_build_object('entry_id', p_entry_id, 'mode', p_mode, 'image', p_image, 'parts', p_parts));
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_entry from public.upload_entries where id = p_entry_id and user_id = p_user_id for update;
  if not found or v_entry.purpose <> 'grouped' then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_entry.state <> 'ready' then
    perform private.raise_app_error('PARTS_NOT_AVAILABLE', 409, jsonb_build_object('state', v_entry.state));
  end if;
  if v_entry.split_confirmed_at is not null then
    perform private.raise_app_error('ALREADY_CONFIRMED', 409, jsonb_build_object('item_ids',
      (select coalesce(jsonb_agg(i.id order by i.created_at, i.id), '[]'::jsonb) from public.items i
        where i.source_entry_id = v_entry.id and i.lifecycle <> 'deleted')));
  end if;
  select * into v_asset from public.media_assets where id = v_entry.asset_id;
  if v_asset.state <> 'ready' or v_asset.deleted_at is not null or v_asset.expires_at <= now() then
    perform private.raise_app_error('SOURCE_EXPIRED', 409);
  end if;
  -- Boxes are relative to the oriented original; a client that saw other
  -- dimensions (or a different orientation) is refused rather than guessed at.
  if jsonb_typeof(p_image) <> 'object' or (p_image ->> 'width') is distinct from v_asset.width::text
     or (p_image ->> 'height') is distinct from v_asset.height::text then
    perform private.raise_app_error('ORIENTATION_MISMATCH', 422,
      jsonb_build_object('width', v_asset.width, 'height', v_asset.height));
  end if;

  if p_mode = 'keep_one' then
    if p_parts is not null and p_parts <> '[]'::jsonb then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'parts'));
    end if;
    v_parts := jsonb_build_array(jsonb_build_object('part_id', null, 'box', jsonb_build_object('x', 0, 'y', 0, 'w', 1, 'h', 1)));
  else
    if jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) < 1 then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'parts'));
    end if;
    if jsonb_array_length(p_parts) > 20 then
      perform private.raise_app_error('VALIDATION_FAILED', 422,
        jsonb_build_object('field', 'parts', 'reason', 'max_parts', 'max_parts', 20));
    end if;
    for v_part, v_index in select e, o::integer from jsonb_array_elements(p_parts) with ordinality as t(e, o) loop
      if jsonb_typeof(v_part) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_part) k where k not in ('part_id', 'box'))
         or coalesce(v_part ->> 'part_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'parts', 'index', v_index));
      end if;
      if not private.valid_part_box(v_part -> 'box', v_asset.width, v_asset.height) then
        perform private.raise_app_error('VALIDATION_FAILED', 422,
          jsonb_build_object('field', 'parts', 'reason', 'box', 'index', v_index));
      end if;
    end loop;
    if (select count(distinct e ->> 'part_id') from jsonb_array_elements(p_parts) e) <> jsonb_array_length(p_parts) then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'parts', 'reason', 'duplicate_part_id'));
    end if;
    -- Overlapping boxes are allowed: they are separate pieces the member chose.
    v_parts := p_parts;
  end if;

  for v_part in select * from jsonb_array_elements(v_parts) loop
    insert into public.items (user_id, source, source_entry_id, source_part_id)
    values (p_user_id, 'gather', v_entry.id, (v_part ->> 'part_id')::uuid)
    returning * into v_item;
    v_job_id := private.enqueue_item_stage(v_item, 'crop', 'crop-v1');
    update private.job_payloads
       set input = input || jsonb_build_object('source_asset_id', v_entry.asset_id, 'box', v_part -> 'box')
     where job_id = v_job_id;
    v_items := v_items || jsonb_build_object('item_id', v_item.id, 'part_id', v_part -> 'part_id', 'job_id', v_job_id);
  end loop;

  update public.upload_entries
     set split = jsonb_build_object('mode', p_mode, 'parts', v_parts), split_confirmed_at = now(), updated_at = now()
   where id = v_entry.id;
  -- The source must outlive its crop jobs; it stays temporary.
  update public.media_assets
     set expires_at = greatest(expires_at, now() + make_interval(hours => (private.upload_limits() ->> 'temporary_asset_hours')::integer)),
         updated_at = now()
   where id = v_entry.asset_id;

  return private.complete_request(p_user_id, 'confirm_parts', p_request_id,
    jsonb_build_object('entry_id', v_entry.id, 'mode', p_mode, 'items', v_items));
end;
$$;

-- A grouped photo that was never confirmed is deleted with its temporary window.
create function public.svc_expire_group_sources(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.upload_entries;
  v_count integer := 0;
begin
  for v_entry in
    select e.* from public.upload_entries e join public.media_assets a on a.id = e.asset_id
     where e.purpose = 'grouped' and e.state = 'ready' and a.state = 'ready' and a.retention = 'temporary'
       and a.expires_at <= now()
     limit p_limit for update of e skip locked
  loop
    if v_entry.split_confirmed_at is null then
      update public.upload_entries set state = 'canceled', updated_at = now() where id = v_entry.id;
    end if;
    perform private.delete_asset(v_entry.asset_id, 'upload_expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- A grouped photo awaiting its choice can also be canceled. Otherwise unchanged
-- from P0.04: ready and rejected entries are final.
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
  if v_entry.state = 'rejected'
     or (v_entry.state = 'ready' and not (v_entry.purpose = 'grouped' and v_entry.split_confirmed_at is null)) then
    perform private.raise_app_error('UPLOAD_NOT_CANCELABLE', 409, jsonb_build_object('state', v_entry.state));
  end if;

  update public.upload_entries set state = 'canceled', failure_code = null, updated_at = now() where id = p_entry_id;
  update public.media_assets set state = 'deletion_pending', updated_at = now() where id = v_entry.asset_id;
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

-- Discards a piece: its jobs are fenced, every attachment's bytes are queued for
-- deletion, derived data is removed and reusable details are scrubbed. The row
-- stays as a tombstone so late results and replays cannot recreate it.
create function private.discard_item(p_item_id uuid, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
  v_role text;
begin
  select * into v_item from public.items where id = p_item_id for update;
  if not found or v_item.lifecycle = 'deleted' then
    return;
  end if;
  update private.jobs set state = 'canceled', failure_code = 'SUPERSEDED', claim_nonce_hash = null,
         updated_at = now(), completed_at = now()
   where kind = 'item_stage' and target_id = p_item_id and state not in ('succeeded', 'failed', 'canceled');
  foreach v_role in array array['original', 'cutout', 'thumbnail', 'mask', 'label'] loop
    perform private.detach_item_asset(p_item_id, v_role, p_reason);
  end loop;
  delete from public.item_embeddings where item_id = p_item_id;
  delete from public.item_suggestions where item_id = p_item_id;
  update public.items
     set lifecycle = 'deleted', deleted_at = now(), name = null, category = null, subcategory = null, pattern = null,
         material = null, formality = null, colors = '[]'::jsonb, seasons = '{}', style_tags = '{}', attributes = '{}'::jsonb,
         brand = null, size_label = null, price_minor = null, currency = null, purchased_on = null,
         field_meta = '{}'::jsonb, revision = revision + 1, updated_at = now()
   where id = p_item_id;
  perform private.release_group_source(v_item.source_entry_id);
end;
$$;
revoke all on function private.discard_item(uuid, text) from public, anon, authenticated;

-- Flags a new piece that closely matches an older piece of the same category in
-- the member's own wardrobe (cosine similarity at least 0.92, PRD). Parts split
-- from the same photo are distinct by the member's choice and are not compared.
create function private.flag_near_duplicate(p_item_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
  v_match_id uuid;
  v_distance double precision;
begin
  select * into v_item from public.items where id = p_item_id;
  if not found or v_item.lifecycle <> 'active' or v_item.category is null
     or exists (select 1 from public.duplicate_reviews r where r.item_id = v_item.id)
     or exists (select 1 from public.duplicate_reviews r
                 where r.entry_id = v_item.source_entry_id and r.state = 'add_another') then
    return;
  end if;
  select n.item_id, n.distance into v_match_id, v_distance
    from public.svc_nearest_items(v_item.user_id, v_item.id, 50) n
    join public.items o on o.id = n.item_id
   where o.category = v_item.category and o.created_at < v_item.created_at
     and o.source_entry_id is distinct from v_item.source_entry_id
   order by n.distance, n.item_id
   limit 1;
  if v_match_id is null or v_distance > 0.08 then
    return;
  end if;
  insert into public.duplicate_reviews (user_id, item_id, existing_item_id, basis, similarity)
  values (v_item.user_id, v_item.id, v_match_id, 'vector', round((1 - v_distance)::numeric, 4))
  on conflict (item_id) where item_id is not null do nothing;
end;
$$;
revoke all on function private.flag_near_duplicate(uuid) from public, anon, authenticated;

-- Use existing / Add another. Decide later is simply leaving the review pending.
create function public.svc_resolve_duplicate(p_user_id uuid, p_request_id uuid, p_review_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_review public.duplicate_reviews;
  v_entry public.upload_entries;
  v_target public.items;
  v_label public.upload_entries;
  v_item_id uuid;
begin
  perform private.require_active_member_id(p_user_id);
  if p_decision is null or p_decision not in ('use_existing', 'add_another') then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'decision'));
  end if;
  v_existing := private.claim_request(p_user_id, 'resolve_duplicate', p_request_id,
    jsonb_build_object('review_id', p_review_id, 'decision', p_decision));
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_review from public.duplicate_reviews where id = p_review_id and user_id = p_user_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_review.state <> 'pending' then
    perform private.raise_app_error('ALREADY_DECIDED', 409, jsonb_build_object('state', v_review.state));
  end if;
  if p_decision = 'use_existing' then
    select * into v_target from public.items
     where id = v_review.existing_item_id and user_id = p_user_id and lifecycle <> 'deleted';
    if not found then
      perform private.raise_app_error('EXISTING_REMOVED', 409);
    end if;
  end if;
  update public.duplicate_reviews set state = p_decision, decided_at = now() where id = v_review.id;

  if v_review.basis = 'hash' then
    select * into v_entry from public.upload_entries where id = v_review.entry_id for update;
    if p_decision = 'use_existing' then
      -- No second piece: the repeated photo is deleted and its labels go to the
      -- piece the member already has.
      perform private.delete_asset(v_entry.asset_id, 'duplicate_discarded');
      for v_label in select * from public.upload_entries
                      where parent_entry_id = v_entry.id and purpose = 'care_label' and state = 'ready' loop
        perform private.attach_label(v_label, v_target);
      end loop;
      v_item_id := v_target.id;
    else
      v_item_id := private.create_gather_item(v_entry);
    end if;
  else
    if p_decision = 'use_existing' then
      perform private.discard_item(v_review.item_id, 'duplicate_discarded');
      v_item_id := v_target.id;
    else
      v_item_id := v_review.item_id;
    end if;
  end if;

  return private.complete_request(p_user_id, 'resolve_duplicate', p_request_id,
    jsonb_build_object('review_id', v_review.id, 'state', p_decision, 'item_id', v_item_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Crop stage in the shared item-stage functions.
-- ---------------------------------------------------------------------------
create or replace function private.claim_item_stage(p_job private.jobs)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_limits jsonb := private.job_limits();
  v_item public.items;
  v_source public.media_assets;
  v_object private.media_objects;
  v_input jsonb;
  v_job private.jobs;
  v_prefix text;
  v_role text := case when p_job.stage in ('colors', 'embedding') then 'cutout' else 'original' end;
  v_label_asset uuid;
begin
  select * into v_item from public.items where id = p_job.target_id for update;
  if not found or v_item.lifecycle = 'deleted' or v_item.media_revision <> p_job.target_revision
     or not private.is_active_member(p_job.user_id) then
    update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now(),
           failure_code = case when v_item.id is null or v_item.lifecycle = 'deleted' or v_item.media_revision <> p_job.target_revision
                               then 'SUPERSEDED' end
     where id = p_job.id;
    return jsonb_build_object('claim_rejected', true);
  end if;
  select input into v_input from private.job_payloads where job_id = p_job.id;
  if p_job.stage = 'crop' then
    -- Only this piece's own grouped source can be cropped.
    select a.* into v_source from public.media_assets a join public.upload_entries e on e.asset_id = a.id
     where a.id = (v_input ->> 'source_asset_id')::uuid and e.id = v_item.source_entry_id and e.purpose = 'grouped'
       and a.user_id = v_item.user_id and a.state = 'ready';
    select * into v_object from private.media_objects
     where asset_id = v_source.id and role = 'original' and deleted_at is null;
  elsif p_job.stage = 'label' then
    v_label_asset := (v_input ->> 'label_asset_id')::uuid;
    select a.* into v_source from public.item_assets ia join public.media_assets a on a.id = ia.asset_id
     where ia.item_id = v_item.id and ia.asset_id = v_label_asset and ia.role = 'label' and ia.detached_at is null
       and a.state = 'ready';
    select * into v_object from private.media_objects
     where asset_id = v_source.id and role = 'original' and deleted_at is null;
  else
    select a.* into v_source from public.item_assets ia join public.media_assets a on a.id = ia.asset_id
     where ia.item_id = v_item.id and ia.role = v_role and ia.detached_at is null and a.state = 'ready';
    select * into v_object from private.media_objects
     where asset_id = v_source.id and role = v_role and deleted_at is null;
  end if;
  if v_object.object_key is null then
    update private.jobs set state = 'failed', failure_code = 'SOURCE_MISSING', claim_nonce_hash = null,
           updated_at = now(), completed_at = now()
     where id = p_job.id;
    return jsonb_build_object('claim_rejected', true);
  end if;

  update private.job_payloads
     set input = input || jsonb_build_object('base_versions', private.field_versions(v_item,
           case p_job.stage when 'colors' then array['colors']
                            when 'tags' then array['category', 'subcategory', 'pattern', 'material', 'formality',
                                                   'seasons', 'style_tags', 'attributes']
                            when 'label' then array['brand', 'size_label', 'material']
                            else array[]::text[] end))
   where job_id = p_job.id
  returning input into v_input;

  update private.jobs
     set state = 'running', claim_nonce_hash = null, claim_expires_at = null,
         lease_generation = lease_generation + 1, attempt_count = attempt_count + 1,
         claimed_at = now(), heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => (v_limits ->> 'lease_seconds')::integer), updated_at = now()
   where id = p_job.id
  returning * into v_job;

  v_prefix := format('users/%s/items/%s/%s', v_job.user_id, v_item.id, v_item.media_revision);
  return jsonb_build_object(
    'job_id', v_job.id,
    'kind', 'item_stage',
    'stage', v_job.stage,
    'user_id', v_job.user_id,
    'item_id', v_item.id,
    'lease_generation', v_job.lease_generation,
    'lease_expires_at', v_job.lease_expires_at,
    'bucket', v_object.bucket,
    'sources', case when v_job.stage in ('tags', 'label') then '{}'::jsonb
                    when v_job.stage = 'crop' then jsonb_build_object('source', v_object.object_key)
                    else jsonb_build_object(v_role, v_object.object_key) end,
    'outputs', case v_job.stage
      when 'crop' then jsonb_build_object(
        'original', format('%s/original-%s-g%s.webp', v_prefix, v_job.id, v_job.lease_generation))
      when 'cutout' then jsonb_build_object(
        'cutout', format('%s/cutout-%s-g%s.webp', v_prefix, v_job.id, v_job.lease_generation),
        'thumbnail', format('%s/thumbnail-%s-g%s.webp', v_prefix, v_job.id, v_job.lease_generation),
        'mask', format('%s/mask-%s-g%s.png', v_prefix, v_job.id, v_job.lease_generation))
      else '{}'::jsonb end,
    'input', case v_job.stage
      when 'crop' then jsonb_build_object(
        'box', v_input -> 'box',
        'source', jsonb_build_object('width', v_source.width, 'height', v_source.height),
        'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint)
      when 'cutout' then jsonb_build_object(
        'model', v_input ->> 'model',
        'original', jsonb_build_object('width', v_source.width, 'height', v_source.height),
        'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint)
      when 'embedding' then (select jsonb_build_object('model', s.model, 'model_revision', s.model_revision,
        'preprocess_version', s.preprocess_version, 'dimension', s.dimension,
        'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint) from private.embedding_space s)
      when 'colors' then jsonb_build_object('max_colors', 5, 'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint)
      when 'label' then jsonb_build_object('task', 'label_read')
      else jsonb_build_object('task', 'item_tags') end
  );
end;
$$;

create or replace function public.svc_complete_item_stage(
  p_job_id uuid,
  p_lease_generation integer,
  p_outcome text,
  p_outputs jsonb,
  p_result jsonb,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.jobs;
  v_item public.items;
  v_input jsonb;
  v_role text;
  v_bucket text;
  v_width integer;
  v_height integer;
  v_space private.embedding_space;
  v_applied text[];
begin
  select * into v_job from private.jobs where id = p_job_id for update;
  if not found or v_job.kind <> 'item_stage' then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_job.state in ('succeeded', 'failed') and v_job.lease_generation = p_lease_generation then
    return jsonb_build_object('status', 'already_applied', 'state', v_job.state);
  end if;
  if v_job.state <> 'running' or v_job.lease_generation <> p_lease_generation then
    return jsonb_build_object('status', 'stale');
  end if;
  select input into v_input from private.job_payloads where job_id = p_job_id;
  select * into v_item from public.items where id = v_job.target_id for update;
  if not found or v_item.lifecycle = 'deleted' or v_item.media_revision <> v_job.target_revision then
    if found and v_item.lifecycle <> 'deleted' and v_job.stage in ('tags', 'colors', 'label') and p_outcome = 'ready'
       and private.valid_suggestion(coalesce(p_result -> 'suggested', '{}')) then
      insert into public.item_suggestions (user_id, item_id, job_id, source, schema_version, input_media_revision,
        base_versions, suggested, status)
      values (v_job.user_id, v_item.id, v_job.id, private.suggestion_source(v_job.stage), 1,
        v_job.target_revision, coalesce(v_input -> 'base_versions', '{}'), p_result -> 'suggested', 'stale');
    end if;
    update private.jobs set state = 'canceled', failure_code = 'SUPERSEDED', updated_at = now(), completed_at = now()
     where id = p_job_id;
    return jsonb_build_object('status', 'stale');
  end if;

  if p_outcome = 'rejected' then
    update private.jobs set state = 'failed', failure_code = p_failure_code, updated_at = now(), completed_at = now()
     where id = p_job_id;
    return jsonb_build_object('status', 'applied', 'state', 'failed');
  elsif p_outcome <> 'ready' then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'outcome'));
  end if;

  if v_job.stage = 'crop' then
    if coalesce(p_outputs -> 'original' ->> 'object_key', '') not like
       format('users/%s/items/%s/%s/original-%s-g%s.%%', v_job.user_id, v_item.id, v_item.media_revision, v_job.id,
              p_lease_generation) then
      perform private.raise_app_error('OUTPUT_REJECTED', 422, jsonb_build_object('output', 'original'));
    end if;
    select o.bucket into v_bucket from private.media_objects o
     where o.asset_id = (v_input ->> 'source_asset_id')::uuid and o.role = 'original' limit 1;
    perform private.attach_item_output(v_item, 'original', v_bucket, p_outputs -> 'original');
    select * into v_item from public.items where id = v_item.id;
    perform private.enqueue_item_stage(v_item, 'cutout', (private.cutout_models())[1]);
    perform private.enqueue_item_stage(v_item, 'tags', private.tags_task_version());

  elsif v_job.stage = 'cutout' then
    select o.bucket, a.width, a.height into v_bucket, v_width, v_height
      from public.item_assets ia
      join public.media_assets a on a.id = ia.asset_id
      join private.media_objects o on o.asset_id = ia.asset_id
     where ia.item_id = v_item.id and ia.role = 'original' and ia.detached_at is null limit 1;
    if (p_outputs -> 'mask' ->> 'width')::integer is distinct from v_width
       or (p_outputs -> 'mask' ->> 'height')::integer is distinct from v_height then
      perform private.raise_app_error('OUTPUT_REJECTED', 422, jsonb_build_object('output', 'mask'));
    end if;
    foreach v_role in array array['cutout', 'thumbnail', 'mask'] loop
      if coalesce(p_outputs -> v_role ->> 'object_key', '') not like
         format('users/%s/items/%s/%s/%s-%s-g%s.%%', v_job.user_id, v_item.id, v_item.media_revision, v_role, v_job.id,
                p_lease_generation) then
        perform private.raise_app_error('OUTPUT_REJECTED', 422, jsonb_build_object('output', v_role));
      end if;
      perform private.attach_item_output(v_item, v_role, v_bucket, p_outputs -> v_role);
    end loop;
    select * into v_item from public.items where id = v_item.id;
    perform private.enqueue_after_cutout(v_item);

  elsif v_job.stage in ('colors', 'tags', 'label') then
    if not private.valid_suggestion(coalesce(p_result -> 'suggested', 'null'))
       or exists (select 1 from jsonb_object_keys(p_result -> 'suggested') k
                   where not k = any (case v_job.stage
                     when 'colors' then array['colors']
                     when 'label' then array['brand', 'size_label', 'material']
                     else array['category', 'category_confidence', 'subcategory', 'pattern', 'material', 'formality',
                                'seasons', 'style_tags', 'attributes'] end)) then
      perform private.raise_app_error('OUTPUT_REJECTED', 422, jsonb_build_object('field', 'suggested'));
    end if;
    v_applied := private.apply_suggestion(v_item, private.suggestion_source(v_job.stage),
      coalesce(v_input -> 'base_versions', '{}'), p_result -> 'suggested');
    insert into public.item_suggestions (user_id, item_id, job_id, source, schema_version, input_media_revision,
      base_versions, suggested, applied_fields, status)
    values (v_job.user_id, v_item.id, v_job.id, private.suggestion_source(v_job.stage), 1,
      v_job.target_revision, coalesce(v_input -> 'base_versions', '{}'), p_result -> 'suggested', v_applied, 'applied');

  elsif v_job.stage = 'embedding' then
    select * into v_space from private.embedding_space;
    if v_space.model is null or p_result ->> 'model' is distinct from v_space.model
       or p_result ->> 'model_revision' is distinct from v_space.model_revision
       or p_result ->> 'preprocess_version' is distinct from v_space.preprocess_version then
      update private.jobs set state = 'failed', failure_code = 'INCOMPATIBLE_VECTOR_SPACE', updated_at = now(), completed_at = now()
       where id = p_job_id;
      return jsonb_build_object('status', 'applied', 'state', 'failed');
    end if;
    if jsonb_typeof(p_result -> 'vector') <> 'array' or jsonb_array_length(p_result -> 'vector') <> v_space.dimension then
      perform private.raise_app_error('OUTPUT_REJECTED', 422, jsonb_build_object('field', 'vector'));
    end if;
    insert into public.item_embeddings (user_id, item_id, model, model_revision, preprocess_version, media_revision, embedding)
    values (v_job.user_id, v_item.id, v_space.model, v_space.model_revision, v_space.preprocess_version, v_item.media_revision,
      (p_result ->> 'vector')::extensions.vector)
    on conflict (item_id, model, model_revision, preprocess_version, media_revision) do nothing;
  end if;

  update private.jobs set state = 'succeeded', failure_code = null, updated_at = now(), completed_at = now()
   where id = p_job_id;
  if v_job.stage = 'crop' then
    perform private.release_group_source(v_item.source_entry_id);
  elsif v_job.stage in ('embedding', 'tags') then
    -- Both a category and a vector are needed; whichever arrives last compares.
    perform private.flag_near_duplicate(v_item.id);
  end if;
  return jsonb_build_object('status', 'applied', 'state', 'succeeded');
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_confirm_parts(uuid, uuid, uuid, text, jsonb, jsonb)',
    'public.svc_expire_group_sources(integer)',
    'public.svc_resolve_duplicate(uuid, uuid, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
