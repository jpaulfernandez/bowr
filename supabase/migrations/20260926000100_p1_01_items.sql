-- P1.01: add one piece and correct it without AI.
-- A validated garment upload becomes exactly one visible item in the same
-- transaction, with a queued cutout stage. Lifecycle, processing and review are
-- separate: items.lifecycle, public.item_stages and items.category_review_required.

-- ---------------------------------------------------------------------------
-- Taxonomy (versioned shared data; packages/domain/src/taxonomy.ts is the source
-- and the integration suite fails if this copy drifts).
-- ---------------------------------------------------------------------------
create function private.taxonomy()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{"version":1,"categories":{"tops":["t-shirt","shirt","polo","blouse","sweater","hoodie","tank","other"],"bottoms":["jeans","trousers","shorts","skirt","leggings","other"],"outerwear":["jacket","coat","blazer","cardigan","vest","other"],"dresses":["dress","jumpsuit","other"],"shoes":["sneakers","loafers","boots","sandals","slides","heels","other"],"eyewear":["shades","optical frames"],"headwear":["cap","bucket hat","beanie","other"],"bags":["tote","backpack","crossbody","shoulder bag","clutch","other"],"belts":["belt"],"watches":["watch"],"jewelry":["earrings","necklace","bracelet","ring","other"]},"patterns":["solid","striped","checked","floral","graphic","printed","dotted","textured","other"],"seasons":["hot","mild","cold","rainy"],"colors":["black","charcoal","grey","white","cream","beige","khaki","tan","brown","burgundy","red","pink","orange","mustard","yellow","olive","green","teal","light blue","blue","navy","purple","silver","gold"],"attributes":{"sole_color":{"categories":["shoes"],"values":["black","charcoal","grey","white","cream","beige","khaki","tan","brown","burgundy","red","pink","orange","mustard","yellow","olive","green","teal","light blue","blue","navy","purple","silver","gold"]},"frame_shape":{"categories":["eyewear"],"values":["round","square","rectangle","aviator","cat-eye","oval","other"]},"frame_color":{"categories":["eyewear"],"values":["black","charcoal","grey","white","cream","beige","khaki","tan","brown","burgundy","red","pink","orange","mustard","yellow","olive","green","teal","light blue","blue","navy","purple","silver","gold"]},"lens_tint":{"categories":["eyewear"],"values":["clear","dark","gradient","mirrored","colored"]},"has_logo":{"categories":["headwear"],"values":[true,false]}},"max_colors":5,"max_style_tags":10}'::jsonb;
$$;
revoke all on function private.taxonomy() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Media: derived renditions are their own assets with one object each.
-- ---------------------------------------------------------------------------
alter table public.media_assets drop constraint media_assets_purpose_check;
alter table public.media_assets drop constraint media_assets_content_type_check;
alter table public.media_assets
  add constraint media_assets_purpose_check
    check (purpose in ('gather_original', 'care_label', 'item_cutout', 'item_thumbnail', 'item_mask')),
  add constraint media_assets_content_type_check check (content_type in ('image/webp', 'image/png'));

alter table private.media_objects drop constraint media_objects_role_check;
alter table private.media_objects
  add constraint media_objects_role_check check (role in ('quarantine', 'original', 'cutout', 'thumbnail', 'mask'));

