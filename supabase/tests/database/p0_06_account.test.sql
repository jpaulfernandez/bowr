-- P0.06: fresh authentication, suspension, ownership transfer and account deletion (sequential cases).
-- Auth removal, object deletion and racing processors live in supabase/tests/integration/p0_06_account.test.ts.
begin;
\ir ../fixtures/auth.psql
select plan(29);

update private.memberships set role = 'member' where role = 'owner';
select tests.create_identity('owner', 'active', 'owner') as owner_id \gset
select tests.create_identity('member') as member_id \gset
select tests.create_identity('other') as other_id \gset

-- Challenges are verified with the current transaction time; now() is fixed inside it.
create function pg_temp.proof(p_user uuid, p_action text, p_hash text)
returns jsonb language sql as $$
  select public.svc_verify_reauth_challenge(p_user,
    (public.svc_create_reauth_challenge(p_user, p_action, gen_random_uuid()) ->> 'challenge_id')::uuid,
    gen_random_uuid(), now(), p_hash);
$$;

-- Grants -------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.svc_start_account_deletion(uuid, text, text)', 'execute'),
  'clients cannot start a deletion directly');
select ok(not has_function_privilege('authenticated', 'public.svc_verify_reauth_challenge(uuid, uuid, uuid, timestamptz, text)', 'execute'),
  'clients cannot verify a challenge directly');
select ok(not has_function_privilege('anon', 'public.svc_account_deletion_status(text)', 'execute'),
  'deletion status goes through the Edge capability check');
select ok(not has_table_privilege('authenticated', 'private.account_deletions', 'select'), 'deletion records are private');
select ok(not has_table_privilege('authenticated', 'private.reauth_challenges', 'select'), 'challenges are private');

-- Fresh authentication ----------------------------------------------------------------
select public.svc_create_reauth_challenge(:'member_id', 'delete_account', '00000000-0000-4000-8000-000000000001') ->> 'challenge_id' as c1 \gset
select throws_ok(format('select public.svc_verify_reauth_challenge(%L, %L, %L, now(), %L)', :'member_id', :'c1',
  '00000000-0000-4000-8000-000000000001', repeat('a', 64)), 'PT403', 'REAUTH_REQUIRED',
  'the requesting session cannot verify its own challenge');
select throws_ok(format('select public.svc_verify_reauth_challenge(%L, %L, gen_random_uuid(), now() - interval ''1 second'', %L)',
  :'member_id', :'c1', repeat('a', 64)), 'PT403', 'REAUTH_REQUIRED',
  'a session authenticated before the challenge cannot verify it');
-- Sign-in times come from the token in whole seconds, so a sign-in in the challenge's
-- own second cannot be told from one just before it and is refused; the next second verifies.
select public.svc_create_reauth_challenge(:'member_id', 'delete_account', gen_random_uuid()) ->> 'challenge_id' as c2 \gset
update private.reauth_challenges set created_at = date_trunc('second', now()) + interval '400 milliseconds' where id = :'c2';
select throws_ok(format('select public.svc_verify_reauth_challenge(%L, %L, gen_random_uuid(), %L, %L)', :'member_id', :'c2',
  date_trunc('second', now()), repeat('a', 64)), 'PT403', 'REAUTH_REQUIRED',
  'a sign-in in the same whole second as the challenge is refused as ambiguous');
select lives_ok(format('select public.svc_verify_reauth_challenge(%L, %L, gen_random_uuid(), %L, %L)', :'member_id', :'c2',
  date_trunc('second', now()) + interval '1 second', repeat('9', 64)), 'a sign-in in the next second verifies it');
select throws_ok(format('select public.svc_verify_reauth_challenge(%L, %L, gen_random_uuid(), now(), %L)',
  :'other_id', :'c1', repeat('a', 64)), 'PT403', 'REAUTH_REQUIRED', 'another member cannot verify the challenge');
