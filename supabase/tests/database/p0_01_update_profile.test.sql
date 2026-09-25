-- P0.01-T2: update_profile is revisioned and idempotent.
begin;
\ir ../fixtures/auth.psql
select plan(9);

select tests.create_identity('a') as a_id \gset
select tests.authenticate_as(:'a_id');

select is(public.update_profile('22222222-2222-4222-8222-222222222222', 1, '{"display_name":"Ana","timezone":"Asia/Manila"}') ->> 'revision',
  '2', 'first request applies');
select is(public.update_profile('22222222-2222-4222-8222-222222222222', 1, '{"display_name":"Ana","timezone":"Asia/Manila"}') ->> 'revision',
  '2', 'same key and body returns the stored result');
select is((select revision from public.profiles), 2::bigint, 'replay did not apply twice');
select throws_ok(
  $$select public.update_profile('22222222-2222-4222-8222-222222222222', 1, '{"display_name":"Other"}')$$,
  'PT409', 'IDEMPOTENCY_CONFLICT', 'changed body under the same key conflicts');
select throws_ok(
  $$select public.update_profile(gen_random_uuid(), 1, '{"city":"Manila"}')$$,
  'PT409', 'REVISION_CONFLICT', 'stale revision conflicts');
select throws_ok(
  $$select public.update_profile(gen_random_uuid(), 2, '{"timezone":"Mars/Olympus"}')$$,
  'PT422', 'VALIDATION_FAILED', 'unknown timezone rejected');
select throws_ok(
  $$select public.update_profile(gen_random_uuid(), 2, '{"temperature_unit":"kelvin"}')$$,
  'PT422', 'VALIDATION_FAILED', 'unknown unit rejected');
select throws_ok(
  $$select public.update_profile(null, 2, '{"city":"Manila"}')$$,
  'PT422', 'VALIDATION_FAILED', 'request id is required');
select is(public.update_profile(gen_random_uuid(), 2, '{"onboarding_completed":true,"city":"  "}') ->> 'city',
  null, 'blank city clears the optional field');

select * from finish();
rollback;
