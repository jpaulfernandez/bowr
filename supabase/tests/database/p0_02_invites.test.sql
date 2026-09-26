-- P0.02: invite grants, redemption rules and throttling (sequential cases).
-- Concurrency cases live in supabase/tests/integration/p0_02_invites.test.ts.
begin;
\ir ../fixtures/auth.psql
select plan(27);

update private.memberships set role = 'member' where role = 'owner';
select tests.create_identity('owner', 'active', 'owner') as owner_id \gset
select tests.create_identity('member') as member_id \gset
select tests.create_identity('p1', 'pending') as p1_id \gset
select tests.create_identity('p2', 'pending') as p2_id \gset
select tests.create_identity('p3', 'pending') as p3_id \gset

-- Grants ------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.svc_redeem_invite(uuid, text, text)', 'execute'),
  'clients cannot call redemption directly');
select ok(not has_function_privilege('authenticated', 'public.svc_create_invite(uuid, uuid, text, text, integer)', 'execute'),
  'clients cannot create invites directly');
select ok(not has_function_privilege('anon', 'public.svc_admin_overview(uuid)', 'execute'), 'anon cannot read admin overview');
select ok(has_function_privilege('service_role', 'public.svc_redeem_invite(uuid, text, text)', 'execute'),
  'service role executes redemption');
select ok(not has_table_privilege('authenticated', 'private.invite_codes', 'select'), 'invite codes are private');
select ok(not has_table_privilege('service_role', 'private.invite_codes', 'select'), 'even service role reads invites only through functions');

-- Owner-only administration ------------------------------------------------------
select throws_ok(
  format($$select public.svc_create_invite(%L, gen_random_uuid(), repeat('a', 64), null, null)$$, :'member_id'),
  'PT404', 'NOT_FOUND', 'a nonowner cannot create invites');
select throws_ok(format('select public.svc_admin_overview(%L)', :'member_id'), 'PT404', 'NOT_FOUND',
  'a nonowner cannot read the admin overview');

select (public.svc_create_invite(:'owner_id', '33333333-3333-4333-8333-333333333333', repeat('a', 64), 'For Pia', null)
  ->> 'invite_id') as invite_a \gset
select is((select expires_at::date - created_at::date from private.invite_codes where id = :'invite_a'), 7,
  'default expiry is seven days');
select is(
  public.svc_create_invite(:'owner_id', '33333333-3333-4333-8333-333333333333', repeat('f', 64), 'For Pia', null) ->> 'invite_id',
  :'invite_a', 'a create retry returns the first invite');
select is((public.svc_create_invite(:'owner_id', '33333333-3333-4333-8333-333333333333', repeat('f', 64), 'For Pia', null) ->> 'replayed')::boolean,
  true, 'a create retry is marked as replayed');
select is((select count(*)::int from private.invite_codes where created_by = :'owner_id'), 1, 'retry created no second invite');
select throws_ok(
  format($$select public.svc_create_invite(%L, '33333333-3333-4333-8333-333333333333', repeat('b', 64), 'Changed', null)$$, :'owner_id'),
  'PT409', 'IDEMPOTENCY_CONFLICT', 'changed input under the same key conflicts');
select throws_ok(
  format($$select public.svc_create_invite(%L, gen_random_uuid(), repeat('c', 64), null, 31)$$, :'owner_id'),
  'PT422', 'VALIDATION_FAILED', 'expiry is bounded');

-- Redemption ---------------------------------------------------------------------
select is(public.svc_redeem_invite(:'p1_id', repeat('a', 64), null) ->> 'outcome', 'admitted', 'pending identity redeems');
select is((select state || '/' || role || '/' || (invited_by = :'owner_id')::text from private.memberships where user_id = :'p1_id'),
  'active/member/true', 'membership is active with invited_by');
select is(public.svc_redeem_invite(:'p1_id', repeat('a', 64), null) ->> 'outcome', 'admitted', 'winner retry returns existing membership');
select is((select uses from private.invite_codes where id = :'invite_a'), 1, 'winner retry consumed no extra use');
select is(public.svc_redeem_invite(:'p2_id', repeat('a', 64), null), '{"outcome":"unavailable"}'::jsonb,
  'an exhausted code fails generically');

-- Expired and revoked codes fail with the same generic outcome.
insert into private.invite_codes (code_digest, created_by, note, expires_at, created_at)
values (repeat('d', 64), :'owner_id', 'secret note', now() - interval '1 minute', now() - interval '8 days');
select is(public.svc_redeem_invite(:'p2_id', repeat('d', 64), null), '{"outcome":"unavailable"}'::jsonb,
  'an expired code fails generically without its note');
select (public.svc_create_invite(:'owner_id', gen_random_uuid(), repeat('e', 64), null, 3) ->> 'invite_id') as invite_e \gset
select public.svc_revoke_invite(:'owner_id', gen_random_uuid(), :'invite_e');
select is(public.svc_redeem_invite(:'p2_id', repeat('e', 64), null), '{"outcome":"unavailable"}'::jsonb,
  'a revoked code fails generically');

-- Revoking a used invite does not suspend the member it admitted.
select public.svc_revoke_invite(:'owner_id', gen_random_uuid(), :'invite_a');
select is((select state from private.memberships where user_id = :'p1_id'), 'active', 'revocation does not suspend an existing member');

-- Throttling: five attempts per hour per account; the sixth returns retry time.
select is(
  (select array_agg(public.svc_redeem_invite(:'p3_id', repeat('0', 64), null) ->> 'outcome') from generate_series(1, 5)),
  array['unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable'], 'first five attempts are evaluated');
select is(public.svc_redeem_invite(:'p3_id', repeat('0', 64), null) ->> 'outcome', 'rate_limited', 'the sixth attempt is throttled');
select ok((public.svc_redeem_invite(:'p3_id', repeat('0', 64), null) ->> 'retry_after_seconds')::int between 3000 and 3600,
  'throttle returns the remaining window');
update private.rate_limit_buckets set window_started_at = now() - interval '61 minutes'
 where scope = 'invite_redeem_account' and subject_hash = :'p3_id';
select is(public.svc_redeem_invite(:'p3_id', repeat('0', 64), null) ->> 'outcome', 'unavailable', 'the window resets after an hour');

-- Suspended or deleting identities cannot redeem.
select tests.create_identity('susp', 'suspended') as susp_id \gset
select throws_ok(format($$select public.svc_redeem_invite(%L, repeat('0', 64), null)$$, :'susp_id'),
  'PT403', 'MEMBERSHIP_INACTIVE', 'suspended identity cannot redeem');

select * from finish();
rollback;
