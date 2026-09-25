-- P0.03: upload records are owner-readable only; keys, jobs and deletion tasks are private.
begin;
\ir ../fixtures/auth.psql
select plan(16);

select tests.create_identity('a') as a_id \gset
select tests.create_identity('b') as b_id \gset
select tests.create_identity('pending', 'pending') as p_id \gset

select (public.svc_create_upload_batch(:'a_id', gen_random_uuid(), 'bucket',
  '[{"client_file_id":"11111111-1111-4111-8111-111111111111","purpose":"garment","content_type":"image/png","byte_size":100}]'::jsonb)
  -> 'entries' -> 0) as entry \gset
select (:'entry'::jsonb ->> 'entry_id') as entry_id, (:'entry'::jsonb ->> 'asset_id') as asset_id \gset

-- Grants and RLS -----------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.media_objects', 'select'), 'object keys are private');
select ok(not has_table_privilege('authenticated', 'private.jobs', 'select'), 'jobs are private');
select ok(not has_table_privilege('authenticated', 'private.deletion_tasks', 'select'), 'deletion tasks are private');
select ok(not has_table_privilege('authenticated', 'public.media_assets', 'insert'), 'no direct asset insert');
select ok(not has_table_privilege('authenticated', 'public.upload_entries', 'update'), 'no direct entry update');
select ok(not has_function_privilege('authenticated', 'public.svc_authorize_media_access(uuid, jsonb)', 'execute'),
  'clients cannot call the media signer directly');
select ok(not has_function_privilege('authenticated', 'public.svc_claim_job(uuid, text)', 'execute'),
  'clients cannot claim jobs');

select tests.authenticate_as(:'a_id');
select is((select count(*)::int from public.upload_entries where id = :'entry_id'), 1, 'A reads own entry');
select is((select count(*)::int from public.media_assets where id = :'asset_id'), 1, 'A reads own asset');
select tests.clear_authentication();
select tests.authenticate_as(:'b_id');
select is((select count(*)::int from public.upload_entries), 0, 'B reads no entries of A');
select is((select count(*)::int from public.media_assets), 0, 'B reads no assets of A');
select tests.clear_authentication();
select tests.authenticate_as(:'p_id');
select is((select count(*)::int from public.upload_batches), 0, 'pending reads no batches');
select tests.clear_authentication();

-- Same-owner links and command authority -------------------------------------------
insert into public.media_assets (user_id, purpose) values (:'a_id', 'gather_original') returning id as a_asset2 \gset
select throws_ok(
  format($$insert into public.upload_entries (user_id, batch_id, client_file_id, purpose, declared_content_type,
    declared_byte_size, asset_id, upload_expires_at)
    select %L, batch_id, gen_random_uuid(), 'garment', 'image/png', 1, %L, now() from public.upload_entries where id = %L$$,
    :'b_id', :'a_asset2', :'entry_id'),
  '23503', null, 'an entry cannot link another owner''s batch or asset');
select throws_ok(format('select public.svc_complete_upload_entry(%L, gen_random_uuid(), %L, 100)', :'b_id', :'entry_id'),
  'PT404', 'NOT_FOUND', 'B cannot complete A''s entry');
select throws_ok(format('select public.svc_create_upload_batch(%L, gen_random_uuid(), %L, %L::jsonb)', :'p_id', 'bucket',
  '[{"client_file_id":"22222222-2222-4222-8222-222222222222","purpose":"garment","content_type":"image/png","byte_size":1}]'),
  'PT403', 'MEMBERSHIP_INACTIVE', 'pending cannot create uploads');
select is(
  (public.svc_authorize_media_access(:'b_id', format('[{"asset_id":"%s","variant":"original"}]', :'asset_id')::jsonb) -> 0 ->> 'status'),
  'not_found', 'B cannot authorize A''s asset');

select * from finish();
rollback;
