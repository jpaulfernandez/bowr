-- P0.01-A1: anonymous and pending users cannot read member data; A cannot read or
-- update B; authority fields are rejected; owner bootstrap is operator-only and one-time.
begin;
\ir ../fixtures/auth.psql
select plan(32);

create temporary table ids (label text primary key, id uuid) on commit drop;
grant select on ids to anon, authenticated;
insert into ids values
  ('a', tests.create_identity('a')),
  ('b', tests.create_identity('b')),
  ('pending', tests.create_identity('pending', 'pending')),
  ('suspended', tests.create_identity('suspended', 'suspended')),
  ('deleting', tests.create_identity('deleting', 'deleting'));

-- Auth trigger ---------------------------------------------------------------
select is(
  (select state from private.memberships where user_id = (select id from ids where label = 'pending')),
  'pending', 'new Auth user starts pending');

select tests.create_identity('meta', 'pending') as meta_id \gset
update auth.users set raw_user_meta_data = '{"role":"owner","state":"active"}' where id = :'meta_id';
select is((select state || '/' || role from private.memberships where user_id = :'meta_id'),
  'pending/member', 'user metadata never grants admission or role');

-- Exposure: private schema and tables ----------------------------------------
select ok(not has_table_privilege('authenticated', 'private.memberships', 'select'), 'authenticated cannot select memberships');
select ok(not has_table_privilege('anon', 'public.profiles', 'select'), 'anon has no profile grant');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'insert'), 'no direct profile insert');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'update'), 'no direct profile update');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'delete'), 'no direct profile delete');
select ok(not has_function_privilege('authenticated', 'private.bootstrap_owner(uuid)', 'execute'), 'authenticated cannot bootstrap owner');
select ok(not has_function_privilege('anon', 'private.bootstrap_owner(uuid)', 'execute'), 'anon cannot bootstrap owner');
select ok(not has_function_privilege('service_role', 'private.bootstrap_owner(uuid)', 'execute'), 'service role cannot bootstrap owner');
select ok(not has_function_privilege('anon', 'public.update_profile(uuid, bigint, jsonb)', 'execute'), 'anon cannot update profiles');

-- Allowlist of anon/authenticated grants in public: fail when a new object is exposed silently.
select is(
  (select coalesce(array_agg(g order by g), '{}') from (select format('%s:%s:%s', grantee, table_name, privilege_type) as g
     from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')) grants),
  array['authenticated:item_assets:SELECT', 'authenticated:item_stages:SELECT', 'authenticated:items:SELECT',
    'authenticated:media_assets:SELECT', 'authenticated:upload_batches:SELECT', 'authenticated:upload_entries:SELECT'],
  'table-wide grants to anon/authenticated in public are exactly the owner-filtered reads');
select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')),
  array['get_bootstrap', 'update_item', 'update_profile'], 'authenticated executes only allowlisted public functions');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
  0, 'anon executes no public functions');

-- Anonymous -------------------------------------------------------------------
select tests.authenticate_anon();
select throws_ok('select count(*) from public.profiles', '42501', null, 'anon cannot read profiles');
select tests.clear_authentication();

-- Pending, suspended, deleting --------------------------------------------------
select tests.authenticate_as((select id from ids where label = 'pending'));
select is((select count(*)::int from public.profiles), 0, 'pending reads no profiles, including its own');
select throws_ok(
  $$select public.update_profile(gen_random_uuid(), 1, '{"display_name":"P"}')$$,
  'PT403', 'MEMBERSHIP_INACTIVE', 'pending cannot update profile');
select is((select public.get_bootstrap() -> 'profile'), 'null'::jsonb, 'pending bootstrap has no profile');
select tests.clear_authentication();

select tests.authenticate_as((select id from ids where label = 'suspended'));
select is((select count(*)::int from public.profiles), 0, 'suspended reads no profiles');
select tests.clear_authentication();

select tests.authenticate_as((select id from ids where label = 'deleting'));
select is((select count(*)::int from public.profiles), 0, 'deleting reads no profiles');
select tests.clear_authentication();

-- A versus B -------------------------------------------------------------------
select tests.authenticate_as((select id from ids where label = 'a'));
select is((select array_agg(id) from public.profiles), array[(select id from ids where label = 'a')], 'A reads only own profile');
select is((select count(*)::int from public.profiles where id = (select id from ids where label = 'b')), 0, 'A cannot read B by id');
select throws_ok(
  format($$update public.profiles set display_name = 'x' where id = %L$$, (select id from ids where label = 'b')),
  '42501', null, 'A cannot write B directly');
select throws_ok(
  $$select public.update_profile(gen_random_uuid(), 1, '{"role":"owner"}')$$,
  'PT422', 'VALIDATION_FAILED', 'role is not an editable profile field');
select throws_ok(
  $$select public.update_profile(gen_random_uuid(), 1, '{"id":"00000000-0000-0000-0000-000000000000","display_name":"x"}')$$,
  'PT422', 'VALIDATION_FAILED', 'owner id cannot be supplied');
select throws_ok(
  $$select public.update_profile(gen_random_uuid(), 1, '{"state":"active"}')$$,
  'PT422', 'VALIDATION_FAILED', 'admission fields are rejected');
select is(
  (select public.update_profile('11111111-1111-4111-8111-111111111111', 1, '{"display_name":"Ana"}') ->> 'revision'),
  '2', 'A updates own profile at expected revision');
select tests.clear_authentication();
select is((select display_name from public.profiles where id = (select id from ids where label = 'b')), null, 'B profile untouched');

-- Owner bootstrap --------------------------------------------------------------
-- Precondition within this rolled-back transaction: no owner exists yet.
update private.memberships set role = 'member' where role = 'owner';
select is((private.bootstrap_owner((select id from ids where label = 'pending')) ->> 'role'), 'owner', 'operator bootstraps first owner');
select is((select state || '/' || role from private.memberships where user_id = (select id from ids where label = 'pending')),
  'active/owner', 'bootstrapped owner is active');
select throws_ok(
  format('select private.bootstrap_owner(%L)', (select id from ids where label = 'a')),
  'PT409', 'OWNER_ALREADY_EXISTS', 'bootstrap works only once');
select is((select count(*)::int from private.audit_events
  where action = 'owner_bootstrapped' and target_id = (select id from ids where label = 'pending')), 1, 'bootstrap is audited');

select * from finish();
rollback;
