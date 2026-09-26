-- P1.02: receive tags, colors and embeddings without losing edits.
-- Colors and embeddings are computed locally from the cutout; tags come from the
-- budget-gated gateway. Every result is bounded, versioned and applied only to
-- fields whose captured version still matches and that the member has not locked,
-- and only for the media revision it was computed from.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Stages
-- ---------------------------------------------------------------------------
alter table private.jobs drop constraint jobs_stage_check;
alter table private.jobs add constraint jobs_stage_check check (stage in ('validate', 'cutout', 'colors', 'embedding', 'tags'));
alter table public.item_stages drop constraint item_stages_stage_check;
alter table public.item_stages add constraint item_stages_stage_check check (stage in ('cutout', 'colors', 'embedding', 'tags'));
-- A parked tag job resumed after a budget reset needs a new attempt identity;
-- the refused attempt under the old identity is never reused.
alter table private.jobs add column budget_resumes integer not null default 0 check (budget_resumes between 0 and 24);

-- ---------------------------------------------------------------------------
-- Vector space: exactly one current embedding space. Vectors from any other
-- model, revision or preprocessing are never compared with it. Unset means
-- embeddings are not computed and visual matching is unavailable.
-- ---------------------------------------------------------------------------
create table private.embedding_space (
  id boolean primary key default true check (id),
  model text not null check (char_length(model) between 1 and 64),
  model_revision text not null check (char_length(model_revision) between 1 and 64),
  preprocess_version text not null check (char_length(preprocess_version) between 1 and 64),
  dimension integer not null check (dimension = 512),
  updated_at timestamptz not null default now()
);
revoke all on private.embedding_space from public, anon, authenticated;

create table public.item_embeddings (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  item_id uuid not null,
  model text not null,
  model_revision text not null,
  preprocess_version text not null,
  media_revision integer not null,
  embedding extensions.vector(512) not null,
  created_at timestamptz not null default now(),
  unique (item_id, model, model_revision, preprocess_version, media_revision),
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade
);
create index item_embeddings_owner on public.item_embeddings (user_id, model, model_revision, preprocess_version);
-- Vectors are private: members read that a current embedding exists (the stage
-- row), not the vector itself.
alter table public.item_embeddings enable row level security;
revoke all on public.item_embeddings from anon, authenticated;

-- Inference kept separate from canonical values (ARCHITECTURE 6.4).
create table public.item_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  item_id uuid not null,
  job_id uuid,
  source text not null check (source in ('vision', 'computed')),
  schema_version integer not null check (schema_version = 1),
  input_media_revision integer not null,
  base_versions jsonb not null check (jsonb_typeof(base_versions) = 'object'),
  suggested jsonb not null check (jsonb_typeof(suggested) = 'object' and octet_length(suggested::text) <= 2048),
  applied_fields text[] not null default '{}',
  status text not null check (status in ('applied', 'stale')),
  created_at timestamptz not null default now(),
  foreign key (user_id, item_id) references public.items (user_id, id) on delete cascade
);
create index item_suggestions_item on public.item_suggestions (item_id, created_at desc);
alter table public.item_suggestions enable row level security;
revoke all on public.item_suggestions from anon, authenticated;
grant select on public.item_suggestions to authenticated;
create policy item_suggestions_read_own on public.item_suggestions for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_active_member((select auth.uid()))));

-- A parked (budget) stage shows why it waits and offers no manual retry: it
-- resumes after the reset. Failed and canceled stages can be retried twice.
create or replace function private.sync_item_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'item_stage' then
    update public.item_stages
       set state = new.state,
           failure_code = case when new.state in ('failed', 'canceled', 'retry_wait', 'blocked_budget') then new.failure_code end,
           can_retry = new.state in ('failed', 'canceled') and new.manual_retries < 2,
           updated_at = now()
     where item_id = new.target_id and stage = new.stage and job_id = new.id;
  end if;
  return new;
end;
$$;

-- Validates a tag or color suggestion against the taxonomy. Unknown fields,
-- values or oversized arrays fail; nothing is coerced into a valid category.
create function private.valid_suggestion(p_suggested jsonb)
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
                     'style_tags', 'attributes', 'colors')
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
  if p_suggested ? 'material' and (jsonb_typeof(p_suggested -> 'material') <> 'string'
     or char_length(p_suggested ->> 'material') not between 1 and 60) then
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
revoke all on function private.valid_suggestion(jsonb) from public, anon, authenticated;