alter table private.deletion_tasks drop constraint deletion_tasks_reason_check;
alter table private.deletion_tasks add constraint deletion_tasks_reason_check check (reason in (
  'quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload',
  'account_deleted', 'upload_expired', 'orphan', 'superseded'));

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------
create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null default 'gather' check (source in ('gather')),
  source_entry_id uuid,
  lifecycle text not null default 'active' check (lifecycle in ('active', 'archived', 'deleted')),
  category_review_required boolean not null default true,
  reviewed_at timestamptz,
  revision bigint not null default 1 check (revision >= 1),
  media_revision integer not null default 1 check (media_revision >= 1),
  -- Core tags. A null name means "generate one from the tags" (DESIGN 6.2).
  name text check (name is null or char_length(name) between 1 and 80),
  category text,
  subcategory text,
  pattern text,
  material text check (material is null or char_length(material) between 1 and 60),
  formality smallint check (formality between 1 and 5),
  colors jsonb not null default '[]'::jsonb
    check (jsonb_typeof(colors) = 'array' and jsonb_array_length(colors) <= 5),
  seasons text[] not null default '{}' check (cardinality(seasons) <= 4),
  style_tags text[] not null default '{}' check (cardinality(style_tags) <= 10),
  attributes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(attributes) = 'object' and octet_length(attributes::text) <= 512),
  -- Optional details; never required to use the app.
  brand text check (brand is null or char_length(brand) between 1 and 60),
  size_label text check (size_label is null or char_length(size_label) between 1 and 20),
  price_minor bigint check (price_minor between 0 and 1000000000000),
  currency text check (currency ~ '^[A-Z]{3}$'),
  purchased_on date,
  -- Which rendition the member chose to show ("Use original").
  display_image text not null default 'cutout' check (display_image in ('cutout', 'original')),
  -- Per-field version, source (user, vision, label, computed), lock and time.
  field_meta jsonb not null default '{}'::jsonb check (jsonb_typeof(field_meta) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  unique (user_id, id),
  constraint items_price_has_currency check (price_minor is null or currency is not null),
  foreign key (user_id, source_entry_id) references public.upload_entries (user_id, id) on delete set null (source_entry_id)
);
-- One visible item per ordinary upload entry, however often completion repeats.
create unique index items_source_entry on public.items (source_entry_id) where source_entry_id is not null;
create index items_owner_recent on public.items (user_id, lifecycle, created_at desc, id);
create index items_owner_category on public.items (user_id, category);

create table public.item_assets (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  item_id uuid not null,
  asset_id uuid not null unique,
  role text not null check (role in ('original', 'cutout', 'thumbnail', 'mask', 'label')),
  media_revision integer not null check (media_revision >= 1),
  created_at timestamptz not null default now(),
  detached_at timestamptz,
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade,
  foreign key (user_id, asset_id) references public.media_assets (user_id, id) on delete cascade
);
-- One current original/cutout/thumbnail/mask per item; labels may be several.
create unique index item_assets_current on public.item_assets (item_id, role)
  where detached_at is null and role <> 'label';
create index item_assets_item on public.item_assets (user_id, item_id);

-- Owner-visible processing state per stage, kept in step with the private job.
create table public.item_stages (
  user_id uuid not null,
  item_id uuid not null,
  stage text not null check (stage in ('cutout')),
  media_revision integer not null,
  state text not null check (state in ('queued', 'running', 'retry_wait', 'blocked_budget', 'succeeded', 'failed', 'canceled')),
  failure_code text check (failure_code ~ '^[A-Z_]{3,40}$'),
  model text,
  job_id uuid not null,
  can_retry boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (item_id, stage),
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade
);

do $$
declare
  v_table text;
begin
  foreach v_table in array array['items', 'item_assets', 'item_stages'] loop
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
-- Item stage jobs
-- ---------------------------------------------------------------------------
alter table private.jobs drop constraint jobs_kind_check;
alter table private.jobs drop constraint jobs_stage_check;
alter table private.jobs
  add constraint jobs_kind_check check (kind in ('validate_upload', 'item_stage')),
  add constraint jobs_stage_check check (stage in ('validate', 'cutout')),
  -- The media revision an item stage was computed for; stale results are fenced.
  add column target_revision integer;

create function private.cutout_models()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['isnet_general_use', 'u2netp'];
$$;
revoke all on function private.cutout_models() from public, anon, authenticated;

