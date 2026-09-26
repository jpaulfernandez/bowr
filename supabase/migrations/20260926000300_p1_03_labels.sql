-- P1.03: gather a mixed batch with care labels.
-- A care-label photo is an attachment to one garment: another photo in the same
-- batch or an existing piece. It never creates a wardrobe piece. Its reading
-- (brand, size, material) is a separate AI stage whose result fills only
-- unlocked, unchanged fields; removing the label keeps approved values.

-- ---------------------------------------------------------------------------
-- Entries: a label names its garment entry or an existing item.
-- ---------------------------------------------------------------------------
alter table public.upload_entries drop constraint upload_entries_purpose_check;
alter table public.upload_entries
  add constraint upload_entries_purpose_check check (purpose in ('garment', 'care_label')),
  add column parent_entry_id uuid,
  add column target_item_id uuid,
  add constraint upload_entries_parent_fk foreign key (user_id, parent_entry_id)
    references public.upload_entries (user_id, id) on delete set null (parent_entry_id),
  add constraint upload_entries_target_item_fk foreign key (user_id, target_item_id)
    references public.items (user_id, id) on delete set null (target_item_id),
  -- Garments have no label target. A new label names exactly one target; the
  -- target may later become null if that garment or piece is removed.
  add constraint upload_entries_label_target check (
    purpose = 'care_label' or (parent_entry_id is null and target_item_id is null)),
  add constraint upload_entries_one_label_target check (not (parent_entry_id is not null and target_item_id is not null));
create index upload_entries_parent on public.upload_entries (parent_entry_id) where parent_entry_id is not null;

alter table private.jobs drop constraint jobs_stage_check;
alter table private.jobs add constraint jobs_stage_check
  check (stage in ('validate', 'cutout', 'colors', 'embedding', 'tags', 'label'));
alter table public.item_stages drop constraint item_stages_stage_check;
alter table public.item_stages add constraint item_stages_stage_check
  check (stage in ('cutout', 'colors', 'embedding', 'tags', 'label'));

alter table public.item_suggestions drop constraint item_suggestions_source_check;
alter table public.item_suggestions add constraint item_suggestions_source_check
  check (source in ('vision', 'computed', 'label'));

alter table private.deletion_tasks drop constraint deletion_tasks_reason_check;
alter table private.deletion_tasks add constraint deletion_tasks_reason_check check (reason in (
  'quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload',
  'account_deleted', 'upload_expired', 'orphan', 'superseded', 'label_removed'));

-- ---------------------------------------------------------------------------
-- Batch creation. Files: [{client_file_id, purpose, content_type, byte_size,
-- rotation?, label_for?, target_item_id?}]. label_for names a garment
-- client_file_id in the same request; target_item_id an owned piece.
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

  -- Label targets are checked before anything is created.
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
    if v_purpose not in ('garment', 'care_label')
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

  -- Second pass: a label points at its garment's entry in this batch.
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

-- ---------------------------------------------------------------------------
-- Attaching labels
-- ---------------------------------------------------------------------------

-- Attaches a validated label to its piece and queues its reading. The label is
-- retained only once attached; until then it stays temporary.
create function private.attach_label(p_entry public.upload_entries, p_item public.items)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  if exists (select 1 from public.item_assets where asset_id = p_entry.asset_id) then
    return;
  end if;
  insert into public.item_assets (user_id, item_id, asset_id, role, media_revision)
  values (p_entry.user_id, p_item.id, p_entry.asset_id, 'label', p_item.media_revision);
  update public.media_assets set retention = 'retained', expires_at = null, updated_at = now() where id = p_entry.asset_id;
  v_job_id := private.enqueue_item_stage(p_item, 'label', 'label-read-v1:' || p_entry.asset_id);
  update private.job_payloads set input = input || jsonb_build_object('label_asset_id', p_entry.asset_id)
   where job_id = v_job_id;
end;
$$;
revoke all on function private.attach_label(public.upload_entries, public.items) from public, anon, authenticated;

-- The piece a label entry belongs to, if it exists yet.
create function private.label_item(p_entry public.upload_entries)
returns public.items
language sql
stable
set search_path = ''
as $$
  select i.* from public.items i
   where i.lifecycle <> 'deleted' and i.user_id = p_entry.user_id
     and (i.id = p_entry.target_item_id
          or (p_entry.parent_entry_id is not null and i.source_entry_id = p_entry.parent_entry_id))
   limit 1;
$$;
revoke all on function private.label_item(public.upload_entries) from public, anon, authenticated;

create or replace function private.create_gather_item(p_entry public.upload_entries)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
  v_label public.upload_entries;
