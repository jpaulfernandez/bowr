-- P1.06: find, organize, archive and permanently delete pieces.
-- Search is explicit text-and-tag matching over a server-computed document
-- (name, taxonomy synonyms, brand, colors, material, tags); OR within a facet,
-- AND across facets; stable keyset cursors per sort. Bulk changes are
-- all-or-nothing and never skip a stale row. Permanent deletion leaves a neutral
-- tombstone and deletes every attached asset.

-- ---------------------------------------------------------------------------
-- Shared text rules (packages/domain/src/taxonomy.ts and items.ts are the
-- source; the integration suite fails if these copies drift).
-- ---------------------------------------------------------------------------
create function private.category_synonyms()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{"tops":["top","tops","shirt","shirts","tee","tees","t-shirt","blouse","sweater","hoodie","polo","tank"],"bottoms":["bottom","bottoms","pants","trousers","jeans","shorts","skirt","skirts","leggings","slacks"],"outerwear":["outerwear","jacket","jackets","coat","coats","blazer","cardigan","vest","layer"],"dresses":["dress","dresses","jumpsuit","gown"],"shoes":["shoe","shoes","sneakers","trainers","loafers","boots","sandals","slides","heels","footwear"],"eyewear":["eyewear","shades","sunglasses","sunnies","glasses","frames","spectacles"],"headwear":["headwear","hat","hats","cap","caps","bucket hat","beanie"],"bags":["bag","bags","tote","backpack","purse","handbag","crossbody","clutch"],"belts":["belt","belts"],"watches":["watch","watches","timepiece"],"jewelry":["jewelry","jewellery","earrings","necklace","bracelet","ring","rings","chain"]}'::jsonb;
$$;
revoke all on function private.category_synonyms() from public, anon, authenticated;

create function private.category_nouns()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{"tops":"top","bottoms":"bottom","outerwear":"layer","dresses":"dress","shoes":"shoes","eyewear":"eyewear","headwear":"hat","bags":"bag","belts":"belt","watches":"watch","jewelry":"jewelry"}'::jsonb;
$$;
revoke all on function private.category_nouns() from public, anon, authenticated;

-- The name a piece shows: the member's name, or one generated from its tags
-- ("Navy linen shirt", "Untitled top", "Untitled piece"), as displayName() does.
create function private.display_name(p_item public.items)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_noun text;
  v_material text;
  v_words text;
begin
  if nullif(btrim(p_item.name), '') is not null then
    return btrim(p_item.name);
  end if;
  v_noun := case when p_item.subcategory is not null and p_item.subcategory <> 'other' then p_item.subcategory
                 else private.category_nouns() ->> p_item.category end;
  if v_noun is null then
    return 'Untitled piece';
  end if;
  v_material := case when char_length(p_item.material) <= 12 and p_item.material !~ '[0-9%]' then lower(p_item.material) end;
  v_words := concat_ws(' ', p_item.colors -> 0 ->> 'name', v_material, v_noun);
  if v_words = v_noun then
    return 'Untitled ' || v_noun;
  end if;
  return upper(left(v_words, 1)) || substr(v_words, 2);
end;
$$;
revoke all on function private.display_name(public.items) from public, anon, authenticated;

-- Lower-case text a search token must appear in.
create function private.search_document(p_item public.items)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(concat_ws(' ',
    private.display_name(p_item), p_item.category, p_item.subcategory, p_item.brand, p_item.material, p_item.pattern,
    (select string_agg(c ->> 'name', ' ') from jsonb_array_elements(p_item.colors) c),
    array_to_string(p_item.style_tags, ' '),
    (select string_agg(s, ' ') from jsonb_array_elements_text(private.category_synonyms() -> p_item.category) s)));
