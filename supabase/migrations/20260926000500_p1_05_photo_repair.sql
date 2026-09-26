-- P1.05: repair or replace a piece photo reversibly.
-- A member's edited mask, an explicit alternate-model cutout and a replacement
-- photo each advance the piece's media revision. The cutout is always composed
-- on the server from the stored original; the member only ever supplies a mask.
-- Earlier renditions stay attached until their replacements are published, so a
-- failed repair leaves a usable image, and results for an older revision are fenced.

-- ---------------------------------------------------------------------------
-- Replacement photos: an upload that targets an existing piece.
-- ---------------------------------------------------------------------------
alter table public.upload_entries drop constraint upload_entries_purpose_check;
alter table public.upload_entries drop constraint upload_entries_label_target;
alter table public.upload_entries
  add constraint upload_entries_purpose_check check (purpose in ('garment', 'care_label', 'grouped', 'replacement')),
  -- Only labels and replacements name a target piece; only labels name a garment
  -- entry. A target may later become null if that piece is removed.
  add constraint upload_entries_label_target check (
    purpose in ('care_label', 'replacement') or (parent_entry_id is null and target_item_id is null)),
  add constraint upload_entries_replacement_target check (purpose <> 'replacement' or parent_entry_id is null);

alter table private.deletion_tasks drop constraint deletion_tasks_reason_check;
alter table private.deletion_tasks add constraint deletion_tasks_reason_check check (reason in (
  'quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload',
  'account_deleted', 'upload_expired', 'orphan', 'superseded', 'label_removed', 'group_source_released',
  'duplicate_discarded', 'mask_input_used'));

-- Advances the media revision. Work for the previous revision is canceled (its
-- late results are fenced anyway); current renditions stay until replaced.
create function private.advance_media_revision(p_item public.items)
returns public.items
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
begin
  update public.items set media_revision = media_revision + 1, updated_at = now()
   where id = p_item.id
  returning * into v_item;
  update private.jobs set state = 'canceled', failure_code = 'SUPERSEDED', claim_nonce_hash = null,
         updated_at = now(), completed_at = now()
   where kind = 'item_stage' and target_id = p_item.id and target_revision < v_item.media_revision
     and state in ('queued', 'retry_wait', 'blocked_budget');
  return v_item;
end;
$$;
revoke all on function private.advance_media_revision(public.items) from public, anon, authenticated;

-- A validated replacement becomes the piece's original at a new media revision.
-- The piece keeps its ID, details, labels and source; its earlier cutout stays
-- visible until the new one is published.
create function private.replace_item_photo(p_entry public.upload_entries)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
begin
  select * into v_item from public.items
   where id = p_entry.target_item_id and user_id = p_entry.user_id and lifecycle <> 'deleted' for update;
  if not found then
    -- The piece was removed meanwhile: the photo is not kept.
    update public.upload_entries set state = 'canceled', updated_at = now() where id = p_entry.id;
    perform private.delete_asset(p_entry.asset_id, 'upload_canceled');
    return null;
  end if;
  if exists (select 1 from public.item_assets where asset_id = p_entry.asset_id) then
    return v_item.id;
  end if;
  v_item := private.advance_media_revision(v_item);
  -- The old original is detached first; its bytes are deleted only after that.
  perform private.detach_item_asset(v_item.id, 'original', 'superseded');
  insert into public.item_assets (user_id, item_id, asset_id, role, media_revision)
  values (v_item.user_id, v_item.id, p_entry.asset_id, 'original', v_item.media_revision);
  update public.media_assets set retention = 'retained', expires_at = null, updated_at = now() where id = p_entry.asset_id;
  perform private.enqueue_item_stage(v_item, 'cutout', (private.cutout_models())[1]);
  perform private.enqueue_item_stage(v_item, 'tags', private.tags_task_version());
  return v_item.id;