-- Queues one stage for an item's current media revision. The dedupe key names the
-- item, revision, stage and model, so repeating the request reuses the same job.
create function private.enqueue_item_stage(p_item public.items, p_stage text, p_model text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_key text := format('item:%s:mr%s:%s:%s', p_item.id, p_item.media_revision, p_stage, p_model);
begin
  insert into private.jobs (user_id, kind, stage, target_id, target_revision, dedupe_key)
  values (p_item.user_id, 'item_stage', p_stage, p_item.id, p_item.media_revision, v_key)
  on conflict (dedupe_key) do nothing
  returning id into v_job_id;
  if v_job_id is null then
    select id into v_job_id from private.jobs where dedupe_key = v_key;
    return v_job_id;
  end if;
  insert into private.job_payloads (job_id, input)
  values (v_job_id, jsonb_build_object('schema_version', 1, 'stage', p_stage, 'model', p_model));
  insert into public.item_stages (user_id, item_id, stage, media_revision, state, model, job_id)
  values (p_item.user_id, p_item.id, p_stage, p_item.media_revision, 'queued', p_model, v_job_id)
  on conflict (item_id, stage) do update
    set media_revision = excluded.media_revision, state = 'queued', failure_code = null, model = excluded.model,
        job_id = excluded.job_id, can_retry = false, updated_at = now();
  return v_job_id;
end;
$$;
revoke all on function private.enqueue_item_stage(public.items, text, text) from public, anon, authenticated;

-- Every job transition (claim, retry, lease expiry, cancel, restore) is mirrored
-- to the stage row that points at that job.
create function private.sync_item_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'item_stage' then
    update public.item_stages
       set state = new.state,
           failure_code = case when new.state in ('failed', 'canceled', 'retry_wait') then new.failure_code end,
           can_retry = new.state in ('failed', 'canceled') and new.manual_retries < 2,
           updated_at = now()
     where item_id = new.target_id and stage = new.stage and job_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.sync_item_stage() from public, anon, authenticated;
create trigger jobs_sync_item_stage after update of state, failure_code, manual_retries on private.jobs
  for each row execute function private.sync_item_stage();

-- A validated garment becomes one item with its original attached, and its
-- cutout is queued. Called inside the validation completion transaction.
create function private.create_gather_item(p_entry public.upload_entries)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
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
  return v_item.id;
end;
$$;
revoke all on function private.create_gather_item(public.upload_entries) from public, anon, authenticated;

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
    select * into v_entry from public.upload_entries where id = v_entry.id;
    perform private.create_gather_item(v_entry);
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

-- Claim for an item stage: the item must still exist at the job's media revision.
create function private.claim_item_stage(p_job private.jobs)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_limits jsonb := private.job_limits();
  v_item public.items;
  v_original public.media_assets;
  v_object private.media_objects;
  v_input jsonb;
  v_job private.jobs;
  v_prefix text;
begin
  select * into v_item from public.items where id = p_job.target_id for update;
  if not found or v_item.lifecycle = 'deleted' or v_item.media_revision <> p_job.target_revision
     or not private.is_active_member(p_job.user_id) then
    update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now(),
           failure_code = case when v_item.id is null or v_item.lifecycle = 'deleted' or v_item.media_revision <> p_job.target_revision
                               then 'SUPERSEDED' end
     where id = p_job.id;
    perform private.raise_app_error('CLAIM_REJECTED', 403);
  end if;
  select a.* into v_original from public.item_assets ia join public.media_assets a on a.id = ia.asset_id
   where ia.item_id = v_item.id and ia.role = 'original' and ia.detached_at is null and a.state = 'ready';
  select * into v_object from private.media_objects
   where asset_id = v_original.id and role = 'original' and deleted_at is null;
  if v_object.object_key is null then
    update private.jobs set state = 'failed', failure_code = 'SOURCE_MISSING', claim_nonce_hash = null,
           updated_at = now(), completed_at = now()
     where id = p_job.id;
    perform private.raise_app_error('CLAIM_REJECTED', 403, jsonb_build_object('reason', 'source'));
  end if;
  select input into v_input from private.job_payloads where job_id = p_job.id;

  update private.jobs
     set state = 'running', claim_nonce_hash = null, claim_expires_at = null,
         lease_generation = lease_generation + 1, attempt_count = attempt_count + 1,
         claimed_at = now(), heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => (v_limits ->> 'lease_seconds')::integer), updated_at = now()
   where id = p_job.id
  returning * into v_job;

  -- Immutable per-job, per-attempt keys under the item's own prefix.
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
    'sources', jsonb_build_object('original', v_object.object_key),
    'outputs', case v_job.stage
      when 'cutout' then jsonb_build_object(
        'cutout', format('%s/cutout-%s-g%s.webp', v_prefix, v_job.id, v_job.lease_generation),
        'thumbnail', format('%s/thumbnail-%s-g%s.webp', v_prefix, v_job.id, v_job.lease_generation),
        'mask', format('%s/mask-%s-g%s.png', v_prefix, v_job.id, v_job.lease_generation))
      else '{}'::jsonb end,
    'input', jsonb_build_object(
      'model', v_input ->> 'model',
      'original', jsonb_build_object('width', v_original.width, 'height', v_original.height),
      'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint
    )
  );