-- The field versions a result may apply to, captured when its stage starts.
create function private.field_versions(p_item public.items, p_fields text[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(f, coalesce((p_item.field_meta -> f ->> 'v')::integer, 0)), '{}'::jsonb)
    from unnest(p_fields) f;
$$;
revoke all on function private.field_versions(public.items, text[]) from public, anon, authenticated;

-- Applies the eligible fields of a validated suggestion. A field is filled only
-- if it is not user-locked and its version still equals the captured version.
-- Returns the fields applied. Callers hold the item row lock.
create function private.apply_suggestion(p_item public.items, p_source text, p_base jsonb, p_suggested jsonb)
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  v_fields constant text[] := array['category', 'subcategory', 'pattern', 'material', 'formality', 'seasons',
    'style_tags', 'attributes', 'colors'];
  v_field text;
  v_applied text[] := '{}';
  v_meta jsonb := p_item.field_meta;
  v_item public.items := p_item;
  v_category text;
begin
  foreach v_field in array v_fields loop
    continue when not p_suggested ? v_field;
    continue when coalesce((v_meta -> v_field ->> 'locked')::boolean, false);
    continue when coalesce((v_meta -> v_field ->> 'v')::integer, 0) <> coalesce((p_base ->> v_field)::integer, -1);
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
    formality = case when 'formality' = any (v_applied) then (p_suggested ->> 'formality')::smallint else formality end,
    seasons = case when 'seasons' = any (v_applied)
      then array(select e from jsonb_array_elements_text(p_suggested -> 'seasons') with ordinality t(e, o) group by e order by min(o))
      else seasons end,
    style_tags = case when 'style_tags' = any (v_applied)
      then array(select e from jsonb_array_elements_text(p_suggested -> 'style_tags') with ordinality t(e, o) group by e order by min(o))
      else style_tags end,
    attributes = case when 'attributes' = any (v_applied) then p_suggested -> 'attributes' else attributes end,
    colors = case when 'colors' = any (v_applied) then p_suggested -> 'colors' else colors end,
    -- A confident suggested category needs no approval; an uncertain one asks
    -- the member to check it (DESIGN 6.3).
    category_review_required = case when 'category' = any (v_applied)
      then coalesce(p_suggested ->> 'category_confidence', 'low') <> 'high' else category_review_required end,
    field_meta = v_meta,
    revision = revision + 1,
    updated_at = now()
  where id = p_item.id;
  return v_applied;
end;
$$;
revoke all on function private.apply_suggestion(public.items, text, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Queuing: tags start with the item (independent of the cutout, so a paused AI
-- budget never blocks a cutout); colors and the embedding follow the cutout.
-- ---------------------------------------------------------------------------
create function private.tags_task_version()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'item_tags:item-tags-v1';
$$;
revoke all on function private.tags_task_version() from public, anon, authenticated;

create function private.space_label()
returns text
language sql
stable
set search_path = ''
as $$
  select model || '@' || model_revision || '/' || preprocess_version from private.embedding_space;
$$;
revoke all on function private.space_label() from public, anon, authenticated;

create or replace function private.create_gather_item(p_entry public.upload_entries)
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
  perform private.enqueue_item_stage(v_item, 'tags', private.tags_task_version());
  return v_item.id;
end;
$$;

-- Colors and the embedding need the cutout's foreground.
create function private.enqueue_after_cutout(p_item public.items)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_space text := private.space_label();
begin
  perform private.enqueue_item_stage(p_item, 'colors', 'kmeans-v1');
  if v_space is not null then
    perform private.enqueue_item_stage(p_item, 'embedding', v_space);
  end if;
end;
$$;
revoke all on function private.enqueue_after_cutout(public.items) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Claims: colors and the embedding read the cutout; the captured field
-- versions travel in the job payload.
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
  select a.* into v_source from public.item_assets ia join public.media_assets a on a.id = ia.asset_id
   where ia.item_id = v_item.id and ia.role = v_role and ia.detached_at is null and a.state = 'ready';
  select * into v_object from private.media_objects
   where asset_id = v_source.id and role = v_role and deleted_at is null;
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
    'sources', case when v_job.stage = 'tags' then '{}'::jsonb
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
      else jsonb_build_object('task', 'item_tags') end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Completion for every item stage.
-- ---------------------------------------------------------------------------
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
    if found and v_job.stage in ('tags', 'colors') and p_outcome = 'ready' and private.valid_suggestion(coalesce(p_result -> 'suggested', '{}')) then
      insert into public.item_suggestions (user_id, item_id, job_id, source, schema_version, input_media_revision,
        base_versions, suggested, status)
      values (v_job.user_id, v_item.id, v_job.id, case when v_job.stage = 'tags' then 'vision' else 'computed' end, 1,
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

  elsif v_job.stage in ('colors', 'tags') then
    if not private.valid_suggestion(coalesce(p_result -> 'suggested', 'null'))
       or (v_job.stage = 'colors' and exists (select 1 from jsonb_object_keys(p_result -> 'suggested') k where k <> 'colors')) then
      perform private.raise_app_error('OUTPUT_REJECTED', 422, jsonb_build_object('field', 'suggested'));
    end if;
    v_applied := private.apply_suggestion(v_item, case when v_job.stage = 'tags' then 'vision' else 'computed' end,
      coalesce(v_input -> 'base_versions', '{}'), p_result -> 'suggested');
    insert into public.item_suggestions (user_id, item_id, job_id, source, schema_version, input_media_revision,
      base_versions, suggested, applied_fields, status)
    values (v_job.user_id, v_item.id, v_job.id, case when v_job.stage = 'tags' then 'vision' else 'computed' end, 1,
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

-- ---------------------------------------------------------------------------
-- AI tag stage: the Edge gateway runs it for the worker's claimed job.
-- ---------------------------------------------------------------------------

-- Context for one tag attempt: the item's current original and the attempt
-- identity. A lease retry reuses the identity, so a possibly-billed call is
-- never re-sent; a manual retry gets a new one.
create function public.svc_item_ai_context(p_job_id uuid, p_lease_generation integer)
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
  if not found or v_job.kind <> 'item_stage' or v_job.stage <> 'tags' or v_job.state <> 'running'
     or v_job.lease_generation <> p_lease_generation then
    return jsonb_build_object('status', 'stale');
  end if;
  select o.object_key into v_key
    from public.item_assets ia join private.media_objects o on o.asset_id = ia.asset_id and o.role = 'original' and o.deleted_at is null
   where ia.item_id = v_job.target_id and ia.role = 'original' and ia.detached_at is null;
  return jsonb_build_object(
    'status', 'ok',
    'user_id', v_job.user_id,
    'item_id', v_job.target_id,
    'media_revision', v_job.target_revision,
    'original_key', v_key,
    'attempt_key', format('item_tags:%s:mr%s:r%s:b%s', v_job.id, v_job.target_revision, v_job.manual_retries,
      v_job.budget_resumes)
  );
end;
$$;

-- A refused reservation parks the stage until the budget allows it again; it is
-- not a retry loop and it does not touch the item.
create function public.svc_block_item_stage(p_job_id uuid, p_lease_generation integer)
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
  update private.jobs set state = 'blocked_budget', failure_code = 'AI_BUDGET_PAUSED', lease_expires_at = null,
         claim_nonce_hash = null, updated_at = now()
   where id = p_job_id;
  return jsonb_build_object('status', 'applied', 'state', 'blocked_budget');
end;
$$;

-- After the monthly reset, parked tag jobs for pieces that still exist at the
-- same photo become runnable again (a new reservation is still required). Only
-- the scheduler calls this; opening a screen never does.
create function public.svc_resume_blocked_stages(p_limit integer default 50)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period private.budget_periods := private.budget_period_at(now());
  v_resumed integer;
begin
  if private.budget_mode(private.budget_committed(v_period), (select s from private.budget_settings s)) = 'paused' then
    return 0;
  end if;
  with due as (
    select j.id from private.jobs j join public.items i on i.id = j.target_id
     where j.state = 'blocked_budget' and j.kind = 'item_stage' and j.updated_at < v_period.period_start
       and i.lifecycle = 'active' and i.media_revision = j.target_revision
     order by j.updated_at limit p_limit
     for update of j skip locked
  )
  update private.jobs j set state = 'queued', failure_code = null, attempt_count = 0, next_run_at = now(),
         budget_resumes = j.budget_resumes + 1, updated_at = now()
    from due where j.id = due.id;
  get diagnostics v_resumed = row_count;
  return v_resumed;
end;
$$;

-- The owner retries a failed stage; a parked (budget) stage waits for the reset.
create or replace function public.svc_retry_item_stage(p_user_id uuid, p_item_id uuid, p_stage text, p_media_revision integer)
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
-- Exact, owner-filtered nearest neighbours in the current vector space only.
-- Ownership is applied before candidate selection; no approximate index.
-- ---------------------------------------------------------------------------
create function public.svc_nearest_items(p_user_id uuid, p_item_id uuid, p_limit integer default 10)
returns table (item_id uuid, distance double precision)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_space private.embedding_space;
  v_query extensions.vector(512);
begin
  select * into v_space from private.embedding_space;
  if v_space.model is null then
    return;
  end if;
  select e.embedding into v_query
    from public.item_embeddings e join public.items i on i.id = e.item_id
   where e.item_id = p_item_id and e.user_id = p_user_id and e.media_revision = i.media_revision
     and e.model = v_space.model and e.model_revision = v_space.model_revision
     and e.preprocess_version = v_space.preprocess_version;
  if v_query is null then
    return;
  end if;
  return query
  select e.item_id, (e.embedding operator(extensions.<=>) v_query)::double precision
    from public.item_embeddings e join public.items i on i.id = e.item_id
   where e.user_id = p_user_id and i.user_id = p_user_id and i.lifecycle = 'active' and e.item_id <> p_item_id
     and e.media_revision = i.media_revision
     and e.model = v_space.model and e.model_revision = v_space.model_revision
     and e.preprocess_version = v_space.preprocess_version
   order by 2, e.item_id
   limit least(greatest(p_limit, 1), 50);
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_item_ai_context(uuid, integer)',
    'public.svc_block_item_stage(uuid, integer)',
    'public.svc_resume_blocked_stages(integer)',
    'public.svc_nearest_items(uuid, uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
