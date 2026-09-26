// Operator-only deletion-aware restore into an isolated, empty database
// (docs/runbooks/backup-restore.md). Nothing here serves traffic.
//
//   BACKUP_MANIFEST=/secure/path/bowr-....json BACKUP_ENCRYPTION_KEY=<base64> \
//   RESTORE_DATABASE_URL=postgresql://.../bowr_restore \
//   R2_PUBLIC_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... DELETION_JOURNAL_BUCKET=... \
//   pnpm ops:restore-rehearsal
//
// Steps: decrypt and verify the export; restore schema and data; revoke every
// session and fail old jobs and paid work (private.prepare_restored_database);
// replay the external deletion journal; expire temporary uploads; reconcile which
// registered objects still exist. Prints a report with counts and timings only.
// PG_TOOLS_CONTAINER runs pg_restore inside that container as supabase_admin (local
// stack only), which can restore Supabase-owned schemas like auth.
import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import postgres from 'postgres';

const RPO_SECONDS = 24 * 3600;
const RTO_SECONDS = 24 * 3600;
const started = Date.now();

const env = (value, name) => {
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(2);
  }
  return value;
};

const manifestPath = env(process.env.BACKUP_MANIFEST, 'BACKUP_MANIFEST');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const target = env(process.env.RESTORE_DATABASE_URL, 'RESTORE_DATABASE_URL');
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).href === new URL(target).href) {
  console.error('Refusing to restore over the live database: RESTORE_DATABASE_URL must be an isolated target.');
  process.exit(2);
}

// 1. Decrypt and verify.
const payload = readFileSync(join(dirname(manifestPath), manifest.file));
if (createHash('sha256').update(payload).digest('hex') !== manifest.sha256) throw new Error('Backup checksum mismatch');
if (payload.subarray(0, 7).toString() !== 'BOWRBK1') throw new Error('Unknown backup format');
const decipher = createDecipheriv('aes-256-gcm', Buffer.from(env(process.env.BACKUP_ENCRYPTION_KEY, 'BACKUP_ENCRYPTION_KEY'), 'base64'), payload.subarray(7, 19));
decipher.setAuthTag(payload.subarray(19, 35));
const dump = Buffer.concat([decipher.update(payload.subarray(35)), decipher.final()]);

// 2. Restore into the empty isolated database.
const sql = postgres(target, { max: 1, onnotice: () => {} });
const [{ tables }] = await sql`
  select count(*)::int as tables from pg_tables where schemaname in ('auth', 'public', 'private')`;
if (tables > 0) {
  await sql.end();
  console.error('Refusing to restore: the target database is not empty.');
  process.exit(2);
}
// The dump recreates the public schema with its grants.
await sql`drop schema if exists public`;
await sql`create schema if not exists extensions`;
await sql`create extension if not exists pgcrypto with schema extensions`;
const container = process.env.PG_TOOLS_CONTAINER;
const restore = container
  ? spawnSync('docker', ['exec', '-i', container, 'pg_restore', '-U', 'supabase_admin', '-d', new URL(target).pathname.slice(1), '--exit-on-error'], {
      input: dump,
      maxBuffer: 64 * 1024 * 1024,
    })
  : spawnSync('pg_restore', [`--dbname=${target}`, '--exit-on-error'], { input: dump, maxBuffer: 64 * 1024 * 1024 });
if (restore.status !== 0) {
  await sql.end();
  throw new Error(`pg_restore failed: ${restore.stderr.toString().slice(0, 500)}`);
}

// 3. Old sessions, claims and paid work from the backup's timeline must not resume.
const [{ prepared }] = await sql`select private.prepare_restored_database() as prepared`;

// 4. Replay the external deletion journal (idempotent; every retained entry).
const endpoint = env(process.env.R2_PUBLIC_ENDPOINT, 'R2_PUBLIC_ENDPOINT').replace(/\/$/, '');
const aws = new AwsClient({
  accessKeyId: env(process.env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
  secretAccessKey: env(process.env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY'),
  service: 's3',
  region: 'auto',
});
async function listKeys(bucket, prefix = '') {
  const keys = [];
  let token = null;
  do {
    const url = new URL(`${endpoint}/${bucket}`);
    url.searchParams.set('list-type', '2');
    if (prefix) url.searchParams.set('prefix', prefix);
    if (token) url.searchParams.set('continuation-token', token);
    const body = await (await aws.fetch(url.toString())).text();
    for (const [, key] of body.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(key);
    token = /<IsTruncated>true<\/IsTruncated>/.test(body) ? /<NextContinuationToken>([^<]+)</.exec(body)?.[1] ?? null : null;
  } while (token);
  return keys;
}
const journalBucket = env(process.env.DELETION_JOURNAL_BUCKET, 'DELETION_JOURNAL_BUCKET');
const replay = { replayed: 0, already_deleting: 0, absent: 0 };
for (const key of (await listKeys(journalBucket, 'deletions/')).sort()) {
  const entry = await (await aws.fetch(`${endpoint}/${journalBucket}/${key}`)).json();
  if (entry.kind !== 'account_deleted') continue;
  const [{ outcome }] = await sql`select private.replay_account_deletion(${entry.subject_id}::uuid) as outcome`;
  replay[outcome] += 1;
}

// 5. Temporary uploads past their deadline are expired now, not when traffic resumes.
const [{ cleanup }] = await sql`select public.svc_temporary_cleanup(10000) as cleanup`;

// 6. Which registered objects still exist? Missing quarantine bytes are simply gone;
// missing retained originals (not already being deleted) need members to reupload.
const bucket = env(process.env.R2_BUCKET, 'R2_BUCKET');
const live = await sql`select object_key, role from private.media_objects where deleted_at is null`;
const missing = [];
for (const object of live) {
  const head = await aws.fetch(`${endpoint}/${bucket}/${object.object_key}`, { method: 'HEAD' });
  if (head.status === 404) missing.push(object);
}
await sql`update private.media_objects set deleted_at = now()
  where role = 'quarantine' and object_key = any(${missing.filter((o) => o.role === 'quarantine').map((o) => o.object_key)}::text[])`;
const [{ originals_missing }] = await sql`
  select count(*)::int as originals_missing from private.media_objects o
   where o.role = 'original' and o.deleted_at is null
     and o.object_key = any(${missing.filter((o) => o.role === 'original').map((o) => o.object_key)}::text[])
     and not exists (select 1 from private.deletion_tasks t where t.object_key = o.object_key and t.state = 'pending')`;
await sql.end();

const elapsedSeconds = Math.round((Date.now() - started) / 1000);
const exportAgeSeconds = Math.round((started - Date.parse(manifest.created_at)) / 1000);
console.log(
  JSON.stringify({
    export_created_at: manifest.created_at,
    export_age_seconds: exportAgeSeconds,
    rpo_met: exportAgeSeconds <= RPO_SECONDS,
    restore_elapsed_seconds: elapsedSeconds,
    rto_met: elapsedSeconds <= RTO_SECONDS,
    prepared,
    journal: replay,
    cleanup,
    objects_checked: live.length,
    quarantine_missing: missing.filter((o) => o.role === 'quarantine').length,
    originals_missing,
    next: 'Recreate Vault secrets, verify the owner, enable schedules, then serve traffic.',
  }),
);
