// Integration tests drive scheduling explicitly (maintenance endpoint calls), so the
// minute cron jobs are paused while they run and restored afterwards.
import postgres from 'postgres';
import { stack } from '../../../tests/support/stack';

export default async function setup() {
  const sql = postgres(stack().DB_URL, { max: 1, onnotice: () => {} });
  await sql`select cron.alter_job(jobid, active := false) from cron.job where jobname like 'bowr-%'`;
  await sql.end();
  return async () => {
    const restore = postgres(stack().DB_URL, { max: 1, onnotice: () => {} });
    await restore`select cron.alter_job(jobid, active := true) from cron.job where jobname like 'bowr-%'`;
    await restore.end();
  };
}