end;
$$;
revoke all on function private.claim_item_stage(private.jobs) from public, anon, authenticated;

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
      'purpose', v_input ->> 'purpose',
      'rotation', (v_input ->> 'rotation')::integer,
      'max_bytes', (private.upload_limits() ->> 'max_bytes')::bigint,
      'max_pixels', (private.upload_limits() ->> 'max_pixels')::bigint,
      'max_edge', case when v_asset.purpose = 'care_label' then 2048 else 1024 end
    )
  );
end;
$$;

-- Detaches an item's current rendition of one role and queues its bytes for
-- deletion once nothing else references the asset.
create function private.detach_item_asset(p_item_id uuid, p_role text, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_link public.item_assets;
  v_object private.media_objects;
begin
  for v_link in select * from public.item_assets
                 where item_id = p_item_id and role = p_role and detached_at is null for update loop
    update public.item_assets set detached_at = now() where id = v_link.id;
    update public.media_assets set state = 'deletion_pending', updated_at = now()
     where id = v_link.asset_id and state not in ('deleted', 'deletion_pending');
    for v_object in select * from private.media_objects where asset_id = v_link.asset_id and deleted_at is null loop
      perform private.enqueue_object_deletion(v_link.user_id, v_object.bucket, v_object.object_key, p_reason, now());
    end loop;
  end loop;
end;
$$;
revoke all on function private.detach_item_asset(uuid, text, text) from public, anon, authenticated;

-- Publishes one rendition produced by an item stage as a new retained asset.
create function private.attach_item_output(p_item public.items, p_role text, p_bucket text, p_output jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_asset_id uuid;
begin
  perform private.detach_item_asset(p_item.id, p_role, 'superseded');
  insert into public.media_assets (user_id, purpose, state, retention, media_revision, width, height, content_type,
    byte_size, sha256)
  values (p_item.user_id, 'item_' || p_role, 'ready', 'retained', p_item.media_revision,
    (p_output ->> 'width')::integer, (p_output ->> 'height')::integer, p_output ->> 'content_type',
    (p_output ->> 'byte_size')::bigint, p_output ->> 'sha256')
  returning id into v_asset_id;
  insert into private.media_objects (user_id, asset_id, bucket, object_key, role, byte_size, sha256)
  values (p_item.user_id, v_asset_id, p_bucket, p_output ->> 'object_key', p_role,
    (p_output ->> 'byte_size')::bigint, p_output ->> 'sha256');
  insert into public.item_assets (user_id, item_id, asset_id, role, media_revision)
  values (p_item.user_id, p_item.id, v_asset_id, p_role, p_item.media_revision);
  return v_asset_id;
end;
$$;
revoke all on function private.attach_item_output(public.items, text, text, jsonb) from public, anon, authenticated;

-- Applies an item stage result only if the lease is current and the item is
-- still at the job's media revision. A repeat is a no-op; a fenced result is
-- reported stale so its outputs are discarded.
create function public.svc_complete_item_stage(
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
  v_role text;
  v_bucket text;
  v_width integer;
  v_height integer;
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
  select * into v_item from public.items where id = v_job.target_id for update;
  if not found or v_item.lifecycle = 'deleted' or v_item.media_revision <> v_job.target_revision then
    update private.jobs set state = 'canceled', failure_code = 'SUPERSEDED', updated_at = now(), completed_at = now()
     where id = p_job_id;
    return jsonb_build_object('status', 'stale');
  end if;

  if p_outcome = 'ready' and v_job.stage = 'cutout' then
    select o.bucket, a.width, a.height into v_bucket, v_width, v_height
      from public.item_assets ia
      join public.media_assets a on a.id = ia.asset_id
      join private.media_objects o on o.asset_id = ia.asset_id
     where ia.item_id = v_item.id and ia.role = 'original' and ia.detached_at is null limit 1;
    -- The editable mask must cover the original pixel for pixel.
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
    update private.jobs set state = 'succeeded', failure_code = null, updated_at = now(), completed_at = now()
     where id = p_job_id;
  elsif p_outcome = 'rejected' then
    update private.jobs set state = 'failed', failure_code = p_failure_code, updated_at = now(), completed_at = now()
     where id = p_job_id;
  else
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'outcome'));
  end if;
  return jsonb_build_object('status', 'applied', 'state', case when p_outcome = 'ready' then 'succeeded' else 'failed' end);
end;
$$;

-- Owner retries a failed or interrupted stage for the current media revision.
-- Finite: two manual retries per job, each with a fresh budget of attempts.
create function public.svc_retry_item_stage(p_user_id uuid, p_item_id uuid, p_stage text, p_media_revision integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_stage public.item_stages;
  v_job private.jobs;
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_item from public.items where id = p_item_id and user_id = p_user_id and lifecycle <> 'deleted' for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_item.media_revision <> p_media_revision then
    perform private.raise_app_error('REVISION_CONFLICT', 409, jsonb_build_object('current_media_revision', v_item.media_revision));
  end if;
  select * into v_stage from public.item_stages where item_id = p_item_id and stage = p_stage;
  if not found or v_stage.state not in ('failed', 'canceled') then
    perform private.raise_app_error('RETRY_NOT_AVAILABLE', 409, jsonb_build_object('state', v_stage.state));
  end if;
  select * into v_job from private.jobs where id = v_stage.job_id for update;
  if v_job.manual_retries >= 2 then
    perform private.raise_app_error('RETRY_LIMIT_REACHED', 409);
  end if;
  update private.jobs
     set state = 'queued', attempt_count = 0, manual_retries = manual_retries + 1, failure_code = null,
         next_run_at = now(), completed_at = null, updated_at = now()
   where id = v_job.id;
  return jsonb_build_object('item_id', p_item_id, 'stage', p_stage, 'state', 'queued', 'job_id', v_job.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- update_item: revisioned, idempotent, allowlisted, taxonomy-validated.
-- Every edited field becomes a locked user value; clearing a field is an edit.
-- ---------------------------------------------------------------------------
create function private.item_json(p_item public.items)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_item.id, 'lifecycle', p_item.lifecycle, 'name', p_item.name, 'category', p_item.category,
    'subcategory', p_item.subcategory, 'pattern', p_item.pattern, 'material', p_item.material,
    'formality', p_item.formality, 'colors', p_item.colors, 'seasons', to_jsonb(p_item.seasons),
    'style_tags', to_jsonb(p_item.style_tags), 'attributes', p_item.attributes, 'brand', p_item.brand,
    'size_label', p_item.size_label, 'price_minor', p_item.price_minor, 'currency', p_item.currency,
    'purchased_on', p_item.purchased_on, 'display_image', p_item.display_image,
    'category_review_required', p_item.category_review_required, 'field_meta', p_item.field_meta,
    'revision', p_item.revision, 'media_revision', p_item.media_revision, 'updated_at', p_item.updated_at);
$$;
revoke all on function private.item_json(public.items) from public, anon, authenticated;

create function private.invalid_item_field(p_field text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', p_field));
end;
$$;
revoke all on function private.invalid_item_field(text) from public, anon, authenticated;

-- Validates a patch against the taxonomy. Returns the resulting category, so
-- dependent fields (subcategory, attributes) are checked against it.
create function private.validate_item_patch(p_patch jsonb, p_item public.items)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tax jsonb := private.taxonomy();
  v_category text := case when p_patch ? 'category' then p_patch ->> 'category' else p_item.category end;
  v_value jsonb;
  v_key text;
begin
  if p_patch ? 'name' and jsonb_typeof(p_patch -> 'name') not in ('string', 'null') then
    perform private.invalid_item_field('name');
  end if;
  if p_patch ? 'category' and jsonb_typeof(p_patch -> 'category') <> 'null'
     and not (v_tax -> 'categories') ? (p_patch ->> 'category') then
    perform private.invalid_item_field('category');
  end if;
  if p_patch ? 'subcategory' and jsonb_typeof(p_patch -> 'subcategory') <> 'null'
     and (v_category is null or not (v_tax -> 'categories' -> v_category) ? (p_patch ->> 'subcategory')) then
    perform private.invalid_item_field('subcategory');
  end if;
  if p_patch ? 'pattern' and jsonb_typeof(p_patch -> 'pattern') <> 'null'
     and not (v_tax -> 'patterns') ? (p_patch ->> 'pattern') then
    perform private.invalid_item_field('pattern');
  end if;
  foreach v_key in array array['material', 'brand', 'size_label', 'currency', 'purchased_on'] loop
    if p_patch ? v_key and jsonb_typeof(p_patch -> v_key) not in ('string', 'null') then
      perform private.invalid_item_field(v_key);
    end if;
  end loop;
  if p_patch ? 'purchased_on' and jsonb_typeof(p_patch -> 'purchased_on') = 'string'
     and (p_patch ->> 'purchased_on' !~ '^\d{4}-\d{2}-\d{2}$') then
    perform private.invalid_item_field('purchased_on');
  end if;
  if p_patch ? 'formality' and jsonb_typeof(p_patch -> 'formality') <> 'null'
     and (jsonb_typeof(p_patch -> 'formality') <> 'number' or (p_patch ->> 'formality') !~ '^[1-5]$') then
    perform private.invalid_item_field('formality');
  end if;
  if p_patch ? 'price_minor' and jsonb_typeof(p_patch -> 'price_minor') <> 'null'
     and (jsonb_typeof(p_patch -> 'price_minor') <> 'number' or (p_patch ->> 'price_minor') !~ '^\d{1,13}$') then
    perform private.invalid_item_field('price_minor');
  end if;
  if p_patch ? 'display_image' and coalesce(p_patch ->> 'display_image', '') not in ('cutout', 'original') then
    perform private.invalid_item_field('display_image');
  end if;

  if p_patch ? 'colors' then
    if jsonb_typeof(p_patch -> 'colors') <> 'array'
       or jsonb_array_length(p_patch -> 'colors') > (v_tax ->> 'max_colors')::integer then
      perform private.invalid_item_field('colors');
    end if;
    for v_value in select * from jsonb_array_elements(p_patch -> 'colors') loop
      if jsonb_typeof(v_value) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_value) k where k not in ('hex', 'name', 'proportion'))
         or not (v_tax -> 'colors') ? coalesce(v_value ->> 'name', '')
         or coalesce(v_value ->> 'hex', '') !~ '^#[0-9A-Fa-f]{6}$'
         or (v_value ? 'proportion' and (jsonb_typeof(v_value -> 'proportion') <> 'number'
             or (v_value ->> 'proportion')::numeric not between 0 and 1)) then
        perform private.invalid_item_field('colors');
      end if;
    end loop;
    if (select count(distinct e ->> 'name') from jsonb_array_elements(p_patch -> 'colors') e)
       <> jsonb_array_length(p_patch -> 'colors') then
      perform private.invalid_item_field('colors');
    end if;
  end if;

  if p_patch ? 'seasons' then
    if jsonb_typeof(p_patch -> 'seasons') <> 'array'
       or exists (select 1 from jsonb_array_elements(p_patch -> 'seasons') s
                   where jsonb_typeof(s) <> 'string' or not (v_tax -> 'seasons') ? (s #>> '{}'))
       or (select count(distinct s) from jsonb_array_elements_text(p_patch -> 'seasons') s)
          <> jsonb_array_length(p_patch -> 'seasons') then
      perform private.invalid_item_field('seasons');
    end if;
  end if;

  if p_patch ? 'style_tags' then
    if jsonb_typeof(p_patch -> 'style_tags') <> 'array'
       or jsonb_array_length(p_patch -> 'style_tags') > (v_tax ->> 'max_style_tags')::integer
       or exists (select 1 from jsonb_array_elements(p_patch -> 'style_tags') t
                   where jsonb_typeof(t) <> 'string' or (t #>> '{}') !~ '^[a-z0-9][a-z0-9 -]{0,23}$')
       or (select count(distinct t) from jsonb_array_elements_text(p_patch -> 'style_tags') t)
          <> jsonb_array_length(p_patch -> 'style_tags') then
      perform private.invalid_item_field('style_tags');
    end if;
  end if;

  if p_patch ? 'attributes' then
    if jsonb_typeof(p_patch -> 'attributes') <> 'object' then
      perform private.invalid_item_field('attributes');
    end if;
    for v_key, v_value in select * from jsonb_each(p_patch -> 'attributes') loop
      if not (v_tax -> 'attributes') ? v_key
         or v_category is null
         or not (v_tax -> 'attributes' -> v_key -> 'categories') ? v_category
         or not (v_tax -> 'attributes' -> v_key -> 'values') @> jsonb_build_array(v_value) then
        perform private.invalid_item_field('attributes');
      end if;
    end loop;
  end if;
end;
$$;
revoke all on function private.validate_item_patch(jsonb, public.items) from public, anon, authenticated;

create function public.update_item(p_request_id uuid, p_item_id uuid, p_expected_revision bigint, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_member();
  v_tracked constant text[] := array['name', 'category', 'subcategory', 'pattern', 'material', 'formality', 'colors',
    'seasons', 'style_tags', 'attributes', 'brand', 'size_label', 'price_minor', 'currency', 'purchased_on'];
  v_allowed constant text[] := v_tracked || array['display_image'];
  v_unknown text[];
  v_existing jsonb;
  v_item public.items;
  v_meta jsonb;
  v_field text;
  v_category text;
  v_subcategory text;
  v_attributes jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'patch'));
  end if;
  select array_agg(k) into v_unknown from jsonb_object_keys(p_patch) k where k <> all (v_allowed);
  if v_unknown is not null then
    perform private.raise_app_error('VALIDATION_FAILED', 422,
      jsonb_build_object('reason', 'unexpected_fields', 'fields', to_jsonb(v_unknown)));
  end if;

  v_existing := private.claim_request(v_uid, 'update_item', p_request_id,
    jsonb_build_object('item_id', p_item_id, 'expected_revision', p_expected_revision, 'patch', p_patch));
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_item from public.items where id = p_item_id and user_id = v_uid and lifecycle <> 'deleted' for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_item.revision <> p_expected_revision then
    perform private.raise_app_error('REVISION_CONFLICT', 409, jsonb_build_object('current_revision', v_item.revision));
  end if;
  perform private.validate_item_patch(p_patch, v_item);

  v_category := case when p_patch ? 'category' then p_patch ->> 'category' else v_item.category end;
  -- A category change clears a subcategory and attributes that no longer apply.
  v_subcategory := case when p_patch ? 'subcategory' then p_patch ->> 'subcategory' else v_item.subcategory end;
  if v_subcategory is not null
     and (v_category is null or not (private.taxonomy() -> 'categories' -> v_category) ? v_subcategory) then
    v_subcategory := null;
  end if;
  v_attributes := coalesce((
    select jsonb_object_agg(key, value) from jsonb_each(case when p_patch ? 'attributes' then p_patch -> 'attributes'
                                                              else v_item.attributes end)
     where v_category is not null and (private.taxonomy() -> 'attributes' -> key -> 'categories') ? v_category
  ), '{}'::jsonb);

  v_meta := v_item.field_meta;
  foreach v_field in array v_tracked loop
    if p_patch ? v_field then
      v_meta := jsonb_set(v_meta, array[v_field], jsonb_build_object(
        'v', coalesce((v_meta -> v_field ->> 'v')::integer, 0) + 1, 'source', 'user', 'locked', true, 'at', now()));
    end if;
  end loop;

  begin
    update public.items set
      name = case when p_patch ? 'name' then nullif(btrim(p_patch ->> 'name'), '') else name end,
      category = v_category,
      subcategory = v_subcategory,
      pattern = case when p_patch ? 'pattern' then p_patch ->> 'pattern' else pattern end,
      material = case when p_patch ? 'material' then nullif(btrim(p_patch ->> 'material'), '') else material end,
      formality = case when p_patch ? 'formality' then (p_patch ->> 'formality')::smallint else formality end,
      colors = case when p_patch ? 'colors' then p_patch -> 'colors' else colors end,
      seasons = case when p_patch ? 'seasons' then array(select jsonb_array_elements_text(p_patch -> 'seasons')) else seasons end,
      style_tags = case when p_patch ? 'style_tags' then array(select jsonb_array_elements_text(p_patch -> 'style_tags')) else style_tags end,
      attributes = v_attributes,
      brand = case when p_patch ? 'brand' then nullif(btrim(p_patch ->> 'brand'), '') else brand end,
      size_label = case when p_patch ? 'size_label' then nullif(btrim(p_patch ->> 'size_label'), '') else size_label end,
      price_minor = case when p_patch ? 'price_minor' then (p_patch ->> 'price_minor')::bigint else price_minor end,
      currency = case when p_patch ? 'currency' then p_patch ->> 'currency' else currency end,
      purchased_on = case when p_patch ? 'purchased_on' then (p_patch ->> 'purchased_on')::date else purchased_on end,
      display_image = case when p_patch ? 'display_image' then p_patch ->> 'display_image' else display_image end,
      -- Choosing a category (including confirming the current one) resolves review.
      category_review_required = case when p_patch ? 'category' then v_category is null else category_review_required end,
      reviewed_at = case when p_patch ? 'category' and v_category is not null then now() else reviewed_at end,
      field_meta = v_meta,
      revision = revision + 1,
      updated_at = now()
    where id = p_item_id
    returning * into v_item;
  exception
    when check_violation or not_null_violation or invalid_datetime_format or datetime_field_overflow then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'invalid_value'));
  end;
  if v_item.purchased_on > current_date + 1 then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'purchased_on'));
  end if;

  return private.complete_request(v_uid, 'update_item', p_request_id, private.item_json(v_item));