end;
$$;
revoke all on function private.replace_item_photo(public.upload_entries) from public, anon, authenticated;

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

  -- Targets are checked before anything is created. A label names one garment
  -- photo or piece; a replacement names the member's own piece.
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
    elsif v_purpose = 'replacement' then
      if not v_file ? 'target_item_id' or v_file ? 'label_for' then
        perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'replacement_target',
          'client_file_id', v_file ->> 'client_file_id'));
      end if;
    elsif v_file ? 'label_for' or v_file ? 'target_item_id' then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'label_target',
        'client_file_id', v_file ->> 'client_file_id'));
    end if;
    if v_file ? 'target_item_id' and not exists (
      select 1 from public.items i
       where i.id::text = v_file ->> 'target_item_id' and i.user_id = p_user_id and i.lifecycle <> 'deleted') then
      perform private.raise_app_error('NOT_FOUND', 404, jsonb_build_object('field', 'target_item_id'));
    end if;
  end loop;

  insert into public.upload_batches (user_id, entry_count) values (p_user_id, jsonb_array_length(p_files))
  returning id into v_batch_id;

  for v_file in select * from jsonb_array_elements(p_files) loop
    v_purpose := coalesce(v_file ->> 'purpose', '');
    if v_purpose not in ('garment', 'care_label', 'grouped', 'replacement')
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
    -- A garment is retained now; a label or replacement once attached; a grouped
    -- source never (it stays temporary until its parts are confirmed and cropped).
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
           proposed_parts = case when v_entry.purpose = 'grouped' then coalesce((
             select jsonb_agg(b order by o) from jsonb_array_elements(coalesce(p_output -> 'parts', '[]'::jsonb))
                    with ordinality as p(b, o)
              where o <= 20 and private.valid_part_box(b, v_width, v_height)), '[]'::jsonb) end
     where id = v_entry.id;
    update private.jobs set state = 'succeeded', updated_at = now(), completed_at = now() where id = p_job_id;
    select * into v_entry from public.upload_entries where id = v_entry.id;
    if v_entry.purpose = 'garment' then
      perform private.create_gather_item(v_entry);
    elsif v_entry.purpose = 'replacement' then
      perform private.replace_item_photo(v_entry);
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

-- ---------------------------------------------------------------------------
-- Edited masks and alternate-model cutouts
-- ---------------------------------------------------------------------------

-- The piece's current original, as the base for a new cutout.
create function private.current_original(p_item_id uuid)
returns public.media_assets
language sql
stable
set search_path = ''
as $$
  select a.* from public.item_assets ia join public.media_assets a on a.id = ia.asset_id
   where ia.item_id = p_item_id and ia.role = 'original' and ia.detached_at is null and a.state = 'ready'
   limit 1;
$$;
revoke all on function private.current_original(uuid) from public, anon, authenticated;

