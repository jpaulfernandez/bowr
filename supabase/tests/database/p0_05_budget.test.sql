-- P0.05: budget reservation, settlement, thresholds and rollover (sequential cases).
-- Concurrency and provider-call counts live in supabase/tests/integration/p0_05_budget.test.ts.
begin;
\ir ../fixtures/auth.psql
select plan(34);

update private.memberships set role = 'member' where role = 'owner';
select tests.create_identity('owner', 'active', 'owner') as owner_id \gset
select tests.create_identity('member') as member_id \gset

-- A controlled clock: September 2026 (UTC) and the following October.
create function pg_temp.reserve(p_key text, p_normal bigint, p_lighter bigint, p_at timestamptz default '2026-09-10 12:00:00+00',
  p_window integer default 60)
returns jsonb language sql as $$
  select public.svc_ai_reserve('test:' || p_key, null, null, 'diagnostic', 'model-normal', 'model-lighter', 'price-v1',
    p_normal, p_lighter, p_window, p_at);
$$;
create function pg_temp.sept() returns private.budget_periods language sql as $$
  select * from private.budget_periods where period_start = '2026-09-01 00:00:00+00';
$$;
create function pg_temp.committed(p_start timestamptz) returns bigint language sql as $$
  select private.budget_committed(p) from private.budget_periods p where p.period_start = p_start;
$$;

-- Clean slate for the controlled months.
delete from private.budget_holds;
delete from private.ai_usage;
delete from private.budget_periods;

-- Grants -------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.svc_ai_reserve(text, uuid, uuid, text, text, text, text, bigint, bigint, integer, timestamptz)', 'execute'),
  'clients cannot reserve AI spend');
select ok(not has_function_privilege('authenticated', 'public.svc_admin_update_budget(uuid, uuid, bigint, bigint, bigint, bigint, boolean)', 'execute'),
  'clients cannot change thresholds directly');
select ok(not has_table_privilege('authenticated', 'private.ai_usage', 'select'), 'the ledger is private');

-- Defaults and ceiling --------------------------------------------------------------
select is((select lighter_micros || '/' || stop_micros || '/' || ceiling_micros from private.budget_settings),
  '8000000/9500000/10000000', 'defaults are $8 / $9.50 / $10');
select throws_ok('update private.budget_settings set ceiling_micros = 10000001', '23514', null,
  'no configuration can raise the ceiling above $10');
select throws_ok(format('select public.svc_admin_update_budget(%L, gen_random_uuid(), 1, 8000000, 9500000, 10000001, false)', :'owner_id'),
  'PT422', 'VALIDATION_FAILED', 'the owner cannot raise the ceiling above $10');
select throws_ok(format('select public.svc_admin_update_budget(%L, gen_random_uuid(), 1, 9000000, 8000000, 10000000, false)', :'owner_id'),
  'PT422', 'VALIDATION_FAILED', 'lighter must not exceed stop');
select throws_ok(format('select public.svc_admin_update_budget(%L, gen_random_uuid(), 1, 0, 0, 10000000, false)', :'member_id'),
  'PT404', 'NOT_FOUND', 'a nonowner cannot change thresholds');
select throws_ok(format('select public.svc_admin_update_budget(%L, gen_random_uuid(), 99, 0, 0, 10000000, false)', :'owner_id'),
  'PT409', 'REVISION_CONFLICT', 'a stale revision cannot change thresholds');

-- Normal, lighter and stop --------------------------------------------------------------
select is(pg_temp.reserve('a1', 1000000, 500000) ->> 'mode', 'normal', 'below $8 uses the normal envelope');
update private.budget_periods set settled_micros = 7500000 where period_start = '2026-09-01 00:00:00+00';
select is(pg_temp.reserve('a2', 1000000, 400000) ->> 'mode', 'lighter', 'a request crossing $8 is repriced under lighter mode');
select is((pg_temp.reserve('a2b', 1000000, 400000) ->> 'reserved_micros')::bigint, 400000::bigint, 'the lighter reservation is admitted');
select is(pg_temp.reserve('a3', 1000000, 700000) ->> 'refusal_reason', 'budget_stop', 'a request past $9.50 is refused');
select is(pg_temp.committed('2026-09-01 00:00:00+00'), 9300000::bigint, 'committed = settled + reservations');
select ok(pg_temp.committed('2026-09-01 00:00:00+00') <= (select stop_micros from private.budget_settings),
  'settled + reservations + holds never exceed the operational stop');
