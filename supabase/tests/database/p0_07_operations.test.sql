-- P0.07: heartbeats, deletion deadlines, cleanup, journal and analytics outbox (sequential cases).
-- Recovery, orphan listing, the external journal and restore live in the integration tests.
begin;
\ir ../fixtures/auth.psql
select plan(18);

select tests.create_identity('member') as member_id \gset

-- Grants -------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.svc_operations_health()', 'execute'),
  'clients cannot read operational health directly');
select ok(not has_function_privilege('anon', 'public.svc_record_maintenance_run(text, timestamptz, text)', 'execute'),
  'clients cannot forge a heartbeat');
select ok(not has_function_privilege('service_role', 'private.prepare_restored_database()', 'execute'),
  'restore preparation is operator-only, not reachable through the API');
select ok(not has_table_privilege('authenticated', 'private.deletion_journal', 'select'), 'the journal is private');
select throws_ok(format('select public.svc_admin_operations(%L)', :'member_id'), 'PT404', 'NOT_FOUND',
  'a member cannot read the operations summary');

-- Heartbeats ------------------------------------------------------------------------
update private.maintenance_heartbeats set last_succeeded_at = now();
select is(private.operations_health() -> 'stale_tasks', '[]'::jsonb, 'recent runs are not stale');
update private.maintenance_heartbeats set last_succeeded_at = now() - interval '13 minutes' where task = 'temporary_cleanup';
select is(private.operations_health() -> 'stale_tasks', '["temporary_cleanup"]'::jsonb,
  'a five-minute task silent for over two intervals is stale');
select is(private.operations_health() ->> 'status', 'degraded', 'a stale task degrades health');
select public.svc_record_maintenance_run('temporary_cleanup', now(), 'storage DELETE 503');
select is((select last_error from private.maintenance_heartbeats where task = 'temporary_cleanup'), 'storage DELETE 503',
  'a failed run is recorded');
select is(private.operations_health() ->> 'status', 'degraded', 'a failed run does not refresh the heartbeat');
select public.svc_record_maintenance_run('temporary_cleanup', now(), null);
select is(private.operations_health() -> 'stale_tasks', '[]'::jsonb, 'a successful run refreshes it');

-- Deletion deadlines ------------------------------------------------------------------
insert into private.deletion_tasks (user_id, bucket, object_key, reason, not_before)
values (:'member_id', 'b', 'uploads/test/temporary-key', 'upload_expired', now() + interval '10 minutes'),
       (:'member_id', 'b', 'media/test/retained-key-0', 'account_deleted', now());
select is((select deadline - not_before from private.deletion_tasks where object_key = 'uploads/test/temporary-key'),
  interval '1 hour', 'temporary objects are due within one hour');
select is((select deadline - created_at from private.deletion_tasks where object_key = 'media/test/retained-key-0'),
  interval '24 hours', 'retained objects are due within 24 hours');
update private.deletion_tasks set deadline = now() - interval '1 second' where object_key = 'media/test/retained-key-0';
select ok((private.operations_health() ->> 'deletions_overdue')::int >= 1, 'a missed deletion deadline is reported');

-- Journal -------------------------------------------------------------------------------
insert into private.account_deletions (user_id, status_token_hash) values (:'member_id', repeat('a', 64));
select is((select count(*)::int from private.deletion_journal where subject_id = :'member_id'), 1,
  'starting an account deletion writes a journal entry in the same transaction');

-- Budget-mode analytics ------------------------------------------------------------------
delete from private.analytics_outbox;
insert into private.budget_periods (period_start, period_end)
select date_trunc('month', now() at time zone 'utc') at time zone 'utc',
       (date_trunc('month', now() at time zone 'utc') + interval '1 month') at time zone 'utc'
on conflict (period_start) do nothing;
update private.budget_periods set reported_mode = 'normal' where period_start <= now() and period_end > now();
update private.budget_settings set paused_reason = 'operator' where id;
select public.svc_observe_budget_mode();
select public.svc_observe_budget_mode();
select is((select count(*)::int from private.analytics_outbox), 1, 'one transition produces exactly one event');
select is((select properties from private.analytics_outbox), '{"mode": "paused"}'::jsonb, 'the event carries the mode only');
update private.budget_settings set paused_reason = null where id;
select public.svc_observe_budget_mode();
update private.budget_settings set paused_reason = 'operator' where id;
select public.svc_observe_budget_mode();
select is((select count(*)::int from private.analytics_outbox), 3, 'a repeated transition is a new event');

select * from finish();
rollback;
