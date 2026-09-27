-- P1.06: owner-scoped search, all-or-nothing bulk changes and permanent deletion.
begin;
\ir ../fixtures/auth.psql
select plan(12);

select tests.create_identity('a') as a_id \gset
select tests.create_identity('b') as b_id \gset

select ok(has_function_privilege('authenticated', 'public.search_items(text, jsonb, text, text, integer)', 'execute'),
  'members search through an owner-scoped RPC');
select ok(not has_function_privilege('authenticated', 'public.svc_delete_item(uuid, uuid, uuid, bigint)', 'execute'),
  'permanent deletion goes through the API');
select ok(not has_function_privilege('anon', 'public.bulk_update_items(uuid, jsonb, jsonb)', 'execute'),
  'bulk changes need a signed-in member');

insert into public.items (user_id, name, category, subcategory, colors) values
  (:'a_id', null, 'eyewear', 'shades', '[{"name":"black","hex":"#1C1C1E"}]'),
  (:'a_id', 'Work trousers', 'bottoms', 'trousers', '[]');
insert into public.items (user_id, category) values (:'b_id', 'eyewear') returning id as b_item \gset

select is((select private.display_name(i) from public.items i where user_id = :'a_id' and category = 'eyewear'),
  'Black shades', 'generated names follow the domain rule');
select ok((select position('sunglasses' in private.search_document(i)) > 0 from public.items i where user_id = :'a_id' and category = 'eyewear'),
  'category synonyms are part of the search document');

select tests.authenticate_as(:'a_id');
select is((public.search_items('shades', '{}', 'recent', null, 50) ->> 'total')::int, 1, 'A finds only A''s shades');
select is((public.search_items('pants', '{}', 'name', null, 50) ->> 'total')::int, 1, '"pants" finds bottoms');
select throws_ok($$select public.search_items(null, '{}', 'recent', 'bm90LWpzb24', 50)$$, 'PT422', 'INVALID_CURSOR', 'a cursor that is not ours fails');
select throws_ok($$select public.search_items(null, '{"categories":["capes"]}', 'recent', null, 50)$$, 'PT422', 'VALIDATION_FAILED', 'unknown facet values fail');
select throws_ok(format($$select public.bulk_update_items(gen_random_uuid(), '[{"id":"%s","expected_revision":1}]', '{"kind":"archive"}')$$, :'b_item'),
  'PT404', 'NOT_FOUND', 'another member''s piece is not found, and nothing changes');
select throws_ok($$select public.bulk_update_items(gen_random_uuid(), (select jsonb_agg(jsonb_build_object('id', id, 'expected_revision', revision + 1)) from public.items where user_id = auth.uid()), '{"kind":"archive"}')$$,
  'PT409', 'REVISION_CONFLICT', 'stale revisions abort the whole change');
select tests.clear_authentication();
select is((select count(*)::int from public.items where user_id = :'a_id' and lifecycle = 'archived'), 0, 'no piece was archived by the refused changes');

select * from finish();
rollback;
