-- P2.01: saved combinations are separate from confirmed wear.
create table public.outfits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text check (name is null or char_length(name) between 1 and 80),
  source text not null default 'manual' check (source in ('manual', 'pair', 'inspo', 'generated', 'log')),
  loved boolean not null default false,
  composition_hash text not null,
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);
create index outfits_owner_recent on public.outfits(user_id, deleted_at, created_at desc, id);
create index outfits_owner_composition on public.outfits(user_id, composition_hash) where deleted_at is null;

create table public.outfit_items (
  user_id uuid not null,
  outfit_id uuid not null,
  item_id uuid not null,
  slot text not null check (slot in ('top','bottom','one_piece','outerwear','shoes','eyewear','headwear','bag','accessory')),
  ordinal smallint not null check (ordinal between 0 and 19),
  primary key (outfit_id, item_id),
  unique (outfit_id, ordinal),
  foreign key (user_id, outfit_id) references public.outfits(user_id, id) on delete cascade,
  foreign key (user_id, item_id) references public.items(user_id, id)
);
create unique index outfit_items_core_slot on public.outfit_items(outfit_id, slot) where slot <> 'accessory';
create index outfit_items_item on public.outfit_items(user_id, item_id);

alter table public.outfits enable row level security;
alter table public.outfit_items enable row level security;
revoke all on public.outfits, public.outfit_items from public, anon, authenticated;
grant select on public.outfits, public.outfit_items to authenticated;
create policy outfits_read_own on public.outfits for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_active_member((select auth.uid()))));
create policy outfit_items_read_own on public.outfit_items for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_active_member((select auth.uid()))));