begin
  insert into public.items (user_id, source, source_entry_id)
  values (p_entry.user_id, 'gather', p_entry.id)
  on conflict (source_entry_id) where source_entry_id is not null do nothing
  returning * into v_item;
  if v_item.id is null then
    return (select id from public.items where source_entry_id = p_entry.id);
  end if;
  insert into public.item_assets (user_id, item_id, asset_id, role, media_revision)
  values (p_entry.user_id, v_item.id, p_entry.asset_id, 'original', v_item.media_revision);
  perform private.enqueue_item_stage(v_item, 'cutout', (private.cutout_models())[1]);
  perform private.enqueue_item_stage(v_item, 'tags', private.tags_task_version());
  -- Labels in the batch that were validated before their garment attach now.
  for v_label in select * from public.upload_entries
                  where parent_entry_id = p_entry.id and purpose = 'care_label' and state = 'ready' loop
    perform private.attach_label(v_label, v_item);
  end loop;
  return v_item.id;
end;
$$;

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
    -- A garment is retained now; a label only once it is attached to its piece.
    update public.media_assets
       set state = 'ready',
           retention = case when v_entry.purpose = 'garment' then 'retained' else retention end,
           expires_at = case when v_entry.purpose = 'garment' then null else expires_at end,
           width = (p_output ->> 'width')::integer, height = (p_output ->> 'height')::integer,
           content_type = 'image/webp', byte_size = (p_output ->> 'byte_size')::bigint, sha256 = p_output ->> 'sha256',
           updated_at = now()
     where id = v_job.target_id;
    update public.upload_entries set state = 'ready', updated_at = now() where id = v_entry.id;
    update private.jobs set state = 'succeeded', updated_at = now(), completed_at = now() where id = p_job_id;
    select * into v_entry from public.upload_entries where id = v_entry.id;
    if v_entry.purpose = 'garment' then
      perform private.create_gather_item(v_entry);
    else
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

