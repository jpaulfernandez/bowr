-- P0.05: owner sees and controls bounded AI work.
-- Every billable provider attempt reserves its worst-case cost in integer USD
-- micros under a locked period row before dispatch (ARCHITECTURE section 10.4).
-- The shared allowance resets at 00:00 UTC on the first of each month.

-- ---------------------------------------------------------------------------
-- Settings, periods, usage and holds (all private)
-- ---------------------------------------------------------------------------
create table private.budget_settings (
  id boolean primary key default true check (id),
  lighter_micros bigint not null default 8000000,
  stop_micros bigint not null default 9500000,
  ceiling_micros bigint not null default 10000000,
  -- Set when AI must stop regardless of thresholds (for example a charge above
  -- its reservation). Cleared only by a deliberate owner action.
  paused_reason text check (paused_reason in ('over_reservation', 'operator')),
  revision bigint not null default 1,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint budget_threshold_order check (
    0 <= lighter_micros and lighter_micros <= stop_micros and stop_micros <= ceiling_micros
    and ceiling_micros <= 10000000
  )
);
insert into private.budget_settings (id) values (true);
revoke all on private.budget_settings from public, anon, authenticated;

create table private.budget_periods (
  id uuid primary key default gen_random_uuid(),
  period_start timestamptz not null unique,
  period_end timestamptz not null,
  settled_micros bigint not null default 0 check (settled_micros >= 0),
  -- Active reservations created in this period: reserved, dispatching and unknown.
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  created_at timestamptz not null default now(),
  constraint budget_period_bounds check (period_end > period_start)
);
revoke all on private.budget_periods from public, anon, authenticated;

create table private.ai_usage (
  id uuid primary key default gen_random_uuid(),
  -- Detached (null) when the member's account is deleted; the accounting stays.
  user_id uuid references auth.users (id) on delete set null,
  job_id uuid references private.jobs (id) on delete set null,
  attempt_key text not null unique check (char_length(attempt_key) between 3 and 200),
  task text not null check (char_length(task) between 1 and 64),
  period_id uuid not null references private.budget_periods (id),
  mode text check (mode in ('normal', 'lighter')),
  model text,
  price_version text,
  state text not null check (state in ('refused', 'reserved', 'dispatching', 'settled', 'released', 'unknown')),
  refusal_reason text check (refusal_reason in ('budget_stop', 'paused', 'rollover_window')),
  reserved_micros bigint not null default 0 check (reserved_micros >= 0),
  settled_micros bigint check (settled_micros >= 0),
  input_tokens integer,
  output_tokens integer,
  thinking_tokens integer,
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 200),
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  settled_at timestamptz,
  constraint ai_usage_refusal check ((state = 'refused') = (refusal_reason is not null)),
  constraint ai_usage_settlement check ((state = 'settled') = (settled_micros is not null))
);
create index ai_usage_period_state on private.ai_usage (period_id, state);
create index ai_usage_open on private.ai_usage (created_at) where state in ('reserved', 'dispatching', 'unknown');
revoke all on private.ai_usage from public, anon, authenticated;