$$;
revoke all on function private.search_document(public.items) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- search_items: owner-scoped; filters {categories, colors, seasons, archived};
-- sort recent|category|color|name; opaque cursor carrying the last sort key.
-- ---------------------------------------------------------------------------
create function private.invalid_search(p_field text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', p_field));
end;
$$;
revoke all on function private.invalid_search(text) from public, anon, authenticated;

create function public.search_items(p_query text, p_filters jsonb, p_sort text, p_cursor text, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_member();
  v_tax jsonb := private.taxonomy();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_sort text := coalesce(p_sort, 'recent');
  v_limit integer := coalesce(p_limit, 50);
  v_tokens text[];
  v_categories text[];
  v_colors text[];
  v_seasons text[];
  v_archived boolean;
  v_cursor jsonb;
  v_after_key text;
  v_after_id uuid;
  v_rows jsonb;
  v_total integer;
  v_processing integer;
begin
  if v_sort not in ('recent', 'category', 'color', 'name') then
    perform private.invalid_search('sort');
  end if;
  if v_limit not between 1 and 100 then
    perform private.invalid_search('limit');
  end if;
  if jsonb_typeof(v_filters) <> 'object'
     or exists (select 1 from jsonb_object_keys(v_filters) k where k not in ('categories', 'colors', 'seasons', 'archived')) then
    perform private.invalid_search('filters');
  end if;
  if v_filters ? 'categories' and (jsonb_typeof(v_filters -> 'categories') <> 'array'
     or exists (select 1 from jsonb_array_elements(v_filters -> 'categories') c where not (v_tax -> 'categories') ? (c #>> '{}'))) then
    perform private.invalid_search('categories');
  end if;
  if v_filters ? 'colors' and (jsonb_typeof(v_filters -> 'colors') <> 'array'
     or exists (select 1 from jsonb_array_elements(v_filters -> 'colors') c where not (v_tax -> 'colors') @> jsonb_build_array(c))) then
    perform private.invalid_search('colors');
  end if;
  if v_filters ? 'seasons' and (jsonb_typeof(v_filters -> 'seasons') <> 'array'
     or exists (select 1 from jsonb_array_elements(v_filters -> 'seasons') c where not (v_tax -> 'seasons') @> jsonb_build_array(c))) then
    perform private.invalid_search('seasons');
  end if;
  if v_filters ? 'archived' and jsonb_typeof(v_filters -> 'archived') <> 'boolean' then
    perform private.invalid_search('archived');
  end if;
  v_categories := array(select jsonb_array_elements_text(coalesce(v_filters -> 'categories', '[]')));
  v_colors := array(select jsonb_array_elements_text(coalesce(v_filters -> 'colors', '[]')));
  v_seasons := array(select jsonb_array_elements_text(coalesce(v_filters -> 'seasons', '[]')));
  v_archived := coalesce((v_filters ->> 'archived')::boolean, false);

  if char_length(coalesce(p_query, '')) > 200 then
    perform private.invalid_search('query');
  end if;
  v_tokens := array(select t from regexp_split_to_table(lower(btrim(coalesce(p_query, ''))), '\s+') t where t <> '');
  if cardinality(v_tokens) > 8 then
    perform private.invalid_search('query');
  end if;

  -- A cursor names its sort and the last row's sort key and ID; anything else fails.
  if p_cursor is not null then
    begin
      v_cursor := convert_from(decode(translate(p_cursor, '-_', '+/') || repeat('=', (4 - char_length(p_cursor) % 4) % 4), 'base64'), 'UTF8')::jsonb;
      v_after_key := v_cursor ->> 'k';
      v_after_id := (v_cursor ->> 'i')::uuid;
    exception when others then
      perform private.raise_app_error('INVALID_CURSOR', 422);
    end;
    if jsonb_typeof(v_cursor) <> 'object' or v_cursor ->> 's' is distinct from v_sort or v_after_key is null or v_after_id is null
       or (select count(*) from jsonb_object_keys(v_cursor)) <> 3 then
      perform private.raise_app_error('INVALID_CURSOR', 422);
    end if;
  end if;

  with matched as (
    select i.id,
           -- Byte order ("C"), so cursors compare exactly as rows were ordered.
           (case v_sort
             when 'recent' then to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
             when 'category' then coalesce(i.category, '~')
             when 'color' then coalesce(i.colors -> 0 ->> 'name', '~')
             else lower(private.display_name(i)) end) collate "C" as sort_key,
           exists (select 1 from public.item_stages s where s.item_id = i.id and s.stage in ('crop', 'cutout')
                     and s.state in ('queued', 'running', 'retry_wait')) as processing
      from public.items i
     where i.user_id = v_uid
       and i.lifecycle = case when v_archived then 'archived' else 'active' end
       and (cardinality(v_categories) = 0 or i.category = any (v_categories))
       and (cardinality(v_colors) = 0 or exists (select 1 from jsonb_array_elements(i.colors) c where c ->> 'name' = any (v_colors)))
       and (cardinality(v_seasons) = 0 or i.seasons && v_seasons)
       and not exists (select 1 from unnest(v_tokens) t where position(t in private.search_document(i)) = 0)
  ),
  page as (
    select * from matched m
     where v_after_id is null
        or (v_sort = 'recent' and (m.sort_key, m.id) < (v_after_key, v_after_id))
        or (v_sort <> 'recent' and (m.sort_key, m.id) > (v_after_key, v_after_id))
     order by case when v_sort = 'recent' then m.sort_key end desc, case when v_sort = 'recent' then m.id end desc,
              case when v_sort <> 'recent' then m.sort_key end asc, case when v_sort <> 'recent' then m.id end asc
     limit v_limit + 1
  )
  select (select count(*) from matched), (select count(*) from matched where processing),
         coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'k', p.sort_key) order by n) from (
           select p.*, row_number() over (
             order by case when v_sort = 'recent' then p.sort_key end desc, case when v_sort = 'recent' then p.id end desc,
                      case when v_sort <> 'recent' then p.sort_key end asc, case when v_sort <> 'recent' then p.id end asc) as n
             from page p) p), '[]'::jsonb)
    into v_total, v_processing, v_rows;

  return jsonb_build_object(
    'ids', coalesce((select jsonb_agg(r -> 'id' order by o) from jsonb_array_elements(v_rows) with ordinality x(r, o)
                      where o <= v_limit), '[]'::jsonb),
    'next_cursor', case when jsonb_array_length(v_rows) > v_limit then
      rtrim(translate(encode(convert_to(jsonb_build_object('s', v_sort, 'k', v_rows -> (v_limit - 1) ->> 'k',
        'i', v_rows -> (v_limit - 1) ->> 'id')::text, 'UTF8'), 'base64'), '+/' || chr(10), '-_'), '=') end,
    'total', v_total,
    'processing', v_processing
  );
end;
$$;
revoke all on function public.search_items(text, jsonb, text, text, integer) from public, anon, authenticated;
grant execute on function public.search_items(text, jsonb, text, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- bulk_update_items: up to 100 of the member's pieces, each at the revision the
-- member saw. Archive, restore or set a category; all or nothing.
-- ---------------------------------------------------------------------------
create function public.bulk_update_items(p_request_id uuid, p_items jsonb, p_operation jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_member();
  v_existing jsonb;
  v_kind text := p_operation ->> 'kind';
  v_category text := p_operation ->> 'category';
  v_ids uuid[];
  v_missing uuid[];
  v_stale jsonb;
  v_item public.items;
  v_entry jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 100
     or exists (select 1 from jsonb_array_elements(p_items) e
                 where jsonb_typeof(e) <> 'object'
                    or exists (select 1 from jsonb_object_keys(e) k where k not in ('id', 'expected_revision'))
                    or coalesce(e ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or coalesce(e ->> 'expected_revision', '') !~ '^\d{1,18}$') then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'items', 'max_items', 100));
  end if;
  if (select count(distinct e ->> 'id') from jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'items', 'reason', 'duplicate_id'));
  end if;
  if jsonb_typeof(p_operation) <> 'object' or v_kind is null or v_kind not in ('archive', 'restore', 'category')
     or exists (select 1 from jsonb_object_keys(p_operation) k where k not in ('kind', 'category'))
     or (v_kind = 'category') <> (p_operation ? 'category')
     or (v_kind = 'category' and not (private.taxonomy() -> 'categories') ? coalesce(v_category, '')) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'operation'));
  end if;

  v_existing := private.claim_request(v_uid, 'bulk_update_items', p_request_id,
    jsonb_build_object('items', p_items, 'operation', p_operation));
  if v_existing is not null then
    return v_existing;
  end if;

  v_ids := array(select (e ->> 'id')::uuid from jsonb_array_elements(p_items) e);
  -- Lock every row first, in a stable order.
  perform 1 from public.items where id = any (v_ids) and user_id = v_uid order by id for update;
  -- Foreign, unknown and deleted pieces are all simply "not found": nothing changes.
  v_missing := array(select u.item_id from unnest(v_ids) as u(item_id)
                      where not exists (select 1 from public.items i
                                         where i.id = u.item_id and i.user_id = v_uid and i.lifecycle <> 'deleted'));
  if cardinality(v_missing) > 0 then
    perform private.raise_app_error('NOT_FOUND', 404, jsonb_build_object('count', cardinality(v_missing)));
  end if;
  -- Every stale row is reported; none is skipped.
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'current_revision', i.revision) order by i.id), '[]'::jsonb)
    into v_stale
    from jsonb_array_elements(p_items) e join public.items i on i.id = (e ->> 'id')::uuid
   where i.revision <> (e ->> 'expected_revision')::bigint
      or (v_kind = 'archive' and i.lifecycle <> 'active')
      or (v_kind = 'restore' and i.lifecycle <> 'archived');
  if jsonb_array_length(v_stale) > 0 then
    perform private.raise_app_error('REVISION_CONFLICT', 409, jsonb_build_object('stale', v_stale));
  end if;

  for v_entry in select * from jsonb_array_elements(p_items) loop
    select * into v_item from public.items where id = (v_entry ->> 'id')::uuid;
    if v_kind = 'archive' then
      update public.items set lifecycle = 'archived', archived_at = now(), revision = revision + 1, updated_at = now()
       where id = v_item.id;
    elsif v_kind = 'restore' then
      update public.items set lifecycle = 'active', archived_at = null, revision = revision + 1, updated_at = now()
       where id = v_item.id;
    else
      -- As update_item: a chosen category is the member's value and resolves
      -- review; a subcategory or attributes of another category are cleared.
      update public.items set
        category = v_category,
        subcategory = case when (private.taxonomy() -> 'categories' -> v_category) ? subcategory then subcategory end,
        attributes = coalesce((select jsonb_object_agg(key, value) from jsonb_each(attributes)
                                where (private.taxonomy() -> 'attributes' -> key -> 'categories') ? v_category), '{}'::jsonb),
        category_review_required = false,
        reviewed_at = now(),
        field_meta = jsonb_set(field_meta, '{category}', jsonb_build_object(
          'v', coalesce((field_meta -> 'category' ->> 'v')::integer, 0) + 1, 'source', 'user', 'locked', true, 'at', now())),
        revision = revision + 1,
        updated_at = now()
       where id = v_item.id;
    end if;
  end loop;

  return private.complete_request(v_uid, 'bulk_update_items', p_request_id, jsonb_build_object(
    'updated', jsonb_array_length(p_items),
    'items', (select jsonb_agg(jsonb_build_object('id', i.id, 'revision', i.revision, 'lifecycle', i.lifecycle, 'category', i.category)
                                order by i.id)
                from public.items i where i.id = any (v_ids))));