-- Removes a label attachment. The garment and every value already on it stay;
-- the label's bytes are deleted and its reading job, if pending, is canceled.
create function public.svc_remove_label(p_user_id uuid, p_asset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.item_assets;
  v_object private.media_objects;
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_link from public.item_assets
   where asset_id = p_asset_id and user_id = p_user_id and role = 'label' and detached_at is null for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  update public.item_assets set detached_at = now() where id = v_link.id;
  update public.media_assets set state = 'deletion_pending', updated_at = now() where id = p_asset_id;
  for v_object in select * from private.media_objects where asset_id = p_asset_id and deleted_at is null loop
    perform private.enqueue_object_deletion(p_user_id, v_object.bucket, v_object.object_key, 'label_removed', now());
  end loop;
  update private.jobs set state = 'canceled', failure_code = 'SUPERSEDED', claim_nonce_hash = null, updated_at = now(),
         completed_at = now()
   where kind = 'item_stage' and stage = 'label' and target_id = v_link.item_id
     and dedupe_key like '%:label-read-v1:' || p_asset_id and state in ('queued', 'retry_wait', 'blocked_budget', 'running');
  return jsonb_build_object('asset_id', p_asset_id, 'state', 'deletion_pending');
end;
$$;

-- ---------------------------------------------------------------------------
-- Label reading: facts from the label fill brand, size and material.
-- ---------------------------------------------------------------------------
create or replace function private.valid_suggestion(p_suggested jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tax jsonb := private.taxonomy();
  v_category text := p_suggested ->> 'category';
begin
  if jsonb_typeof(p_suggested) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_suggested) k
     where k not in ('category', 'category_confidence', 'subcategory', 'pattern', 'material', 'formality', 'seasons',
                     'style_tags', 'attributes', 'colors', 'brand', 'size_label')
  ) then
    return false;
  end if;
  if p_suggested ? 'category' and not (v_tax -> 'categories') ? v_category then return false; end if;
  if p_suggested ? 'category_confidence' and coalesce(p_suggested ->> 'category_confidence', '') not in ('high', 'low') then
    return false;
  end if;
  if p_suggested ? 'subcategory' and (v_category is null or not (v_tax -> 'categories' -> v_category) ? (p_suggested ->> 'subcategory')) then
    return false;
  end if;
  if p_suggested ? 'pattern' and not (v_tax -> 'patterns') ? (p_suggested ->> 'pattern') then return false; end if;
  if p_suggested ? 'material' and (coalesce(jsonb_typeof(p_suggested -> 'material'), '') <> 'string'
     or char_length(p_suggested ->> 'material') not between 1 and 60) then
    return false;
  end if;
  if p_suggested ? 'brand' and (coalesce(jsonb_typeof(p_suggested -> 'brand'), '') <> 'string'
     or char_length(p_suggested ->> 'brand') not between 1 and 60) then
    return false;
  end if;
  if p_suggested ? 'size_label' and (coalesce(jsonb_typeof(p_suggested -> 'size_label'), '') <> 'string'
     or char_length(p_suggested ->> 'size_label') not between 1 and 20) then
    return false;
  end if;
  if p_suggested ? 'formality' and coalesce(p_suggested ->> 'formality', '') !~ '^[1-5]$' then return false; end if;
  if p_suggested ? 'seasons' and (jsonb_typeof(p_suggested -> 'seasons') <> 'array'
     or exists (select 1 from jsonb_array_elements(p_suggested -> 'seasons') s where not (v_tax -> 'seasons') @> jsonb_build_array(s))) then
    return false;
  end if;
  if p_suggested ? 'style_tags' and (jsonb_typeof(p_suggested -> 'style_tags') <> 'array'
     or jsonb_array_length(p_suggested -> 'style_tags') > 10
     or exists (select 1 from jsonb_array_elements(p_suggested -> 'style_tags') t
                 where jsonb_typeof(t) <> 'string' or (t #>> '{}') !~ '^[a-z0-9][a-z0-9 -]{0,23}$')) then
    return false;
  end if;
  if p_suggested ? 'attributes' and (jsonb_typeof(p_suggested -> 'attributes') <> 'object' or exists (
       select 1 from jsonb_each(p_suggested -> 'attributes') a
        where not (v_tax -> 'attributes') ? a.key or v_category is null
           or not (v_tax -> 'attributes' -> a.key -> 'categories') ? v_category
           or not (v_tax -> 'attributes' -> a.key -> 'values') @> jsonb_build_array(a.value))) then
    return false;
  end if;
  if p_suggested ? 'colors' and (jsonb_typeof(p_suggested -> 'colors') <> 'array'
     or jsonb_array_length(p_suggested -> 'colors') > 5
     or exists (select 1 from jsonb_array_elements(p_suggested -> 'colors') c
                 where jsonb_typeof(c) <> 'object'
                    or exists (select 1 from jsonb_object_keys(c) k where k not in ('hex', 'name', 'proportion'))
                    or not (v_tax -> 'colors') ? coalesce(c ->> 'name', '')
                    or coalesce(c ->> 'hex', '') !~ '^#[0-9A-Fa-f]{6}$'
                    or coalesce(jsonb_typeof(c -> 'proportion'), '') <> 'number'
                    or (c ->> 'proportion')::numeric not between 0 and 1)) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function private.apply_suggestion(p_item public.items, p_source text, p_base jsonb, p_suggested jsonb)
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  v_fields constant text[] := array['category', 'subcategory', 'pattern', 'material', 'formality', 'seasons',
    'style_tags', 'attributes', 'colors', 'brand', 'size_label'];
  v_field text;
  v_applied text[] := '{}';
  v_meta jsonb := p_item.field_meta;
  v_category text;
begin
  foreach v_field in array v_fields loop
    continue when not p_suggested ? v_field;
    continue when coalesce((v_meta -> v_field ->> 'locked')::boolean, false);
    continue when coalesce((v_meta -> v_field ->> 'v')::integer, 0) <> coalesce((p_base ->> v_field)::integer, -1);
    -- A value read from the care label is a printed fact; a visual guess never replaces it.
    continue when p_source = 'vision' and v_meta -> v_field ->> 'source' = 'label';
    v_applied := v_applied || v_field;
    v_meta := jsonb_set(v_meta, array[v_field], jsonb_build_object(
      'v', coalesce((v_meta -> v_field ->> 'v')::integer, 0) + 1, 'source', p_source, 'locked', false, 'at', now()));
  end loop;
  if cardinality(v_applied) = 0 then
    return v_applied;
  end if;

  v_category := case when 'category' = any (v_applied) then p_suggested ->> 'category' else p_item.category end;
  update public.items set
    category = v_category,
    subcategory = case
      when 'subcategory' = any (v_applied) and (private.taxonomy() -> 'categories' -> v_category) ? (p_suggested ->> 'subcategory')
        then p_suggested ->> 'subcategory'
      when v_category is not null and subcategory is not null and (private.taxonomy() -> 'categories' -> v_category) ? subcategory
        then subcategory
      else null end,
    pattern = case when 'pattern' = any (v_applied) then p_suggested ->> 'pattern' else pattern end,
    material = case when 'material' = any (v_applied) then p_suggested ->> 'material' else material end,
    brand = case when 'brand' = any (v_applied) then p_suggested ->> 'brand' else brand end,
    size_label = case when 'size_label' = any (v_applied) then p_suggested ->> 'size_label' else size_label end,
    formality = case when 'formality' = any (v_applied) then (p_suggested ->> 'formality')::smallint else formality end,
    seasons = case when 'seasons' = any (v_applied)
      then array(select e from jsonb_array_elements_text(p_suggested -> 'seasons') with ordinality t(e, o) group by e order by min(o))
      else seasons end,
    style_tags = case when 'style_tags' = any (v_applied)
      then array(select e from jsonb_array_elements_text(p_suggested -> 'style_tags') with ordinality t(e, o) group by e order by min(o))
      else style_tags end,
    attributes = case when 'attributes' = any (v_applied) then p_suggested -> 'attributes' else attributes end,
    colors = case when 'colors' = any (v_applied) then p_suggested -> 'colors' else colors end,
    category_review_required = case when 'category' = any (v_applied)
      then coalesce(p_suggested ->> 'category_confidence', 'low') <> 'high' else category_review_required end,
    field_meta = v_meta,
    revision = revision + 1,
    updated_at = now()
  where id = p_item.id;
  return v_applied;
end;
$$;

-- ---------------------------------------------------------------------------
-- Label stage in the shared item-stage functions.
-- ---------------------------------------------------------------------------
create function private.suggestion_source(p_stage text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_stage when 'tags' then 'vision' when 'label' then 'label' else 'computed' end;
$$;
revoke all on function private.suggestion_source(text) from public, anon, authenticated;

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
    -- Returned, not raised: raising would roll the cancellation back and the
    -- job would be dispatched again after its claim expired.
    return jsonb_build_object('claim_rejected', true);
  end if;
  if p_job.stage = 'label' then
    -- The label named by this job must still be attached to the piece.
    select (input ->> 'label_asset_id')::uuid into v_label_asset from private.job_payloads where job_id = p_job.id;
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

  -- The versions this attempt may apply to are captured now.
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
                    else jsonb_build_object(v_role, v_object.object_key) end,
    'outputs', case v_job.stage
      when 'cutout' then jsonb_build_object(
        'cutout', format('%s/cutout-%s-g%s.webp', v_prefix, v_job.id, v_job.lease_generation),
        'thumbnail', format('%s/thumbnail-%s-g%s.webp', v_prefix, v_job.id, v_job.lease_generation),
        'mask', format('%s/mask-%s-g%s.png', v_prefix, v_job.id, v_job.lease_generation))
      else '{}'::jsonb end,
    'input', case v_job.stage
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
    -- A result for an older photo stays inspectable but never applies.
    if found and v_job.stage in ('tags', 'colors', 'label') and p_outcome = 'ready' and private.valid_suggestion(coalesce(p_result -> 'suggested', '{}')) then
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

  if v_job.stage = 'cutout' then
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
    -- Each stage may suggest only its own fields.
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
  return jsonb_build_object('status', 'applied', 'state', 'succeeded');
end;
$$;

create or replace function public.svc_item_ai_context(p_job_id uuid, p_lease_generation integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_job private.jobs;
  v_key text;
begin
  select * into v_job from private.jobs where id = p_job_id;
  if not found or v_job.kind <> 'item_stage' or v_job.stage not in ('tags', 'label') or v_job.state <> 'running'
     or v_job.lease_generation <> p_lease_generation then
    return jsonb_build_object('status', 'stale');
  end if;
  -- Tags read the piece's original; a label reading reads only its label photo.
  select o.object_key into v_key
    from public.item_assets ia join private.media_objects o on o.asset_id = ia.asset_id and o.role = 'original' and o.deleted_at is null
   where ia.item_id = v_job.target_id and ia.detached_at is null
     and case when v_job.stage = 'label'
              then ia.role = 'label' and ia.asset_id = (select (p.input ->> 'label_asset_id')::uuid from private.job_payloads p where p.job_id = v_job.id)
              else ia.role = 'original' end;
  return jsonb_build_object(
    'status', 'ok',
    'user_id', v_job.user_id,
    'item_id', v_job.target_id,
    'media_revision', v_job.target_revision,
    'original_key', v_key,
    'task', case when v_job.stage = 'label' then 'label_read' else 'item_tags' end,
    'attempt_key', format('%s:%s:mr%s:r%s:b%s', case when v_job.stage = 'label' then 'label_read' else 'item_tags' end,
      v_job.id, v_job.target_revision, v_job.manual_retries, v_job.budget_resumes)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- A label whose garment never became a piece stays temporary and is deleted
-- when its temporary window ends (it is never kept unattached).
-- ---------------------------------------------------------------------------
create function public.svc_expire_unattached_labels(p_limit integer default 200)
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

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_remove_label(uuid, uuid)',
    'public.svc_expire_unattached_labels(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