create function public.save_outfit(p_request_id uuid, p_outfit_id uuid, p_expected_revision bigint, p_name text, p_pieces jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_member();
  v_existing jsonb;
  v_outfit public.outfits;
  v_piece jsonb;
  v_item public.items;
  v_item_id uuid;
  v_slot text;
  v_expected_slot text;
  v_ids uuid[];
  v_slots text[];
  v_hash text;
  v_result jsonb;
begin
  if p_request_id is null or (p_outfit_id is null and p_expected_revision is not null)
     or (p_outfit_id is not null and p_expected_revision is null)
     or (p_name is not null and (char_length(trim(p_name)) not between 1 and 80))
     or jsonb_typeof(p_pieces) is distinct from 'array' then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'outfit'));
  end if;
  if jsonb_array_length(p_pieces) not between 1 and 20 then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'pieces'));
  end if;
  if exists (select 1 from jsonb_array_elements(p_pieces) e where jsonb_typeof(e) <> 'object'
        or (select count(*) from jsonb_object_keys(e)) <> 3
        or not (e ?& array['item_id','slot','ordinal'])
        or coalesce(e ->> 'item_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(e ->> 'slot','') not in ('top','bottom','one_piece','outerwear','shoes','eyewear','headwear','bag','accessory')
        or coalesce(e ->> 'ordinal','') !~ '^(0|[1-9]|1[0-9])$') then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'outfit'));
  end if;

  v_ids := array(select (e ->> 'item_id')::uuid from jsonb_array_elements(p_pieces) e);
  v_slots := array(select e ->> 'slot' from jsonb_array_elements(p_pieces) e);
  if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x)
     or (select count(distinct (e ->> 'ordinal')::int) from jsonb_array_elements(p_pieces) e) <> cardinality(v_ids)
     or exists (select 1 from unnest(v_slots) x where x <> 'accessory' group by x having count(*) > 1)
     or ('one_piece' = any(v_slots) and ('top' = any(v_slots) or 'bottom' = any(v_slots))) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'pieces'));
  end if;

  v_existing := private.claim_request(v_uid, 'save_outfit', p_request_id,
    jsonb_build_object('outfit_id', p_outfit_id, 'expected_revision', p_expected_revision, 'name', p_name, 'pieces', p_pieces));
  if v_existing is not null then return v_existing; end if;

  if p_outfit_id is not null then
    select * into v_outfit from public.outfits where id = p_outfit_id and user_id = v_uid and deleted_at is null for update;
    if not found then perform private.raise_app_error('NOT_FOUND', 404); end if;
    if v_outfit.revision <> p_expected_revision then perform private.raise_app_error('REVISION_CONFLICT', 409); end if;
  end if;

  -- A concurrent archive/delete waits on these locks, so validation and save agree.
  perform 1 from public.items where id = any(v_ids) and user_id = v_uid order by id for update;
  for v_piece in select * from jsonb_array_elements(p_pieces) loop
    v_item_id := (v_piece ->> 'item_id')::uuid;
    v_slot := v_piece ->> 'slot';
    select * into v_item from public.items where id = v_item_id and user_id = v_uid;
    if not found or v_item.lifecycle = 'deleted' then perform private.raise_app_error('NOT_FOUND', 404); end if;
    if v_item.lifecycle <> 'active' and not (p_outfit_id is not null and exists
       (select 1 from public.outfit_items oi where oi.outfit_id = p_outfit_id and oi.item_id = v_item_id and oi.slot = v_slot)) then
      perform private.raise_app_error('ITEM_UNAVAILABLE', 409);
    end if;
    if v_item.category is null and nullif(trim(v_item.name), '') is null then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'piece_identity'));
    end if;
    v_expected_slot := case v_item.category
      when 'tops' then 'top' when 'bottoms' then 'bottom' when 'dresses' then 'one_piece'
      when 'outerwear' then 'outerwear' when 'shoes' then 'shoes' when 'eyewear' then 'eyewear'
      when 'headwear' then 'headwear' when 'bags' then 'bag'
      when 'belts' then 'accessory' when 'watches' then 'accessory' when 'jewelry' then 'accessory' end;
    if v_expected_slot is not null and v_expected_slot <> v_slot then
      perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'slot'));
    end if;
  end loop;

  select md5(string_agg((e ->> 'item_id') || ':' || (e ->> 'slot'), ',' order by (e ->> 'item_id'), (e ->> 'slot')))
    into v_hash from jsonb_array_elements(p_pieces) e;
  if p_outfit_id is null then
    insert into public.outfits(user_id, name, composition_hash) values(v_uid, nullif(trim(p_name), ''), v_hash) returning * into v_outfit;
  else
    update public.outfits set name = nullif(trim(p_name), ''), composition_hash = v_hash,
      revision = revision + 1, updated_at = now() where id = p_outfit_id returning * into v_outfit;
    delete from public.outfit_items where outfit_id = p_outfit_id;
  end if;
  insert into public.outfit_items(user_id, outfit_id, item_id, slot, ordinal)
    select v_uid, v_outfit.id, (e ->> 'item_id')::uuid, e ->> 'slot', (e ->> 'ordinal')::smallint
      from jsonb_array_elements(p_pieces) e;
  v_result := jsonb_build_object('id', v_outfit.id, 'revision', v_outfit.revision, 'deleted_at', v_outfit.deleted_at);
  return private.complete_request(v_uid, 'save_outfit', p_request_id, v_result);
