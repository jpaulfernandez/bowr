-- P0.04: job registry rules (concurrency, attempts, reconciliation, grants).
begin;
\ir ../fixtures/auth.psql
select plan(14);

-- Isolate this transaction from jobs left by other suites.
update private.jobs set state = 'canceled' where state in ('queued', 'running', 'retry_wait');

select tests.create_identity('a') as a_id \gset
select tests.create_identity('b') as b_id \gset
select tests.create_identity('c') as c_id \gset

create temporary table j (label text primary key, id uuid) on commit drop;
insert into j
select label, (select id from private.jobs where target_id = asset_id) from (
  select label, (public.svc_create_upload_batch(uid, gen_random_uuid(), 'bucket',
    jsonb_build_array(jsonb_build_object('client_file_id', gen_random_uuid(), 'purpose', 'garment',
      'content_type', 'image/png', 'byte_size', 10))) -> 'entries' -> 0 ->> 'asset_id')::uuid as asset_id, uid
  from (values ('a1', :'a_id'::uuid), ('a2', :'a_id'::uuid), ('b1', :'b_id'::uuid), ('c1', :'c_id'::uuid)) v(label, uid)
) s;
-- Mark each entry uploaded and commit its job (as completion would).
select public.svc_complete_upload_entry(e.user_id, gen_random_uuid(), e.id, 10) from public.upload_entries e
 where e.user_id in (:'a_id', :'b_id', :'c_id');
update j set id = (select jb.id from private.jobs jb join public.upload_entries e on e.asset_id = jb.target_id
  where e.user_id = case when j.label like 'a%' then :'a_id'::uuid when j.label = 'b1' then :'b_id'::uuid else :'c_id'::uuid end
  order by jb.created_at, jb.id offset case when j.label = 'a2' then 1 else 0 end limit 1);

select ok(not has_function_privilege('authenticated', 'public.svc_reconcile_jobs(integer)', 'execute'), 'clients cannot reconcile');
select ok(not has_function_privilege('authenticated', 'public.svc_heartbeat_job(uuid, integer)', 'execute'), 'clients cannot heartbeat');
select ok(not has_table_privilege('authenticated', 'private.job_payloads', 'select'), 'payloads are private');
select is((select count(*)::int from private.job_payloads where job_id in (select id from j)), 4, 'every job commits its payload');

-- Concurrency: one running job per member, two globally.
create function pg_temp.start(p_job uuid) returns text language plpgsql as $$
begin
  if not public.svc_issue_job_claim(p_job, repeat('a', 64)) then return 'deferred'; end if;
  perform public.svc_claim_job(p_job, repeat('a', 64));
  return 'running';
end $$;
select is(pg_temp.start((select id from j where label = 'a1')), 'running', 'first job for A starts');
select is(pg_temp.start((select id from j where label = 'a2')), 'deferred', 'second job for A waits for A''s slot');
select is(pg_temp.start((select id from j where label = 'b1')), 'running', 'B starts in the second global slot');
select is(pg_temp.start((select id from j where label = 'c1')), 'deferred', 'C waits for a global slot');

-- Reconciliation: an expired lease moves to retry_wait, then back to queued.
update private.jobs set lease_expires_at = now() - interval '1 second' where id = (select id from j where label = 'a1');
select * from public.svc_reconcile_jobs(20);
select is((select state from private.jobs where id = (select id from j where label = 'a1')), 'retry_wait', 'expired lease waits to retry');
select is((select e.state from public.upload_entries e join private.jobs jb on jb.target_id = e.asset_id where jb.id = (select id from j where label = 'a1')),
  'uploaded', 'its entry returns to uploaded, not rejected');
update private.jobs set next_run_at = now() where id = (select id from j where label = 'a1');
select ok((select id from j where label = 'a1') in (select job_id from public.svc_reconcile_jobs(20)), 'due retries are runnable again');

-- Attempts are bounded at three.
update private.jobs set attempt_count = 3, state = 'running', lease_expires_at = now() - interval '1 second'
 where id = (select id from j where label = 'a1');
select * from public.svc_reconcile_jobs(20);
select is((select state || '/' || coalesce(failure_code, '') from private.jobs where id = (select id from j where label = 'a1')),
  'failed/LEASE_EXPIRED', 'the third lost attempt fails the job');
select is((select e.state || '/' || e.failure_code from public.upload_entries e join private.jobs jb on jb.target_id = e.asset_id
  where jb.id = (select id from j where label = 'a1')), 'failed/PROCESSING_FAILED', 'the entry shows a safe failure');
select throws_ok(format('update private.jobs set attempt_count = 4 where id = %L', (select id from j where label = 'a1')),
  '23514', null, 'attempt count cannot exceed three');

select * from finish();
rollback;