-- Records a member-edited mask the API has already verified as a PNG and
-- stored under the piece's edits prefix, and queues a cutout composed from it.
-- Two corrections of the same revision cannot both apply: the second conflicts.
create function public.svc_submit_mask(
  p_user_id uuid,
  p_request_id uuid,
  p_item_id uuid,
  p_media_revision integer,
  p_bucket text,
  p_object_key text,
  p_width integer,
  p_height integer,
  p_byte_size bigint,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_item public.items;
  v_original public.media_assets;
  v_asset_id uuid;
  v_job_id uuid;
begin
  perform private.require_active_member_id(p_user_id);
  v_existing := private.claim_request(p_user_id, 'submit_mask', p_request_id,
    jsonb_build_object('item_id', p_item_id, 'media_revision', p_media_revision, 'sha256', p_sha256));
  if v_existing is not null then
    return v_existing;
  end if;
  select * into v_item from public.items where id = p_item_id and user_id = p_user_id and lifecycle <> 'deleted' for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_item.media_revision <> p_media_revision then
    perform private.raise_app_error('REVISION_CONFLICT', 409, jsonb_build_object('current_media_revision', v_item.media_revision));
  end if;
  v_original := private.current_original(v_item.id);
  if v_original.id is null or p_width is distinct from v_original.width or p_height is distinct from v_original.height then
    perform private.raise_app_error('MASK_REJECTED', 422,
      jsonb_build_object('width', v_original.width, 'height', v_original.height));
  end if;
  if p_object_key not like format('users/%s/items/%s/edits/%%.png', p_user_id, p_item_id)
     or p_sha256 !~ '^[0-9a-f]{64}$' or p_byte_size < 1 then
    perform private.raise_app_error('MASK_REJECTED', 422);
  end if;

  insert into public.media_assets (user_id, purpose, state, retention, expires_at, width, height, content_type, byte_size, sha256)
  values (p_user_id, 'item_mask', 'ready', 'temporary',
    now() + make_interval(hours => (private.upload_limits() ->> 'temporary_asset_hours')::integer),
    p_width, p_height, 'image/png', p_byte_size, p_sha256)
  returning id into v_asset_id;
  insert into private.media_objects (user_id, asset_id, bucket, object_key, role, byte_size, sha256)
  values (p_user_id, v_asset_id, p_bucket, p_object_key, 'mask', p_byte_size, p_sha256);

  v_item := private.advance_media_revision(v_item);
  v_job_id := private.enqueue_item_stage(v_item, 'cutout', 'manual');
  update private.job_payloads set input = input || jsonb_build_object('mask_asset_id', v_asset_id) where job_id = v_job_id;
  return private.complete_request(p_user_id, 'submit_mask', p_request_id,
    jsonb_build_object('item_id', v_item.id, 'media_revision', v_item.media_revision, 'job_id', v_job_id));
end;
$$;

-- An explicit cutout with another pinned model. Bounded: at most three model
-- cutouts per original (the first and two retries), and never started
-- automatically.
create function public.svc_recut_item(
  p_user_id uuid,
  p_request_id uuid,
  p_item_id uuid,
  p_media_revision integer,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_item public.items;
  v_since timestamptz;
  v_job_id uuid;
begin
  perform private.require_active_member_id(p_user_id);
  if p_model is null or not p_model = any (private.cutout_models()) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'model'));
  end if;
  v_existing := private.claim_request(p_user_id, 'recut_item', p_request_id,
    jsonb_build_object('item_id', p_item_id, 'media_revision', p_media_revision, 'model', p_model));
  if v_existing is not null then
    return v_existing;
  end if;
  select * into v_item from public.items where id = p_item_id and user_id = p_user_id and lifecycle <> 'deleted' for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_item.media_revision <> p_media_revision then
    perform private.raise_app_error('REVISION_CONFLICT', 409, jsonb_build_object('current_media_revision', v_item.media_revision));
  end if;
  select ia.created_at into v_since from public.item_assets ia
   where ia.item_id = v_item.id and ia.role = 'original' and ia.detached_at is null;
  if v_since is null then
    perform private.raise_app_error('RETRY_NOT_AVAILABLE', 409);
  end if;
  if (select count(*) from private.jobs j
       where j.kind = 'item_stage' and j.stage = 'cutout' and j.target_id = v_item.id and j.created_at >= v_since
         and split_part(j.dedupe_key, ':', 5) = any (private.cutout_models())) >= 3 then
    perform private.raise_app_error('RETRY_LIMIT_REACHED', 409);
  end if;
  v_item := private.advance_media_revision(v_item);
  v_job_id := private.enqueue_item_stage(v_item, 'cutout', p_model);
  return private.complete_request(p_user_id, 'recut_item', p_request_id,
    jsonb_build_object('item_id', v_item.id, 'media_revision', v_item.media_revision, 'job_id', v_job_id));
end;
$$;

-- A submitted mask that never reached a cutout job's end is deleted with its
-- temporary window.
create function public.svc_expire_mask_inputs(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.media_assets;
  v_count integer := 0;
begin
  for v_asset in
    select a.* from public.media_assets a
     where a.purpose = 'item_mask' and a.retention = 'temporary' and a.state = 'ready' and a.expires_at <= now()
     limit p_limit for update skip locked
  loop
    perform private.delete_asset(v_asset.id, 'upload_expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- The cutout stage reads the submitted mask when there is one.
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
  v_mask private.media_objects;
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
  if p_job.stage = 'cutout' and v_input ? 'mask_asset_id' then
    select o.* into v_mask from private.media_objects o join public.media_assets a on a.id = o.asset_id
     where o.asset_id = (v_input ->> 'mask_asset_id')::uuid and o.role = 'mask' and o.deleted_at is null
       and a.user_id = v_item.user_id and a.state = 'ready' and a.width = v_source.width and a.height = v_source.height;
  end if;
  if v_object.object_key is null or (v_input ? 'mask_asset_id' and v_mask.object_key is null) then
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
                    when v_mask.object_key is not null
                      then jsonb_build_object('original', v_object.object_key, 'mask', v_mask.object_key)
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

-- Unchanged from P1.04 except that a submitted mask is deleted once its cutout
-- job ends, whatever the outcome.
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
  v_mask_input uuid;
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
  v_mask_input := (v_input ->> 'mask_asset_id')::uuid;
  if v_mask_input is not null then
    perform private.delete_asset(v_mask_input, 'mask_input_used');
  end if;
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
    'public.svc_submit_mask(uuid, uuid, uuid, integer, text, text, integer, integer, bigint, text)',
    'public.svc_recut_item(uuid, uuid, uuid, integer, text)',
    'public.svc_expire_mask_inputs(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