end;
$$;
revoke all on function public.save_outfit(uuid, uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_outfit(uuid, uuid, bigint, text, jsonb) to authenticated;

create function public.set_outfit_loved(p_request_id uuid, p_outfit_id uuid, p_expected_revision bigint, p_loved boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_member();
  v_existing jsonb;
  v_outfit public.outfits;
  v_result jsonb;
begin
  if p_loved is null or p_expected_revision is null then perform private.raise_app_error('VALIDATION_FAILED', 422); end if;
  v_existing := private.claim_request(v_uid, 'set_outfit_loved', p_request_id,
    jsonb_build_object('outfit_id', p_outfit_id, 'expected_revision', p_expected_revision, 'loved', p_loved));
  if v_existing is not null then return v_existing; end if;
  select * into v_outfit from public.outfits where id = p_outfit_id and user_id = v_uid and deleted_at is null for update;
  if not found then perform private.raise_app_error('NOT_FOUND', 404); end if;
  if v_outfit.revision <> p_expected_revision then perform private.raise_app_error('REVISION_CONFLICT', 409); end if;
  update public.outfits set loved = p_loved, revision = revision + 1, updated_at = now()
    where id = p_outfit_id returning * into v_outfit;
  v_result := jsonb_build_object('id', v_outfit.id, 'revision', v_outfit.revision, 'deleted_at', v_outfit.deleted_at);
  return private.complete_request(v_uid, 'set_outfit_loved', p_request_id, v_result);
end;
$$;
revoke all on function public.set_outfit_loved(uuid, uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.set_outfit_loved(uuid, uuid, bigint, boolean) to authenticated;

create function public.delete_outfit(p_request_id uuid, p_outfit_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_active_member();
  v_existing jsonb;
  v_outfit public.outfits;
  v_result jsonb;
begin
  if p_expected_revision is null then perform private.raise_app_error('VALIDATION_FAILED', 422); end if;
  v_existing := private.claim_request(v_uid, 'delete_outfit', p_request_id,
    jsonb_build_object('outfit_id', p_outfit_id, 'expected_revision', p_expected_revision));
  if v_existing is not null then return v_existing; end if;
  select * into v_outfit from public.outfits where id = p_outfit_id and user_id = v_uid and deleted_at is null for update;
  if not found then perform private.raise_app_error('NOT_FOUND', 404); end if;
  if v_outfit.revision <> p_expected_revision then perform private.raise_app_error('REVISION_CONFLICT', 409); end if;
  delete from public.outfit_items where outfit_id = p_outfit_id;
  update public.outfits set name = null, composition_hash = md5(''), loved = false,
    deleted_at = now(), revision = revision + 1, updated_at = now()
    where id = p_outfit_id returning * into v_outfit;
  v_result := jsonb_build_object('id', v_outfit.id, 'revision', v_outfit.revision, 'deleted_at', v_outfit.deleted_at);
  return private.complete_request(v_uid, 'delete_outfit', p_request_id, v_result);
end;
$$;
revoke all on function public.delete_outfit(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.delete_outfit(uuid, uuid, bigint) to authenticated;

-- Permanent piece deletion must leave no reusable outfit composition reference.
create function private.scrub_deleted_outfit_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_outfit_ids uuid[];
begin
  if new.lifecycle = 'deleted' and old.lifecycle <> 'deleted' then
    v_outfit_ids := array(select outfit_id from public.outfit_items where user_id = new.user_id and item_id = new.id);
    delete from public.outfit_items where user_id = new.user_id and item_id = new.id;
    update public.outfits o set composition_hash = coalesce((
      select md5(string_agg(oi.item_id::text || ':' || oi.slot, ',' order by oi.item_id, oi.slot))
      from public.outfit_items oi where oi.outfit_id = o.id), md5('')),
      revision = revision + 1, updated_at = now()
      where o.user_id = new.user_id and o.deleted_at is null and o.id = any(v_outfit_ids);
  end if;
  return new;
end;
$$;
revoke all on function private.scrub_deleted_outfit_item() from public, anon, authenticated;
create trigger items_scrub_outfits after update of lifecycle on public.items
  for each row execute function private.scrub_deleted_outfit_item();

create or replace function private.scrub_account_domain(p_user_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  delete from public.outfits where user_id = p_user_id;
  update public.profiles set display_name = null, city = null, revision = revision + 1, updated_at = now()
   where id = p_user_id;
  delete from public.upload_batches where user_id = p_user_id;
  delete from public.media_assets where user_id = p_user_id;
  delete from private.job_payloads where job_id in (select id from private.jobs where user_id = p_user_id);
  delete from private.mutation_requests where user_id = p_user_id;
  delete from private.reauth_challenges where user_id = p_user_id and consumed_at is null;
  update private.ai_usage set user_id = null where user_id = p_user_id;
end;
$$;
