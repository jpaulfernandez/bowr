// Operator-only recovery after a missed maintenance heartbeat (docs/runbooks/operations.md).
//
//   FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 MAINTENANCE_SECRET=... HEALTH_CHECK_TOKEN=... \
//   DATABASE_URL=postgresql://... pnpm ops:recover-maintenance
//
// 1. Re-enables paused bowr-* schedules (needs DATABASE_URL; skipped without it).
// 2. Runs the scheduled tasks once in dependency order, repeating cleanup and
//    deletion until they stop making progress, so queued deletions drain.
// 3. Prints the health report. Exits 1 if the service is still degraded.
// Output holds task names and counts only.
import postgres from 'postgres';

const functionsUrl = process.env.FUNCTIONS_URL?.replace(/\/$/, '');
const secret = process.env.MAINTENANCE_SECRET;
const healthToken = process.env.HEALTH_CHECK_TOKEN;
if (!functionsUrl || !secret || !healthToken) {
  console.error('FUNCTIONS_URL, MAINTENANCE_SECRET and HEALTH_CHECK_TOKEN are required.');
  process.exit(2);
}

if (process.env.DATABASE_URL) {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const resumed = await sql`
      select jobname from cron.job where jobname like 'bowr-%' and not active`;
    await sql`select cron.alter_job(jobid, active := true) from cron.job where jobname like 'bowr-%' and not active`;
    console.log(`Schedules re-enabled: ${resumed.map((r) => r.jobname).join(', ') || 'none were paused'}`);
  } finally {
    await sql.end();
  }
} else {
  console.log('DATABASE_URL not set: schedules were not checked.');
}

async function run(task) {
  const response = await fetch(`${functionsUrl}/maintenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ task }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${task} failed with ${response.status}`);
  console.log(`${task}: ${JSON.stringify(body.data)}`);
  return body.data;
}

await run('dispatch_jobs');
for (let round = 0; round < 10; round += 1) {
  const cleanup = await run('temporary_cleanup');
  const deletion = await run('account_deletion');
  if (cleanup.objects_deleted + cleanup.uploads_expired + deletion.objects_deleted + deletion.accounts_completed === 0) break;
}
await run('pending_account_cleanup');
await run('ai_rollover');
await run('orphan_reconciliation');

const health = await fetch(`${functionsUrl}/maintenance/health`, { headers: { Authorization: `Bearer ${healthToken}` } });
const report = (await health.json()).data;
console.log(`Health: ${JSON.stringify(report)}`);
if (health.status !== 200) process.exitCode = 1;
