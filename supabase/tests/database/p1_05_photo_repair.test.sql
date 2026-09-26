-- P1.05: corrections advance the media revision once; a replacement names the
-- member's own piece; alternate-model cutouts are bounded.
begin;
\ir ../fixtures/auth.psql
select plan(14);

select tests.create_identity('a') as a_id \gset
select tests.create_identity('b') as b_id \gset

select ok(not has_function_privilege('authenticated', 'public.svc_submit_mask(uuid, uuid, uuid, integer, text, text, integer, integer, bigint, text)', 'execute'),
  'masks are submitted through the API');
select ok(not has_function_privilege('authenticated', 'public.svc_recut_item(uuid, uuid, uuid, integer, text)', 'execute'),
  'alternate cutouts are requested through the API');
select ok(not has_function_privilege('authenticated', 'public.svc_expire_mask_inputs(integer)', 'execute'),
  'mask input expiry is scheduler-only');

-- A piece with an 800x600 original.
insert into public.items (user_id) values (:'a_id') returning id as item_id \gset
insert into public.media_assets (user_id, purpose, state, retention, width, height, content_type, byte_size, sha256)
values (:'a_id', 'gather_original', 'ready', 'retained', 800, 600, 'image/webp', 10, repeat('c', 64)) returning id as original_id \gset
insert into public.item_assets (user_id, item_id, asset_id, role, media_revision) values (:'a_id', :'item_id', :'original_id', 'original', 1);
select format('users/%s/items/%s/edits/one.png', :'a_id', :'item_id') as mask_key \gset

-- Masks -----------------------------------------------------------------------------
select throws_ok(format($$select public.svc_submit_mask(%L, gen_random_uuid(), %L, 1, 'b', %L, 600, 800, 10, %L)$$,
  :'a_id', :'item_id', :'mask_key', repeat('d', 64)), 'PT422', 'MASK_REJECTED', 'a mask of another size is refused');
select throws_ok(format($$select public.svc_submit_mask(%L, gen_random_uuid(), %L, 1, 'b', 'uploads/elsewhere.png', 800, 600, 10, %L)$$,
  :'a_id', :'item_id', repeat('d', 64)), 'PT422', 'MASK_REJECTED', 'a mask outside the piece''s edits prefix is refused');
select throws_ok(format($$select public.svc_submit_mask(%L, gen_random_uuid(), %L, 1, 'b', %L, 800, 600, 10, %L)$$,
  :'b_id', :'item_id', :'mask_key', repeat('d', 64)), 'PT404', 'NOT_FOUND', 'B cannot correct A''s piece');
select is((public.svc_submit_mask(:'a_id', gen_random_uuid(), :'item_id', 1, 'b', :'mask_key', 800, 600, 10, repeat('d', 64)) ->> 'media_revision')::integer,
  2, 'an accepted mask advances the media revision');
select is((select model from public.item_stages where item_id = :'item_id' and stage = 'cutout'), 'manual', 'the cutout is composed from the mask');
select throws_ok(format($$select public.svc_submit_mask(%L, gen_random_uuid(), %L, 1, 'b', %L, 800, 600, 10, %L)$$,
  :'a_id', :'item_id', :'mask_key', repeat('e', 64)), 'PT409', 'REVISION_CONFLICT', 'a second correction of the same revision conflicts');
select is((select count(*)::int from public.item_assets where item_id = :'item_id' and role = 'original' and detached_at is null),
  1, 'the original stays attached');

-- Alternate models are bounded --------------------------------------------------------------
select throws_ok(format($$select public.svc_recut_item(%L, gen_random_uuid(), %L, 2, 'birefnet')$$, :'a_id', :'item_id'),
  'PT422', 'VALIDATION_FAILED', 'only pinned models can be requested');
select public.svc_recut_item(:'a_id', gen_random_uuid(), :'item_id', 2, 'u2netp');
select public.svc_recut_item(:'a_id', gen_random_uuid(), :'item_id', 3, 'isnet_general_use');
select public.svc_recut_item(:'a_id', gen_random_uuid(), :'item_id', 4, 'u2netp');
select throws_ok(format($$select public.svc_recut_item(%L, gen_random_uuid(), %L, 5, 'isnet_general_use')$$, :'a_id', :'item_id'),
  'PT409', 'RETRY_LIMIT_REACHED', 'a fourth model cutout of one original is refused');

-- Replacements ------------------------------------------------------------------------------
select throws_ok(format($$select public.svc_create_upload_batch(%L, gen_random_uuid(), 'b', '[{"client_file_id":"77777777-7777-4777-8777-777777777777","purpose":"replacement","content_type":"image/png","byte_size":10}]')$$, :'a_id'),
  'PT422', 'VALIDATION_FAILED', 'a replacement names its piece');
select throws_ok(format($$select public.svc_create_upload_batch(%L, gen_random_uuid(), 'b', '[{"client_file_id":"77777777-7777-4777-8777-777777777777","purpose":"replacement","content_type":"image/png","byte_size":10,"target_item_id":"%s"}]')$$, :'b_id', :'item_id'),
  'PT404', 'NOT_FOUND', 'B cannot replace A''s photo');

select * from finish();
rollback;