end;
$$;
revoke all on function public.update_item(uuid, uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.update_item(uuid, uuid, bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Media access: a requested variant must name the object's own role, so an
-- upload's quarantine bytes and unknown variants stay unsignable.
-- ---------------------------------------------------------------------------
create or replace function public.svc_authorize_media_access(p_user_id uuid, p_requests jsonb)
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
      on o.asset_id = a.id and o.deleted_at is null and o.role <> 'quarantine' and o.role = r ->> 'variant'
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lifecycle hooks
-- ---------------------------------------------------------------------------
create or replace function private.scrub_account_domain(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.profiles set display_name = null, city = null, revision = revision + 1, updated_at = now()
   where id = p_user_id;
  -- Items first: their attachments reference the assets removed below.
  delete from public.items where user_id = p_user_id;
  delete from public.upload_batches where user_id = p_user_id;
  delete from public.media_assets where user_id = p_user_id;
  delete from private.job_payloads where job_id in (select id from private.jobs where user_id = p_user_id);
  delete from private.mutation_requests where user_id = p_user_id;
  delete from private.reauth_challenges where user_id = p_user_id and consumed_at is null;
  -- Accounting stays for the shared ledger, detached from the person.
  update private.ai_usage set user_id = null where user_id = p_user_id;
end;
$$;

-- Restoring a suspended member also resumes item stages the suspension canceled
-- (a superseded stage carries SUPERSEDED and stays canceled).
create or replace function public.svc_admin_set_suspension(p_actor_id uuid, p_member_id uuid, p_suspend boolean)
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
    update private.jobs set state = 'canceled', claim_nonce_hash = null, updated_at = now(), completed_at = now()
     where user_id = p_member_id and state in ('queued', 'running', 'retry_wait');
    update public.upload_entries set state = 'uploaded', updated_at = now()
     where user_id = p_member_id and state = 'validating';
    insert into private.audit_events (actor_id, action, target_type, target_id)
    values (p_actor_id, 'member_suspended', 'membership', p_member_id);
  elsif not p_suspend and v_member.state = 'suspended' then
    update private.memberships set state = 'active', suspended_at = null, updated_at = now() where user_id = p_member_id;
    update private.jobs set state = 'queued', attempt_count = 0, next_run_at = now(), completed_at = null, updated_at = now()
     where user_id = p_member_id and state = 'canceled' and kind = 'validate_upload'
       and target_id in (select asset_id from public.upload_entries where user_id = p_member_id and state = 'uploaded');
    update private.jobs j set state = 'queued', attempt_count = 0, next_run_at = now(), completed_at = null, updated_at = now()
      from public.items i
     where j.user_id = p_member_id and j.state = 'canceled' and j.kind = 'item_stage' and j.failure_code is null
       and i.id = j.target_id and i.lifecycle <> 'deleted' and i.media_revision = j.target_revision;
    insert into private.audit_events (actor_id, action, target_type, target_id)
    values (p_actor_id, 'member_restored', 'membership', p_member_id);
  end if;
  select * into v_member from private.memberships where user_id = p_member_id;
  return jsonb_build_object('user_id', p_member_id, 'state', v_member.state);
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_complete_item_stage(uuid, integer, text, jsonb, jsonb, text)',
    'public.svc_retry_item_stage(uuid, uuid, text, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