-- Conservative holds for uncertain amounts carried into a later period. Not spend.
create table private.budget_holds (
  usage_id uuid not null references private.ai_usage (id) on delete cascade,
  period_id uuid not null references private.budget_periods (id),
  amount_micros bigint not null check (amount_micros > 0),
  reason text not null check (reason in ('rollover')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (usage_id, period_id)
);
revoke all on private.budget_holds from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Returns the UTC-month period containing p_at, creating it if needed.
create function private.budget_period_at(p_at timestamptz)
returns private.budget_periods
language plpgsql
set search_path = ''
as $$
declare
  v_start timestamptz := date_trunc('month', p_at at time zone 'UTC') at time zone 'UTC';
  v_period private.budget_periods;
begin
  insert into private.budget_periods (period_start, period_end)
  values (v_start, (v_start at time zone 'UTC' + interval '1 month') at time zone 'UTC')
  on conflict (period_start) do nothing;
  select * into v_period from private.budget_periods where period_start = v_start;
  return v_period;
end;
$$;
revoke all on function private.budget_period_at(timestamptz) from public, anon, authenticated;

-- Everything counted against a period's allowance: settled cost, its own active
-- reservations and unreleased holds carried from earlier periods.
create function private.budget_committed(p_period private.budget_periods)
returns bigint
language sql
stable
set search_path = ''
as $$
  select p_period.settled_micros + p_period.reserved_micros
    + coalesce((select sum(h.amount_micros) from private.budget_holds h
                 where h.period_id = p_period.id and h.released_at is null), 0)::bigint;
$$;
revoke all on function private.budget_committed(private.budget_periods) from public, anon, authenticated;

create function private.budget_mode(p_committed bigint, p_settings private.budget_settings)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_settings.paused_reason is not null or p_committed >= p_settings.stop_micros then 'paused'
    when p_committed >= p_settings.lighter_micros then 'lighter'
    else 'normal' end;
$$;
revoke all on function private.budget_mode(bigint, private.budget_settings) from public, anon, authenticated;

-- Releases a usage's reservation and holds. Callers hold the usage row lock and
-- lock periods in chronological order.
create function private.release_usage(p_usage private.ai_usage, p_state text, p_settled bigint)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update private.budget_periods
     set reserved_micros = reserved_micros - p_usage.reserved_micros,
         settled_micros = settled_micros + coalesce(p_settled, 0)
   where id = p_usage.period_id;
  update private.budget_holds set released_at = now() where usage_id = p_usage.id and released_at is null;
end;
$$;
revoke all on function private.release_usage(private.ai_usage, text, bigint) from public, anon, authenticated;

-- Locks every period a usage touches, oldest first, to avoid deadlocks.
create function private.lock_usage_periods(p_usage_id uuid)
returns void
language sql
set search_path = ''
as $$
  select 1 from private.budget_periods p
   where p.id in (select period_id from private.ai_usage where id = p_usage_id
                  union select period_id from private.budget_holds where usage_id = p_usage_id)
   order by p.period_start
   for update;
$$;
revoke all on function private.lock_usage_periods(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Gateway functions (internal Edge only)
-- ---------------------------------------------------------------------------

-- Admits one provider attempt. Returns an existing attempt with the same identity
-- unchanged. p_now is for controlled-clock tests; the gateway passes null.
create function public.svc_ai_reserve(
  p_attempt_key text,
  p_user_id uuid,
  p_job_id uuid,
  p_task text,
  p_model text,
  p_lighter_model text,
  p_price_version text,
  p_reserve_normal bigint,
  p_reserve_lighter bigint,
  p_window_seconds integer,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_existing private.ai_usage;
  v_settings private.budget_settings;
  v_period private.budget_periods;
  v_committed bigint;
  v_mode text;
  v_amount bigint;
  v_model text;
  v_refusal text;
  v_usage_id uuid;
begin
  if p_reserve_normal is null or p_reserve_normal <= 0 or p_reserve_lighter is null or p_reserve_lighter <= 0
     or p_reserve_lighter > p_reserve_normal or p_window_seconds is null or p_window_seconds <= 0
     or p_price_version is null or p_model is null or p_lighter_model is null then
    -- Unknown price, bound or accounting input: fail closed.
    perform private.raise_app_error('AI_CONFIGURATION_INVALID', 503);
  end if;

  select * into v_existing from private.ai_usage where attempt_key = p_attempt_key;
  if found then
    return jsonb_build_object('usage_id', v_existing.id, 'state', v_existing.state, 'mode', v_existing.mode,
      'model', v_existing.model, 'reserved_micros', v_existing.reserved_micros, 'refusal_reason', v_existing.refusal_reason,
      'existing', true);
  end if;

  v_period := private.budget_period_at(v_now);
  select * into v_period from private.budget_periods where id = v_period.id for update;
  select * into v_settings from private.budget_settings for share;
  v_committed := private.budget_committed(v_period);

  if v_now + make_interval(secs => p_window_seconds) > v_period.period_end then
    v_refusal := 'rollover_window';
  elsif v_settings.paused_reason is not null then
    v_refusal := 'paused';
  elsif v_committed + p_reserve_normal <= v_settings.lighter_micros then
    v_mode := 'normal';
    v_amount := p_reserve_normal;
    v_model := p_model;
  elsif v_committed + p_reserve_lighter <= v_settings.stop_micros then
    -- Crossing the lighter threshold reprices the request with the lighter envelope.
    v_mode := 'lighter';
    v_amount := p_reserve_lighter;
    v_model := p_lighter_model;
  else
    v_refusal := 'budget_stop';
  end if;

  if v_refusal is not null then
    insert into private.ai_usage (user_id, job_id, attempt_key, task, period_id, state, refusal_reason, price_version, created_at)
    values (p_user_id, p_job_id, p_attempt_key, p_task, v_period.id, 'refused', v_refusal, p_price_version, v_now)
    returning id into v_usage_id;
    return jsonb_build_object('usage_id', v_usage_id, 'state', 'refused', 'refusal_reason', v_refusal,
      'resets_at', v_period.period_end, 'existing', false);
  end if;

  insert into private.ai_usage (user_id, job_id, attempt_key, task, period_id, mode, model, price_version, state,
    reserved_micros, created_at)
  values (p_user_id, p_job_id, p_attempt_key, p_task, v_period.id, v_mode, v_model, p_price_version, 'reserved',
    v_amount, v_now)
  returning id into v_usage_id;
  update private.budget_periods set reserved_micros = reserved_micros + v_amount where id = v_period.id;
  return jsonb_build_object('usage_id', v_usage_id, 'state', 'reserved', 'mode', v_mode, 'model', v_model,
    'reserved_micros', v_amount, 'existing', false);
end;
$$;

-- Moves a reservation to dispatching immediately before the provider call. Rechecks
-- pause, rollover proximity and the effective tariff; any change releases it.
create function public.svc_ai_mark_dispatching(p_usage_id uuid, p_price_version text, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage private.ai_usage;
  v_period private.budget_periods;
  v_settings private.budget_settings;
  v_blocked text;
begin
  perform private.lock_usage_periods(p_usage_id);
  select * into v_usage from private.ai_usage where id = p_usage_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_usage.state <> 'reserved' then
    return jsonb_build_object('state', v_usage.state, 'dispatch', false);
  end if;
  select * into v_period from private.budget_periods where id = v_usage.period_id;
  select * into v_settings from private.budget_settings;

  if v_settings.paused_reason is not null then
    v_blocked := 'paused';
  elsif v_usage.price_version is distinct from p_price_version then
    v_blocked := 'tariff_changed';
  elsif now() + make_interval(secs => p_window_seconds) > v_period.period_end then
    v_blocked := 'rollover_window';
  end if;
  if v_blocked is not null then
    perform private.release_usage(v_usage, 'released', null);
    update private.ai_usage set state = 'released', settled_at = now() where id = p_usage_id;
    return jsonb_build_object('state', 'released', 'dispatch', false, 'reason', v_blocked);
  end if;

  update private.ai_usage set state = 'dispatching', dispatched_at = now() where id = p_usage_id;
  return jsonb_build_object('state', 'dispatching', 'dispatch', true);
end;
$$;

-- Replaces a reservation with the observed billed cost. A duplicate settlement is
-- a no-op. A charge above the reservation pauses AI and records an alert.
create function public.svc_ai_settle(
  p_usage_id uuid,
  p_input_tokens integer,
  p_output_tokens integer,
  p_thinking_tokens integer,
  p_billed_micros bigint,
  p_provider_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage private.ai_usage;
  v_over boolean;
begin
  if p_billed_micros is null or p_billed_micros < 0 then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('field', 'billed_micros'));
  end if;
  perform private.lock_usage_periods(p_usage_id);
  select * into v_usage from private.ai_usage where id = p_usage_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_usage.state = 'settled' then
    return jsonb_build_object('state', 'settled', 'settled_micros', v_usage.settled_micros, 'duplicate', true);
  end if;
  if v_usage.state not in ('dispatching', 'unknown') then
    perform private.raise_app_error('USAGE_NOT_SETTLEABLE', 409, jsonb_build_object('state', v_usage.state));
  end if;

  perform private.release_usage(v_usage, 'settled', p_billed_micros);
  update private.ai_usage
     set state = 'settled', settled_micros = p_billed_micros, input_tokens = p_input_tokens,
         output_tokens = p_output_tokens, thinking_tokens = p_thinking_tokens,
         provider_request_id = p_provider_request_id, settled_at = now()
   where id = p_usage_id;

  v_over := p_billed_micros > v_usage.reserved_micros;
  if v_over then
    update private.budget_settings set paused_reason = 'over_reservation', updated_at = now() where id;
    insert into private.audit_events (actor_id, action, target_type, target_id, details)
    values (null, 'ai_charge_above_reservation', 'ai_usage', p_usage_id,
      jsonb_build_object('reserved_micros', v_usage.reserved_micros, 'billed_micros', p_billed_micros));
  end if;
  return jsonb_build_object('state', 'settled', 'settled_micros', p_billed_micros, 'duplicate', false,
    'over_reservation', v_over);
end;
$$;

-- A known unbilled outcome (rejected before processing, or canceled before
-- dispatch) releases the reservation once.
create function public.svc_ai_release(p_usage_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage private.ai_usage;
begin
  perform private.lock_usage_periods(p_usage_id);
  select * into v_usage from private.ai_usage where id = p_usage_id for update;
  if not found then
    perform private.raise_app_error('NOT_FOUND', 404);
  end if;
  if v_usage.state = 'released' then
    return jsonb_build_object('state', 'released', 'duplicate', true);
  end if;
  if v_usage.state not in ('reserved', 'dispatching') then
    -- Unknown and settled attempts are never released by a caller.
    return jsonb_build_object('state', v_usage.state, 'duplicate', false);
  end if;
  perform private.release_usage(v_usage, 'released', null);
  update private.ai_usage set state = 'released', settled_at = now() where id = p_usage_id;
  return jsonb_build_object('state', 'released', 'duplicate', false);
end;
$$;

-- The provider may have processed (and billed) the request: keep the full reservation.
create function public.svc_ai_mark_unknown(p_usage_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  update private.ai_usage set state = 'unknown' where id = p_usage_id and state = 'dispatching'
  returning state into v_state;
  if v_state is null then
    select state into v_state from private.ai_usage where id = p_usage_id;
  end if;
  return jsonb_build_object('state', v_state);
end;
$$;

-- At a month boundary, carries every possibly-billed amount from earlier periods
-- into the current period as a hold, so the new allowance cannot spend it twice.
create function public.svc_ai_rollover(p_now timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_period private.budget_periods := private.budget_period_at(v_now);
  v_carried integer := 0;
begin
  -- Chronological locks: earlier periods first, then the current one.
  perform 1 from private.budget_periods where period_start <= v_period.period_start order by period_start for update;
  insert into private.budget_holds (usage_id, period_id, amount_micros, reason)
  select u.id, v_period.id, u.reserved_micros, 'rollover'
    from private.ai_usage u join private.budget_periods p on p.id = u.period_id
   where u.state in ('dispatching', 'unknown') and p.period_start < v_period.period_start and u.reserved_micros > 0
  on conflict (usage_id, period_id) do nothing;
  get diagnostics v_carried = row_count;
  return jsonb_build_object('period_start', v_period.period_start, 'holds_created', v_carried);
end;
$$;

-- Budget facts for one member or the gateway: mode and reset time only.
create function public.svc_ai_status(p_now timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period private.budget_periods := private.budget_period_at(coalesce(p_now, now()));
  v_settings private.budget_settings;
begin
  select * into v_settings from private.budget_settings;
  return jsonb_build_object('mode', private.budget_mode(private.budget_committed(v_period), v_settings),
    'resets_at', v_period.period_end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner administration
-- ---------------------------------------------------------------------------
create function public.svc_admin_budget(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period private.budget_periods;
  v_settings private.budget_settings;
  v_committed bigint;
begin
  perform private.require_owner(p_actor_id);
  v_period := private.budget_period_at(now());
  select * into v_settings from private.budget_settings;
  v_committed := private.budget_committed(v_period);
  return jsonb_build_object(
    'settings', jsonb_build_object('lighter_micros', v_settings.lighter_micros, 'stop_micros', v_settings.stop_micros,
      'ceiling_micros', v_settings.ceiling_micros, 'paused_reason', v_settings.paused_reason, 'revision', v_settings.revision),
    'period', jsonb_build_object(
      'period_start', v_period.period_start,
      'resets_at', v_period.period_end,
      'settled_micros', v_period.settled_micros,
      'reserved_micros', v_period.reserved_micros,
      'unknown_micros', coalesce((select sum(reserved_micros) from private.ai_usage
                                   where period_id = v_period.id and state = 'unknown'), 0),
      'held_micros', coalesce((select sum(amount_micros) from private.budget_holds
                                where period_id = v_period.id and released_at is null), 0),
      'remaining_micros', greatest(v_settings.stop_micros - v_committed, 0),
      'mode', private.budget_mode(v_committed, v_settings),
      'refusals', (select count(*) from private.ai_usage where period_id = v_period.id and state = 'refused')
    ),
    'by_task', coalesce((
      select jsonb_agg(jsonb_build_object('task', task, 'attempts', attempts, 'settled_micros', settled,
        'reserved_micros', reserved, 'refusals', refusals) order by task)
      from (select task, count(*) filter (where state <> 'refused') as attempts,
                   coalesce(sum(settled_micros), 0) as settled,
                   coalesce(sum(reserved_micros) filter (where state in ('reserved', 'dispatching', 'unknown')), 0) as reserved,
                   count(*) filter (where state = 'refused') as refusals
              from private.ai_usage where period_id = v_period.id group by task) t
    ), '[]'::jsonb),
    'by_member', coalesce((
      select jsonb_agg(jsonb_build_object('display_name', coalesce(p.display_name, 'Unnamed member'),
        'settled_micros', m.settled, 'reserved_micros', m.reserved) order by m.settled desc, p.display_name)
      from (select user_id, coalesce(sum(settled_micros), 0) as settled,
                   coalesce(sum(reserved_micros) filter (where state in ('reserved', 'dispatching', 'unknown')), 0) as reserved
              from private.ai_usage where period_id = v_period.id and state <> 'refused' and user_id is not null
             group by user_id) m
      left join public.profiles p on p.id = m.user_id
    ), '[]'::jsonb)
  );
end;
$$;

-- Deliberate, revisioned threshold change. The ceiling can never exceed $10.
create function public.svc_admin_update_budget(
  p_actor_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_lighter_micros bigint,
  p_stop_micros bigint,
  p_ceiling_micros bigint,
  p_clear_pause boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing jsonb;
  v_settings private.budget_settings;
  v_result jsonb;
begin
  perform private.require_owner(p_actor_id);
  if p_lighter_micros is null or p_stop_micros is null or p_ceiling_micros is null
     or not (0 <= p_lighter_micros and p_lighter_micros <= p_stop_micros and p_stop_micros <= p_ceiling_micros
             and p_ceiling_micros <= 10000000) then
    perform private.raise_app_error('VALIDATION_FAILED', 422, jsonb_build_object('reason', 'threshold_order',
      'max_ceiling_micros', 10000000));
  end if;
  v_existing := private.claim_request(p_actor_id, 'update_budget', p_request_id, jsonb_build_object(
    'expected_revision', p_expected_revision, 'lighter', p_lighter_micros, 'stop', p_stop_micros,
    'ceiling', p_ceiling_micros, 'clear_pause', coalesce(p_clear_pause, false)));
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_settings from private.budget_settings for update;
  if v_settings.revision <> p_expected_revision then
    perform private.raise_app_error('REVISION_CONFLICT', 409, jsonb_build_object('current_revision', v_settings.revision));
  end if;
  update private.budget_settings
     set lighter_micros = p_lighter_micros, stop_micros = p_stop_micros, ceiling_micros = p_ceiling_micros,
         paused_reason = case when coalesce(p_clear_pause, false) then null else paused_reason end,
         revision = revision + 1, updated_by = p_actor_id, updated_at = now()
   where id
  returning * into v_settings;
  insert into private.audit_events (actor_id, action, target_type, target_id, details)
  values (p_actor_id, 'budget_thresholds_changed', 'budget_settings', null, jsonb_build_object(
    'lighter_micros', p_lighter_micros, 'stop_micros', p_stop_micros, 'ceiling_micros', p_ceiling_micros,
    'cleared_pause', coalesce(p_clear_pause, false)));
  v_result := jsonb_build_object('lighter_micros', v_settings.lighter_micros, 'stop_micros', v_settings.stop_micros,
    'ceiling_micros', v_settings.ceiling_micros, 'paused_reason', v_settings.paused_reason, 'revision', v_settings.revision);
  return private.complete_request(p_actor_id, 'update_budget', p_request_id, v_result);
end;
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.svc_ai_reserve(text, uuid, uuid, text, text, text, text, bigint, bigint, integer, timestamptz)',
    'public.svc_ai_mark_dispatching(uuid, text, integer)',
    'public.svc_ai_settle(uuid, integer, integer, integer, bigint, text)',
    'public.svc_ai_release(uuid)',
    'public.svc_ai_mark_unknown(uuid)',
    'public.svc_ai_rollover(timestamptz)',
    'public.svc_ai_status(timestamptz)',
    'public.svc_admin_budget(uuid)',
    'public.svc_admin_update_budget(uuid, uuid, bigint, bigint, bigint, bigint, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- Carry uncertain amounts across the month boundary within minutes of reset.
select cron.schedule('bowr-ai-rollover', '*/10 * * * *', $$select private.invoke_maintenance('ai_rollover')$$);
