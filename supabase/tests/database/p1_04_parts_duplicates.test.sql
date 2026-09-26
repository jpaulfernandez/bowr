-- P1.04: grouped photos become pieces only on confirmation; possible duplicates
-- stay inside one wardrobe and are never merged automatically.
begin;
\ir ../fixtures/auth.psql
select plan(19);

select tests.create_identity('a') as a_id \gset
select tests.create_identity('b') as b_id \gset

select ok(not has_function_privilege('authenticated', 'public.svc_confirm_parts(uuid, uuid, uuid, text, jsonb, jsonb)', 'execute'),
  'confirming parts goes through the API');
select ok(not has_function_privilege('authenticated', 'public.svc_resolve_duplicate(uuid, uuid, uuid, text)', 'execute'),
  'resolving a duplicate goes through the API');
select ok(not has_function_privilege('authenticated', 'public.svc_expire_group_sources(integer)', 'execute'),
  'group expiry is scheduler-only');

-- A validated grouped photo (dimensions as validation would set them).
select (public.svc_create_upload_batch(:'a_id', gen_random_uuid(), 'b',
  '[{"client_file_id":"44444444-4444-4444-8444-444444444444","purpose":"grouped","content_type":"image/png","byte_size":10}]')
  -> 'entries' -> 0 ->> 'entry_id') as entry_id \gset
update public.upload_entries set state = 'ready', proposed_parts = '[]' where id = :'entry_id';
update public.media_assets set state = 'ready', width = 800, height = 600, content_type = 'image/webp', byte_size = 10, sha256 = repeat('b', 64), expires_at = now() + interval '1 hour'
 where id = (select asset_id from public.upload_entries where id = :'entry_id');

-- Box rules --------------------------------------------------------------------------
select ok(private.valid_part_box('{"x":0.1,"y":0.1,"w":0.5,"h":0.5}', 800, 600), 'a normal box is valid');
select ok(not private.valid_part_box('{"x":0.9,"y":0.1,"w":0.2,"h":0.2}', 800, 600), 'a box past the edge is refused');
select ok(not private.valid_part_box('{"x":0.1,"y":0.1,"w":0.03,"h":0.5}', 800, 600), 'a box under 32 px is refused');
select ok(not private.valid_part_box('{"x":"0.1","y":0.1,"w":0.5,"h":0.5}', 800, 600), 'a box with text coordinates is refused');
select ok(not private.valid_part_box('{"x":0.1,"y":0.1,"w":0.5,"h":0.5,"z":1}', 800, 600), 'a box with extra fields is refused');

-- Confirmation -------------------------------------------------------------------------
select throws_ok(format($$select public.svc_confirm_parts(%L, gen_random_uuid(), %L, 'split', '{"width":800,"height":600}',
  '[{"part_id":"55555555-5555-4555-8555-555555555555","box":{"x":0,"y":0,"w":0.5,"h":0.5}}]')$$, :'b_id', :'entry_id'),
  'PT404', 'NOT_FOUND', 'B cannot confirm A''s grouped photo');
select throws_ok(format($$select public.svc_confirm_parts(%L, gen_random_uuid(), %L, 'split', '{"width":600,"height":800}',
  '[{"part_id":"55555555-5555-4555-8555-555555555555","box":{"x":0,"y":0,"w":0.5,"h":0.5}}]')$$, :'a_id', :'entry_id'),
  'PT422', 'ORIENTATION_MISMATCH', 'boxes drawn on another orientation are refused');
select is((select count(*)::int from public.items where source_entry_id = :'entry_id'), 0, 'no piece exists before confirmation');
select is(jsonb_array_length(public.svc_confirm_parts(:'a_id', gen_random_uuid(), :'entry_id', 'split', '{"width":800,"height":600}',
  '[{"part_id":"55555555-5555-4555-8555-555555555555","box":{"x":0,"y":0,"w":0.5,"h":0.5}},
    {"part_id":"66666666-6666-4666-8666-666666666666","box":{"x":0.25,"y":0.25,"w":0.5,"h":0.5}}]') -> 'items'),
  2, 'two overlapping parts are two pieces');
select throws_ok(format($$select public.svc_confirm_parts(%L, gen_random_uuid(), %L, 'keep_one', '{"width":800,"height":600}', null)$$,
  :'a_id', :'entry_id'), 'PT409', 'ALREADY_CONFIRMED', 'a group is confirmed once');
select is((select count(*)::int from private.jobs j join public.items i on i.id = j.target_id
  where i.source_entry_id = :'entry_id' and j.stage = 'crop'), 2, 'each part has its own crop job');
select throws_ok(format($$insert into public.items (user_id, source_entry_id, source_part_id) values (%L, %L, '55555555-5555-4555-8555-555555555555')$$,
  :'a_id', :'entry_id'), '23505', null, 'a part maps to one piece');

-- Duplicate reviews stay inside one wardrobe ---------------------------------------------------
insert into public.items (user_id) values (:'a_id') returning id as a_item \gset
insert into public.items (user_id) values (:'b_id') returning id as b_item \gset
select throws_ok(format($$insert into public.duplicate_reviews (user_id, item_id, existing_item_id, basis) values (%L, %L, %L, 'vector')$$,
  :'a_id', :'a_item', :'b_item'), '23503', null, 'a review cannot compare with another member''s piece');
select throws_ok(format($$insert into public.duplicate_reviews (user_id, entry_id, item_id, existing_item_id, basis) values (%L, %L, %L, %L, 'hash')$$,
  :'a_id', :'entry_id', :'a_item', :'a_item'), '23514', null, 'a review is about one entry or one piece');
insert into public.duplicate_reviews (user_id, item_id, existing_item_id, basis) values (:'a_id', :'a_item', :'a_item', 'vector');
select tests.authenticate_as(:'b_id');
select is((select count(*)::int from public.duplicate_reviews), 0, 'B reads none of A''s reviews');
select tests.clear_authentication();
select throws_ok(format($$select public.svc_resolve_duplicate(%L, gen_random_uuid(), (select id from public.duplicate_reviews where item_id = %L), 'use_existing')$$,
  :'b_id', :'a_item'), 'PT404', 'NOT_FOUND', 'B cannot resolve A''s review');

select * from finish();
rollback;