update private.reauth_challenges set expires_at = now() - interval '1 second' where id = :'c1';
select throws_ok(format('select public.svc_verify_reauth_challenge(%L, %L, gen_random_uuid(), now(), %L)',
  :'member_id', :'c1', repeat('a', 64)), 'PT403', 'REAUTH_REQUIRED', 'an expired challenge cannot be verified');
select lives_ok(format('select pg_temp.proof(%L, ''transfer_ownership'', %L)', :'member_id', repeat('b', 64)),
  'a fresh session verifies a challenge');
select throws_ok(format('select public.svc_start_account_deletion(%L, %L, %L)', :'member_id', repeat('b', 64), repeat('c', 64)),
  'PT403', 'REAUTH_REQUIRED', 'a proof for another action cannot delete the account');

-- Suspension ------------------------------------------------------------------------------
select throws_ok(format('select public.svc_admin_set_suspension(%L, %L, true)', :'member_id', :'other_id'),
  'PT404', 'NOT_FOUND', 'a nonowner cannot suspend');
select throws_ok(format('select public.svc_admin_set_suspension(%L, %L, true)', :'owner_id', :'owner_id'),
  'PT409', 'CANNOT_SUSPEND_OWNER', 'the owner cannot be suspended');
select is(public.svc_admin_set_suspension(:'owner_id', :'other_id', true) ->> 'state', 'suspended', 'the owner suspends a member');
select ok(not private.is_active_member(:'other_id'), 'a suspended member is not active');
select is(public.svc_admin_set_suspension(:'owner_id', :'other_id', false) ->> 'state', 'active', 'the owner restores a member');

-- Ownership transfer ------------------------------------------------------------------------
select pg_temp.proof(:'owner_id', 'transfer_ownership', repeat('d', 64));
select throws_ok(format('select public.svc_transfer_ownership(%L, %L, %L)', :'owner_id', :'owner_id', repeat('d', 64)),
  'PT422', 'INVALID_RECIPIENT', 'the owner cannot transfer to themselves');
select is(public.svc_transfer_ownership(:'owner_id', :'member_id', repeat('d', 64)) ->> 'owner_id', :'member_id',
  'a verified owner transfers ownership');
select is((select count(*)::int from private.memberships where role = 'owner'), 1, 'there is exactly one owner');
select throws_ok(format('select public.svc_transfer_ownership(%L, %L, %L)', :'member_id', :'owner_id', repeat('d', 64)),
  'PT403', 'REAUTH_REQUIRED', 'a proof is single-use');

-- Deletion ------------------------------------------------------------------------------------
-- member_id is now the owner and other members are active.
select pg_temp.proof(:'member_id', 'delete_account', repeat('e', 64));
select throws_ok(format('select public.svc_start_account_deletion(%L, %L, %L)', :'member_id', repeat('e', 64), repeat('f', 64)),
  'PT409', 'OWNER_TRANSFER_REQUIRED', 'an owner with members must transfer first');

insert into private.media_objects (user_id, bucket, object_key, role)
values (:'other_id', 'bowr-private', 'validated/test-' || gen_random_uuid(), 'original');
select pg_temp.proof(:'other_id', 'delete_account', repeat('1', 64));
select is(public.svc_start_account_deletion(:'other_id', repeat('1', 64), repeat('2', 64)) ->> 'state', 'objects_pending',
  'a verified member starts deletion');
select is((select state from private.memberships where user_id = :'other_id'), 'deleting', 'access is denied at once');
select is((select count(*)::int from private.deletion_tasks where user_id = :'other_id' and reason = 'account_deleted'), 1,
  'every stored object is in the deletion manifest');
select is((public.svc_account_deletion_status(repeat('2', 64)) ->> 'objects_remaining')::int, 1,
  'the status reports progress only');
select is((select count(*)::int from public.svc_account_deletions_ready()), 0, 'Auth removal waits for the objects');
select throws_ok(format('select public.svc_account_deletion_status(%L)', repeat('3', 64)), 'PT404', 'NOT_FOUND',
  'an unknown status capability reveals nothing');

select * from finish();
rollback;
