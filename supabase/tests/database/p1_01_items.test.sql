-- P1.01: items and their attachments are owner-readable only, written only
-- through revisioned commands, and linked only to the same owner's records.
begin;
\ir ../fixtures/auth.psql
select plan(26);

select tests.create_identity('a') as a_id \gset
select tests.create_identity('b') as b_id \gset
select tests.create_identity('pending', 'pending') as p_id \gset
select tests.create_identity('suspended', 'suspended') as s_id \gset

insert into public.items (user_id) values (:'a_id') returning id as item_id \gset
insert into public.items (user_id) values (:'s_id') returning id as s_item_id \gset
insert into public.media_assets (user_id, purpose) values (:'a_id', 'item_cutout') returning id as a_asset \gset
insert into public.media_assets (user_id, purpose) values (:'a_id', 'item_cutout') returning id as a_asset2 \gset
insert into public.media_assets (user_id, purpose) values (:'b_id', 'item_cutout') returning id as b_asset \gset

-- Grants -------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.items', 'insert'), 'no direct item insert');
select ok(not has_table_privilege('authenticated', 'public.items', 'update'), 'no direct item update');
select ok(not has_table_privilege('authenticated', 'public.item_assets', 'insert'), 'no direct attachment insert');
select ok(not has_table_privilege('authenticated', 'public.item_stages', 'update'), 'no direct stage update');
select ok(has_function_privilege('authenticated', 'public.update_item(uuid, uuid, bigint, jsonb)', 'execute'),
  'members edit through update_item');
select ok(not has_function_privilege('authenticated', 'public.svc_complete_item_stage(uuid, integer, text, jsonb, jsonb, text)', 'execute'),
  'clients cannot complete stages');
select ok(not has_function_privilege('authenticated', 'public.svc_retry_item_stage(uuid, uuid, text, integer)', 'execute'),
  'clients cannot call the retry service directly');
select ok(not has_function_privilege('anon', 'public.update_item(uuid, uuid, bigint, jsonb)', 'execute'), 'anonymous cannot edit');

-- RLS ----------------------------------------------------------------------------
select tests.authenticate_as(:'a_id');
select is((select count(*)::int from public.items), 1, 'A reads own item');
select tests.clear_authentication();
select tests.authenticate_as(:'b_id');
select is((select count(*)::int from public.items), 0, 'B reads no items of A');
select tests.clear_authentication();
select tests.authenticate_as(:'p_id');
select is((select count(*)::int from public.items), 0, 'pending reads no items');
select tests.clear_authentication();
select tests.authenticate_as(:'s_id');
select is((select count(*)::int from public.items), 0, 'suspended reads no items, not even their own');
select tests.clear_authentication();

-- Same-owner links and uniqueness ---------------------------------------------------
insert into public.item_assets (user_id, item_id, asset_id, role, media_revision) values (:'a_id', :'item_id', :'a_asset', 'cutout', 1);
select throws_ok(
  format($$insert into public.item_assets (user_id, item_id, asset_id, role, media_revision) values (%L, %L, %L, 'cutout', 1)$$,
    :'a_id', :'item_id', :'a_asset2'),
  '23505', null, 'one current cutout per item');
select throws_ok(
  format($$insert into public.item_assets (user_id, item_id, asset_id, role, media_revision) values (%L, %L, %L, 'label', 1)$$,
    :'a_id', :'item_id', :'b_asset'),
  '23503', null, 'an item cannot attach another owner''s asset');
select throws_ok(
  format($$insert into public.item_assets (user_id, item_id, asset_id, role, media_revision) values (%L, %L, %L, 'label', 1)$$,
    :'b_id', :'item_id', :'b_asset'),
  '23503', null, 'an owner cannot attach to another owner''s item');
select throws_ok(format($$update public.items set price_minor = 100 where id = %L$$, :'item_id'),
  '23514', null, 'a price needs a currency');

-- update_item ------------------------------------------------------------------------
select tests.authenticate_as(:'a_id');
select is((public.update_item(gen_random_uuid(), :'item_id', 1, '{"category":"shoes","subcategory":"loafers"}') ->> 'revision')::int,
  2, 'A edits own item');
select throws_ok(format($$select public.update_item(gen_random_uuid(), %L, 1, '{"name":"late"}')$$, :'item_id'),
  'PT409', 'REVISION_CONFLICT', 'an edit at a stale revision conflicts');
select is((public.update_item(gen_random_uuid(), :'item_id', 2, '{"subcategory":null}') -> 'field_meta' -> 'subcategory' ->> 'locked'),
  'true', 'clearing a field is a locked user edit');
select tests.clear_authentication();
select tests.authenticate_as(:'b_id');
select throws_ok(format($$select public.update_item(gen_random_uuid(), %L, 3, '{"name":"mine"}')$$, :'item_id'),
  'PT404', 'NOT_FOUND', 'B cannot edit A''s item');
select tests.clear_authentication();
select tests.authenticate_as(:'s_id');
select throws_ok(format($$select public.update_item(gen_random_uuid(), %L, 1, '{"name":"x"}')$$, :'s_item_id'),
  'PT403', 'MEMBERSHIP_INACTIVE', 'a suspended member cannot edit');
select tests.clear_authentication();
update public.items set lifecycle = 'deleted' where id = :'item_id';
select tests.authenticate_as(:'a_id');
select throws_ok(format($$select public.update_item(gen_random_uuid(), %L, 3, '{"name":"back"}')$$, :'item_id'),
  'PT404', 'NOT_FOUND', 'a deleted piece cannot be edited');
select tests.clear_authentication();

-- Stage rows follow their own job only -----------------------------------------------
insert into public.items (user_id) values (:'a_id') returning id as item2 \gset
select private.enqueue_item_stage(i, 'cutout', 'isnet_general_use') as job1 from public.items i where i.id = :'item2' \gset
select is((select state from public.item_stages where item_id = :'item2'), 'queued', 'a new stage is queued');
update private.jobs set state = 'failed', failure_code = 'NO_FOREGROUND' where id = :'job1';
select is((select state || ':' || failure_code || ':' || can_retry from public.item_stages where item_id = :'item2'),
  'failed:NO_FOREGROUND:true', 'a failed job is mirrored with its retry option');
select private.enqueue_item_stage(i, 'cutout', 'u2netp') as job2 from public.items i where i.id = :'item2' \gset
update private.jobs set state = 'succeeded', failure_code = null where id = :'job1';
select is((select state || ':' || model from public.item_stages where item_id = :'item2'), 'queued:u2netp',
  'a later transition of a replaced job does not overwrite the current stage');
select is(private.enqueue_item_stage(i, 'cutout', 'u2netp'), :'job2'::uuid, 'queuing the same stage again reuses its job')
  from public.items i where i.id = :'item2';

select * from finish();
rollback;
