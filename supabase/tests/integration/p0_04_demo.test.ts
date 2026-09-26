// P0.04 demo with real processes: kill the validation worker mid-stage, then the
// original job recovers under a new lease and publishes once.
// This test replaces whatever worker listens on :8765 and leaves a normal worker running.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { api, maintenance } from '../../../tests/support/api';
import { createIdentity } from '../../../tests/support/identities';
import { createSlot, mediaFixtures, member, putSlot } from '../../../tests/support/media';
import { sql } from '../../../tests/support/stack';

function startWorker(env: Record<string, string>, log: string): ChildProcess {
  const child = spawn('uv', ['run', 'python', '-m', 'bowr_worker.local_server'], {
    cwd: 'services/worker',
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
  });
  child.unref();
  return child;
}

async function waitForPort(open: boolean) {
  for (let i = 0; i < 80; i += 1) {
    const listening = await fetch('http://127.0.0.1:8765/', { method: 'POST' }).then(
      () => true,
      () => false,
    );
    if (listening === open) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`worker port did not become ${open ? 'open' : 'closed'}`);
}

function stopAnyWorker() {
  try {
    execFileSync('fuser', ['-k', '-KILL', '8765/tcp'], { stdio: 'ignore' });
  } catch {
    // Nothing was listening.
  }
}

beforeAll(async () => {
  stopAnyWorker();
  await waitForPort(false);
});

afterAll(async () => {
  await sql().end();
});

it('P0.04 demo: a worker killed mid-stage is replaced and the job publishes once', async () => {
  const fixtures = mediaFixtures();
  const owner = await member(createIdentity, 'demo-recovery');

  // 1. A slow worker holds the stage long enough to be killed while running.
  const slow = startWorker({ BOWR_WORKER_STAGE_DELAY_SECONDS: '60', BOWR_WORKER_HEARTBEAT_SECONDS: '1' }, '/tmp/bowr-demo-slow-worker.log');
  await waitForPort(true);

  const { entry } = await createSlot(owner.token, fixtures.png, 'image/png');
  expect((await putSlot(entry, fixtures.png)).status).toBe(200);
  expect((await api(`/upload-entries/${entry.entry_id}/complete`, { token: owner.token, method: 'POST' })).status).toBe(202);

  let [job] = await sql()`select j.* from private.jobs j where j.target_id = ${entry.asset_id}`;
  for (let i = 0; i < 40 && job!.state !== 'running'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    [job] = await sql()`select j.* from private.jobs j where j.target_id = ${entry.asset_id}`;
  }
  expect(job).toMatchObject({ state: 'running', lease_generation: 1 });
  // Heartbeats from the live worker extend the lease.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const [beating] = await sql()`select heartbeat_at > claimed_at as renewed from private.jobs where id = ${job!.id}`;
  expect(beating!.renewed).toBe(true);

  // 2. Kill the worker process group mid-stage (no cleanup, no callback).
  process.kill(-slow.pid!, 'SIGKILL');
  await waitForPort(false);

  // 3. A normal worker starts. Its predecessor's lease would expire within 120 s;
  //    the test fast-forwards that one timestamp instead of sleeping.
  startWorker({}, '/tmp/bowr-demo-worker.log');
  await waitForPort(true);
  await sql()`update private.jobs set lease_expires_at = now() - interval '1 second' where id = ${job!.id}`;
  expect((await maintenance('dispatch_jobs')).status).toBe(200);
  const [waiting] = await sql()`select state from private.jobs where id = ${job!.id}`;
  expect(waiting!.state).toBe('retry_wait');
  await sql()`update private.jobs set next_run_at = now() where id = ${job!.id}`;
  expect((await maintenance('dispatch_jobs')).status).toBe(200);

  // 4. The original job, not a new one, publishes exactly once.
  let [entryRow] = await sql()`select state from public.upload_entries where id = ${entry.entry_id}`;
  for (let i = 0; i < 80 && entryRow!.state !== 'ready'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    [entryRow] = await sql()`select state from public.upload_entries where id = ${entry.entry_id}`;
  }
  expect(entryRow!.state).toBe('ready');
  const jobs = await sql()`select id, state, attempt_count, lease_generation from private.jobs where target_id = ${entry.asset_id}`;
  expect(jobs).toEqual([{ id: job!.id, state: 'succeeded', attempt_count: 2, lease_generation: 2 }]);
  const originals = await sql()`select object_key from private.media_objects where asset_id = ${entry.asset_id} and role = 'original'`;
  expect(originals).toHaveLength(1);
  expect(originals[0]!.object_key).toMatch(/original-g2\.webp$/);
}, 120_000);