end;
$$;
revoke all on function public.bulk_update_items(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.bulk_update_items(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Permanent deletion
-- ---------------------------------------------------------------------------
alter table private.deletion_tasks drop constraint deletion_tasks_reason_check;
alter table private.deletion_tasks add constraint deletion_tasks_reason_check check (reason in (
  'quarantine_consumed', 'quarantine_recheck', 'upload_canceled', 'stale_output', 'rejected_upload',
  'account_deleted', 'upload_expired', 'orphan', 'superseded', 'label_removed', 'group_source_released',
  'duplicate_discarded', 'mask_input_used', 'item_deleted'));

-- Deletes a piece at the revision the member saw. Access to its images ends in
-- this transaction; their bytes are deleted by the deletion service. The
-- lifecycle registry of what references a piece grows with later phases
-- (outfits, wear logs); in phase 1 only uploads and duplicate reviews do, and
-- both keep only the tombstone's ID.
create function public.svc_delete_item(p_user_id uuid, p_request_id uuid, p_item_id uuid, p_expected_revision bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_item public.items;
begin
  perform private.require_active_member_id(p_user_id);
  v_existing := private.claim_request(p_user_id, 'delete_item', p_request_id,
    jsonb_build_object('item_id', p_item_id, 'expected_revision', p_expected_revision));
  if v_existing is not null then
    return v_existing;
  end if;
  select * into v_item from public.items where id = p_item_id and user_id = p_user_id and lifecycle <> 'deleted' for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_item.revision <> p_expected_revision then
    perform private.raise_app_error('REVISION_CONFLICT', 409, jsonb_build_object('current_revision', v_item.revision));
  end if;
  perform private.discard_item(v_item.id, 'item_deleted');
  -- A pending duplicate question about this piece has nothing left to ask.
  update public.duplicate_reviews set state = 'use_existing', decided_at = now()
   where item_id = v_item.id and state = 'pending';
  return private.complete_request(p_user_id, 'delete_item', p_request_id,
    jsonb_build_object('item_id', v_item.id, 'state', 'deletion_pending'));
end;
$$;

-- Whether a deleted piece's images are gone: pending until every stored image
-- of the piece is confirmed absent. (The raw upload key of its original was
-- emptied at validation; its post-expiry recheck still guards a replayed upload.)
create function public.svc_item_deletion_status(p_user_id uuid, p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_pending integer;
begin
  perform private.require_active_member_id(p_user_id);
  select * into v_item from public.items where id = p_item_id and user_id = p_user_id and lifecycle = 'deleted';
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  select count(*) into v_pending
    from public.item_assets ia join private.media_objects o on o.asset_id = ia.asset_id
   where ia.item_id = v_item.id and o.deleted_at is null and o.role <> 'quarantine';
  return jsonb_build_object('item_id', v_item.id, 'state', case when v_pending = 0 then 'deleted' else 'deletion_pending' end);
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_delete_item(uuid, uuid, uuid, bigint)',
    'public.svc_item_deletion_status(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fix (P1.03): a care label and its garment validated at the same moment could
-- each miss the other (neither committed yet), leaving the label unattached.
-- Unchanged from P1.05 except for the parent-row lock.
-- ---------------------------------------------------------------------------
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
      -- Serialize with the garment's own completion (which holds its entry row):
      -- whichever commits second sees the other, so the label is never stranded.
      perform 1 from public.upload_entries where id = v_entry.parent_entry_id for update;
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