select is(pg_temp.reserve('a2', 1, 1) ->> 'existing', 'true', 'the same attempt identity returns the existing attempt');

-- Settlement, release and unknown -----------------------------------------------------
select (pg_temp.reserve('s1', 100000, 50000) ->> 'usage_id') as s1 \gset
select is(public.svc_ai_mark_dispatching(:'s1', 'price-v1', 60) ->> 'state', 'dispatching', 'dispatch rechecks and proceeds');
select is(public.svc_ai_settle(:'s1', 10, 5, 0, 40000, 'req-1') ->> 'duplicate', 'false', 'settlement replaces the reservation');
select is(public.svc_ai_settle(:'s1', 10, 5, 0, 40000, 'req-1') ->> 'duplicate', 'true', 'duplicate settlement is a no-op');
select is((select settled_micros from private.budget_periods where period_start = '2026-09-01 00:00:00+00'), 7540000::bigint,
  'settled once');

select (pg_temp.reserve('r1', 30000, 20000) ->> 'usage_id') as r1 \gset
select public.svc_ai_mark_dispatching(:'r1', 'price-v1', 60);
select is(public.svc_ai_release(:'r1') ->> 'duplicate', 'false', 'a known unbilled rejection releases');
select is(public.svc_ai_release(:'r1') ->> 'duplicate', 'true', 'and releases only once');

select (pg_temp.reserve('u1', 60000, 30000) ->> 'usage_id') as u1 \gset
select public.svc_ai_mark_dispatching(:'u1', 'price-v1', 60);
select is(public.svc_ai_mark_unknown(:'u1') ->> 'state', 'unknown', 'a timeout after dispatch becomes unknown');
select is(public.svc_ai_release(:'u1') ->> 'state', 'unknown', 'an unknown attempt cannot be released by a caller');
select * from public.svc_reconcile_jobs(20);
select is((select state from private.ai_usage where id = :'u1'), 'unknown', 'lease reconciliation cannot free an unknown attempt');

-- Tariff and pause rechecks before dispatch ----------------------------------------------
select (pg_temp.reserve('t1', 30000, 20000) ->> 'usage_id') as t1 \gset
select is(public.svc_ai_mark_dispatching(:'t1', 'price-v2', 60) ->> 'reason', 'tariff_changed',
  'a tariff change before dispatch releases the reservation');

select (pg_temp.reserve('o1', 30000, 20000) ->> 'usage_id') as o1 \gset
select public.svc_ai_mark_dispatching(:'o1', 'price-v1', 60);
select is((public.svc_ai_settle(:'o1', 1, 1, 0, 45000, 'req-over') ->> 'over_reservation')::boolean, true,
  'a charge above the reservation is recorded');
select is((select paused_reason from private.budget_settings), 'over_reservation', 'and pauses AI');
select is(pg_temp.reserve('after-over', 100, 50) ->> 'refusal_reason', 'paused', 'no further attempts are admitted while paused');
update private.budget_settings set paused_reason = null;

-- Month boundary --------------------------------------------------------------------------
select is(pg_temp.reserve('late', 1000, 500, '2026-09-30 23:59:30+00', 60) ->> 'refusal_reason', 'rollover_window',
  'a call too close to the UTC rollover is blocked');
select is((public.svc_ai_rollover('2026-10-01 00:05:00+00') ->> 'holds_created')::integer, 1,
  'the unknown September attempt is carried into October as a hold');
select is(pg_temp.committed('2026-10-01 00:00:00+00'), 30000::bigint, 'October counts the uncertain hold');
select public.svc_ai_settle(:'u1', 10, 5, 0, 25000, 'req-late');
select is(pg_temp.committed('2026-10-01 00:00:00+00'), 0::bigint, 'settling the attempt releases the October hold');

-- Missing bounds fail closed ------------------------------------------------------------------
select throws_ok($$select public.svc_ai_reserve('bad', null, null, 'diagnostic', 'm', 'm', null, 1000, 500, 60, null)$$,
  'PT503', 'AI_CONFIGURATION_INVALID', 'an unknown price version fails closed');

select * from finish();
rollback;
