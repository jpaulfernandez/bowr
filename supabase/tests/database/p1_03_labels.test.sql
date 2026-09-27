-- P1.03: care labels attach to one garment, never become items, and label facts
-- outrank visual guesses.
begin;
\ir ../fixtures/auth.psql
select plan(16);

select tests.create_identity('a') as a_id \gset
select tests.create_identity('b') as b_id \gset
insert into public.items (user_id) values (:'a_id') returning id as item_id \gset

select ok(not has_function_privilege('authenticated', 'public.svc_remove_label(uuid, uuid)', 'execute'),
  'label removal goes through the API');
select ok(not has_function_privilege('authenticated', 'public.svc_expire_unattached_labels(integer)', 'execute'),
  'label expiry is scheduler-only');

-- Batch rules ------------------------------------------------------------------------
select throws_ok(format($$select public.svc_create_upload_batch(%L, gen_random_uuid(), 'b', %L::jsonb)$$, :'a_id',
  (select jsonb_agg(jsonb_build_object('client_file_id', gen_random_uuid(), 'purpose', 'garment', 'content_type', 'image/png', 'byte_size', 10))
     from generate_series(1, 21))),
  'PT422', 'VALIDATION_FAILED', 'a twenty-first file is refused');
select throws_ok(format($$select public.svc_create_upload_batch(%L, gen_random_uuid(), 'b', '[{"client_file_id":"11111111-1111-4111-8111-111111111111","purpose":"care_label","content_type":"image/png","byte_size":10}]')$$, :'a_id'),
  'PT422', 'VALIDATION_FAILED', 'a label needs a target');
select throws_ok(format($$select public.svc_create_upload_batch(%L, gen_random_uuid(), 'b', '[{"client_file_id":"11111111-1111-4111-8111-111111111111","purpose":"care_label","content_type":"image/png","byte_size":10,"target_item_id":"%s"}]')$$, :'b_id', :'item_id'),
  'PT404', 'NOT_FOUND', 'B cannot attach a label to A''s piece');
select (public.svc_create_upload_batch(:'a_id', gen_random_uuid(), 'b', '[
  {"client_file_id":"22222222-2222-4222-8222-222222222222","purpose":"garment","content_type":"image/png","byte_size":10},
  {"client_file_id":"33333333-3333-4333-8333-333333333333","purpose":"care_label","content_type":"image/png","byte_size":10,
   "label_for":"22222222-2222-4222-8222-222222222222"}]') ->> 'batch_id') as batch_id \gset
select is((select count(*)::int from public.upload_entries l join public.upload_entries g on g.id = l.parent_entry_id
  where l.batch_id = :'batch_id' and l.purpose = 'care_label' and g.purpose = 'garment'),
  1, 'a label in the batch points at its garment entry');
select ok((select (array_agg(purpose order by created_at, id))[1] = 'garment' from public.upload_entries where batch_id = :'batch_id')
  and (select count(distinct created_at) = 2 from public.upload_entries where batch_id = :'batch_id'),
  'entries keep the order they were chosen in');

-- Constraints ------------------------------------------------------------------------
select throws_ok(
  format($$update public.upload_entries set target_item_id = %L where purpose = 'garment' and user_id = %L$$, :'item_id', :'a_id'),
  '23514', null, 'a garment entry cannot carry a label target');
select throws_ok(
  format($$update public.upload_entries set target_item_id = %L where purpose = 'care_label' and user_id = %L$$, :'item_id', :'a_id'),
  '23514', null, 'a label names one target only');

-- Label facts outrank visual guesses ----------------------------------------------------
select private.field_versions(i, array['material', 'brand']) as base0 from public.items i where i.id = :'item_id' \gset
select is((select private.apply_suggestion(i, 'label', :'base0'::jsonb, '{"material":"100% linen","brand":"Kept"}')
  from public.items i where i.id = :'item_id'), array['material', 'brand'], 'a label fills unlocked fields');
select private.field_versions(i, array['material']) as base1 from public.items i where i.id = :'item_id' \gset
select is((select private.apply_suggestion(i, 'vision', :'base1'::jsonb, '{"material":"cotton"}')
  from public.items i where i.id = :'item_id'), array[]::text[], 'a visual guess never replaces a label fact');
select is((select material from public.items where id = :'item_id'), '100% linen', 'the printed material stays');
-- The guess can land first, after the label's job took its versions: the label still wins.
insert into public.items (user_id) values (:'a_id') returning id as item2_id \gset
select private.field_versions(i, array['material']) as base2 from public.items i where i.id = :'item2_id' \gset
select is((select private.apply_suggestion(i, 'vision', :'base2'::jsonb, '{"material":"cotton"}')
  from public.items i where i.id = :'item2_id'), array['material'], 'a visual guess fills an empty material');
select is((select private.apply_suggestion(i, 'label', :'base2'::jsonb, '{"material":"100% cotton"}')
  from public.items i where i.id = :'item2_id'), array['material'], 'a label read from older versions replaces the later guess');
select is((select material from public.items where id = :'item2_id'), '100% cotton', 'the printed material replaces the guess');

-- Removal ------------------------------------------------------------------------------
insert into public.media_assets (user_id, purpose, state, retention, width, height, content_type, byte_size, sha256)
values (:'a_id', 'care_label', 'ready', 'retained', 10, 10, 'image/webp', 10, repeat('a', 64)) returning id as label_asset \gset
insert into public.item_assets (user_id, item_id, asset_id, role, media_revision) values (:'a_id', :'item_id', :'label_asset', 'label', 1);
select throws_ok(format($$select public.svc_remove_label(%L, %L)$$, :'b_id', :'label_asset'),
  'PT404', 'NOT_FOUND', 'B cannot remove A''s label');

select * from finish();
rollback;
